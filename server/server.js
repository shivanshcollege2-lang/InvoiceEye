import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import PDFDocument from 'pdfkit';
import fs from 'fs/promises';
import path from 'path';
import { spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { getDatabaseMode, getPool, initMySQL } from './db/index.js';
import { getAdminAllowlist, requireAuth, requireRoles, resolveIdentityRole, signToken, verifyGoogleIdentityToken } from './middleware/auth.js';
import { errorHandler, notFound } from './middleware/error.js';
import { parseInvoiceText } from './services/parser.js';
import { verifyInvoice } from './services/verifier.js';
import { anomalySignal } from './services/anomaly.js';
import { extractDocument } from './services/documentExtractor.js';
import { validateDocumentBuffer } from './services/fileValidation.js';
import { parsePurchaseOrderCsv } from './services/purchaseOrderImport.js';
import { getProviderConfiguration, isValidNotificationRecipient, renderVendorNotification, sendVendorNotification } from './services/vendorNotifications.js';
import { buildVendorInsights } from './services/vendorInsights.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const app = express();
const PORT = Number(process.env.PORT || 5050);
const uploadDir = path.resolve(projectRoot, process.env.UPLOAD_DIR || 'server/uploads');
const allowedUploadExtensions = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff', '.txt']);
const maxUploadBytes = 8 * 1024 * 1024;
function getNonPoInvoicePolicy() {
  const configured = String(process.env.NON_PO_INVOICE_POLICY || 'review').trim().toLowerCase();
  return ['review','allow','reject'].includes(configured) ? configured : 'review';
}
const corsOrigins = new Set((process.env.CORS_ORIGIN || 'http://127.0.0.1:5173,http://localhost:5173')
  .split(',').map(origin => origin.trim()).filter(Boolean));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadBytes, files: 1, fields: 3, parts: 4 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (!allowedUploadExtensions.has(extension)) {
      return callback(Object.assign(new Error('Unsupported invoice file type'), { status: 415 }));
    }
    callback(null, true);
  }
});

const apiCors = cors({
  origin(origin, callback) {
    if (!origin || corsOrigins.has(origin)) return callback(null, true);
    callback(Object.assign(new Error('Origin is not allowed by CORS'), { status: 403 }));
  }
});
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin === `${req.protocol}://${req.get('host')}`) return next();
  apiCors(req, res, next);
});
app.use(express.json({ limit: '2mb' }));

function pool() { return getPool(); }
function audit(req, invoiceId, action, status, details='') {
  return pool().query('INSERT INTO audit_logs(invoice_id,user_id,action,status,details,ip_address) VALUES (?,?,?,?,?,?)', [invoiceId || null, req.user?.id || null, action, status || null, details, req.ip]);
}
function invoiceId() { return `INV-${Date.now()}-${Math.floor(Math.random()*1000)}`; }
function notificationDedupeKey({invoiceId,vendorId,channel,recipient,decision,reason}) {
  return createHash('sha256').update([invoiceId,vendorId,channel,recipient,decision,reason].join('\0')).digest('hex');
}

async function prepareVendorNotification(db,invoiceIdValue,channel) {
  if(!['email','whatsapp','sms'].includes(channel))return {found:true,eligible:false,channel,status:'UNSUPPORTED CHANNEL',message:'Choose email, WhatsApp Business or SMS.'};
  const [invoiceRows]=await db.query(`SELECT i.invoice_id,i.invoice_number,i.vendor_id,i.status,i.currency,
    v.name vendorName,v.email vendorEmail,vr.decision_reason
    FROM invoices i JOIN vendors v ON v.vendor_id=i.vendor_id
    LEFT JOIN verification_results vr ON vr.result_id=(SELECT MAX(result_id) FROM verification_results WHERE invoice_id=i.invoice_id)
    WHERE i.invoice_id=? LIMIT 1`,[invoiceIdValue]);
  if(!invoiceRows.length)return { found:false };
  const invoice=invoiceRows[0];
  if(!['ACCEPTED','NEEDS REVIEW','REJECTED'].includes(invoice.status)) {
    return { found:true,eligible:false,invoiceId:invoice.invoice_id,decision:invoice.status,channel,status:'DECISION NOT FINAL',message:'A finalized financial decision is required before vendor communication.' };
  }
  let exactReason=String(invoice.decision_reason||'').trim();
  if(invoice.status==='NEEDS REVIEW'){
    const [clarifications]=await db.query(`SELECT vendor_message FROM invoice_status_history
      WHERE invoice_id=? AND vendor_message IS NOT NULL AND TRIM(vendor_message)<>''
      ORDER BY history_id DESC LIMIT 1`,[invoiceIdValue]);
    if(clarifications.length)exactReason=String(clarifications[0].vendor_message);
  }
  const [contactRows]=await db.query(`SELECT channel,recipient,is_verified isVerified,has_consent hasConsent,
    verification_method verificationMethod,consent_evidence consentEvidence
    FROM vendor_notification_contacts WHERE vendor_id=? AND channel=? LIMIT 1`,[invoice.vendor_id,channel]);
  const contact=contactRows[0]||null;
  const recipient=contact?.recipient|| (channel==='email'?invoice.vendorEmail||'':'');
  const configuration=getProviderConfiguration(channel);
  const recipientValid=isValidNotificationRecipient(channel,recipient);
  const contactEligible=Boolean(contact&&Number(contact.isVerified)&&Number(contact.hasConsent)&&contact.verificationMethod&&contact.consentEvidence&&recipientValid);
  const rendered=renderVendorNotification({channel,vendor:{name:invoice.vendorName},invoice,reason:exactReason});
  const dedupeKey=notificationDedupeKey({invoiceId:invoice.invoice_id,vendorId:invoice.vendor_id,channel,recipient,decision:invoice.status,reason:exactReason});
  const [priorRows]=await db.query(`SELECT notification_id notificationId,attempt_number attemptNumber,status,provider_status providerStatus,
    provider_message_id providerMessageId,created_at createdAt FROM notification_history
    WHERE dedupe_key=? ORDER BY attempt_number DESC LIMIT 1`,[dedupeKey]);
  const previous=priorRows[0]||null;
  let status='READY';
  let message='Ready to send.';
  if(!configuration.configured){status='INTEGRATION NOT CONFIGURED';message=`Configure ${configuration.provider} credentials in the server environment.`;}
  else if(!contactEligible){status='CONTACT NOT VERIFIED';message='A valid vendor contact, verification evidence and recorded consent are required.';}
  else if(!exactReason){status='REASON NOT RECORDED';message='A system-generated decision reason is required before sending.';}
  else if(previous?.status==='ACCEPTED'){status='ALREADY SENT';message='This decision and channel were already accepted by the provider.';}
  else if(previous&&previous.status!=='FAILED'){status='SEND REQUIRES REVIEW';message='A previous attempt is pending or uncertain; automatic resend is blocked to prevent duplicates.';}
  else if(previous?.status==='FAILED'){status='RETRY AVAILABLE';message='The previous provider attempt failed. Use the explicit retry action.';}
  return {
    found:true,invoiceId:invoice.invoice_id,vendorId:invoice.vendor_id,vendorName:invoice.vendorName,
    decision:invoice.status,channel,recipient,recipientValid,contactEligible,
    contact:{verified:Boolean(contact&&Number(contact.isVerified)),consent:Boolean(contact&&Number(contact.hasConsent)),verificationMethod:contact?.verificationMethod||null,consentEvidence:contact?.consentEvidence||null},
    configuration,rendered,dedupeKey,previous,status,message,
    canSend:status==='READY'
  };
}

async function dispatchVendorNotification(req,preview,retry=false) {
  const db=pool();
  let attemptNumber=1;
  if(preview.previous){
    if(!retry||preview.previous.status!=='FAILED')return { conflict:true,notification:preview.previous };
    attemptNumber=Number(preview.previous.attemptNumber)+1;
  }else if(retry)return { conflict:true };
  const id=randomUUID();
  const conn=await db.getConnection();
  try{
    await conn.beginTransaction();
    await conn.query(`INSERT INTO notification_history(notification_id,dedupe_key,attempt_number,invoice_id,vendor_id,channel,recipient,
      decision,reason,message_subject,message_body,initiated_by,provider,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'SENDING')`,[
      id,preview.dedupeKey,attemptNumber,preview.invoiceId,preview.vendorId,preview.channel,preview.recipient,
      preview.decision,preview.rendered.reason,preview.rendered.subject,preview.rendered.body,req.user.id,preview.configuration.provider
    ]);
    await conn.commit();
  } catch(error){
    await conn.rollback();
    if(error.code==='ER_DUP_ENTRY'||error.code==='SQLITE_CONSTRAINT_PRIMARYKEY'||error.code==='SQLITE_CONSTRAINT_UNIQUE')return { conflict:true };
    throw error;
  } finally {conn.release();}

  let outcome;
  try{
    const providerResult=await sendVendorNotification({channel:preview.channel,recipient:preview.recipient,rendered:preview.rendered});
    outcome={status:'ACCEPTED',providerStatus:providerResult.providerStatus,providerMessageId:providerResult.providerMessageId||null,
      providerResponse:JSON.stringify(providerResult.response||{}),error:null,provider:providerResult.provider};
  }catch(error){
    outcome={status:error.uncertain?'UNKNOWN':'FAILED',providerStatus:error.providerStatusCode?String(error.providerStatusCode):null,
      providerMessageId:null,providerResponse:JSON.stringify(error.providerResponse||{}),error:String(error.message||'Provider submission failed.').slice(0,2000),provider:preview.configuration.provider};
  }

  await db.query(`UPDATE notification_history SET status=?,provider_status=?,provider_message_id=?,provider_response=?,error=?,provider=?,updated_at=CURRENT_TIMESTAMP
    WHERE notification_id=?`,[outcome.status,outcome.providerStatus,outcome.providerMessageId,outcome.providerResponse,outcome.error,outcome.provider,id]);
  const auditDetails=JSON.stringify({
    notificationId:id,attemptNumber,channel:preview.channel,recipient:preview.recipient,decision:preview.decision,
    reason:preview.rendered.reason,messageSubject:preview.rendered.subject,messageBody:preview.rendered.body,
    provider:outcome.provider,status:outcome.status,providerStatus:outcome.providerStatus,
    providerMessageId:outcome.providerMessageId,providerResponse:outcome.providerResponse,error:outcome.error
  });
  await audit(req,preview.invoiceId,'VENDOR_NOTIFICATION',outcome.status,auditDetails);
  return { notificationId:id,attemptNumber,...outcome };
}

const batchFinalStatuses = new Set(['ACCEPTED','NEEDS REVIEW','REJECTED','PROCESSING FAILED','FAILED']);

function getBatchContext(req) {
  const { batchId, batchItemId, batchAttempt } = req.body || {};
  if (!batchId && !batchItemId && !batchAttempt) return null;
  const attemptNumber=Number(batchAttempt);
  if (typeof batchId!=='string'||typeof batchItemId!=='string'||!Number.isInteger(attemptNumber)||attemptNumber<1) {
    throw Object.assign(new Error('Batch file context is invalid.'),{status:400});
  }
  return { batchId, itemId:batchItemId, attemptNumber };
}

