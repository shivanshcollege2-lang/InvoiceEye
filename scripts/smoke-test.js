import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { getDatabaseMode, getPool, initMySQL, seedDemoData } from '../server/db/mysql.js';
import { requireAuth, signToken } from '../server/middleware/auth.js';
import { initSQLite } from '../server/db/sqlite.js';
import { validateDocumentBuffer } from '../server/services/fileValidation.js';
import { parseInvoiceText } from '../server/services/parser.js';
import { parsePurchaseOrderCsv } from '../server/services/purchaseOrderImport.js';
import { getProviderConfiguration, isValidNotificationRecipient, renderVendorNotification, sendVendorNotification } from '../server/services/vendorNotifications.js';
import { verifyInvoice } from '../server/services/verifier.js';
import { getAdminAllowlist, resolveIdentityRole } from '../server/middleware/auth.js';
import { MAX_BATCH_CONCURRENCY, runWithConcurrency } from '../client/src/batchProcessing.js';
import { buildVendorInsights } from '../server/services/vendorInsights.js';

const originalMode = process.env.DB_MODE;
delete process.env.DB_MODE;
assert.equal(getDatabaseMode(), 'sqlite');
process.env.DB_MODE = 'mysql';
assert.equal(getDatabaseMode(), 'mysql');
process.env.DB_MODE = 'invalid';
assert.throws(() => getDatabaseMode(), /DB_MODE must be either/);
if (originalMode === undefined) delete process.env.DB_MODE;
else process.env.DB_MODE = originalMode;

