import { parse } from 'csv-parse/sync';

const aliases = new Map([
  ['ponumber','poId'], ['purchaseordernumber','poId'], ['poreference','poId'], ['poid','poId'],
  ['vendorid','vendorId'], ['vendorname','vendorName'], ['vendor','vendor'], ['supplier','vendor'],
  ['suppliername','vendorName'], ['vendoremail','vendorEmail'], ['supplieremail','vendorEmail'],
  ['podate','poDate'], ['orderdate','poDate'], ['date','poDate'], ['status','status'],
  ['currency','currency'], ['sku','sku'], ['itemsku','sku'],
  ['description','description'], ['itemdescription','description'], ['linedescription','description'],
  ['quantity','quantity'], ['qty','quantity'], ['orderedquantity','quantity'],
  ['unitprice','unitPrice'], ['price','unitPrice'], ['rate','unitPrice'], ['notes','notes']
]);

function normalizedHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parsePurchaseOrderCsv(csvText) {
  if (typeof csvText !== 'string' || !csvText.trim()) throw new Error('CSV content is required.');
  if (Buffer.byteLength(csvText, 'utf8') > 1_000_000) throw new Error('PO CSV must be 1 MB or smaller.');

  const rows = parse(csvText, { bom: true, skip_empty_lines: true, trim: true, relax_column_count: false });
  if (rows.length < 2) throw new Error('CSV must include a header and at least one PO line item.');

  const headers = rows[0].map(header => aliases.get(normalizedHeader(header)) || null);
  const recognized = headers.filter(Boolean);
  const errors = [];
  if (new Set(recognized).size !== recognized.length) {
    errors.push({ row:1, field:'header', message:'CSV contains duplicate columns for the same field.' });
  }
  const hasVendor = headers.some(field => ['vendorId','vendorName','vendorEmail','vendor'].includes(field));
  for (const field of ['poId','poDate','status','currency','description','quantity','unitPrice']) {
    if (!headers.includes(field)) errors.push({ row:1, field, message:`Required CSV column is missing: ${field}.` });
  }
  if (!hasVendor) errors.push({ row:1, field:'vendor', message:'A vendor_id, vendor_name, or vendor_email column is required.' });
  if (errors.length) return { orders:[], errors, rowCount:rows.length - 1 };

  const orders = new Map();
  const seenItems = new Set();
  rows.slice(1).forEach((row, index) => {
    const rowNumber = index + 2;
    const values = Object.fromEntries(headers.map((field, column) => [field, field ? String(row[column] || '').trim() : '']));
    const order = {
      poId:values.poId,
      vendorId:values.vendorId || '',
      vendorName:values.vendorName || '',
      vendorEmail:values.vendorEmail || '',
      vendorReference:values.vendor || '',
      poDate:values.poDate,
      status:values.status.toUpperCase(),
      currency:values.currency.toUpperCase(),
      notes:values.notes || '',
      items:[]
    };
    const quantity = Number(values.quantity);
    const unitPrice = Number(values.unitPrice);
    const compatibleDecimal = value => Number.isFinite(value) && value <= 999999999999.99 && Math.abs(value * 100 - Math.round(value * 100)) < 1e-7;
    const item = { sku:values.sku || null, description:values.description, quantity, unitPrice };
    if (!order.poId) errors.push({ row:rowNumber, field:'poId', message:'PO number is required.' });
    if (order.poId.length > 40) errors.push({ row:rowNumber, field:'poId', message:'PO number must be 40 characters or fewer.' });
    if (!order.vendorId && !order.vendorName && !order.vendorEmail && !order.vendorReference) errors.push({ row:rowNumber, field:'vendor', message:'Vendor identity is required.' });
    if (!validDate(order.poDate)) errors.push({ row:rowNumber, field:'poDate', message:'PO date must be a valid YYYY-MM-DD date.' });
    if (!['DRAFT','APPROVED','CLOSED','CANCELLED'].includes(order.status)) errors.push({ row:rowNumber, field:'status', message:'PO status must be DRAFT, APPROVED, CLOSED, or CANCELLED.' });
    if (!/^[A-Z]{3}$/.test(order.currency)) errors.push({ row:rowNumber, field:'currency', message:'Currency must be a three-letter code.' });
    if (!item.description) errors.push({ row:rowNumber, field:'description', message:'Line-item description is required.' });
    if (item.description.length > 255) errors.push({ row:rowNumber, field:'description', message:'Line-item description must be 255 characters or fewer.' });
    if (item.sku && item.sku.length > 80) errors.push({ row:rowNumber, field:'sku', message:'SKU must be 80 characters or fewer.' });
    if (!compatibleDecimal(quantity) || quantity <= 0) errors.push({ row:rowNumber, field:'quantity', message:'Quantity must be positive, fit the PO precision, and have at most two decimals.' });
    if (!compatibleDecimal(unitPrice) || unitPrice < 0) errors.push({ row:rowNumber, field:'unitPrice', message:'Unit price must be non-negative, fit the PO precision, and have at most two decimals.' });
    if (order.notes.length > 500) errors.push({ row:rowNumber, field:'notes', message:'PO notes must be 500 characters or fewer.' });

    const reference = order.poId.toLowerCase();
    const header = [order.vendorId, order.vendorName.toLowerCase(), order.vendorEmail.toLowerCase(), order.vendorReference.toLowerCase(), order.poDate, order.status, order.currency, order.notes].join('|');
    let grouped = orders.get(reference);
    if (grouped && grouped.header !== header) {
      errors.push({ row:rowNumber, field:'poId', message:`PO ${order.poId} has conflicting header data across its rows.` });
    } else if (!grouped) {
      grouped = { header, order:{ ...order, items:[] } };
      orders.set(reference, grouped);
    }
    const itemKey = `${reference}|${String(item.sku || '').toLowerCase()}|${item.description.toLowerCase()}|${values.quantity}|${values.unitPrice}`;
    if (seenItems.has(itemKey)) errors.push({ row:rowNumber, field:'lineItem', message:`Duplicate line item for PO ${order.poId}.` });
    seenItems.add(itemKey);
    grouped.order.items.push(item);
  });

  return { orders:[...orders.values()].map(entry => entry.order), errors, rowCount:rows.length - 1 };
}