async function validateBatchAttempt(db,context,user) {
  if (!context) return;
  const [rows]=await db.query(`SELECT b.created_by,bi.latest_attempt,a.status FROM invoice_batch_attempts a
    JOIN invoice_batches b ON b.batch_id=a.batch_id
    JOIN invoice_batch_items bi ON bi.batch_id=a.batch_id AND bi.item_id=a.item_id
    WHERE a.batch_id=? AND a.item_id=? AND a.attempt_number=?`,[context.batchId,context.itemId,context.attemptNumber]);
  if (!rows.length) throw Object.assign(new Error('Batch file attempt was not found.'),{status:404});
  if (Number(rows[0].created_by)!==Number(user.id)&&user.role!=='admin') throw Object.assign(new Error('Batch file attempt is not available to your account.'),{status:403});
  if (Number(rows[0].latest_attempt)!==context.attemptNumber||rows[0].status!=='UPLOADING') {
    throw Object.assign(new Error('This batch file attempt has already been submitted.'),{status:409});
  }
}

async function setBatchAttemptStage(db,context,{status,uploadProgress,ocrStatus,verificationStatus,invoiceId:invoiceRecordId,error}) {
  if (!context) return;
  await db.query(`UPDATE invoice_batch_attempts SET status=?,upload_progress=COALESCE(?,upload_progress),
    ocr_status=COALESCE(?,ocr_status),verification_status=COALESCE(?,verification_status),
    invoice_id=COALESCE(?,invoice_id),error=?,updated_at=CURRENT_TIMESTAMP
    WHERE batch_id=? AND item_id=? AND attempt_number=? AND status NOT IN ('ACCEPTED','NEEDS REVIEW','REJECTED','PROCESSING FAILED','FAILED')`,[
    status,uploadProgress??null,ocrStatus??null,verificationStatus??null,invoiceRecordId??null,error??null,
    context.batchId,context.itemId,context.attemptNumber
  ]);
  await refreshBatchStatus(db,context.batchId);
}

async function updateBatchAttempt(db, batchId, itemId, attemptNumber, update) {
  return db.query(`UPDATE invoice_batch_attempts SET status=?,upload_progress=?,ocr_status=?,verification_status=?,invoice_id=?,error=?,updated_at=CURRENT_TIMESTAMP
    WHERE batch_id=? AND item_id=? AND attempt_number=?`, [
    update.status, update.uploadProgress ?? 0, update.ocrStatus || 'QUEUED', update.verificationStatus || 'QUEUED',
    update.invoiceId || null, update.error || null, batchId, itemId, attemptNumber
  ]);
}

async function refreshBatchStatus(db, batchId) {
  const [rows] = await db.query(`SELECT COUNT(*) total,
    SUM(CASE WHEN a.status IN ('ACCEPTED','NEEDS REVIEW','REJECTED','PROCESSING FAILED','FAILED') THEN 1 ELSE 0 END) finished,
    SUM(CASE WHEN a.status IN ('PROCESSING FAILED','FAILED') THEN 1 ELSE 0 END) failures
    FROM invoice_batch_items bi LEFT JOIN invoice_batch_attempts a
      ON a.batch_id=bi.batch_id AND a.item_id=bi.item_id AND a.attempt_number=bi.latest_attempt
    WHERE bi.batch_id=?`, [batchId]);
  const totals = rows[0];
  if (!totals || Number(totals.total) === 0) return;
  if (Number(totals.finished) === Number(totals.total)) {
    const status = Number(totals.failures) ? 'COMPLETED WITH FAILURES' : 'COMPLETED';
    await db.query('UPDATE invoice_batches SET status=?,completed_at=CURRENT_TIMESTAMP WHERE batch_id=?', [status,batchId]);
  } else {
    await db.query("UPDATE invoice_batches SET status='PROCESSING',completed_at=NULL WHERE batch_id=?", [batchId]);
  }
}

async function loadInvoiceBatch(db, batchId, user) {
  const [batchRows] = await db.query('SELECT * FROM invoice_batches WHERE batch_id=?', [batchId]);
  if (!batchRows.length) return null;
  const batch = batchRows[0];
  if (user.role !== 'admin' && Number(batch.created_by) !== Number(user.id)) return { denied:true };
  const [items] = await db.query(`SELECT bi.item_id itemId,bi.original_name originalName,bi.file_size fileSize,bi.latest_attempt latestAttempt,
    a.status,a.upload_progress uploadProgress,a.ocr_status ocrStatus,a.verification_status verificationStatus,a.invoice_id invoiceId,a.error,
    i.invoice_number invoiceNumber,i.vendor_id vendorId,i.total,i.currency,i.risk_score riskScore
    FROM invoice_batch_items bi JOIN invoice_batch_attempts a
      ON a.batch_id=bi.batch_id AND a.item_id=bi.item_id AND a.attempt_number=bi.latest_attempt
    LEFT JOIN invoices i ON i.invoice_id=a.invoice_id WHERE bi.batch_id=? ORDER BY bi.created_at,bi.item_id`, [batchId]);
  const counts = { totalUploaded:items.length, processedSuccessfully:0, approved:0, needsReview:0, rejected:0, processingFailures:0, pending:0 };
  for (const item of items) {
    if (['ACCEPTED','NEEDS REVIEW','REJECTED'].includes(item.status)) counts.processedSuccessfully += 1;
    else if (['PROCESSING FAILED','FAILED'].includes(item.status)) counts.processingFailures += 1;
    else counts.pending += 1;
    if (item.status === 'ACCEPTED') counts.approved += 1;
    if (item.status === 'NEEDS REVIEW') counts.needsReview += 1;
    if (item.status === 'REJECTED') counts.rejected += 1;
  }
  const [attempts] = await db.query(`SELECT a.item_id itemId,a.attempt_number attemptNumber,a.status,a.upload_progress uploadProgress,
    a.ocr_status ocrStatus,a.verification_status verificationStatus,a.invoice_id invoiceId,a.error,a.created_at createdAt,
    i.invoice_number invoiceNumber FROM invoice_batch_attempts a LEFT JOIN invoices i ON i.invoice_id=a.invoice_id
    WHERE a.batch_id=? ORDER BY a.item_id,a.attempt_number`, [batchId]);
  const attemptsByItem = new Map();
  for (const attempt of attempts) {
    if (!attemptsByItem.has(attempt.itemId)) attemptsByItem.set(attempt.itemId, []);
    attemptsByItem.get(attempt.itemId).push(attempt);
  }
  return { ...batch, ...counts, items:items.map(item=>({...item,attempts:attemptsByItem.get(item.itemId)||[]})) };
}
async function addStatusHistory(conn, event) {
  return conn.query(`INSERT INTO invoice_status_history
    (invoice_id,actor_id,event_type,old_status,new_status,reason,vendor_message,internal_note)
    VALUES (?,?,?,?,?,?,?,?)`, [
    event.invoiceId, event.actorId ?? null, event.eventType, event.oldStatus ?? null,
    event.newStatus, event.reason ?? null, event.vendorMessage ?? null, event.internalNote ?? null
  ]);
}

async function evaluateInvoice(db, parsed, excludeInvoiceId = null) {
  const [vendorRows] = await db.query('SELECT * FROM vendors WHERE vendor_id=? OR LOWER(name)=LOWER(?) LIMIT 1', [parsed.vendor, parsed.vendor]);
  const vendor = vendorRows[0] || null;
  parsed.vendorId = vendor?.vendor_id || null;
  const loadPO = async poId => {
    const [rows] = await db.query(`SELECT p.*,v.name vendorName FROM purchase_orders p JOIN vendors v ON v.vendor_id=p.vendor_id WHERE p.po_id=? LIMIT 1`, [poId]);
    if (!rows.length) return null;
    const [items] = await db.query('SELECT * FROM po_items WHERE po_id=? ORDER BY po_item_id', [poId]);
    const excludedSql = excludeInvoiceId ? ' AND i.invoice_id<>?' : '';
    const values = [poId, rows[0].vendor_id];
    if (excludeInvoiceId) values.push(excludeInvoiceId);
    const [usageRows] = await db.query(`SELECT ii.sku,ii.description,COALESCE(SUM(ii.quantity),0) invoicedQuantity
      FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.invoice_id
      WHERE i.po_id=? AND i.vendor_id=? AND i.status IN ('ACCEPTED','NEEDS REVIEW')${excludedSql}
      GROUP BY ii.sku,ii.description`, values);
    const priorQuantity = item => usageRows.reduce((sum, usage) => {
      const skuMatch = item.sku && usage.sku && String(item.sku).trim().toLowerCase() === String(usage.sku).trim().toLowerCase();
      const descriptionMatch = String(item.description||'').trim().replace(/\s+/g,' ').toLowerCase() === String(usage.description||'').trim().replace(/\s+/g,' ').toLowerCase();
      return sum + (skuMatch || (!item.sku || !usage.sku) && descriptionMatch ? Number(usage.invoicedQuantity||0) : 0);
    },0);
    const remainingItems = items.map(item => ({ ...item, remainingQuantity:Math.max(0,Number(item.quantity||0)-priorQuantity(item)) }));
    const orderedQuantity = items.reduce((sum,item)=>sum+Number(item.quantity||0),0);
    const invoicedQuantity = usageRows.reduce((sum,item)=>sum+Number(item.invoicedQuantity||0),0);
    return { ...rows[0], items, remainingItems, orderedQuantity, invoicedQuantity, remainingQuantity:Math.max(0,orderedQuantity-invoicedQuantity) };
  };

  let po = parsed.poNumber ? await loadPO(parsed.poNumber) : null;
  let matchMethod = po ? 'REFERENCE' : null;
  if (!parsed.poNumber && vendor) {
    const [candidates] = await db.query(`SELECT po_id FROM purchase_orders
      WHERE vendor_id=? AND status='APPROVED' AND currency=? ORDER BY po_date DESC,po_id`, [vendor.vendor_id, parsed.currency || 'INR']);
    const matchingCandidates = [];
    for (const candidate of candidates) {
      const option = await loadPO(candidate.po_id);
      if (!option || option.remainingQuantity <= 0) continue;
      const candidateResult = verifyInvoice(parsed, option, false, { score:0 }, { nonPoPolicy:'review' });
      const requiredChecks = ['vendor_po_match','quantity_match','price_match','po_value_match'];
      if (parsed.lineItems?.length) requiredChecks.push('line_quantity_match');
      if (requiredChecks.every(name => candidateResult.checks.find(check => check.name === name)?.passed === true)) {
        matchingCandidates.push(option);
      }
    }
    if (matchingCandidates.length === 1) {
      po = matchingCandidates[0];
      parsed.poNumber = po.po_id;
      matchMethod = 'INFERRED';
    }
  }
  const duplicateSql = `SELECT invoice_id FROM invoices
    WHERE vendor_id=? AND LOWER(TRIM(invoice_number))=LOWER(TRIM(?)) AND status <> 'REJECTED'
    ${excludeInvoiceId ? 'AND invoice_id<>?' : ''} LIMIT 1`;
  const duplicateParams = [parsed.vendorId, parsed.invoiceNumber];
  if (excludeInvoiceId) duplicateParams.push(excludeInvoiceId);
  const [duplicateRows] = await db.query(duplicateSql, duplicateParams);
  const [history] = await db.query('SELECT vendor_id,total FROM invoices WHERE vendor_id IS NOT NULL ORDER BY created_at DESC LIMIT 200');
  const anomaly = anomalySignal({ ...parsed, vendorId:vendor?.vendor_id || null }, history);
  const nonPoPolicy = getNonPoInvoicePolicy();
  const result = verifyInvoice(parsed, po, duplicateRows.length > 0, anomaly, { nonPoPolicy });
  return { vendor, po, result, matchMethod, nonPoPolicy };
}

