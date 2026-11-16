import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { SMTPServer } from 'smtp-server';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MAX_BATCH_CONCURRENCY, runWithConcurrency } from '../client/src/batchProcessing.js';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = path.join(projectRoot, 'test-invoices', 'pdfs');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'invoiceeye-integration-'));
const databasePath = path.join(temporaryRoot, 'test.sqlite');
const uploadPath = path.join(temporaryRoot, 'uploads');
const ownerEmail = 'integration-owner@example.test';
const ownerPassword = 'integration-test-password';
const inv1048Text = `Invoice Number: INV-1048
Invoice Date: 24-October-2026
PO Reference: PO-9921
Vendor: Northstar Supplies
Tax ID: GSTIN123456789
Line item:
Office Chairs
Quantity: 4
Unit Price: ₹1,850.00
Declared Line Total: ₹7,200.00
Subtotal: ₹7,200.00
CGST: ₹0.00
SGST: ₹0.00
Discount: ₹0.00
Grand Total: ₹7,200.00`;
const appEnv = {
  ...process.env,
  DB_MODE: 'sqlite',
  OWNER_EMAIL: ownerEmail,
  OWNER_PASSWORD: ownerPassword,
  OWNER_NAME: 'Integration Owner',
  NON_PO_INVOICE_POLICY: 'review',
  SQLITE_PATH: databasePath,
  UPLOAD_DIR: uploadPath
};