const clean = `Invoice Number: INV-TEST-001\nVendor: Apex Office Supplies\nPO Number: PO-1001\nInvoice Date: 2026-09-15\nLine Items:\nDescription|Quantity|Unit Price|Line Total\nPremium Ball Pens|100|500|50000\nSubtotal: 50000\nTax: 9000\nDiscount: 0\nTotal: 59000`;
const mockInsightRows={
  invoices:[
    {invoiceId:'A1',invoiceNumber:'INV-A1',invoiceDate:'2026-09-01',createdAt:'2026-09-01',status:'ACCEPTED',invoiceCurrency:'INR',vendorId:'V1',vendorName:'North Supply',category:'Office Supplies',sku:'PEN-1',description:'Blue Pens',quantity:10,unitPrice:12,total:120,poId:'PO-A1',decisionReason:'All configured checks passed.'},
    {invoiceId:'A2',invoiceNumber:'INV-A2',invoiceDate:'2026-10-01',createdAt:'2026-10-01',status:'ACCEPTED',invoiceCurrency:'INR',vendorId:'V1',vendorName:'North Supply',category:'Office Supplies',sku:'PEN-1',description:'Blue Pens',quantity:5,unitPrice:14,total:70,poId:'PO-A2',decisionReason:'All configured checks passed.'},
    {invoiceId:'A3',invoiceNumber:'INV-A3',invoiceDate:'2026-10-10',createdAt:'2026-10-10',status:'NEEDS REVIEW',invoiceCurrency:'INR',vendorId:'V1',vendorName:'North Supply',category:'Office Supplies',sku:'PEN-1',description:'Blue Pens',quantity:5,unitPrice:15,total:75,poId:'PO-A3',decisionReason:'Quantity mismatch recorded.'}
  ],
  purchaseOrders:[{poId:'PO-A3',poDate:'2026-10-02',poStatus:'APPROVED',poCurrency:'INR',vendorId:'V1',vendorName:'North Supply',category:'Office Supplies',sku:'PEN-1',description:'Blue Pens',quantity:5,unitPrice:13}]
};
const mockInsightsDb={async query(sql){return [sql.includes('FROM invoices i')?mockInsightRows.invoices:mockInsightRows.purchaseOrders];}};
const insightResults=await buildVendorInsights(mockInsightsDb,'PEN-1');
assert.equal(insightResults.vendors[0].approvedTransactionCount,2);
assert.deepEqual(insightResults.vendors[0].approvedInvoicePriceRanges,[{currency:'INR',min:12,max:14,samples:2}]);
assert.equal(insightResults.vendors[0].discrepancyRecord.needsReview,1);
assert.ok(insightResults.vendors[0].recommendationReasons.some(reason=>reason.includes('Exact SKU match')));
assert.equal(insightResults.vendors[0].deliveryPerformance.available,false);
const insufficientInsight=await buildVendorInsights({async query(){return [[]];}},'unmatched-product');
assert.equal(insufficientInsight.message,'Insufficient historical evidence to generate a reliable vendor recommendation.');
for (const channel of ['email','whatsapp','sms']) assert.equal(getProviderConfiguration(channel,{}).configured,false);
assert.equal(isValidNotificationRecipient('email','billing@example.test'),true);
assert.equal(isValidNotificationRecipient('whatsapp','not-a-number'),false);
const previewMessage=renderVendorNotification({channel:'email',vendor:{name:'Apex'},invoice:{invoice_id:'INV-NOTIFY-1',invoice_number:'INV-NOTIFY-1',status:'NEEDS REVIEW'},reason:'Exact missing PO clarification'});
assert.match(previewMessage.body,/Exact missing PO clarification/);
const whatsappPreview=renderVendorNotification({channel:'whatsapp',vendor:{name:'Apex'},invoice:{invoice_number:'INV-NOTIFY-1',status:'REJECTED'},reason:'Duplicate invoice',env:{WHATSAPP_TEMPLATE_NAME:'invoice_status'}});
assert.match(whatsappPreview.preview,/invoice_status.*INV-NOTIFY-1.*REJECTED.*Duplicate invoice/s);
const providerInvoice={invoice_number:'INV-NOTIFY-1',status:'NEEDS REVIEW'};
const providerVendor={name:'Apex'};
const providerMessage=renderVendorNotification({channel:'email',vendor:providerVendor,invoice:providerInvoice,reason:'Exact review reason'});
const smtpResult=await sendVendorNotification({
  channel:'email',recipient:'billing@example.test',rendered:providerMessage,
  env:{SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',SMTP_USER:'test',SMTP_PASS:'test',SMTP_FROM:'invoices@example.test'},
  transportFactory:()=>({sendMail:async message=>({messageId:'smtp-test-id',accepted:[message.to],response:'250 queued'}),close(){}})
});
assert.equal(smtpResult.providerStatus,'accepted_by_smtp');
assert.equal(smtpResult.providerMessageId,'smtp-test-id');
let whatsappUrl='';
const whatsappResult=await sendVendorNotification({
  channel:'whatsapp',recipient:'+14155550123',rendered:renderVendorNotification({channel:'whatsapp',vendor:providerVendor,invoice:providerInvoice,reason:'Exact review reason'}),
  env:{WHATSAPP_ACCESS_TOKEN:'test-token',WHATSAPP_PHONE_NUMBER_ID:'123456',WHATSAPP_TEMPLATE_NAME:'invoice_status',WHATSAPP_LANGUAGE_CODE:'en',WHATSAPP_GRAPH_API_VERSION:'v22.0'},
  fetchImpl:async(url)=>{whatsappUrl=String(url);return {ok:true,json:async()=>({messages:[{id:'wamid.test',message_status:'accepted'}]})};}
});
assert.match(whatsappUrl,/^https:\/\/graph\.facebook\.com\/v22\.0\/123456\/messages$/);
assert.equal(whatsappResult.providerMessageId,'wamid.test');
let twilioUrl='';
const smsResult=await sendVendorNotification({
  channel:'sms',recipient:'+14155550123',rendered:renderVendorNotification({channel:'sms',vendor:providerVendor,invoice:providerInvoice,reason:'Exact review reason'}),
  env:{TWILIO_ACCOUNT_SID:'AC123',TWILIO_AUTH_TOKEN:'test-token',TWILIO_FROM_NUMBER:'+14155550999'},
  fetchImpl:async(url)=>{twilioUrl=String(url);return {ok:true,json:async()=>({sid:'SM-test',status:'queued'})};}
});
assert.match(twilioUrl,/^https:\/\/api\.twilio\.com\/2010-04-01\/Accounts\/AC123\/Messages\.json$/);
assert.equal(smsResult.providerStatus,'queued');
await assert.rejects(sendVendorNotification({
  channel:'sms',recipient:'+14155550123',rendered:providerMessage,
  env:{TWILIO_ACCOUNT_SID:'AC123',TWILIO_AUTH_TOKEN:'test-token',TWILIO_FROM_NUMBER:'+14155550999'},
  fetchImpl:async()=>({ok:false,status:400,json:async()=>({message:'Invalid destination'})})
}),error=>error.providerStatusCode===400&&error.uncertain===false);
let activeBatchWorkers=0;
let peakBatchWorkers=0;
const batchWorkerResults=await runWithConcurrency(Array.from({length:15},(_,index)=>index),async index=>{
  activeBatchWorkers+=1;
  peakBatchWorkers=Math.max(peakBatchWorkers,activeBatchWorkers);
  await new Promise(resolve=>setTimeout(resolve,1));
  activeBatchWorkers-=1;
  if(index===7)throw new Error('one item failure');
  return index;
});
assert.equal(MAX_BATCH_CONCURRENCY,3);
assert.ok(peakBatchWorkers<=MAX_BATCH_CONCURRENCY);
assert.equal(batchWorkerResults.length,15);
assert.ok(batchWorkerResults[7].error);
assert.equal(batchWorkerResults.filter(result=>!result.error).length,14);
const poCsv = `po_number,vendor_id,po_date,status,currency,sku,description,quantity,unit_price\nPO-CSV-001,V001,2026-10-01,APPROVED,INR,SKU-1,Widget,10,25\nPO-CSV-001,V001,2026-10-01,APPROVED,INR,SKU-2,"Blue, widget",5,50`;
const parsedPOCsv = parsePurchaseOrderCsv(poCsv);
assert.equal(parsedPOCsv.errors.length, 0);
assert.equal(parsedPOCsv.orders.length, 1);
assert.equal(parsedPOCsv.orders[0].items.length, 2);
assert.equal(parsedPOCsv.orders[0].items[1].description, 'Blue, widget');
const invalidPOCsv = parsePurchaseOrderCsv(`${poCsv}\nPO-CSV-001,V001,2026-10-01,APPROVED,INR,SKU-1,Widget,0,25`);
assert.ok(invalidPOCsv.errors.some(error => error.field === 'quantity'));
const duplicateLineCsv = parsePurchaseOrderCsv(`${poCsv}\nPO-CSV-001,V001,2026-10-01,APPROVED,INR,SKU-1,Widget,10,25`);
assert.ok(duplicateLineCsv.errors.some(error => error.field === 'lineItem'));
const parsed = parseInvoiceText(clean);
assert.equal(parsed.invoiceNumber,'INV-TEST-001');
assert.equal(parsed.vendor,'Apex Office Supplies');
assert.equal(parsed.poNumber,'PO-1001');
assert.equal(parsed.quantity,100);
assert.equal(parsed.unitPrice,500);
assert.equal(parsed.subtotal,50000);
assert.equal(parsed.total,59000);

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
const inv1048 = parseInvoiceText(inv1048Text);
assert.equal(parseInvoiceText('Invoice Number: INV-TAX-PARTIAL\nCGST: 10').tax, null);
assert.equal(parseInvoiceText('Invoice Number: INV-TAX-PAIRED\nCGST: 10\nSGST: 10').tax, 20);
assert.equal(inv1048.invoiceNumber, 'INV-1048');
assert.equal(inv1048.invoiceDate, '2026-10-24');
assert.equal(inv1048.poNumber, 'PO-9921');
assert.equal(inv1048.vendor, 'Northstar Supplies');
assert.equal(inv1048.taxId, 'GSTIN123456789');
assert.deepEqual(inv1048.lineItems, [{
  description: 'Office Chairs',
  quantity: 4,
  unitPrice: 1850,
  lineTotal: 7200
}]);
assert.equal(inv1048.quantity, 4);
assert.equal(inv1048.unitPrice, 1850);
assert.equal(inv1048.cgst, 0);
assert.equal(inv1048.sgst, 0);
assert.equal(inv1048.discount, 0);
assert.equal(inv1048.tax, 0);
assert.equal(inv1048.total, 7200);
const inv1048Result = verifyInvoice({ ...inv1048, vendorId: null }, null, false, { score: 0 });
assert.equal(inv1048Result.status, 'NEEDS REVIEW');
assert.equal(inv1048Result.checks.find(check => check.name === 'quantity_price_calculation').passed, true);
assert.match(inv1048Result.checks.find(check => check.name === 'declared_line_total').message, /₹7400\.00.*₹7200\.00.*₹200\.00/);
assert.equal(inv1048Result.checks.find(check => check.name === 'subtotal_consistency').passed, true);
assert.equal(inv1048Result.checks.find(check => check.name === 'total_consistency').passed, true);
assert.equal(inv1048Result.checks.find(check => check.name === 'tax_amount').passed, true);
assert.equal(inv1048Result.checks.find(check => check.name === 'discount_amount').passed, true);
assert.equal(inv1048Result.checks.find(check => check.name === 'vendor').passed, false);
assert.equal(inv1048Result.checks.find(check => check.name === 'purchase_order').passed, true);
assert.match(inv1048Result.checks.find(check => check.name === 'po_match').message, /PO-9921.*no matching purchase-order record exists/);
assert.equal(inv1048Result.checks.find(check => check.name === 'duplicate').passed, true);

const po={po_id:'PO-1001',vendor_id:'V001',currency:'INR',items:[{description:'Premium Ball Pens',quantity:100,unit_price:500}]};
parsed.vendorId='V001';
let result=verifyInvoice(parsed,po,false,{score:0});
assert.equal(result.status,'ACCEPTED');
assert.equal(result.duplicate,false);
const draftPOResult=verifyInvoice(parsed,{...po,status:'DRAFT'},false,{score:0});
assert.equal(draftPOResult.status,'NEEDS REVIEW');
assert.equal(draftPOResult.checks.find(check=>check.name==='po_status').passed,false);
const nonPoInvoice={...parsed,poNumber:null};
const nonPoReview=verifyInvoice(nonPoInvoice,null,false,{score:0},{nonPoPolicy:'review'});
assert.equal(nonPoReview.status,'NEEDS REVIEW');
assert.equal(nonPoReview.status,'NEEDS REVIEW', 'Missing POs default to review, not rejection');
const nonPoAllow=verifyInvoice(nonPoInvoice,null,false,{score:0},{nonPoPolicy:'allow'});
assert.equal(nonPoAllow.status,'ACCEPTED',JSON.stringify(nonPoAllow.checks));
const nonPoReject=verifyInvoice(nonPoInvoice,null,false,{score:0},{nonPoPolicy:'reject'});
assert.equal(nonPoReject.status,'REJECTED');

const qty=verifyInvoice({...parsed,quantity:120,subtotal:60000,total:69000},po,false,{score:0});
assert.equal(qty.status,'NEEDS REVIEW');

const missingQuantity=verifyInvoice({...parsed,quantity:null,unitPrice:null,subtotal:null,total:null},po,false,{score:0});
assert.equal(missingQuantity.status,'NEEDS REVIEW');
assert.match(missingQuantity.checks.find(check=>check.name==='quantity').message,/could not be extracted reliably/);

const price=verifyInvoice({...parsed,unitPrice:750,subtotal:75000,total:84000},po,false,{score:0});
assert.equal(price.status,'REJECTED');

const dup=verifyInvoice(parsed,po,true,{score:0});
assert.equal(dup.status,'REJECTED');

const total=verifyInvoice({...parsed,total:58000},po,false,{score:0});
assert.equal(total.status,'NEEDS REVIEW');

const unknownVendor=verifyInvoice({...parsed,vendorId:null},po,false,{score:0});
assert.equal(unknownVendor.status,'NEEDS REVIEW');
assert.equal(unknownVendor.checks.find(x=>x.name==='vendor').passed,false);
assert.equal(unknownVendor.checks.find(x=>x.name==='vendor_po_match').passed,false);

const wrongVendor=verifyInvoice({...parsed,vendorId:'V002'},po,false,{score:0});
assert.equal(wrongVendor.status,'NEEDS REVIEW');
assert.equal(wrongVendor.checks.find(x=>x.name==='vendor_po_match').passed,false);

const wrongCurrency=verifyInvoice({...parsed,currency:'USD'},po,false,{score:0});
assert.equal(wrongCurrency.status,'NEEDS REVIEW');
assert.equal(wrongCurrency.checks.find(x=>x.name==='currency_match').passed,false);

const multiLine=verifyInvoice({
  ...parsed,
  quantity:30,
  unitPrice:null,
  subtotal:2000,
  tax:360,
  discount:0,
  total:2360,
  lineItems:[
    {description:'Pens',quantity:10,unitPrice:100,lineTotal:1000},
    {description:'Paper',quantity:20,unitPrice:50,lineTotal:1000}
  ]
}, {
  vendor_id:'V001',
  currency:'INR',
  items:[
    {description:'Pens',quantity:10,unit_price:100},
    {description:'Paper',quantity:20,unit_price:50}
  ]
},false,{score:0});
assert.equal(multiLine.status,'ACCEPTED');
assert.equal(multiLine.checks.find(x=>x.name==='po_value_match').passed,true);

const decimalInvoice = {
  invoiceNumber: 'INV-DECIMAL-001',
  vendorId: 'V001',
  vendor: 'Apex Office Supplies',
  poNumber: 'PO-DECIMAL',
  quantity: 0.1,
  unitPrice: 0.1,
  lineItems: [{ description: 'Decimal item', quantity: 0.1, unitPrice: 0.1, lineTotal: 0.01 }],
  subtotal: 0.01,
  tax: 0.01,
  discount: 0,
  total: 0.02,
  currency: 'INR'
};
const decimalResult = verifyInvoice(decimalInvoice, {
  vendor_id: 'V001',
  currency: 'INR',
  items: [{ description:'Decimal item', quantity: 0.1, unit_price: 0.1 }]
}, false, { score: 0 });
assert.equal(decimalResult.checks.find(x=>x.name==='subtotal_consistency').passed,true);
assert.equal(decimalResult.checks.find(x=>x.name==='total_consistency').passed,true);
assert.equal(decimalResult.status,'ACCEPTED');

validateDocumentBuffer('synthetic.pdf', Buffer.from('%PDF-1.7 synthetic fixture'));
validateDocumentBuffer('invoice.png', Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
validateDocumentBuffer('invoice.jpg', Buffer.from([0xff,0xd8,0xff,0x00]));
assert.throws(
  () => validateDocumentBuffer('spoofed.pdf', Buffer.from('not a PDF')),
  /contents do not match/
);
assert.throws(
  () => validateDocumentBuffer('empty.txt', Buffer.alloc(0)),
  /empty or contains binary/
);

const adminAllowlist = getAdminAllowlist();
assert.ok(adminAllowlist.has('shivanshcollege2@gmail.com'));
assert.equal(await resolveIdentityRole('shivanshcollege2@gmail.com', 'Admin User'), 'admin');
assert.equal(await resolveIdentityRole('vendor.acme@example.test', 'Acme Vendor'), 'vendor');
assert.equal(await resolveIdentityRole('reviewer@example.test', 'Reviewer User'), 'reviewer');

const originalEnv = Object.fromEntries(
  ['DB_MODE', 'SQLITE_PATH', 'OWNER_EMAIL', 'OWNER_PASSWORD', 'OWNER_NAME']
    .map(key => [key, process.env[key]])
);
const testDirectory = await mkdtemp(path.join(os.tmpdir(), 'invoiceeye-smoke-'));
let openPool;
try {
  process.env.DB_MODE = 'sqlite';
  process.env.SQLITE_PATH = path.join(testDirectory, 'invoiceeye.sqlite');
  process.env.OWNER_EMAIL = 'owner@example.test';
  process.env.OWNER_NAME = 'Smoke Test Owner';

  delete process.env.OWNER_PASSWORD;
  openPool = await initMySQL();
  const [defaultOwnerUsers] = await getPool().query('SELECT user_id,email,role,is_active,password_hash FROM users');
  const defaultOwner = defaultOwnerUsers.find(user => user.email === 'owner@example.test');
  assert.ok(defaultOwner, 'Startup without an owner password should create a default admin account for the configured owner email');
  assert.equal(defaultOwner.role, 'admin');
  assert.equal(defaultOwner.is_active, 1);
  assert.ok(await bcrypt.compare('InvoiceEye123!', defaultOwner.password_hash));
  await openPool.end();
  openPool = null;

  process.env.OWNER_PASSWORD = 'test-password-only';
  openPool = await initSQLite();
  const [initialVendors] = await openPool.query('SELECT COUNT(*) count FROM vendors');
  const [initialInvoices] = await openPool.query('SELECT COUNT(*) count FROM invoices');
  assert.equal(initialVendors[0].count, 0, 'Startup should not insert synthetic vendors');
  assert.equal(initialInvoices[0].count, 0, 'Startup should not insert synthetic invoices');
  await openPool.query(
    'INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)',
    ['Old Demo User', 'reviewer@invoiceeye.local', 'inactive-test-hash', 'reviewer']
  );
  await openPool.end();
  openPool = null;

  openPool = await initMySQL();
  const [users] = await getPool().query('SELECT user_id,email,role,is_active,password_hash FROM users');
  const owner = users.find(user => user.email === 'owner@example.test');
  const disabledDemo = users.find(user => user.email === 'reviewer@invoiceeye.local');
  assert.ok(owner);
  assert.equal(owner.role, 'admin');
  assert.equal(owner.is_active, 1);
  assert.ok(await bcrypt.compare('test-password-only', owner.password_hash));
  assert.equal(disabledDemo.is_active, 0);
  assert.equal(users.filter(user => user.is_active).length, 1);

  const inactiveResponse = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  let nextCalled = false;
  await requireAuth({
    headers: { authorization: `Bearer ${signToken({ user_id: disabledDemo.user_id, email: disabledDemo.email, role: disabledDemo.role, name: 'Old Demo User' })}` }
  }, inactiveResponse, () => { nextCalled = true; });
  assert.equal(inactiveResponse.statusCode, 401);
  assert.equal(inactiveResponse.body.message, 'Account is inactive');
  assert.equal(nextCalled, false);

  await seedDemoData();
  await seedDemoData();
  const [demoInvoices] = await getPool().query(
    'SELECT invoice_id,status,is_demo FROM invoices WHERE is_demo=1 ORDER BY invoice_id'
  );
  assert.equal(demoInvoices.length, 4);
  assert.deepEqual(demoInvoices.map(invoice => invoice.status), [
    'ACCEPTED',
    'NEEDS REVIEW',
    'REJECTED',
    'REJECTED'
  ]);
  const [demoVendors] = await getPool().query('SELECT COUNT(*) count FROM vendors');
  assert.equal(demoVendors[0].count, 3);

  await openPool.end();
  openPool = null;
  const legacyDatabasePath = path.join(testDirectory, 'legacy.sqlite');
  const legacySchema = (await readFile(new URL('../server/db/sqlite-schema.sql', import.meta.url), 'utf8'))
    .replace('  tax NUMERIC,\n  discount NUMERIC,\n', '  tax NUMERIC NOT NULL DEFAULT 0,\n')
    .replace('  is_demo INTEGER NOT NULL DEFAULT 0,\n', '')
    .replace('  quantity NUMERIC,\n  unit_price NUMERIC,\n  declared_line_total NUMERIC\n', '  quantity NUMERIC NOT NULL,\n  unit_price NUMERIC NOT NULL\n');
  const legacyDatabase = new DatabaseSync(legacyDatabasePath);
  legacyDatabase.exec(legacySchema);
  legacyDatabase.exec(`
    INSERT INTO users(user_id,name,email,password_hash,role) VALUES (1,'Legacy Reviewer','legacy@example.test','hash','reviewer');
    INSERT INTO vendors(vendor_id,name) VALUES ('V-LEGACY','Legacy Vendor');
    INSERT INTO purchase_orders(po_id,vendor_id) VALUES ('PO-LEGACY','V-LEGACY');
    INSERT INTO invoices(invoice_id,invoice_number,vendor_id,po_id,tax) VALUES ('INV-LEGACY','INV-LEGACY','V-LEGACY','PO-LEGACY',0);
    INSERT INTO invoice_items(invoice_id,description,quantity,unit_price) VALUES ('INV-LEGACY','Legacy item',1,2);
    INSERT INTO verification_results(invoice_id,status) VALUES ('INV-LEGACY','ACCEPTED');
    INSERT INTO audit_logs(invoice_id,action) VALUES ('INV-LEGACY','LEGACY_TEST');
    INSERT INTO review_actions(invoice_id,reviewer_id,action) VALUES ('INV-LEGACY',1,'APPROVE');
  `);
  legacyDatabase.close();
  process.env.SQLITE_PATH = legacyDatabasePath;
  openPool = await initSQLite();
  const [migratedTaxColumn] = await openPool.query('PRAGMA table_info(invoices)');
  assert.equal(migratedTaxColumn.find(column => column.name === 'tax').notnull, 0);
  const [migratedItemColumns] = await openPool.query('PRAGMA table_info(invoice_items)');
  assert.equal(migratedItemColumns.find(column => column.name === 'quantity').notnull, 0);
  assert.ok(migratedItemColumns.some(column => column.name === 'declared_line_total'));
  await openPool.query(`INSERT INTO invoices(invoice_id,invoice_number,tax) VALUES ('INV-MISSING-TAX','INV-MISSING-TAX',NULL)`);
  await openPool.query(`INSERT INTO invoice_items(invoice_id,description,quantity,unit_price) VALUES ('INV-MISSING-TAX','Unparsed item',NULL,NULL)`);
  const [legacyInvoice] = await openPool.query(`SELECT tax FROM invoices WHERE invoice_id='INV-LEGACY'`);
  const [missingInvoice] = await openPool.query(`SELECT tax FROM invoices WHERE invoice_id='INV-MISSING-TAX'`);
  const [migratedChildren] = await openPool.query(`SELECT
    (SELECT COUNT(*) FROM invoice_items WHERE invoice_id='INV-LEGACY') itemCount,
    (SELECT COUNT(*) FROM verification_results WHERE invoice_id='INV-LEGACY') verificationCount,
    (SELECT COUNT(*) FROM audit_logs WHERE invoice_id='INV-LEGACY') auditCount,
    (SELECT COUNT(*) FROM review_actions WHERE invoice_id='INV-LEGACY') reviewCount`);
  const [foreignKeyViolations] = await openPool.query('PRAGMA foreign_key_check');
  assert.equal(legacyInvoice[0].tax, 0);
  assert.equal(missingInvoice[0].tax, null);
  assert.deepEqual({ ...migratedChildren[0] }, { itemCount: 1, verificationCount: 1, auditCount: 1, reviewCount: 1 });
  assert.deepEqual(foreignKeyViolations, []);
  console.log('Legacy SQLite nullable-amount migration and related-record preservation: PASS');
} finally {
  if (openPool) await openPool.end();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(testDirectory, { recursive: true, force: true });
}

console.log('InvoiceEye smoke tests: PASS');
console.log(JSON.stringify({clean:result.status,quantity:qty.status,price:price.status,duplicate:dup.status,totalMismatch:total.status,unknownVendor:unknownVendor.status,wrongVendor:wrongVendor.status,wrongCurrency:wrongCurrency.status,multiLine:multiLine.status},null,2));
console.log('SQLite account bootstrap and demo-account deactivation: PASS');
console.log('Explicit idempotent demo seed and real verification outcomes: PASS');