async function recordProcessingFailure({ req, db, rawText, originalName, mime, extractionMethod, savedFile, error }) {
  const id = invoiceId();
  const batchContext = getBatchContext(req);
  const message = String(error?.message || 'Document extraction failed').slice(0, 1000);
  const parsed = parseInvoiceText(rawText || '');
  const checks = [{ name:'document_processing', passed:false, message:`Document processing failed: ${message}` }];
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(`INSERT INTO invoices(invoice_id,invoice_number,currency,status,risk_score,duplicate_flag,is_demo,source_type,source_file,raw_text,extracted_json,created_by)
      VALUES (?,?,?,'PROCESSING FAILED',0,FALSE,FALSE,?,?,?,?,?)`, [
      id, parsed.invoiceNumber || `UNPROCESSED-${id}`, parsed.currency || 'INR', sourceType(originalName,mime),
      savedFile ? path.basename(savedFile) : null, rawText || null,
      JSON.stringify({ ...parsed, extractionMethod, processingFailure:message }), req.user.id
    ]);
    await conn.query('INSERT INTO verification_results(invoice_id,status,risk_score,decision_reason,checks_json) VALUES (?,?,?,?,?)', [
      id, 'PROCESSING FAILED', 0, message, JSON.stringify(checks)
    ]);
    if (batchContext) {
      await setBatchAttemptStage(conn,batchContext,{
        status:'PROCESSING FAILED',uploadProgress:100,ocrStatus:'FAILED',verificationStatus:'PROCESSING FAILED',invoiceId:id,error:message
      });
    }
    await addStatusHistory(conn, {
      invoiceId:id, actorId:req.user.id, eventType:'PROCESSING', newStatus:'PROCESSING FAILED',
      reason:`Document processing failed: ${message}`
    });
    await conn.query('INSERT INTO audit_logs(invoice_id,user_id,action,status,details,ip_address) VALUES (?,?,?,?,?,?)', [
      id, req.user.id, 'DOCUMENT_PROCESSING_FAILED', 'PROCESSING FAILED', message, req.ip
    ]);
    await conn.commit();
    return { id, parsed, checks };
  } catch (failure) {
    await conn.rollback();
    throw failure;
  } finally {
    conn.release();
  }
}

async function validatePurchaseOrderCsv(db, csvText) {
  let parsed;
  try { parsed = parsePurchaseOrderCsv(csvText); }
  catch(error) { return { orders:[], errors:[{ row:null, field:'csv', message:error.message }], rowCount:0, valid:false }; }
  const errors = [...parsed.errors];
  for (const order of parsed.orders) {
    const [existing] = await db.query('SELECT po_id FROM purchase_orders WHERE LOWER(po_id)=LOWER(?) LIMIT 1', [order.poId]);
    if (existing.length) errors.push({ row:null, field:'poId', message:`Purchase-order reference ${order.poId} already exists; existing records are not overwritten.` });

    let vendorRows = [];
    if (order.vendorId) {
      [vendorRows] = await db.query('SELECT vendor_id,name,email,status FROM vendors WHERE vendor_id=? LIMIT 1', [order.vendorId]);
    } else if (order.vendorEmail) {
      [vendorRows] = await db.query('SELECT vendor_id,name,email,status FROM vendors WHERE LOWER(email)=LOWER(?) LIMIT 2', [order.vendorEmail]);
    } else if (order.vendorName) {
      [vendorRows] = await db.query('SELECT vendor_id,name,email,status FROM vendors WHERE LOWER(name)=LOWER(?) LIMIT 2', [order.vendorName]);
    } else if (order.vendorReference) {
      [vendorRows] = await db.query(`SELECT vendor_id,name,email,status FROM vendors
        WHERE vendor_id=? OR LOWER(email)=LOWER(?) OR LOWER(name)=LOWER(?) LIMIT 2`, [order.vendorReference, order.vendorReference, order.vendorReference]);
    }
    if (vendorRows.length !== 1) {
      errors.push({ row:null, field:'vendor', message:`Vendor for PO ${order.poId} could not be matched uniquely.` });
      continue;
    }
    const vendor = vendorRows[0];
    if (vendor.status && vendor.status !== 'ACTIVE') errors.push({ row:null, field:'vendor', message:`Vendor ${vendor.name} is inactive.` });
    if (order.vendorName && order.vendorName.toLowerCase() !== String(vendor.name).toLowerCase()) {
      errors.push({ row:null, field:'vendor', message:`Vendor name does not match vendor ID for PO ${order.poId}.` });
    }
    if (order.vendorEmail && order.vendorEmail.toLowerCase() !== String(vendor.email || '').toLowerCase()) {
      errors.push({ row:null, field:'vendor', message:`Vendor email does not match the vendor master for PO ${order.poId}.` });
    }
    order.vendorId = vendor.vendor_id;
    order.vendorName = vendor.name;
    order.vendorEmail = vendor.email;
    delete order.vendorReference;
  }
  return { orders:parsed.orders, errors, rowCount:parsed.rowCount, valid:errors.length===0 };
}

async function importPurchaseOrders(csvText) {
  const validation = await validatePurchaseOrderCsv(pool(), csvText);
  if (validation.errors.length) return { validation, imported:0 };
  const conn = await pool().getConnection();
  try {
    await conn.beginTransaction();
    for (const order of validation.orders) {
      await conn.query(`INSERT INTO purchase_orders(po_id,vendor_id,po_date,status,currency,notes)
        VALUES (?,?,?,?,?,?)`, [order.poId, order.vendorId, order.poDate, order.status, order.currency, order.notes || null]);
      for (const item of order.items) {
        await conn.query(`INSERT INTO po_items(po_id,sku,description,quantity,unit_price) VALUES (?,?,?,?,?)`,
          [order.poId, item.sku, item.description, item.quantity, item.unitPrice]);
      }
    }
    await conn.commit();
    return { validation, imported:validation.orders.length };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}
function resolveTesseractExecutable() {
  const configured = process.env.TESSERACT_CMD?.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (configured) return configured;
  if (process.platform === 'win32') {
    const candidates = [
      'tesseract',
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tesseract-OCR', 'tesseract.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tesseract-OCR', 'tesseract.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Tesseract-OCR', 'tesseract.exe')
    ];
    for (const candidate of candidates) {
      try {
        const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        if ((result.status === 0 || result.error?.code === undefined) && !result.error) return candidate;
      } catch {
        // fall through to next candidate
      }
    }
    return null;
  }
  const result = spawnSync('tesseract', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0 && !result.error) return 'tesseract';
  return null;
}
function getOcrHealth() {
  const executable = resolveTesseractExecutable();
  if (!executable) {
    return {
      available: false,
      executable: process.env.TESSERACT_CMD || 'tesseract',
      source: process.env.TESSERACT_CMD ? 'TESSERACT_CMD' : 'PATH',
      message: 'Tesseract OCR is not installed or is not on PATH. Install Tesseract OCR and set TESSERACT_CMD if it is not on PATH.'
    };
  }
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status === 0 && !result.error) {
    return {
      available: true,
      executable,
      source: process.env.TESSERACT_CMD ? 'TESSERACT_CMD' : 'PATH',
      version: String(result.stdout || '').trim().split(/\r?\n/)[0] || 'unknown'
    };
  }
  return {
    available: false,
    executable,
    source: process.env.TESSERACT_CMD ? 'TESSERACT_CMD' : 'PATH',
    message: result.stderr || result.error?.message || 'Tesseract is installed but not executable in this environment.'
  };
}
function sourceType(originalName, mime) {
  const ext = path.extname(originalName || '').toLowerCase();
  if (mime === 'application/pdf' || ext === '.pdf') return 'PDF';
  if (mime?.startsWith('image/') || ['.png','.jpg','.jpeg','.webp','.tif','.tiff'].includes(ext)) return 'IMAGE';
  return 'TEXT';
}

function applyVendorScope(req, query, params) {
  if (req.user.role !== 'vendor') return { query, params };
  if (!req.user.vendorId) return { query: `${query} WHERE 1=0`, params };
  return {
    query: `${query} WHERE i.vendor_id=? OR i.created_by=?`,
    params: [...params, req.user.vendorId, req.user.id]
  };
}

app.get('/api/health', async (_req, res) => {
  const ocr = getOcrHealth();
  try {
    await pool().query('SELECT 1');
    const ownerEmail = (process.env.OWNER_EMAIL || 'shivanshcollege2@gmail.com').trim().toLowerCase();
    const [owners] = await pool().query(
      'SELECT user_id FROM users WHERE LOWER(email)=LOWER(?) AND is_active=1 LIMIT 1',
      [ownerEmail]
    );
    res.json({
      status: ocr.available ? 'ok' : 'degraded',
      service:'InvoiceEye API',
      backend:{ status:'ok', mode:getDatabaseMode() },
      database:{ status:'ok', mode:getDatabaseMode() },
      ocr,
      ownerConfigured: owners.length > 0
    });
  }
  catch (e) {
    console.error('InvoiceEye database health check failed', e);
    res.status(503).json({
      status:'degraded',
      service:'InvoiceEye API',
      backend:{ status:'ok' },
      database:{ status:'unavailable', mode:getDatabaseMode(), message:String(e.message || e) },
      ocr,
      message:'Database unavailable'
    });
  }
});

app.post('/api/auth/google', async (req,res,next) => {
  try {
    const { idToken, email, name } = req.body || {};
    if (!idToken) return res.status(400).json({ message:'Google identity token is required.' });
    const payload = await verifyGoogleIdentityToken(idToken);
    const actualEmail = String(payload.email || email || '').trim().toLowerCase();
    if (!actualEmail) return res.status(400).json({ message:'Google account email is required.' });
    const resolvedRole = await resolveIdentityRole(actualEmail, payload.name || name || actualEmail.split('@')[0]);
    const [rows] = await pool().query('SELECT * FROM users WHERE LOWER(email)=LOWER(?) LIMIT 1', [actualEmail]);
    let user = rows[0];
    if (!user) {
      const passwordHash = await bcrypt.hash(randomUUID(), 10);
      const [result] = await pool().query(
        'INSERT INTO users(name,email,password_hash,role,is_active) VALUES (?,?,?, ?,1)',
        [payload.name || name || actualEmail.split('@')[0], actualEmail, passwordHash, resolvedRole]
      );
      user = { user_id: result.insertId, name: payload.name || name || actualEmail.split('@')[0], email: actualEmail, role: resolvedRole };
    } else {
      await pool().query('UPDATE users SET role=?, is_active=1 WHERE user_id=?', [resolvedRole, user.user_id]);
      user = { ...user, role: resolvedRole };
    }

    const token = signToken(user);
    res.json({ token, user:{ id:user.user_id, name:user.name, email:user.email, role:user.role } });
  } catch (e) {
    next(e);
  }
});

app.post('/api/auth/login', async (req,res,next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ message:'Email and password are required' });
    const [rows] = await pool().query('SELECT * FROM users WHERE email=? AND is_active=1 LIMIT 1', [email]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ message:'Invalid credentials' });
    const role = getAdminAllowlist().has(String(user.email).trim().toLowerCase()) ? 'admin' : (user.role === 'vendor' ? 'vendor' : user.role || 'vendor');
    const token = signToken({ ...user, role });
    res.json({ token, user:{ id:user.user_id, name:user.name, email:user.email, role } });
  } catch (e) { next(e); }
});

app.get('/api/me', requireAuth, async (req,res) => res.json({ user:req.user }));