async function findPythonExecutable() {
  const candidates = [];
  if (process.env.PYTHON_BIN) candidates.push(process.env.PYTHON_BIN.trim().replace(/^(['"])(.*)\1$/, '$2'));
  candidates.push(process.platform === 'win32'
    ? path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
    : path.join(projectRoot, '.venv', 'bin', 'python'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installRoot = path.join(process.env.LOCALAPPDATA, 'Programs', 'Python');
    let installations = [];
    try {
      installations = await readdir(installRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    candidates.push(...installations.filter(entry => entry.isDirectory())
      .map(entry => path.join(installRoot, entry.name, 'python.exe')));
  }
  candidates.push(...(process.platform === 'win32' ? ['py', 'python'] : ['python3', 'python']));

  const failures = [];
  for (const candidate of new Set(candidates)) {
    try {
      await execFileAsync(candidate, ['--version'], { cwd: projectRoot, env: appEnv });
      return candidate;
    } catch (error) {
      if (error.code !== 'ENOENT' && !String(error.stderr || error.message).includes('No Python at ')) throw error;
      failures.push(`${candidate}: ${error.stderr?.trim() || 'not found'}`);
    }
  }
  throw new Error(`No working Python interpreter was found for integration tests (${failures.join('; ')}).`);
}

async function availablePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.listen(0, '127.0.0.1', resolve).once('error', reject));
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(child, baseUrl) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error('InvoiceEye server exited before its health check passed.');
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('InvoiceEye server did not become healthy within 15 seconds.');
}

async function postFile(baseUrl, token, filePath, mimeType) {
  const content = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([content], { type: mimeType }), path.basename(filePath));
  return fetch(`${baseUrl}/api/invoices/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
}

async function postText(baseUrl, token, text) {
  const form = new FormData();
  form.append('text', text);
  return fetch(`${baseUrl}/api/invoices/verify`, {
    method: 'POST',
    headers: { Authorization: ['Bearer', token].join(' ') },
    body: form
  });
}

async function submitBatch(baseUrl,token,filePaths){
  const batchId=randomUUID();
  const documents=filePaths.map(filePath=>({itemId:randomUUID(),filePath,originalName:path.basename(filePath),fileSize:0}));
  for(const document of documents)document.fileSize=(await readFile(document.filePath)).length;
  const createResponse=await fetch(`${baseUrl}/api/invoice-batches`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({batchId,items:documents.map(({itemId,originalName,fileSize})=>({itemId,originalName,fileSize}))})
  });
  assert.equal(createResponse.status,201);
  let active=0;
  let peak=0;
  const outcomes=await runWithConcurrency(documents,async document=>{
    active+=1;
    peak=Math.max(peak,active);
    try{
      const startResponse=await fetch(`${baseUrl}/api/invoice-batches/${batchId}/items/${document.itemId}/attempts/1/start`,{
        method:'POST',headers:{Authorization:`Bearer ${token}`}
      });
      assert.equal(startResponse.status,200);
      const form=new FormData();
      form.append('file',new Blob([await readFile(document.filePath)],{type:'application/pdf'}),document.originalName);
      form.append('batchId',batchId);
      form.append('batchItemId',document.itemId);
      form.append('batchAttempt','1');
      const response=await fetch(`${baseUrl}/api/invoices/verify`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form});
      const data=await response.json();
      assert.ok([201,422].includes(response.status),data.message||data.processingFailure?.message);
      return data;
    }catch(error){
      await fetch(`${baseUrl}/api/invoice-batches/${batchId}/items/${document.itemId}/attempts/1/failure`,{
        method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        body:JSON.stringify({message:error.message})
      }).catch(()=>{});
      return {error:error.message};
    }finally{active-=1;}
  },MAX_BATCH_CONCURRENCY);
  assert.ok(peak<=MAX_BATCH_CONCURRENCY);
  const detailsResponse=await fetch(`${baseUrl}/api/invoice-batches/${batchId}`,{headers:{Authorization:`Bearer ${token}`}});
  assert.equal(detailsResponse.status,200);
  const details=await detailsResponse.json();
  assert.equal(details.totalUploaded,filePaths.length);
  assert.equal(details.pending,0);
  const count=status=>details.items.filter(item=>item.status===status).length;
  assert.equal(details.processedSuccessfully,count('ACCEPTED')+count('NEEDS REVIEW')+count('REJECTED'));
  assert.equal(details.approved,count('ACCEPTED'));
  assert.equal(details.needsReview,count('NEEDS REVIEW'));
  assert.equal(details.rejected,count('REJECTED'));
  assert.equal(details.processingFailures,count('PROCESSING FAILED')+count('FAILED'));
  assert.equal(details.totalUploaded,details.processedSuccessfully+details.processingFailures);
  for(const item of details.items){
    if(['ACCEPTED','NEEDS REVIEW','REJECTED'].includes(item.status)){
      assert.equal(item.ocrStatus,'COMPLETE');
      assert.equal(item.verificationStatus,item.status);
    }
    if(item.status==='PROCESSING FAILED'){
      assert.equal(item.ocrStatus,'FAILED');
      assert.equal(item.verificationStatus,'PROCESSING FAILED');
    }
    if(item.invoiceId){
      const invoiceResponse=await fetch(`${baseUrl}/api/invoices/${item.invoiceId}`,{headers:{Authorization:`Bearer ${token}`}});
      assert.equal(invoiceResponse.status,200);
      const invoiceDetail=await invoiceResponse.json();
      assert.equal(invoiceDetail.invoice.status,item.status);
    }
  }
  return {batchId,details,outcomes,peak};
}

async function verifyImageOcrResponse(response, expectedMethod, label) {
  if (response.status === 422) {
    const failure = await response.json();
    assert.equal(failure.status, 'PROCESSING FAILED');
    assert.match(failure.processingFailure.message, /Tesseract OCR engine/);
    console.log(label + ': PROCESSING FAILED recorded; Tesseract executable is unavailable');
    return false;
  }
  assert.equal(response.status, 201, label + ' should upload successfully or return an explicit OCR availability error');
  const result = await response.json();
  assert.equal(result.extractionMethod, expectedMethod);
  assert.ok(result.parsed);
  console.log(label + ': PASS (Tesseract OCR executed and extracted the document)');
  return true;
}

const postInvoice = (baseUrl, token, fileName) => postFile(
  baseUrl, token, path.join(fixtureRoot, fileName), 'application/pdf'
);

let server;
let smtpServer;
const smtpMessages=[];
const smtpFailureRecipients=new Set();
try {
  const pythonPath = await findPythonExecutable();
  appEnv.PYTHON_BIN = `"${pythonPath}"`;
  smtpServer=new SMTPServer({
    authOptional:false,
    authMethods:['PLAIN','LOGIN'],
    disabledCommands:['STARTTLS'],
    onAuth(auth,_session,callback){
      if(auth.username==='invoiceeye-test'&&auth.password==='smtp-test-password')return callback(null,{user:auth.username});
      callback(new Error('Invalid integration SMTP credentials.'));
    },
    onRcptTo(address,_session,callback){
      if(smtpFailureRecipients.has(address.address.toLowerCase()))return callback(new Error('Test provider rejection.'));
      callback(null,address);
    },
    onData(stream,session,callback){
      const chunks=[];
      stream.on('data',chunk=>chunks.push(chunk));
      stream.on('end',()=>{smtpMessages.push({recipient:session.envelope.rcptTo[0].address,body:Buffer.concat(chunks).toString('utf8')});callback(null,'Queued by isolated integration sink');});
    }
  });
  await new Promise((resolve,reject)=>smtpServer.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  appEnv.SMTP_HOST='127.0.0.1';
  appEnv.SMTP_PORT=String(smtpServer.server.address().port);
  appEnv.SMTP_SECURE='false';
  appEnv.SMTP_USER='invoiceeye-test';
  appEnv.SMTP_PASS='smtp-test-password';
  appEnv.SMTP_FROM='InvoiceEye Integration <invoiceeye@example.test>';
  appEnv.WHATSAPP_ACCESS_TOKEN='';
  appEnv.WHATSAPP_PHONE_NUMBER_ID='';
  appEnv.WHATSAPP_TEMPLATE_NAME='';
  appEnv.WHATSAPP_LANGUAGE_CODE='en';
  appEnv.WHATSAPP_GRAPH_API_VERSION='';
  appEnv.TWILIO_ACCOUNT_SID='';
  appEnv.TWILIO_AUTH_TOKEN='';
  appEnv.TWILIO_FROM_NUMBER='';
  const port = await availablePort();
  appEnv.PORT = String(port);
  await execFileAsync(process.execPath, ['scripts/seed-demo.js'], { cwd: projectRoot, env: appEnv });
  server = spawn(process.execPath, ['server/server.js'], { cwd: projectRoot, env: appEnv, stdio: 'ignore' });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(server, baseUrl);

  const appPageResponse = await fetch(baseUrl);
  const appPage = await appPageResponse.text();
  if (appPageResponse.ok) {
    const scriptPath = appPage.match(/<script[^>]+src="([^"]+)"/)?.[1];
    assert.ok(scriptPath, 'Production page should reference its bundled JavaScript');
    const scriptResponse = await fetch(new URL(scriptPath, baseUrl));
    assert.equal(scriptResponse.status, 200);
    console.log('Production page and bundled JavaScript: PASS');
  } else {
    assert.equal(appPageResponse.status, 503);
    assert.match(appPage, /npm run build/);
    console.log('Missing production build is reported explicitly: PASS');
  }

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: ownerEmail, password: ownerPassword })
  });
  assert.equal(loginResponse.status, 200);
  const { token } = await loginResponse.json();
  assert.ok(token);

  const testDatabase = new DatabaseSync(databasePath);
  const vendorPassword = 'vendor-integration-password';
  const vendorPasswordHash = await bcrypt.hash(vendorPassword, 4);
  testDatabase.prepare('INSERT INTO users(name,email,password_hash,role,is_active) VALUES (?,?,?,?,1)')
    .run('Apex Vendor', 'billing@apex.example', vendorPasswordHash, 'vendor');
  testDatabase.prepare('INSERT INTO users(name,email,password_hash,role,is_active) VALUES (?,?,?,?,1)')
    .run('Nova Vendor', 'accounts@nova.example', vendorPasswordHash, 'vendor');
  testDatabase.close();

  const loginVendor = async email => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method:'POST', headers:{ 'Content-Type':'application/json' },
      body:JSON.stringify({ email, password:vendorPassword })
    });
    assert.equal(response.status, 200);
    return (await response.json()).token;
  };
  const apexToken = await loginVendor('billing@apex.example');
  const novaToken = await loginVendor('accounts@nova.example');

  const adminSummary=await fetch(`${baseUrl}/api/summary`,{headers:{Authorization:`Bearer ${token}`}}).then(response=>response.json());
  const adminInvoiceRows=await fetch(`${baseUrl}/api/invoices?limit=100`,{headers:{Authorization:`Bearer ${token}`}}).then(response=>response.json());
  const adminVendorRows=await fetch(`${baseUrl}/api/vendors`,{headers:{Authorization:`Bearer ${token}`}}).then(response=>response.json());
  assert.equal(Number(adminSummary.total),adminInvoiceRows.length);
  assert.equal(Number(adminSummary.accepted),adminInvoiceRows.filter(invoice=>invoice.status==='ACCEPTED').length);
  assert.equal(Number(adminSummary.review),adminInvoiceRows.filter(invoice=>invoice.status==='NEEDS REVIEW').length);
  assert.equal(Number(adminSummary.rejected),adminInvoiceRows.filter(invoice=>invoice.status==='REJECTED').length);
  assert.equal(Number(adminSummary.processingFailed),adminInvoiceRows.filter(invoice=>invoice.status==='PROCESSING FAILED').length);
  assert.equal(Number(adminSummary.totalVendors),adminVendorRows.length);
  assert.ok(adminSummary.recentDiscrepancies.every(invoice=>['NEEDS REVIEW','REJECTED'].includes(invoice.status)));

  const vendorDashboardInvoice=`Invoice Number: INV-VENDOR-DASH-001
Vendor: Apex Office Supplies
PO Number: PO-1001
Invoice Date: 2026-10-05
Line Items:
Description|Quantity|Unit Price|Line Total
Premium Ball Pens|1|500|500
Subtotal: 500
Tax: 0
Discount: 0
Total: 500
Currency: INR`;
  const vendorDashboardUpload=await postText(baseUrl,apexToken,vendorDashboardInvoice);
  assert.equal(vendorDashboardUpload.status,201);
  const vendorDashboard=await fetch(`${baseUrl}/api/summary`,{headers:{Authorization:`Bearer ${apexToken}`}}).then(response=>response.json());
  const vendorDashboardInvoices=await fetch(`${baseUrl}/api/invoices?limit=100`,{headers:{Authorization:`Bearer ${apexToken}`}}).then(response=>response.json());
  assert.equal(Number(vendorDashboard.total),vendorDashboardInvoices.length);
  assert.equal(Number(vendorDashboard.accepted),vendorDashboardInvoices.filter(invoice=>invoice.status==='ACCEPTED').length);
  assert.ok(vendorDashboardInvoices.every(invoice=>invoice.vendorId==='V001'));
  assert.equal(Number(vendorDashboard.totalVendors),1);
  assert.ok(Array.isArray(vendorDashboard.companyNotifications));
  console.log('Admin and Vendor dashboard counts, amounts, activity and data scopes are database-backed: PASS');

  const purchaseOrderCsv = `po_number,vendor_id,po_date,status,currency,sku,description,quantity,unit_price,notes
PO-CSV-501,V001,2026-10-01,APPROVED,INR,SKU-W,Blue Widget,10,25,imported fixture
PO-CSV-501,V001,2026-10-01,APPROVED,INR,SKU-G,Gadget,5,50,imported fixture`;
  const poPreviewResponse = await fetch(`${baseUrl}/api/purchase-orders/import/preview`, {
    method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ csv:purchaseOrderCsv })
  });
  assert.equal(poPreviewResponse.status,200);
  const poPreview=await poPreviewResponse.json();
  assert.equal(poPreview.valid,true);
  assert.equal(poPreview.orders.length,1);
  assert.equal(poPreview.orders[0].items.length,2);

  const invalidPurchaseOrderCsv=`${purchaseOrderCsv}\nPO-CSV-502,V001,2026-10-01,APPROVED,INR,SKU-X,Bad row,0,10,invalid`;
  const invalidPoPreviewResponse = await fetch(`${baseUrl}/api/purchase-orders/import/preview`, {
    method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ csv:invalidPurchaseOrderCsv })
  });
  const invalidPoPreview=await invalidPoPreviewResponse.json();
  assert.ok(invalidPoPreview.errors.some(error=>error.field==='quantity'));
  const invalidPoImportResponse=await fetch(`${baseUrl}/api/purchase-orders/import`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({csv:invalidPurchaseOrderCsv})
  });
  assert.equal(invalidPoImportResponse.status,422);
  const invalidPOSearch=await fetch(`${baseUrl}/api/purchase-orders?q=PO-CSV-502`,{headers:{Authorization:`Bearer ${token}`}});
  assert.equal((await invalidPOSearch.json()).length,0);
  const deniedPOImport=await fetch(`${baseUrl}/api/purchase-orders/import/preview`,{
    method:'POST',headers:{Authorization:`Bearer ${apexToken}`,'Content-Type':'application/json'},
    body:JSON.stringify({csv:purchaseOrderCsv})
  });
  assert.equal(deniedPOImport.status,403);

  const poImportResponse = await fetch(`${baseUrl}/api/purchase-orders/import`, {
    method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ csv:purchaseOrderCsv })
  });
  assert.equal(poImportResponse.status,201);
  assert.equal((await poImportResponse.json()).imported,1);
  const manualPOResponse=await fetch(`${baseUrl}/api/purchase-orders`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({poId:'PO-MANUAL-601',vendorId:'V003',poDate:'2026-10-04',status:'DRAFT',currency:'INR',notes:'Manual multi-line PO',items:[
      {sku:'M-1',description:'Service A',quantity:2,unitPrice:300},
      {sku:'M-2',description:'Service B',quantity:3,unitPrice:200}
    ]})
  });
  assert.equal(manualPOResponse.status,201);
  const duplicateManualPO=await fetch(`${baseUrl}/api/purchase-orders`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({poId:'PO-MANUAL-601',vendorId:'V003',poDate:'2026-10-04',status:'DRAFT',currency:'INR',items:[{description:'Duplicate',quantity:1,unitPrice:1}]})
  });
  assert.equal(duplicateManualPO.status,409);
  const duplicatePoPreviewResponse = await fetch(`${baseUrl}/api/purchase-orders/import/preview`, {
    method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ csv:purchaseOrderCsv })
  });
  assert.ok((await duplicatePoPreviewResponse.json()).errors.some(error=>/already exists/.test(error.message)));
  const duplicatePoImportResponse = await fetch(`${baseUrl}/api/purchase-orders/import`, {
    method:'POST', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ csv:purchaseOrderCsv })
  });
  assert.equal(duplicatePoImportResponse.status,422);

  const searchedPOResponse = await fetch(`${baseUrl}/api/purchase-orders?q=PO-CSV-501`, { headers:{ Authorization:`Bearer ${token}` } });
  const searchedPOs=await searchedPOResponse.json();
  assert.equal(searchedPOs.length,1);
  assert.equal(searchedPOs[0].remainingQuantity,15);
  const apexPOResponse=await fetch(`${baseUrl}/api/purchase-orders`,{headers:{Authorization:`Bearer ${apexToken}`}});
  const apexPOs=await apexPOResponse.json();
  assert.ok(apexPOs.some(po=>po.id==='PO-CSV-501'));
  assert.ok(apexPOs.every(po=>po.vendorId==='V001'));
  const novaPOResponse=await fetch(`${baseUrl}/api/purchase-orders`,{headers:{Authorization:`Bearer ${novaToken}`}});
  assert.equal((await novaPOResponse.json()).some(po=>po.id==='PO-CSV-501'),false);
  console.log('PO CSV preview/import, duplicate validation, search, and vendor scoping: PASS');

  const unauthenticated = await fetch(`${baseUrl}/api/invoices`);
  assert.equal(unauthenticated.status, 401);

  const cleanResponse = await postInvoice(baseUrl, token, '01_clean_accepted.pdf');
  const clean = await cleanResponse.json();
  assert.equal(cleanResponse.status, 201, clean.message);
  assert.equal(clean.result.status, 'NEEDS REVIEW');
  assert.equal(clean.extractionMethod, 'PDF_TEXT');
  assert.equal(clean.pagesProcessed, 1);
  assert.equal(clean.result.checks.find(check => check.name === 'discount_amount').passed, false);
  console.log('Text-based PDF upload and extraction: PASS; total correctly needs review because discount was not stated');

  const detailResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.invoice.has_document, 1);
  assert.equal(detail.invoice.tax, 9000);
  assert.equal(detail.invoice.discount, null);
  assert.equal(Object.hasOwn(detail.invoice, 'source_file'), false);
  assert.equal(Object.hasOwn(detail.invoice, 'raw_text'), false);

  const documentResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}/document`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(documentResponse.status, 200);
  assert.match(Buffer.from(await documentResponse.arrayBuffer()).toString('ascii', 0, 5), /%PDF-/);

  const deniedDocument = await fetch(`${baseUrl}/api/invoices/${clean.id}/document`);
  assert.equal(deniedDocument.status, 401);
  console.log('Private source-document download and metadata redaction: PASS');

  const clarificationResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}/review`, {
    method:'POST',
    headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ action:'REQUEST_REVIEW', comment:'INTERNAL: verify the source line item.', vendorMessage:'Please confirm the invoice discount and line total.' })
  });
  assert.equal(clarificationResponse.status, 200);
  const clarificationDetailResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}`, {
    headers:{ Authorization:`Bearer ${token}` }
  });
  const clarificationDetail = await clarificationDetailResponse.json();
  assert.equal(clarificationDetail.history[0].oldStatus, 'NEEDS REVIEW');
  assert.equal(clarificationDetail.history[0].newStatus, 'NEEDS REVIEW');
  assert.equal(clarificationDetail.history[0].internalNote, 'INTERNAL: verify the source line item.');

  const vendorInvoicesResponse = await fetch(`${baseUrl}/api/invoices`, { headers:{ Authorization:`Bearer ${apexToken}` } });
  assert.equal(vendorInvoicesResponse.status, 200);
  const vendorInvoices = await vendorInvoicesResponse.json();
  assert.ok(vendorInvoices.some(invoice => invoice.id === clean.id));
  assert.ok(vendorInvoices.every(invoice => invoice.vendorId === 'V001'));
  const vendorCaseResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}`, { headers:{ Authorization:`Bearer ${apexToken}` } });
  assert.equal(vendorCaseResponse.status, 200);
  const vendorCase = await vendorCaseResponse.json();
  assert.equal(vendorCase.history[0].vendorMessage, 'Please confirm the invoice discount and line total.');
  assert.equal(Object.hasOwn(vendorCase.history[0], 'internalNote'), false);
  assert.equal(JSON.stringify(vendorCase).includes('INTERNAL: verify the source line item.'), false);
  const crossVendorCaseResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}`, { headers:{ Authorization:`Bearer ${novaToken}` } });
  assert.equal(crossVendorCaseResponse.status, 403);
  const vendorDecisionResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}/review`, {
    method:'POST', headers:{ Authorization:`Bearer ${apexToken}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ action:'APPROVE', comment:'Not permitted' })
  });
  assert.equal(vendorDecisionResponse.status, 403);
  console.log('Vendor case ownership, clarification visibility, and internal-note isolation: PASS');

  const correctionResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}/extraction`, {
    method:'PATCH', headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify({ discount:0, correctionReason:'Confirmed zero discount from the source document.' })
  });
  assert.equal(correctionResponse.status, 200);
  const correction = await correctionResponse.json();
  assert.equal(correction.result.checks.find(check => check.name === 'discount_amount').passed, true);
  const correctedDetailResponse = await fetch(`${baseUrl}/api/invoices/${clean.id}`, { headers:{ Authorization:`Bearer ${token}` } });
  const correctedDetail = await correctedDetailResponse.json();
  assert.equal(correctedDetail.history[0].internalNote, 'Extraction correction: Confirmed zero discount from the source document.');
  assert.equal(correctedDetail.history[0].oldStatus, 'NEEDS REVIEW');
  console.log('Admin extraction correction and rule re-evaluation: PASS');

  const frozenInvoice = await fetch(`${baseUrl}/api/invoices/DEMO-INV-001/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'REQUEST_REVIEW', vendorMessage:'Please provide supporting details.' })
  });
  assert.equal(frozenInvoice.status, 409);

  const spoofed = new FormData();
  spoofed.append('file', new Blob(['not a PDF'], { type: 'application/pdf' }), 'spoof.pdf');
  const spoofedResponse = await fetch(`${baseUrl}/api/invoices/verify`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: spoofed
  });
  assert.equal(spoofedResponse.status, 415);
  console.log('Mismatched upload content rejection: PASS');

  const scanImage = path.join(projectRoot, 'test-invoices', 'render_check', 'page-1.png');
  const scanJpg = path.join(temporaryRoot, 'scanned-page.jpg');
  const scanPdf = path.join(temporaryRoot, 'scanned-page.pdf');
  const createScanVariants = `from PIL import Image
image=Image.open(r"${scanImage}").convert("RGB")
image.save(r"${scanJpg}", "JPEG")
image.save(r"${scanPdf}", "PDF")
image.close()`;
  await execFileAsync(pythonPath, ['-c', createScanVariants], { cwd: projectRoot, env: appEnv });

  const pngResponse = await postFile(baseUrl, token, scanImage, 'image/png');
  const pngOcrPassed = await verifyImageOcrResponse(pngResponse, 'IMAGE_OCR', 'PNG invoice image');
  const jpgResponse = await postFile(baseUrl, token, scanJpg, 'image/jpeg');
  const jpgOcrPassed = await verifyImageOcrResponse(jpgResponse, 'IMAGE_OCR', 'JPG invoice image');
  const scannedPdfResponse = await postFile(baseUrl, token, scanPdf, 'application/pdf');
  const pdfOcrPassed = await verifyImageOcrResponse(scannedPdfResponse, 'PDF_OCR', 'Scanned PDF');
  if (pngOcrPassed || jpgOcrPassed || pdfOcrPassed) {
    console.log('At least one scanned-image OCR route executed against the installed Tesseract executable.');
  } else {
    console.log('OCR runtime not available; each scan was reported as an explicit extraction failure, not a financial decision.');
  }

  const corruptedPdf = path.join(temporaryRoot, 'corrupted.pdf');
  await writeFile(corruptedPdf, Buffer.from('%PDF-1.7\nthis file is intentionally truncated'));
  const corruptedResponse = await postFile(baseUrl, token, corruptedPdf, 'application/pdf');
  assert.equal(corruptedResponse.status, 422);
  const processingFailure = await corruptedResponse.json();
  assert.equal(processingFailure.status, 'PROCESSING FAILED');
  assert.match(processingFailure.processingFailure.message, /PDF|extract|readable/i);
  const failureDetailResponse = await fetch(`${baseUrl}/api/invoices/${processingFailure.id}`, { headers:{ Authorization:`Bearer ${token}` } });
  assert.equal((await failureDetailResponse.json()).invoice.status, 'PROCESSING FAILED');
  console.log('Corrupted PDF stored as a technical Processing Failed case, not financial rejection: PASS');

  const oversizedPdf = path.join(temporaryRoot, 'over-page-limit.pdf');
  const makeOversizedPdf = `from pypdf import PdfWriter
writer=PdfWriter()
for _ in range(21):
    writer.add_blank_page(width=612,height=792)
writer.write(r"${oversizedPdf}")`;
  await execFileAsync(pythonPath, ['-c', makeOversizedPdf], { cwd: projectRoot, env: appEnv });
  const pageLimitResponse = await postFile(baseUrl, token, oversizedPdf, 'application/pdf');
  assert.equal(pageLimitResponse.status, 422);
  const pageLimitFailure = await pageLimitResponse.json();
  assert.equal(pageLimitFailure.status, 'PROCESSING FAILED');
  assert.match(pageLimitFailure.processingFailure.message, /maximum supported is 20/);
  console.log('PDF page-count limit: PASS');

  const wrongVendorPOText = `Invoice Number: INV-WRONG-VENDOR-PO
Vendor: Nova Components Ltd.
PO Number: PO-CSV-501
Invoice Date: 2026-10-02
Line Items:
Description|Quantity|Unit Price|Line Total
Blue Widget|10|25|250
Subtotal: 250
Tax: 0
Discount: 0
Total: 250
Currency: INR`;
  const wrongVendorPOResponse=await postText(baseUrl,token,wrongVendorPOText);
  assert.equal(wrongVendorPOResponse.status,201);
  const wrongVendorPO=await wrongVendorPOResponse.json();
  assert.equal(wrongVendorPO.result.status,'NEEDS REVIEW');
  assert.equal(wrongVendorPO.result.checks.find(check=>check.name==='vendor_po_match').passed,false);

  const nonPoText = `Invoice Number: INV-NON-PO-001
Vendor: Apex Office Supplies
Invoice Date: 2026-10-02
Line Items:
Description|Quantity|Unit Price|Line Total
Emergency Courier|1|100|100
Subtotal: 100
Tax: 0
Discount: 0
Total: 100
Currency: INR`;
  const nonPoResponse=await postText(baseUrl,token,nonPoText);
  assert.equal(nonPoResponse.status,201);
  const nonPo=await nonPoResponse.json();
  assert.equal(nonPo.po,null);
  assert.equal(nonPo.result.status,'NEEDS REVIEW');
  assert.match(nonPo.result.checks.find(check=>check.name==='po_match').message,/manual approval is required/);

  const validInvoiceText = `Invoice Number: INV-VALID-001
Vendor: Apex Office Supplies
PO Number: PO-CSV-501
Invoice Date: 2026-09-18
Line Items:
Description|Quantity|Unit Price|Line Total
Blue Widget|10|25|250
Subtotal: 250
Tax: 0
Discount: 0
Total: 250
Currency: INR`;
  const validInvoiceResponse = await postText(baseUrl, token, validInvoiceText);
  assert.equal(validInvoiceResponse.status, 201);
  const validInvoice = await validInvoiceResponse.json();
  assert.equal(validInvoice.result.status, 'ACCEPTED');
  assert.equal(validInvoice.matchMethod,'REFERENCE');
  assert.ok(validInvoice.result.checks.every(check => check.passed));
  console.log('Complete valid invoice with explicitly extracted zero discount: PASS');

  const contactResponse=await fetch(`${baseUrl}/api/vendors/V001/notification-contacts/email`,{
    method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({recipient:'billing@apex.example',verified:true,consent:true,verificationMethod:'Integration fixture verified',consentEvidence:'Integration fixture consent recorded'})
  });
  assert.equal(contactResponse.status,200);
  const consentWithdrawn=await fetch(`${baseUrl}/api/vendors/V001/notification-contacts/email`,{
    method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({recipient:'billing@apex.example',verified:true,consent:false,verificationMethod:'Integration fixture verified'})
  });
  assert.equal(consentWithdrawn.status,200);
  const blockedPreview=await fetch(`${baseUrl}/api/invoices/${validInvoice.id}/notifications/preview?channel=email`,{headers:{Authorization:`Bearer ${token}`}}).then(response=>response.json());
  assert.equal(blockedPreview.canSend,false);
  assert.equal(blockedPreview.status,'CONTACT NOT VERIFIED');
  const consentBlockedSend=await fetch(`${baseUrl}/api/invoices/${validInvoice.id}/notifications`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({channel:'email',recipient:'billing@apex.example',confirmed:true})
  });
  assert.equal(consentBlockedSend.status,409);
  const consentRestored=await fetch(`${baseUrl}/api/vendors/V001/notification-contacts/email`,{
    method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({recipient:'billing@apex.example',verified:true,consent:true,verificationMethod:'Integration fixture verified',consentEvidence:'Integration fixture consent recorded'})
  });
  assert.equal(consentRestored.status,200);
  const emailPreviewResponse=await fetch(`${baseUrl}/api/invoices/${validInvoice.id}/notifications/preview?channel=email`,{headers:{Authorization:`Bearer ${token}`}});
  const emailPreview=await emailPreviewResponse.json();
  assert.equal(emailPreview.canSend,true);
  assert.equal(emailPreview.recipient,'billing@apex.example');
  assert.match(emailPreview.rendered.body,/InvoiceEye/);
  const whatsappPreviewResponse=await fetch(`${baseUrl}/api/invoices/${validInvoice.id}/notifications/preview?channel=whatsapp`,{headers:{Authorization:`Bearer ${token}`}});
  const whatsappPreview=await whatsappPreviewResponse.json();
  assert.equal(whatsappPreview.status,'INTEGRATION NOT CONFIGURED');
  const emailSendBody={channel:'email',recipient:emailPreview.recipient,confirmed:true};
  const emailSend=await fetch(`${baseUrl}/api/invoices/${validInvoice.id}/notifications`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(emailSendBody)
  });
  assert.equal(emailSend.status,201);
  const emailSendResult=await emailSend.json();
  assert.equal(emailSendResult.status,'ACCEPTED');
  assert.equal(emailSendResult.provider,'SMTP');
  assert.ok(emailSendResult.providerMessageId);
  assert.equal(smtpMessages.length,1);
  assert.match(smtpMessages[0].body,/INV-VALID-001/);
  const duplicateEmailSend=await fetch(`${baseUrl}/api/invoices/${validInvoice.id}/notifications`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(emailSendBody)
  });
  assert.equal(duplicateEmailSend.status,409);
  console.log('Email preview, provider acceptance, configuration warning and duplicate-send protection: PASS');

  const inferredMatchText = `Invoice Number: INV-INFERRED-PO-001
Vendor: Apex Office Supplies
Invoice Date: 2026-10-03
Line Items:
Description|Quantity|Unit Price|Line Total
Gadget|2|50|100
Subtotal: 100
Tax: 0
Discount: 0
Total: 100
Currency: INR`;
  const inferredMatchResponse=await postText(baseUrl,token,inferredMatchText);
  assert.equal(inferredMatchResponse.status,201);
  const inferredMatch=await inferredMatchResponse.json();
  assert.equal(inferredMatch.parsed.poNumber,'PO-CSV-501');
  assert.equal(inferredMatch.matchMethod,'INFERRED');
  assert.equal(inferredMatch.result.status,'ACCEPTED');
  const remainingPOResponse=await fetch(`${baseUrl}/api/purchase-orders?q=PO-CSV-501`,{headers:{Authorization:`Bearer ${token}`}});
  const remainingPO=(await remainingPOResponse.json())[0];
  assert.equal(remainingPO.invoicedQuantity,12);
  assert.equal(remainingPO.remainingQuantity,3);
  const overRemainingText=`Invoice Number: INV-PO-OVER-REMAINING
Vendor: Apex Office Supplies
PO Number: PO-CSV-501
Invoice Date: 2026-10-04
Line Items:
Description|Quantity|Unit Price|Line Total
Gadget|4|50|200
Subtotal: 200
Tax: 0
Discount: 0
Total: 200
Currency: INR`;
  const overRemainingResponse=await postText(baseUrl,token,overRemainingText);
  const overRemaining=await overRemainingResponse.json();
  assert.equal(overRemainingResponse.status,201);
  assert.equal(overRemaining.result.status,'NEEDS REVIEW');
  assert.equal(overRemaining.result.checks.find(check=>check.name==='quantity_match').passed,false);
  assert.equal(overRemaining.result.checks.find(check=>check.name==='line_quantity_match').passed,false);
  const wrongPriceText=`Invoice Number: INV-PO-WRONG-PRICE
Vendor: Apex Office Supplies
PO Number: PO-CSV-501
Invoice Date: 2026-10-04
Line Items:
Description|Quantity|Unit Price|Line Total
Gadget|1|60|60
Subtotal: 60
Tax: 0
Discount: 0
Total: 60
Currency: INR`;
  const wrongPriceResponse=await postText(baseUrl,token,wrongPriceText);
  const wrongPriceResult=await wrongPriceResponse.json();
  assert.equal(wrongPriceResponse.status,201);
  assert.equal(wrongPriceResult.result.status,'NEEDS REVIEW');
  assert.equal(wrongPriceResult.result.checks.find(check=>check.name==='price_match').passed,false);
  smtpFailureRecipients.add('billing@apex.example');
  const failedNotificationResponse=await fetch(`${baseUrl}/api/invoices/${wrongPriceResult.id}/notifications`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({channel:'email',recipient:'billing@apex.example',confirmed:true})
  });
  assert.equal(failedNotificationResponse.status,201);
  const failedNotification=await failedNotificationResponse.json();
  assert.equal(failedNotification.status,'FAILED');
  smtpFailureRecipients.delete('billing@apex.example');
  const retriedNotificationResponse=await fetch(`${baseUrl}/api/notifications/${failedNotification.notificationId}/retry`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`}
  });
  assert.equal(retriedNotificationResponse.status,201);
  const retriedNotification=await retriedNotificationResponse.json();
  assert.equal(retriedNotification.status,'ACCEPTED');
  assert.equal(retriedNotification.attemptNumber,2);
  const duplicateRetry=await fetch(`${baseUrl}/api/notifications/${failedNotification.notificationId}/retry`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`}
  });
  assert.equal(duplicateRetry.status,409);
  const notificationHistoryResponse=await fetch(`${baseUrl}/api/invoices/${wrongPriceResult.id}/notifications`,{headers:{Authorization:`Bearer ${token}`}});
  const notificationHistory=await notificationHistoryResponse.json();
  assert.equal(notificationHistory.length,2);
  assert.ok(notificationHistory.some(item=>item.status==='FAILED'));
  assert.ok(notificationHistory.some(item=>item.status==='ACCEPTED'&&item.attemptNumber===2));
  const notificationAudits=await fetch(`${baseUrl}/api/audit-logs`,{headers:{Authorization:`Bearer ${token}`}}).then(response=>response.json());
  assert.ok(notificationAudits.filter(item=>item.action==='VENDOR_NOTIFICATION').length>=3);
  console.log('Provider failure persistence, retry attempt history, duplicate retry blocking and audit logging: PASS');
  console.log('Reference and inferred PO matching, partial quantities, and remaining-to-invoice tracking: PASS');

  const inv1048Response = await postText(baseUrl, token, inv1048Text);
  assert.equal(inv1048Response.status, 201);
  const inv1048Result = await inv1048Response.json();
  assert.equal(inv1048Result.parsed.quantity, 4);
  assert.equal(inv1048Result.parsed.unitPrice, 1850);
  assert.equal(inv1048Result.parsed.poNumber, 'PO-9921');
  assert.equal(inv1048Result.result.status, 'NEEDS REVIEW');
  assert.equal(inv1048Result.result.checks.find(check => check.name === 'quantity_price_calculation').passed, true);
  assert.match(inv1048Result.result.checks.find(check => check.name === 'declared_line_total').message, /₹7400\.00.*₹7200\.00.*₹200\.00/);
  assert.match(inv1048Result.result.checks.find(check => check.name === 'po_match').message, /PO-9921.*no matching purchase-order record exists/);
  assert.equal(inv1048Result.po, null);
  const inv1048DetailResponse = await fetch(`${baseUrl}/api/invoices/${inv1048Result.id}`, {
    headers: { Authorization: ['Bearer', token].join(' ') }
  });
  assert.equal(inv1048DetailResponse.status, 200);
  const inv1048Detail = await inv1048DetailResponse.json();
  assert.equal(inv1048Detail.invoice.tax, 0);
  assert.equal(inv1048Detail.invoice.discount, 0);
  assert.equal(inv1048Detail.items[0].quantity, 4);
  assert.equal(inv1048Detail.items[0].unit_price, 1850);
  assert.equal(inv1048Detail.items[0].declared_line_total, 7200);
  console.log('INV-1048 extraction and ₹200 line discrepancy regression: PASS');

  const quantityResponse = await postInvoice(baseUrl, token, '02_quantity_mismatch.pdf');
  assert.equal(quantityResponse.status, 201);
  const quantity = await quantityResponse.json();
  assert.equal(quantity.result.status, 'NEEDS REVIEW');
  const missingComment = await fetch(`${baseUrl}/api/invoices/${quantity.id}/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'APPROVE' })
  });
  assert.equal(missingComment.status, 400);
  const reviewed = await fetch(`${baseUrl}/api/invoices/${quantity.id}/review`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'APPROVE', comment: 'Integration test review rationale' })
  });
  assert.equal(reviewed.status, 200);
  const reviewResult = await reviewed.json();
  assert.equal(reviewResult.status, 'ACCEPTED');
  assert.equal(reviewResult.oldStatus, 'NEEDS REVIEW');
  assert.equal(reviewResult.newStatus, 'ACCEPTED');
  const reviewedDetailResponse = await fetch(`${baseUrl}/api/invoices/${quantity.id}`, { headers:{ Authorization:`Bearer ${token}` } });
  const reviewedDetail = await reviewedDetailResponse.json();
  assert.equal(reviewedDetail.history[0].actorName, 'Integration Owner');
  assert.equal(reviewedDetail.history[0].internalNote, 'Integration test review rationale');
  console.log('Discrepancy review, required rationale and state transition: PASS');

  const csvResponse = await fetch(`${baseUrl}/api/reports/invoices.csv`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  assert.equal(csvResponse.status, 200);
  const csv = await csvResponse.text();
  assert.match(csv, /"Invoice","Vendor","Date","Purchase order"/);
  assert.match(csv, /INV-TEST-001/);
  console.log('Authenticated CSV report export: PASS');

  const vendorCsvResponse = await fetch(`${baseUrl}/api/reports/invoices.csv`, {
    headers:{ Authorization:`Bearer ${apexToken}` }
  });
  assert.equal(vendorCsvResponse.status, 200);
  const vendorCsv = await vendorCsvResponse.text();
  assert.match(vendorCsv, /INV-TEST-001/);
  assert.doesNotMatch(vendorCsv, /INV-DEMO-002/);
  console.log('Vendor CSV export is restricted to vendor-owned invoices: PASS');

  const productInsightsResponse=await fetch(`${baseUrl}/api/admin/vendor-insights?q=Premium%20Ball%20Pens`,{headers:{Authorization:`Bearer ${token}`}});
  assert.equal(productInsightsResponse.status,200);
  const productInsights=await productInsightsResponse.json();
  const apexInsight=productInsights.vendors.find(vendor=>vendor.vendorId==='V001');
  assert.ok(apexInsight);
  assert.ok(apexInsight.approvedTransactionCount>=1);
  assert.ok(apexInsight.approvedInvoicePriceRanges.some(range=>range.min===500&&range.max===500));
  assert.ok(apexInsight.discrepancyRecord.rejected>=1);
  assert.ok(apexInsight.recommendationReasons.some(reason=>reason.includes('description matches')));
  assert.equal(apexInsight.deliveryPerformance.available,false);
  const categoryInsightsResponse=await fetch(`${baseUrl}/api/admin/vendor-insights?q=Office%20Supplies`,{headers:{Authorization:`Bearer ${token}`}});
  const categoryInsights=await categoryInsightsResponse.json();
  assert.ok(categoryInsights.vendors.some(vendor=>vendor.vendorId==='V001'&&vendor.recommendationReasons.some(reason=>reason.includes('category'))));
  const insufficientInsightsResponse=await fetch(`${baseUrl}/api/admin/vendor-insights?q=never-ordered-product`,{headers:{Authorization:`Bearer ${token}`}});
  assert.equal((await insufficientInsightsResponse.json()).message,'Insufficient historical evidence to generate a reliable vendor recommendation.');
  const deniedVendorInsights=await fetch(`${baseUrl}/api/admin/vendor-insights?q=Premium%20Ball%20Pens`,{headers:{Authorization:`Bearer ${apexToken}`}});
  assert.equal(deniedVendorInsights.status,403);
  console.log('Historical approved prices, category matches, discrepancies, insufficient evidence and Admin-only access: PASS');

  const corruptBatchPdf=path.join(temporaryRoot,'batch-corrupt.pdf');
  await writeFile(corruptBatchPdf,Buffer.from('%PDF-1.7\ntruncated batch document'));
  const cleanPdf=path.join(fixtureRoot,'01_clean_accepted.pdf');
  const quantityPdf=path.join(fixtureRoot,'02_quantity_mismatch.pdf');
  const pricePdf=path.join(fixtureRoot,'03_price_mismatch.pdf');
  const duplicatePdf=path.join(fixtureRoot,'04_duplicate_invoice.pdf');
  const oneFileBatch=await submitBatch(baseUrl,token,[cleanPdf]);
  assert.equal(oneFileBatch.details.totalUploaded,1);
  assert.equal((await fetch(`${baseUrl}/api/invoice-batches/${oneFileBatch.batchId}`,{headers:{Authorization:`Bearer ${novaToken}`} })).status,403);
  const duplicateStart=await fetch(`${baseUrl}/api/invoice-batches/${oneFileBatch.batchId}/items/${oneFileBatch.details.items[0].itemId}/attempts/1/start`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`}
  });
  assert.equal(duplicateStart.status,409);

  const fiveFileBatch=await submitBatch(baseUrl,token,[cleanPdf,quantityPdf,pricePdf,duplicatePdf,corruptBatchPdf]);
  assert.equal(fiveFileBatch.details.totalUploaded,5);
  assert.ok(fiveFileBatch.details.processedSuccessfully>0);
  assert.ok(fiveFileBatch.details.processingFailures>0);
  assert.ok(fiveFileBatch.details.items.some(item=>item.status==='PROCESSING FAILED'));
  const failedBatchItem=fiveFileBatch.details.items.find(item=>item.status==='PROCESSING FAILED');
  const retryResponse=await fetch(`${baseUrl}/api/invoice-batches/${fiveFileBatch.batchId}/items/${failedBatchItem.itemId}/retry`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`}
  });
  assert.equal(retryResponse.status,201);
  const {attemptNumber}=await retryResponse.json();
  assert.equal(attemptNumber,2);
  const retryStart=await fetch(`${baseUrl}/api/invoice-batches/${fiveFileBatch.batchId}/items/${failedBatchItem.itemId}/attempts/2/start`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`}
  });
  assert.equal(retryStart.status,200);
  const retryForm=new FormData();
  retryForm.append('file',new Blob([await readFile(corruptBatchPdf)],{type:'application/pdf'}),'batch-corrupt.pdf');
  retryForm.append('batchId',fiveFileBatch.batchId);
  retryForm.append('batchItemId',failedBatchItem.itemId);
  retryForm.append('batchAttempt','2');
  const retryUpload=await fetch(`${baseUrl}/api/invoices/verify`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:retryForm});
  assert.equal(retryUpload.status,422);
  const retriedBatchResponse=await fetch(`${baseUrl}/api/invoice-batches/${fiveFileBatch.batchId}`,{headers:{Authorization:`Bearer ${token}`}});
  const retriedBatch=await retriedBatchResponse.json();
  const retriedItem=retriedBatch.items.find(item=>item.itemId===failedBatchItem.itemId);
  assert.equal(retriedItem.attempts.length,2);
  assert.equal(retriedBatch.totalUploaded,5);
  assert.equal(retriedBatch.processingFailures,1);

  const fifteenFilePaths=Array.from({length:15},(_,index)=>[cleanPdf,quantityPdf,pricePdf,duplicatePdf,corruptBatchPdf][index%5]);
  const fifteenFileBatch=await submitBatch(baseUrl,token,fifteenFilePaths);
  assert.equal(fifteenFileBatch.details.totalUploaded,15);
  assert.equal(fifteenFileBatch.peak,MAX_BATCH_CONCURRENCY);
  assert.ok(fifteenFileBatch.details.processedSuccessfully>0);
  assert.ok(fifteenFileBatch.details.processingFailures>0);
  const tooLargeBatch=await fetch(`${baseUrl}/api/invoice-batches`,{
    method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({batchId:randomUUID(),items:Array.from({length:16},()=>({itemId:randomUUID(),originalName:'invoice.pdf',fileSize:1000}))})
  });
  assert.equal(tooLargeBatch.status,400);
  const batchHistoryResponse=await fetch(`${baseUrl}/api/invoice-batches`,{headers:{Authorization:`Bearer ${token}`}});
  const savedBatches=await batchHistoryResponse.json();
  assert.ok(savedBatches.some(batch=>batch.batch_id===oneFileBatch.batchId));
  assert.ok(savedBatches.some(batch=>batch.batch_id===fiveFileBatch.batchId));
  assert.ok(savedBatches.some(batch=>batch.batch_id===fifteenFileBatch.batchId));
  console.log('Persistent 1/5/15-file batches, independent failures, retries, duplicate protection, and stored totals: PASS');
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise(resolve => server.once('close', resolve));
  }
  if(smtpServer)await new Promise(resolve=>smtpServer.close(()=>resolve()));
  await rm(temporaryRoot, { recursive: true, force: true });
}