app.post('/api/invoice-batches', requireAuth, requireRoles('admin','vendor'), async (req,res,next)=>{
  try {
    const { batchId, items } = req.body || {};
    if (typeof batchId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(batchId) || !Array.isArray(items) || items.length < 1 || items.length > 15) {
      return res.status(400).json({ message:'A batch ID and between 1 and 15 invoice files are required.' });
    }
    const itemIds = new Set();
    for (const item of items) {
      if (!item || typeof item.itemId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(item.itemId) || itemIds.has(item.itemId) ||
        typeof item.originalName !== 'string' || !item.originalName.trim() || item.originalName.length > 255 ||
        !Number.isInteger(item.fileSize) || item.fileSize < 1 || item.fileSize > maxUploadBytes) {
        return res.status(400).json({ message:'Each batch item needs a unique ID, filename, and size no larger than 8 MB.' });
      }
      itemIds.add(item.itemId);
    }
    const [existing] = await pool().query('SELECT created_by,total_files FROM invoice_batches WHERE batch_id=?', [batchId]);
    if (existing.length) {
      if (Number(existing[0].created_by) !== Number(req.user.id)) return res.status(403).json({ message:'This batch belongs to another account.' });
      const [oldItems] = await pool().query('SELECT item_id,original_name,file_size FROM invoice_batch_items WHERE batch_id=? ORDER BY item_id', [batchId]);
      const newItems = [...items].sort((a,b)=>a.itemId.localeCompare(b.itemId));
      if (oldItems.length !== newItems.length || oldItems.some((old,index)=>old.item_id!==newItems[index].itemId || old.original_name!==newItems[index].originalName || Number(old.file_size)!==newItems[index].fileSize)) {
        return res.status(409).json({ message:'Batch ID was already used for a different file set.' });
      }
      return res.status(200).json({ batchId, existing:true });
    }
    const conn = await pool().getConnection();
    try {
      await conn.beginTransaction();
      await conn.query('INSERT INTO invoice_batches(batch_id,created_by,status,total_files) VALUES (?,? ,\'QUEUED\',?)', [batchId,req.user.id,items.length]);
      for (const item of items) {
        await conn.query('INSERT INTO invoice_batch_items(batch_id,item_id,original_name,file_size) VALUES (?,?,?,?)', [batchId,item.itemId,item.originalName.trim(),item.fileSize]);
        await conn.query('INSERT INTO invoice_batch_attempts(batch_id,item_id,attempt_number) VALUES (?,?,1)', [batchId,item.itemId]);
      }
      await conn.commit();
      res.status(201).json({ batchId, existing:false });
    } catch(error) { await conn.rollback(); throw error; }
    finally { conn.release(); }
  } catch(error) { next(error); }
});

app.get('/api/invoice-batches', requireAuth, async (req,res,next)=>{
  try {
    const [batches] = await pool().query(req.user.role==='admin'
      ? 'SELECT batch_id FROM invoice_batches ORDER BY created_at DESC LIMIT 100'
      : 'SELECT batch_id FROM invoice_batches WHERE created_by=? ORDER BY created_at DESC LIMIT 100',
      req.user.role==='admin'?[]:[req.user.id]);
    const result=[];
    for (const batch of batches) result.push(await loadInvoiceBatch(pool(),batch.batch_id,req.user));
    res.json(result);
  } catch(error) { next(error); }
});

app.get('/api/invoice-batches/:batchId', requireAuth, async (req,res,next)=>{
  try {
    const batch = await loadInvoiceBatch(pool(),req.params.batchId,req.user);
    if (!batch) return res.status(404).json({ message:'Invoice batch not found.' });
    if (batch.denied) return res.status(403).json({ message:'This batch is not available to your account.' });
    res.json(batch);
  } catch(error) { next(error); }
});

app.post('/api/invoice-batches/:batchId/items/:itemId/attempts/:attemptNumber/start', requireAuth, async (req,res,next)=>{
  try {
    const batch = await loadInvoiceBatch(pool(),req.params.batchId,req.user);
    if (!batch) return res.status(404).json({ message:'Invoice batch not found.' });
    if (batch.denied) return res.status(403).json({ message:'This batch is not available to your account.' });
    const [update] = await pool().query(`UPDATE invoice_batch_attempts SET status='UPLOADING',upload_progress=0,ocr_status='QUEUED',verification_status='QUEUED',error=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE batch_id=? AND item_id=? AND attempt_number=? AND status='QUEUED'`, [req.params.batchId,req.params.itemId,Number(req.params.attemptNumber)]);
    if (!update.affectedRows) return res.status(409).json({ message:'This file attempt has already started or completed.' });
    await pool().query("UPDATE invoice_batches SET status='PROCESSING',completed_at=NULL WHERE batch_id=?", [req.params.batchId]);
    res.json({ status:'UPLOADING' });
  } catch(error) { next(error); }
});

app.patch('/api/invoice-batches/:batchId/items/:itemId/attempts/:attemptNumber/progress', requireAuth, async (req,res,next)=>{
  try {
    const batch = await loadInvoiceBatch(pool(),req.params.batchId,req.user);
    if (!batch) return res.status(404).json({ message:'Invoice batch not found.' });
    if (batch.denied) return res.status(403).json({ message:'This batch is not available to your account.' });
    const progress = Number(req.body?.progress);
    if (!Number.isInteger(progress) || progress < 0 || progress > 100) return res.status(400).json({ message:'Upload progress must be 0–100.' });
    const [update] = await pool().query(`UPDATE invoice_batch_attempts SET upload_progress=?,updated_at=CURRENT_TIMESTAMP
      WHERE batch_id=? AND item_id=? AND attempt_number=? AND status='UPLOADING'`, [progress,req.params.batchId,req.params.itemId,Number(req.params.attemptNumber)]);
    if (!update.affectedRows) return res.status(409).json({ message:'File upload is no longer active.' });
    res.json({ progress });
  } catch(error) { next(error); }
});

app.post('/api/invoice-batches/:batchId/items/:itemId/retry', requireAuth, async (req,res,next)=>{
  const conn = await pool().getConnection();
  try {
    const batch = await loadInvoiceBatch(pool(),req.params.batchId,req.user);
    if (!batch) return res.status(404).json({ message:'Invoice batch not found.' });
    if (batch.denied) return res.status(403).json({ message:'This batch is not available to your account.' });
    const item = batch.items.find(entry=>entry.itemId===req.params.itemId);
    if (!item) return res.status(404).json({ message:'Batch file not found.' });
    if (!['FAILED','PROCESSING FAILED'].includes(item.status)) return res.status(409).json({ message:'Only failed files can be retried.' });
    const nextAttempt=Number(item.latestAttempt)+1;
    await conn.beginTransaction();
    await conn.query('INSERT INTO invoice_batch_attempts(batch_id,item_id,attempt_number) VALUES (?,?,?)',[req.params.batchId,req.params.itemId,nextAttempt]);
    await conn.query('UPDATE invoice_batch_items SET latest_attempt=? WHERE batch_id=? AND item_id=?',[nextAttempt,req.params.batchId,req.params.itemId]);
    await conn.query("UPDATE invoice_batches SET status='PROCESSING',completed_at=NULL WHERE batch_id=?",[req.params.batchId]);
    await conn.commit();
    res.status(201).json({ attemptNumber:nextAttempt });
  } catch(error) { await conn.rollback(); next(error); }
  finally { conn.release(); }
});

app.post('/api/invoice-batches/:batchId/items/:itemId/attempts/:attemptNumber/failure', requireAuth, async (req,res,next)=>{
  try {
    const batch = await loadInvoiceBatch(pool(),req.params.batchId,req.user);
    if (!batch) return res.status(404).json({ message:'Invoice batch not found.' });
    if (batch.denied) return res.status(403).json({ message:'This batch is not available to your account.' });
    const message=String(req.body?.message||'Document processing failed.').slice(0,1000);
    const [update]=await pool().query(`UPDATE invoice_batch_attempts SET status='FAILED',verification_status='FAILED',error=?,updated_at=CURRENT_TIMESTAMP
      WHERE batch_id=? AND item_id=? AND attempt_number=? AND status IN ('QUEUED','UPLOADING','OCR PROCESSING','VERIFYING')`,
      [message,req.params.batchId,req.params.itemId,Number(req.params.attemptNumber)]);
    if (!update.affectedRows) return res.status(409).json({ message:'This file attempt already has a final result.' });
    await refreshBatchStatus(pool(),req.params.batchId);
    res.json({ status:'FAILED' });
  } catch(error) { next(error); }
});

app.get('/api/summary', requireAuth, async (req,res,next) => {
  try {
    const db=pool();
    const isVendor=req.user.role==='vendor';
    const invoiceScope=isVendor?' WHERE (vendor_id=? OR created_by=?)':'';
    const invoiceParams=isVendor?[req.user.vendorId,req.user.id]:[];
    const [[counts]]=await db.query(`SELECT COUNT(*) total,
      COALESCE(SUM(status='ACCEPTED'),0) accepted,
      COALESCE(SUM(status='NEEDS REVIEW'),0) review,
      COALESCE(SUM(status='REJECTED'),0) rejected,
      COALESCE(SUM(status='PROCESSING FAILED'),0) processingFailed,
      COALESCE(SUM(status='PROCESSING'),0) processing,
      COALESCE(ROUND(AVG(risk_score)),0) avgRisk FROM invoices${invoiceScope}`,invoiceParams);
    const [valueByCurrency]=await db.query(`SELECT currency,COALESCE(SUM(total),0) value FROM invoices
      ${isVendor?'WHERE (vendor_id=? OR created_by=?)':'WHERE total IS NOT NULL'} GROUP BY currency ORDER BY currency`,isVendor?invoiceParams:[]);
    const [trend]=await db.query(`SELECT DATE_FORMAT(invoice_date,'%Y-%m') month,currency,
      COALESCE(SUM(total),0) value,COUNT(*) count FROM invoices
      ${isVendor?'WHERE invoice_date IS NOT NULL AND (vendor_id=? OR created_by=?)':'WHERE invoice_date IS NOT NULL'} GROUP BY month,currency ORDER BY month DESC LIMIT 80`,isVendor?invoiceParams:[]);
    const [[vendorCount]]=await db.query(isVendor
      ? 'SELECT COUNT(*) totalVendors FROM vendors WHERE vendor_id=?'
      : 'SELECT COUNT(*) totalVendors FROM vendors',isVendor?[req.user.vendorId||'']:[]);
    const batchScope=isVendor?'WHERE b.created_by=?':'';
    const [batchActivity]=await db.query(`SELECT b.batch_id batchId,b.status,b.total_files totalFiles,b.created_at createdAt,
      COUNT(bi.item_id) uploaded,
      COALESCE(SUM(CASE WHEN a.status IN ('ACCEPTED','NEEDS REVIEW','REJECTED') THEN 1 ELSE 0 END),0) processed,
      COALESCE(SUM(CASE WHEN a.status IN ('FAILED','PROCESSING FAILED') THEN 1 ELSE 0 END),0) failed
      FROM invoice_batches b JOIN invoice_batch_items bi ON bi.batch_id=b.batch_id
      JOIN invoice_batch_attempts a ON a.batch_id=bi.batch_id AND a.item_id=bi.item_id AND a.attempt_number=bi.latest_attempt
      ${batchScope} GROUP BY b.batch_id,b.status,b.total_files,b.created_at ORDER BY b.created_at DESC LIMIT 8`,isVendor?[req.user.id]:[]);
    const [[activeBatchCount]]=await db.query(`SELECT COUNT(*) activeFiles FROM invoice_batch_attempts a
      JOIN invoice_batches b ON b.batch_id=a.batch_id JOIN invoice_batch_items bi ON bi.batch_id=a.batch_id AND bi.item_id=a.item_id AND bi.latest_attempt=a.attempt_number
      WHERE a.status IN ('QUEUED','UPLOADING','OCR PROCESSING','VERIFYING')${isVendor?' AND b.created_by=?':''}`,isVendor?[req.user.id]:[]);
    const [recentDiscrepancies]=await db.query(`SELECT i.invoice_id id,i.invoice_number invoiceNumber,i.vendor_id vendorId,v.name vendorName,
      i.po_id poId,i.status,i.total,i.currency,i.created_at createdAt,vr.decision_reason reason
      FROM invoices i LEFT JOIN vendors v ON v.vendor_id=i.vendor_id
      LEFT JOIN verification_results vr ON vr.result_id=(SELECT MAX(result_id) FROM verification_results WHERE invoice_id=i.invoice_id)
      WHERE i.status IN ('NEEDS REVIEW','REJECTED')${isVendor?' AND (i.vendor_id=? OR i.created_by=?)':''}
      ORDER BY i.created_at DESC LIMIT 8`,isVendor?invoiceParams:[]);
    const [reviewerDecisions]=await db.query(`SELECT r.review_id id,r.invoice_id invoiceId,i.invoice_number invoiceNumber,i.vendor_id vendorId,
      v.name vendorName,r.action,r.comment,r.created_at createdAt,u.name reviewerName
      FROM review_actions r JOIN invoices i ON i.invoice_id=r.invoice_id LEFT JOIN vendors v ON v.vendor_id=i.vendor_id
      JOIN users u ON u.user_id=r.reviewer_id WHERE 1=1${isVendor?' AND (i.vendor_id=? OR i.created_by=?)':''}
      ORDER BY r.created_at DESC LIMIT 8`,isVendor?invoiceParams:[]);
    let pendingClarifications=0;
    let companyNotifications=[];
    if(isVendor){
      const [[pending]]=await db.query(`SELECT COUNT(DISTINCT h.invoice_id) pendingClarifications FROM invoice_status_history h
        JOIN invoices i ON i.invoice_id=h.invoice_id WHERE i.status='NEEDS REVIEW' AND h.vendor_message IS NOT NULL AND TRIM(h.vendor_message)<>''
        AND (i.vendor_id=? OR i.created_by=?)`,invoiceParams);
      pendingClarifications=Number(pending.pendingClarifications||0);
      const [notifications]=await db.query(`SELECT n.notification_id id,n.invoice_id invoiceId,i.invoice_number invoiceNumber,
        n.channel,n.decision,n.status,n.provider_status providerStatus,n.message_body message,n.created_at createdAt
        FROM notification_history n JOIN invoices i ON i.invoice_id=n.invoice_id
        WHERE (n.vendor_id=? OR i.created_by=?) ORDER BY n.created_at DESC LIMIT 10`,[req.user.vendorId||'',req.user.id]);
      companyNotifications=notifications;
    }
    res.json({
      ...counts,totalVendors:Number(vendorCount.totalVendors||0),currentlyProcessing:Number(counts.processing||0)+Number(activeBatchCount.activeFiles||0),
      pendingClarifications,valueByCurrency,trend:trend.reverse(),batchActivity,recentDiscrepancies,reviewerDecisions,companyNotifications
    });
  } catch(e) { next(e); }
});

app.get('/api/admin/vendor-insights',requireAuth,requireRoles('admin'),async(req,res,next)=>{
  try{
    const query=String(req.query.q||'').trim();
    if(query.length<2)return res.status(400).json({message:'Search for a product, SKU or vendor category using at least two characters.'});
    res.json(await buildVendorInsights(pool(),query));
  }catch(error){next(error);}
});

app.get('/api/invoices', requireAuth, async (req,res,next) => {
  try {
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const requestedLimit = Number(req.query.limit || 100);
    const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 100;
    const requestedPage = Number(req.query.page || 1);
    const page = Number.isInteger(requestedPage) ? Math.min(10000, Math.max(1, requestedPage)) : 1;
    const offset = (page - 1) * limit;
    const where = [];
    const params = [];
    if (req.user.role === 'vendor') {
      where.push('(i.vendor_id=? OR i.created_by=?)');
      params.push(req.user.vendorId, req.user.id);
    }
    if (status) { where.push('i.status=?'); params.push(status); }
    if (q) { where.push('(i.invoice_number LIKE ? OR v.name LIKE ? OR i.po_id LIKE ?)'); const x=`%${q}%`; params.push(x,x,x); }
    const sql = `SELECT i.invoice_id id, i.invoice_number invoiceNumber, i.invoice_date invoiceDate,
      i.po_id poId, i.vendor_id vendorId, v.name vendorName, i.total, i.subtotal, i.tax,
      i.currency, i.status, i.risk_score riskScore, i.duplicate_flag duplicate, i.is_demo isDemo, i.source_type sourceType,
      i.created_at createdAt
      FROM invoices i LEFT JOIN vendors v ON v.vendor_id=i.vendor_id
      ${where.length ? 'WHERE '+where.join(' AND ') : ''}
      ORDER BY i.created_at DESC LIMIT ${limit} OFFSET ${offset}`;
    const [rows] = await pool().query(sql, params);
    res.json(rows);
  } catch(e) { next(e); }
});

app.get('/api/invoices/:id', requireAuth, async (req,res,next) => {
  try {
    const db = pool();
    const [invRows] = await db.query(`SELECT i.invoice_id,i.invoice_number,i.vendor_id,i.po_id,i.invoice_date,
      i.currency,i.subtotal,i.tax,i.discount,i.total,i.status,i.risk_score,i.duplicate_flag,i.is_demo,i.source_type,
      (i.source_file IS NOT NULL) has_document,i.extracted_json,i.created_by,i.created_at,i.updated_at,
      v.name vendorName,v.email vendorEmail,v.tax_id vendorTaxId,
      p.po_date poDate,p.status poStatus,p.currency poCurrency
      FROM invoices i LEFT JOIN vendors v ON v.vendor_id=i.vendor_id LEFT JOIN purchase_orders p ON p.po_id=i.po_id
      WHERE i.invoice_id=?`, [req.params.id]);
    if (!invRows.length) return res.status(404).json({ message:'Invoice not found' });
    const invoice = invRows[0];
    if (req.user.role === 'vendor' && invoice.vendor_id !== req.user.vendorId && invoice.created_by !== req.user.id) {
      return res.status(403).json({ message:'This invoice is not available to your vendor account.' });
    }
    const [items] = await db.query('SELECT * FROM invoice_items WHERE invoice_id=? ORDER BY invoice_item_id', [req.params.id]);
    const [verifications] = await db.query('SELECT * FROM verification_results WHERE invoice_id=? ORDER BY created_at DESC LIMIT 1', [req.params.id]);
    const [history] = await db.query(`SELECT h.history_id id,h.event_type eventType,h.old_status oldStatus,h.new_status newStatus,
      h.reason,h.vendor_message vendorMessage,h.internal_note internalNote,h.created_at createdAt,u.name actorName
      FROM invoice_status_history h LEFT JOIN users u ON u.user_id=h.actor_id
      WHERE h.invoice_id=? ORDER BY h.history_id DESC`, [req.params.id]);
    const [reviews] = req.user.role === 'vendor' ? [[]] : await db.query(
      `SELECT r.*, u.name reviewerName FROM review_actions r JOIN users u ON u.user_id=r.reviewer_id WHERE r.invoice_id=? ORDER BY r.created_at DESC`,
      [req.params.id]
    );
    const visibleHistory = req.user.role === 'vendor'
      ? history.map(({ internalNote, ...entry }) => entry)
      : history;
    res.json({ invoice, items, verification:verifications[0] || null, reviews, history:visibleHistory });
  } catch(e) { next(e); }
});

app.get('/api/invoices/:id/report.pdf',requireAuth,async(req,res,next)=>{
  try{
    const [rows]=await pool().query(`SELECT i.invoice_id,i.invoice_number,i.vendor_id,i.created_by,i.po_id,i.invoice_date,i.currency,
      i.subtotal,i.tax,i.discount,i.total,i.status,i.risk_score,i.extracted_json,v.name vendorName
      FROM invoices i LEFT JOIN vendors v ON v.vendor_id=i.vendor_id WHERE i.invoice_id=?`,[req.params.id]);
    if(!rows.length)return res.status(404).json({message:'Invoice not found.'});
    const invoice=rows[0];
    if(req.user.role==='vendor'&&invoice.vendor_id!==req.user.vendorId&&invoice.created_by!==req.user.id){
      return res.status(403).json({message:'This invoice report is not available to your vendor account.'});
    }
    const [items]=await pool().query('SELECT sku,description,quantity,unit_price unitPrice,declared_line_total lineTotal FROM invoice_items WHERE invoice_id=? ORDER BY invoice_item_id',[req.params.id]);
    const [verificationRows]=await pool().query('SELECT decision_reason decisionReason,checks_json checksJson FROM verification_results WHERE invoice_id=? ORDER BY result_id DESC LIMIT 1',[req.params.id]);
    const [history]=await pool().query(`SELECT h.event_type eventType,h.old_status oldStatus,h.new_status newStatus,h.reason,h.vendor_message vendorMessage,
      ${req.user.role==='admin'?'h.internal_note':'NULL'} internalNote,h.created_at createdAt,u.name actorName
      FROM invoice_status_history h LEFT JOIN users u ON u.user_id=h.actor_id WHERE h.invoice_id=? ORDER BY h.history_id`,[req.params.id]);
    const [reviews]=req.user.role==='vendor'?[[]]:await pool().query(`SELECT r.action,r.comment,r.created_at createdAt,u.name reviewerName
      FROM review_actions r JOIN users u ON u.user_id=r.reviewer_id WHERE r.invoice_id=? ORDER BY r.created_at`,[req.params.id]);
    let extracted={};
    try{extracted=typeof invoice.extracted_json==='string'?JSON.parse(invoice.extracted_json||'{}'):invoice.extracted_json||{};}catch{}
    let checks=[];
    try{checks=Array.isArray(verificationRows[0]?.checksJson)?verificationRows[0].checksJson:JSON.parse(verificationRows[0]?.checksJson||'[]');}catch{}
    const fontCandidates=[process.env.REPORT_FONT_PATH,path.join(process.env.WINDIR||'C:\\Windows','Fonts','arial.ttf'),'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].filter(Boolean);
    let reportFont=null;
    for(const candidate of fontCandidates){try{await fs.access(candidate);reportFont=candidate;break;}catch{}}
    const doc=new PDFDocument({size:'A4',margin:48,info:{Title:`InvoiceEye Verification Report ${invoice.invoice_number}`,Author:'InvoiceEye'}});
    res.set({
      'Content-Type':'application/pdf',
      'Content-Disposition':`attachment; filename="${String(invoice.invoice_number||invoice.invoice_id).replace(/[^A-Za-z0-9._-]/g,'_')}-verification.pdf"`,
      'Cache-Control':'no-store'
    });
    doc.on('error',next);
    doc.pipe(res);
    if(reportFont)doc.font(reportFont);else doc.font('Helvetica');
    doc.fontSize(20).fillColor('#123047').text('InvoiceEye Verification Report');
    doc.moveDown(0.35).fontSize(10).fillColor('#475569').text(`Generated ${new Date().toISOString()} · Invoice ${invoice.invoice_number}`);
    const section=title=>{doc.moveDown(0.8).fontSize(13).fillColor('#0f766e').text(title);doc.moveDown(0.25).fontSize(9).fillColor('#172033');};
    const row=(label,value)=>doc.fontSize(9).fillColor('#334155').text(`${label}: `,{continued:true}).fillColor('#111827').text(String(value??'Not recorded'));
    section('Decision');
    row('Status',invoice.status);row('Risk score',`${invoice.risk_score}/99`);row('System reason',verificationRows[0]?.decisionReason||'No decision reason recorded');
    section('Extracted invoice values');
    row('Vendor',invoice.vendorName);row('Invoice number',invoice.invoice_number);row('Invoice date',invoice.invoice_date);row('Purchase order',invoice.po_id);row('Currency',invoice.currency);
    row('Subtotal',invoice.subtotal);row('Tax',invoice.tax);row('Discount',invoice.discount);row('Total',invoice.total);
    row('Tax ID',extracted.taxId);row('Quantity',extracted.quantity);row('Unit price',extracted.unitPrice);row('Source',extracted.extractionMethod);
    section('Invoice line items');
    if(items.length)items.forEach((item,index)=>doc.text(`${index+1}. ${item.sku?`${item.sku} · `:''}${item.description} · Qty ${item.quantity??'—'} · Unit ${item.unitPrice??'—'} ${invoice.currency} · Line total ${item.lineTotal??'—'} ${invoice.currency}`));
    else doc.text('No invoice line items were recorded.');
    section('Verification evidence and discrepancies');
    if(checks.length)checks.forEach(check=>doc.text(`${check.passed?'PASS':'ATTENTION'} · ${check.name}: ${check.message}`));
    else doc.text('No verification rules were recorded.');
    section('Status and review history');
    if(history.length)history.forEach(event=>{
      doc.text(`${event.createdAt} · ${event.eventType} · ${event.oldStatus?`${event.oldStatus} -> `:''}${event.newStatus} · ${event.actorName||'System'}`);
      if(event.reason)doc.text(`Reason: ${event.reason}`,{indent:12});
      if(event.vendorMessage)doc.text(`Vendor clarification: ${event.vendorMessage}`,{indent:12});
      if(event.internalNote&&req.user.role==='admin')doc.text(`Internal admin note: ${event.internalNote}`,{indent:12});
    });
    if(reviews.length)reviews.forEach(review=>doc.text(`${review.createdAt} · ${review.reviewerName} · ${review.action}${review.comment?` · ${review.comment}`:''}`));
    if(!history.length&&!reviews.length)doc.text('No human review activity is recorded.');
    doc.end();
  }catch(error){next(error);}
});

app.get('/api/invoices/:id/document', requireAuth, async (req,res,next) => {
  try {
    const [rows] = await pool().query('SELECT source_file,source_type,vendor_id,created_by FROM invoices WHERE invoice_id=?', [req.params.id]);
    if (!rows.length || !rows[0].source_file) return res.status(404).json({ message:'Invoice document not found' });
    if (req.user.role === 'vendor' && rows[0].vendor_id !== req.user.vendorId && rows[0].created_by !== req.user.id) {
      return res.status(403).json({ message:'This invoice document is not available to your vendor account.' });
    }
    const storedName = path.basename(rows[0].source_file);
    if (!storedName) return res.status(404).json({ message:'Invoice document not found' });
    const filePath = path.resolve(uploadDir, storedName);
    if (!filePath.startsWith(`${uploadDir}${path.sep}`)) return res.status(404).json({ message:'Invoice document not found' });
    await fs.access(filePath);
    return res.download(filePath, `${req.params.id}${path.extname(storedName)}`, error => {
      if (error && !res.headersSent) next(error);
    });
  } catch(e) {
    if (e.code === 'ENOENT') return res.status(404).json({ message:'Invoice document not found' });
    next(e);
  }
});

app.get('/api/vendors/:vendorId/notification-contacts',requireAuth,requireRoles('admin'),async(req,res,next)=>{
  try{
    const [rows]=await pool().query(`SELECT channel,recipient,is_verified isVerified,has_consent hasConsent,
      verification_method verificationMethod,consent_evidence consentEvidence,verified_at verifiedAt,consent_at consentAt,
      updated_by updatedBy,updated_at updatedAt FROM vendor_notification_contacts WHERE vendor_id=? ORDER BY channel`,[req.params.vendorId]);
    res.json(rows);
  }catch(error){next(error);}
});

app.put('/api/vendors/:vendorId/notification-contacts/:channel',requireAuth,requireRoles('admin'),async(req,res,next)=>{
  try{
    const channel=String(req.params.channel||'').toLowerCase();
    const {recipient,verified=false,consent=false,verificationMethod='',consentEvidence=''}=req.body||{};
    if(!['email','whatsapp','sms'].includes(channel))return res.status(400).json({message:'Unsupported vendor contact channel.'});
    const normalizedRecipient=String(recipient||'').trim();
    if(!isValidNotificationRecipient(channel,normalizedRecipient))return res.status(400).json({message:'Enter a valid email address or E.164 phone number.'});
    if(typeof verified!=='boolean'||typeof consent!=='boolean')return res.status(400).json({message:'Verification and consent must be explicit boolean values.'});
    if(verified&&(!String(verificationMethod).trim()||String(verificationMethod).length>120))return res.status(400).json({message:'Record how the contact was verified.'});
    if(consent&&(!String(consentEvidence).trim()||String(consentEvidence).length>1000))return res.status(400).json({message:'Record evidence of vendor messaging consent.'});
    const [vendors]=await pool().query('SELECT vendor_id,email FROM vendors WHERE vendor_id=? LIMIT 1',[req.params.vendorId]);
    if(!vendors.length)return res.status(404).json({message:'Vendor not found.'});
    if(channel==='email'&&String(vendors[0].email||'').trim().toLowerCase()!==normalizedRecipient.toLowerCase()){
      return res.status(400).json({message:'Email recipient must match the vendor master email.'});
    }
    const [existing]=await pool().query('SELECT vendor_id FROM vendor_notification_contacts WHERE vendor_id=? AND channel=?',[req.params.vendorId,channel]);
    const values=[normalizedRecipient,verified?1:0,consent?1:0,verified?String(verificationMethod).trim():null,
      consent?String(consentEvidence).trim():null,verified?new Date().toISOString():null,consent?new Date().toISOString():null,req.user.id];
    if(existing.length){
      await pool().query(`UPDATE vendor_notification_contacts SET recipient=?,is_verified=?,has_consent=?,verification_method=?,consent_evidence=?,
        verified_at=?,consent_at=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE vendor_id=? AND channel=?`,[...values,req.params.vendorId,channel]);
    }else{
      await pool().query(`INSERT INTO vendor_notification_contacts(recipient,is_verified,has_consent,verification_method,consent_evidence,
        verified_at,consent_at,updated_by,vendor_id,channel) VALUES (?,?,?,?,?,?,?,?,?,?)`,[...values,req.params.vendorId,channel]);
    }
    await audit(req,null,'VENDOR_NOTIFICATION_CONTACT_UPDATED','SUCCESS',JSON.stringify({vendorId:req.params.vendorId,channel,verified,consent,verificationMethod,consentEvidence:consent?String(consentEvidence).trim():null}));
    res.json({message:'Vendor notification contact saved.',vendorId:req.params.vendorId,channel,verified,consent});
  }catch(error){next(error);}
});

app.get('/api/invoices/:id/notifications/preview',requireAuth,requireRoles('admin'),async(req,res,next)=>{
  try{
    const preview=await prepareVendorNotification(pool(),req.params.id,String(req.query.channel||'').toLowerCase());
    if(!preview.found)return res.status(404).json({message:'Invoice or vendor not found.'});
    res.json(preview);
  }catch(error){next(error);}
});

app.post('/api/invoices/:id/notifications',requireAuth,requireRoles('admin'),async(req,res,next)=>{
  try{
    const {channel,recipient,confirmed}=req.body||{};
    if(confirmed!==true)return res.status(400).json({message:'Explicit confirmation is required before provider submission.'});
    const preview=await prepareVendorNotification(pool(),req.params.id,String(channel||'').toLowerCase());
    if(!preview.found)return res.status(404).json({message:'Invoice or vendor not found.'});
    if(recipient!==preview.recipient)return res.status(409).json({message:'Confirmed recipient no longer matches the verified vendor contact.',preview});
    if(!preview.canSend)return res.status(409).json({message:preview.message,preview});
    const result=await dispatchVendorNotification(req,preview,false);
    if(result.conflict)return res.status(409).json({message:'Duplicate or concurrent notification blocked.',notification:result.notification||null});
    res.status(201).json(result);
  }catch(error){next(error);}
});

app.get('/api/invoices/:id/notifications',requireAuth,requireRoles('admin'),async(req,res,next)=>{
  try{
    const [rows]=await pool().query(`SELECT notification_id notificationId,dedupe_key dedupeKey,attempt_number attemptNumber,
      invoice_id invoiceId,vendor_id vendorId,channel,recipient,decision,reason,message_subject subject,message_body body,
      initiated_by initiatedBy,provider,status,provider_status providerStatus,provider_message_id providerMessageId,
      provider_response providerResponse,error,created_at createdAt FROM notification_history
      WHERE invoice_id=? ORDER BY created_at DESC,attempt_number DESC`,[req.params.id]);
    res.json(rows);
  }catch(error){next(error);}
});

app.post('/api/notifications/:notificationId/retry',requireAuth,requireRoles('admin'),async(req,res,next)=>{
  try{
    const [rows]=await pool().query('SELECT * FROM notification_history WHERE notification_id=? LIMIT 1',[req.params.notificationId]);
    if(!rows.length)return res.status(404).json({message:'Notification history entry not found.'});
    const previous=rows[0];
    if(previous.status!=='FAILED')return res.status(409).json({message:'Only a confirmed provider failure can be retried. Unknown or accepted submissions are not resent.'});
    const preview=await prepareVendorNotification(pool(),previous.invoice_id,previous.channel);
    if(!preview.found)return res.status(404).json({message:'Invoice or vendor no longer exists.'});
    if(preview.status!=='RETRY AVAILABLE'||preview.dedupeKey!==previous.dedupe_key)return res.status(409).json({message:preview.message||'Decision or contact changed; create a fresh preview.',preview});
    const result=await dispatchVendorNotification(req,{...preview,previous:{...previous,attemptNumber:previous.attempt_number,status:previous.status}},true);
    if(result.conflict)return res.status(409).json({message:'Duplicate or concurrent retry blocked.'});
    res.status(201).json(result);
  }catch(error){next(error);}
});

app.patch('/api/invoices/:id/extraction', requireAuth, requireRoles('admin'), async (req,res,next) => {
  const conn = await pool().getConnection();
  try {
    const body = req.body || {};
    const { correctionReason, ...updates } = body;
    if (typeof correctionReason !== 'string' || !correctionReason.trim() || correctionReason.length > 1000) {
      return res.status(400).json({ message:'A correction reason of 1000 characters or fewer is required.' });
    }
    const supported = new Set(['invoiceNumber','invoiceDate','vendor','taxId','poNumber','currency','quantity','unitPrice','subtotal','tax','cgst','sgst','igst','discount','total','lineItems']);
    if (!Object.keys(updates).length || Object.keys(updates).some(key => !supported.has(key))) {
      return res.status(400).json({ message:'Provide one or more supported extracted fields to correct.' });
    }
    const [rows] = await pool().query('SELECT invoice_id,status,extracted_json,raw_text FROM invoices WHERE invoice_id=?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ message:'Invoice not found' });
    const savedExtraction = typeof rows[0].extracted_json === 'string'
      ? JSON.parse(rows[0].extracted_json || '{}')
      : rows[0].extracted_json || {};
    const parsed = { ...(savedExtraction.parsed || savedExtraction), ...updates };
    if (updates.lineItems?.length) {
      const quantities = updates.lineItems.map(item => Number(item.quantity)).filter(Number.isFinite);
      if (quantities.length === updates.lineItems.length) parsed.quantity = quantities.reduce((sum, quantity) => sum + quantity, 0);
      parsed.unitPrice = updates.lineItems.length === 1 ? updates.lineItems[0].unitPrice ?? null : null;
    }
    for (const field of ['invoiceNumber','invoiceDate','vendor','taxId','poNumber','currency']) {
      if (updates[field] !== undefined && (typeof updates[field] !== 'string' || updates[field].length > 180)) {
        return res.status(400).json({ message:`${field} must be a string of 180 characters or fewer.` });
      }
    }
    for (const field of ['quantity','unitPrice','subtotal','tax','cgst','sgst','igst','discount','total']) {
      if (updates[field] !== undefined && updates[field] !== null && (!Number.isFinite(Number(updates[field])) || Number(updates[field]) < 0)) {
        return res.status(400).json({ message:`${field} must be a non-negative number or null.` });
      }
    }
    if (updates.lineItems !== undefined && (!Array.isArray(updates.lineItems) || updates.lineItems.length > 100 || updates.lineItems.some(item =>
      !item || typeof item !== 'object' || (item.description != null && typeof item.description !== 'string') ||
      ['quantity','unitPrice','lineTotal'].some(field => item[field] != null && (!Number.isFinite(Number(item[field])) || Number(item[field]) < 0))
    ))) {
      return res.status(400).json({ message:'lineItems must contain up to 100 valid items with non-negative numeric amounts.' });
    }

    const { vendor, po, result } = await evaluateInvoice(pool(), parsed, req.params.id);
    const extractionMethod = savedExtraction.extractionMethod || 'CORRECTED';
    const pagesProcessed = savedExtraction.pagesProcessed || 1;
    const priorStatus = rows[0].status;
    await conn.beginTransaction();
    await conn.query(`UPDATE invoices SET invoice_number=?,vendor_id=?,po_id=?,invoice_date=?,currency=?,subtotal=?,tax=?,discount=?,total=?,status=?,risk_score=?,duplicate_flag=?,extracted_json=?,updated_at=CURRENT_TIMESTAMP
      WHERE invoice_id=?`, [
      parsed.invoiceNumber || `UNPARSED-${req.params.id}`, vendor?.vendor_id || null, po?.po_id || null,
      parsed.invoiceDate || null, parsed.currency || 'INR', parsed.subtotal ?? null, parsed.tax ?? null,
      parsed.discount ?? null, parsed.total ?? null, result.status, result.riskScore, result.duplicate,
      JSON.stringify({ ...parsed, extractionMethod, pagesProcessed }), req.params.id
    ]);
    await conn.query('DELETE FROM invoice_items WHERE invoice_id=?', [req.params.id]);
    for (const item of (parsed.lineItems?.length ? parsed.lineItems : [{ description:'Invoice line', quantity:parsed.quantity ?? null, unitPrice:parsed.unitPrice ?? null }])) {
      await conn.query('INSERT INTO invoice_items(invoice_id,sku,description,quantity,unit_price,declared_line_total) VALUES (?,?,?,?,?,?)', [
        req.params.id, item.sku || null, item.description || 'Invoice line', item.quantity ?? null,
        item.unitPrice ?? null, item.lineTotal ?? null
      ]);
    }
    await conn.query('INSERT INTO verification_results(invoice_id,status,risk_score,decision_reason,checks_json) VALUES (?,?,?,?,?)', [
      req.params.id, result.status, result.riskScore, result.reasons.join(' | '), JSON.stringify(result.checks)
    ]);
    await addStatusHistory(conn, {
      invoiceId:req.params.id, actorId:req.user.id, eventType:'HUMAN', oldStatus:priorStatus,
      newStatus:result.status, reason:result.reasons.join(' | '), internalNote:`Extraction correction: ${correctionReason.trim()}`
    });
    await conn.query('INSERT INTO audit_logs(invoice_id,user_id,action,status,details,ip_address) VALUES (?,?,?,?,?,?)', [
      req.params.id, req.user.id, 'EXTRACTION_CORRECTED', result.status, correctionReason.trim(), req.ip
    ]);
    await conn.commit();
    res.json({ message:'Extraction corrected and verification rules rerun.', id:req.params.id, parsed, vendor, po, result });
  } catch(e) {
    await conn.rollback();
    next(e);
  } finally {
    conn.release();
  }
});

app.post('/api/invoices/verify', requireAuth, upload.single('file'), async (req,res,next) => {
  const db = pool();
  let savedFile = null;
  let batchContext = null;
  try {
    batchContext = getBatchContext(req);
    if (batchContext) {
      await validateBatchAttempt(db,batchContext,req.user);
      if (!req.file) throw Object.assign(new Error('Batch verification requires an invoice document.'),{status:400});
    }
    let rawText = String(req.body?.text || '');
    let pagesProcessed = 1;
    let originalName = 'pasted-invoice.txt';
    let mime = 'text/plain';
    let extractionMethod = 'TEXT';
    if (req.file) {
      originalName = req.file.originalname;
      mime = req.file.mimetype;
      validateDocumentBuffer(originalName, req.file.buffer);
      extractionMethod = sourceType(originalName, mime);
      if (batchContext) await setBatchAttemptStage(db,batchContext,{status:'OCR PROCESSING',uploadProgress:100,ocrStatus:'PROCESSING'});
      await fs.mkdir(uploadDir, { recursive:true });
      const safeName = `${randomUUID()}${path.extname(originalName).toLowerCase()}`;
      savedFile = path.join(uploadDir, safeName);
      await fs.writeFile(savedFile, req.file.buffer);
      let extracted;
      try {
        extracted = await extractDocument(req.file.buffer, originalName, mime);
      } catch (error) {
        const failure = await recordProcessingFailure({ req, db, rawText, originalName, mime, extractionMethod, savedFile, error });
        savedFile = null;
        return res.status(422).json({ id:failure.id, status:'PROCESSING FAILED', parsed:failure.parsed, processingFailure:{ message:String(error.message || 'Document extraction failed') } });
      }
      rawText = extracted.text || '';
      extractionMethod = extracted.method;
      pagesProcessed = extracted.pages || 1;
    }
    if (!rawText.trim()) {
      const error = new Error('Could not extract readable invoice text. Try a clearer PDF/image or paste the text.');
      const failure = await recordProcessingFailure({ req, db, rawText, originalName, mime, extractionMethod, savedFile, error });
      savedFile = null;
      return res.status(422).json({ id:failure.id, status:'PROCESSING FAILED', parsed:failure.parsed, processingFailure:{ message:error.message } });
    }

    if (batchContext) await setBatchAttemptStage(db,batchContext,{status:'VERIFYING',uploadProgress:100,ocrStatus:'COMPLETE',verificationStatus:'PROCESSING'});

    const parsed = parseInvoiceText(rawText);
    const { vendor, po, result, matchMethod, nonPoPolicy } = await evaluateInvoice(db, parsed);
    const id = invoiceId();

    const conn = await db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(`INSERT INTO invoices(invoice_id,invoice_number,vendor_id,po_id,invoice_date,currency,subtotal,tax,discount,total,status,risk_score,duplicate_flag,is_demo,source_type,source_file,raw_text,extracted_json,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,FALSE,?,?,?,?,?)`, [
        id, parsed.invoiceNumber, vendor?.vendor_id || null, po?.po_id || null, parsed.invoiceDate || null, parsed.currency || 'INR',
        parsed.subtotal ?? null, parsed.tax ?? null, parsed.discount ?? null, parsed.total ?? null, result.status, result.riskScore, result.duplicate,
        sourceType(originalName,mime), savedFile ? path.basename(savedFile) : null, rawText,
        JSON.stringify({ ...parsed, extractionMethod, pagesProcessed }), req.user.id
      ]);
      for (const item of (parsed.lineItems?.length ? parsed.lineItems : [{ description:'Invoice line', quantity:parsed.quantity ?? null, unitPrice:parsed.unitPrice ?? null }])) {
        await conn.query('INSERT INTO invoice_items(invoice_id,sku,description,quantity,unit_price,declared_line_total) VALUES (?,?,?,?,?,?)', [
          id, item.sku || null, item.description || 'Invoice line',
          item.quantity ?? null, item.unitPrice ?? null, item.lineTotal ?? null
        ]);
      }
      await conn.query('INSERT INTO verification_results(invoice_id,status,risk_score,decision_reason,checks_json) VALUES (?,?,?,?,?)', [id,result.status,result.riskScore,result.reasons.join(' | '),JSON.stringify(result.checks)]);
      if (batchContext) await setBatchAttemptStage(conn,batchContext,{
        status:result.status,uploadProgress:100,ocrStatus:'COMPLETE',verificationStatus:result.status,invoiceId:id
      });
      await addStatusHistory(conn, {
        invoiceId:id, actorId:req.user.id, eventType:'AUTOMATIC', newStatus:result.status,
        reason:result.reasons.join(' | ')
      });
      await conn.query('INSERT INTO audit_logs(invoice_id,user_id,action,status,details,ip_address) VALUES (?,?,?,?,?,?)', [id,req.user.id,'INVOICE_VERIFIED',result.status,`Source=${extractionMethod}; ${result.reasons.join(' | ')}`,req.ip]);
      await conn.commit();
      savedFile = null;
    } catch(e) { await conn.rollback(); throw e; }
    finally { conn.release(); }

    res.status(201).json({ id, parsed, extractionMethod, pagesProcessed, vendor, po, matchMethod, nonPoPolicy, result });
  } catch(e) {
    if (savedFile) {
      try { await fs.unlink(savedFile); }
      catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') console.error('Failed to remove invoice upload after processing error', cleanupError);
      }
    }
    if (batchContext) {
      try {
        await setBatchAttemptStage(db,batchContext,{
          status:'FAILED',ocrStatus:'FAILED',verificationStatus:'FAILED',error:String(e.message||'Invoice processing failed').slice(0,1000)
        });
      } catch(batchError) { console.error('Failed to store invoice batch failure',batchError); }
    }
    next(e);
  }
});

app.get('/api/vendors', requireAuth, async (req,res,next)=>{
  try {
    if (req.user.role === 'vendor') {
      const [rows] = await pool().query('SELECT * FROM vendors WHERE vendor_id=? OR LOWER(email)=LOWER(?) ORDER BY name LIMIT 50', [req.user.vendorId, req.user.email]);
      return res.json(rows);
    }
    const [rows]=await pool().query('SELECT * FROM vendors ORDER BY name'); res.json(rows);
  } catch(e){next(e);}
});

app.post('/api/vendors', requireAuth, requireRoles('admin'), async (req,res,next)=>{
  try {
    const {vendorId,name,email,category,taxId} = req.body || {};
    if (!vendorId || !name) return res.status(400).json({message:'vendorId and name are required'});
    await pool().query('INSERT INTO vendors(vendor_id,name,email,category,tax_id) VALUES (?,?,?,?,?)',[vendorId,name,email||null,category||null,taxId||null]);
    await audit(req,null,'VENDOR_CREATED','SUCCESS',vendorId);
    res.status(201).json({message:'Vendor created'});
  } catch(e){next(e);}
});

app.post('/api/purchase-orders/import/preview', requireAuth, requireRoles('admin'), async (req,res,next)=>{
  try {
    const csvText = req.body?.csv;
    const preview = await validatePurchaseOrderCsv(pool(), csvText);
    res.json(preview);
  } catch(e) { next(e); }
});

app.post('/api/purchase-orders/import', requireAuth, requireRoles('admin'), async (req,res,next)=>{
  try {
    const { validation, imported } = await importPurchaseOrders(req.body?.csv);
    if (validation.errors.length) return res.status(422).json({ message:'Correct the invalid rows before importing.', ...validation });
    await audit(req,null,'PURCHASE_ORDERS_IMPORTED','SUCCESS',`${imported} purchase orders imported`);
    res.status(201).json({ message:'Purchase orders imported without replacing existing records.', imported, rowCount:validation.rowCount });
  } catch(e) { next(e); }
});

app.get('/api/purchase-orders', requireAuth, async (req,res,next)=>{
  try {
    const params=[];
    const filters=[];
    const q=String(req.query.q||'').trim().slice(0,120);
    const status=String(req.query.status||'').trim();
    const vendorId=String(req.query.vendorId||'').trim();
    if(req.user.role==='vendor'){
      filters.push('(p.vendor_id=? OR LOWER(v.email)=LOWER(?))');
      params.push(req.user.vendorId,req.user.email);
    }else if(vendorId){filters.push('p.vendor_id=?');params.push(vendorId);}
    if(status){filters.push('p.status=?');params.push(status);}
    if(q){filters.push('(p.po_id LIKE ? OR v.name LIKE ? OR p.notes LIKE ?)');const term=`%${q}%`;params.push(term,term,term);}
    const [rows]=await pool().query(`SELECT p.po_id id,p.vendor_id vendorId,v.name vendorName,p.po_date poDate,p.status,p.currency,p.notes
      FROM purchase_orders p JOIN vendors v ON v.vendor_id=p.vendor_id ${filters.length?'WHERE '+filters.join(' AND '):''}
      ORDER BY p.po_date DESC,p.po_id LIMIT 500`,params);
    for (const row of rows) {
      const [items]=await pool().query('SELECT sku,description,quantity,unit_price unitPrice FROM po_items WHERE po_id=? ORDER BY po_item_id',[row.id]);
      const [[usage]]=await pool().query(`SELECT COALESCE(SUM(ii.quantity),0) invoicedQuantity
        FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.invoice_id
        WHERE i.po_id=? AND i.vendor_id=? AND i.status IN ('ACCEPTED','NEEDS REVIEW')`,[row.id,row.vendorId]);
      row.items=items;
      row.orderedQuantity=items.reduce((sum,item)=>sum+Number(item.quantity||0),0);
      row.invoicedQuantity=Number(usage.invoicedQuantity||0);
      row.remainingQuantity=Math.max(0,row.orderedQuantity-row.invoicedQuantity);
    }
    res.json(rows);
  } catch(e){next(e);}
});

app.post('/api/purchase-orders', requireAuth, requireRoles('admin','finance'), async (req,res,next)=>{
  const conn = await pool().getConnection();
  try {
    const {poId,vendorId,poDate,status='APPROVED',currency='INR',notes='',items=[]}=req.body||{};
    const normalizedPoId=String(poId||'').trim();
    const normalizedCurrency=String(currency||'').trim().toUpperCase();
    const validDate=typeof poDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(poDate)&&Number.isFinite(new Date(`${poDate}T00:00:00Z`).getTime())&&new Date(`${poDate}T00:00:00Z`).toISOString().slice(0,10)===poDate;
    const validAmount=value=>Number.isFinite(Number(value))&&Number(value)<=999999999999.99&&Math.abs(Number(value)*100-Math.round(Number(value)*100))<1e-7;
    if(!normalizedPoId||normalizedPoId.length>40||!vendorId||!Array.isArray(items)||!items.length||items.length>100) return res.status(400).json({message:'PO number, vendor and 1 to 100 line items are required.'});
    if(!validDate) return res.status(400).json({message:'PO date must be a valid YYYY-MM-DD date.'});
    if(!['DRAFT','APPROVED','CLOSED','CANCELLED'].includes(status)) return res.status(400).json({message:'Invalid PO status.'});
    if(!/^[A-Z]{3}$/.test(normalizedCurrency)) return res.status(400).json({message:'Currency must be a three-letter code.'});
    if(typeof notes!=='string'||notes.length>500) return res.status(400).json({message:'PO notes must be 500 characters or fewer.'});
    if(items.some(item=>!item||typeof item.description!=='string'||!item.description.trim()||item.description.trim().length>255||
      (item.sku!=null&&String(item.sku).length>80)||!validAmount(item.quantity)||Number(item.quantity)<=0||!validAmount(item.unitPrice)||Number(item.unitPrice)<0)) {
      return res.status(400).json({message:'Each PO line needs a description, positive quantity, and non-negative unit price with at most two decimals.'});
    }
    const [existing]=await pool().query('SELECT po_id FROM purchase_orders WHERE LOWER(po_id)=LOWER(?) LIMIT 1',[normalizedPoId]);
    if(existing.length) return res.status(409).json({message:`Purchase-order reference ${normalizedPoId} already exists.`});
    const [vendors]=await pool().query('SELECT vendor_id,status FROM vendors WHERE vendor_id=? LIMIT 1',[vendorId]);
    if(!vendors.length||vendors[0].status!=='ACTIVE') return res.status(400).json({message:'Select an active vendor from the vendor master.'});
    await conn.beginTransaction();
    await conn.query('INSERT INTO purchase_orders(po_id,vendor_id,po_date,status,currency,notes) VALUES(?,?,?,?,?,?)',[normalizedPoId,vendorId,poDate,status,normalizedCurrency,notes||null]);
    for(const item of items){ await conn.query('INSERT INTO po_items(po_id,sku,description,quantity,unit_price) VALUES(?,?,?,?,?)',[normalizedPoId,item.sku||null,item.description.trim(),Number(item.quantity),Number(item.unitPrice)]); }
    await conn.commit();
    await audit(req,null,'PURCHASE_ORDER_CREATED','SUCCESS',poId);
    res.status(201).json({message:'Purchase order created',poId});
  } catch(e){await conn.rollback();next(e);} finally{conn.release();}
});

app.get('/api/audit-logs', requireAuth, async (req,res,next)=>{
  try {
    const vendorFilter = req.user.role === 'vendor'
      ? `WHERE a.action IN ('INVOICE_VERIFIED','DOCUMENT_PROCESSING_FAILED') AND a.invoice_id IN (SELECT invoice_id FROM invoices WHERE vendor_id=? OR created_by=?)`
      : '';
    const params = req.user.role === 'vendor' ? [req.user.vendorId, req.user.id] : [];
    const [rows]=await pool().query(`SELECT a.audit_id id,a.invoice_id invoiceId,a.action,a.status,a.details,a.created_at createdAt,
      u.name userName FROM audit_logs a LEFT JOIN users u ON u.user_id=a.user_id ${vendorFilter} ORDER BY a.created_at DESC LIMIT 300`, params);
    res.json(rows);
  } catch(e){next(e);}
});

app.get('/api/reports/invoices.csv', requireAuth, async (req,res,next)=>{
  try {
    const params = [];
    const filters = [];
    if (req.user.role === 'vendor') {
      filters.push('(i.vendor_id=? OR i.created_by=?)');
      params.push(req.user.vendorId, req.user.id);
    }
    const status = String(req.query.status || '').trim();
    const q = String(req.query.q || '').trim().slice(0, 120);
    if (status) { filters.push('i.status=?'); params.push(status); }
    if (q) {
      filters.push('(i.invoice_number LIKE ? OR v.name LIKE ? OR i.po_id LIKE ?)');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const [rows] = await pool().query(`SELECT i.invoice_number invoiceNumber,v.name vendorName,
      i.invoice_date invoiceDate,i.po_id poId,i.total,i.currency,i.status,i.risk_score riskScore,i.created_at createdAt
      FROM invoices i LEFT JOIN vendors v ON v.vendor_id=i.vendor_id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY i.created_at DESC LIMIT 5000`, params);
    const escapeCell = value => {
      let text = String(value ?? '');
      if (/^[\t\r =+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };
    const columns = ['Invoice', 'Vendor', 'Date', 'Purchase order', 'Amount', 'Currency', 'Status', 'Risk score', 'Submitted'];
    const lines = [columns, ...rows.map(row => [
      row.invoiceNumber, row.vendorName, row.invoiceDate, row.poId, row.total,
      row.currency, row.status, row.riskScore, row.createdAt
    ])].map(row => row.map(escapeCell).join(','));
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="invoiceeye-invoices.csv"',
      'Cache-Control': 'no-store'
    });
    res.send(`\uFEFF${lines.join('\r\n')}`);
  } catch(e) { next(e); }
});

app.post('/api/invoices/:id/review', requireAuth, requireRoles('reviewer','admin'), async (req,res,next)=>{
  const conn = await pool().getConnection();
  try {
    const {action,comment='',vendorMessage=''}=req.body||{};
    if(!['APPROVE','REJECT','REQUEST_REVIEW'].includes(action)) return res.status(400).json({message:'Invalid review action'});
    if (typeof comment !== 'string' || comment.length > 1000) return res.status(400).json({message:'Review comment must be 1000 characters or fewer'});
    if (typeof vendorMessage !== 'string' || vendorMessage.length > 1000) return res.status(400).json({message:'Vendor clarification must be 1000 characters or fewer'});
    if (action !== 'REQUEST_REVIEW' && !comment.trim()) return res.status(400).json({message:'Add a reason before approving or rejecting an invoice'});
    if (action === 'REQUEST_REVIEW' && !vendorMessage.trim()) return res.status(400).json({message:'State the correction or clarification requested from the vendor.'});
    const map={APPROVE:'ACCEPTED',REJECT:'REJECTED',REQUEST_REVIEW:'NEEDS REVIEW'};
    await conn.beginTransaction();
    const [invRows]=await conn.query('SELECT invoice_id,status FROM invoices WHERE invoice_id=? FOR UPDATE',[req.params.id]);
    if(!invRows.length){await conn.rollback(); return res.status(404).json({message:'Invoice not found'});}
    if (invRows[0].status !== 'NEEDS REVIEW') {
      await conn.rollback();
      return res.status(409).json({message:'Only invoices in NEEDS REVIEW can receive a reviewer decision.'});
    }
    const oldStatus = invRows[0].status;
    const newStatus = map[action];
    await conn.query('UPDATE invoices SET status=? WHERE invoice_id=?',[newStatus,req.params.id]);
    await conn.query('INSERT INTO review_actions(invoice_id,reviewer_id,action,comment) VALUES(?,?,?,?)',[req.params.id,req.user.id,action,comment]);
    await addStatusHistory(conn, {
      invoiceId:req.params.id, actorId:req.user.id, eventType:'HUMAN', oldStatus, newStatus,
      vendorMessage:action === 'REQUEST_REVIEW' ? vendorMessage.trim() : null,
      internalNote:comment.trim() || null
    });
    await conn.query('INSERT INTO audit_logs(invoice_id,user_id,action,status,details,ip_address) VALUES(?,?,?,?,?,?)',[req.params.id,req.user.id,'REVIEW_DECISION',newStatus,comment,req.ip]);
    await conn.commit();
    res.json({message:'Review decision recorded',status:newStatus,oldStatus,newStatus});
  } catch(e){await conn.rollback();next(e);} finally{conn.release();}
});

app.get('/api/users', requireAuth, requireRoles('admin'), async (_req,res,next)=>{
  try { const [rows]=await pool().query('SELECT user_id id,name,email,role,is_active active,created_at createdAt FROM users ORDER BY created_at DESC'); res.json(rows); }
  catch(e){next(e);}
});

app.use(express.static(path.join(projectRoot, 'dist')));
app.get('/{*splat}', async (req,res,next)=>{
  if(req.path === '/api' || req.path.startsWith('/api/')) return next();
  const distIndex = path.join(projectRoot, 'dist/index.html');
  try {
    await fs.access(distIndex);
    return res.sendFile(distIndex);
  } catch (error) {
    if (error.code !== 'ENOENT') return next(error);
    return res.status(503).type('text/plain').send(
      'InvoiceEye frontend is not built. Run `npm run build` from the InvoiceEye_Full folder, then restart the server.'
    );
  }
});
app.use(notFound);
app.use(errorHandler);

await fs.mkdir(uploadDir,{recursive:true});
await initMySQL();
app.listen(PORT,()=>console.log(`InvoiceEye running: http://127.0.0.1:${PORT}`));
