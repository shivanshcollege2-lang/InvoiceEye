function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findValue(text, labels) {
  const lines = text.split(/\r?\n/);
  for (const label of labels) {
    const escaped = escapeRegExp(label);
    const inline = new RegExp(`^\\s*${escaped}\\s*[:#-]\\s*([^\\n\\r]+)`, 'i');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(inline);
      if (m) return m[1].trim();
      const labelOnly = new RegExp(`^\\s*${escaped}\\s*$`, 'i');
      if (labelOnly.test(line)) {
        for (let j = i + 1; j < Math.min(lines.length, i + 4); j++) {
          const next = lines[j].trim();
          if (!next) continue;
          if (/^(invoice|vendor|supplier|purchase order|quantity|qty|unit price|price per unit|rate|subtotal|sub total|net amount|tax|gst|vat|grand total|amount due|total|date|invoice date)\b/i.test(next) && j > i + 1) break;
          return next;
        }
      }
    }
  }
  return '';
}


function toNumber(value) {
  const normalized = String(value ?? '').replace(/[,₹$€£]/g, '').replace(/[^0-9.-]/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

function money(text, labels) {
  const raw = findValue(text, labels);
  return raw ? toNumber(raw) : null;
}

function dateValue(text) {
  const raw = findValue(text, ['Invoice Date', 'Date', 'Bill Date']);
  if (!raw) return null;
  const iso = raw.match(/(20\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`;
  const namedMonth = raw.match(/^(\d{1,2})[-/\s.]([A-Za-z]+)[-/\s.,]+(20\d{2})$/);
  if (namedMonth) {
    const month = new Date(`${namedMonth[2]} 1, 2000`).getMonth();
    const day = Number(namedMonth[1]);
    const year = Number(namedMonth[3]);
    const parsed = new Date(Date.UTC(year, month, day));
    if (parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month && parsed.getUTCDate() === day) {
      return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0,10);
  return raw;
}

function parseLineItems(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const items = [];
  const headerIndex = lines.findIndex(l => /description.*quantity.*unit\s*price/i.test(l));
  if (headerIndex >= 0) {
    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^(subtotal|tax|gst|vat|total|grand total|amount due)\b/i.test(line)) break;
      const parts = line.split(/\||,|\t/).map(x => x.trim()).filter(Boolean);
      if (parts.length >= 3) {
        const values = parts.slice(1).map(toNumber);
        const qty = values[0];
        const unitPrice = values[1];
        if (qty != null && unitPrice != null) {
          items.push({
            description: parts[0],
            quantity: qty,
            unitPrice,
            ...(values[2] == null ? {} : { lineTotal: values[2] })
          });
        }
      }
    }
  }
  return items;
}

function parseLabeledLineItems(text) {
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const items = [];
  let current = null;
  let inItems = false;
  const finish = () => {
    if (current && (current.quantity != null || current.unitPrice != null || current.lineTotal != null)) {
      items.push(current);
    }
    current = null;
  };
  const summaryLine = /^(subtotal|sub total|tax|cgst|sgst|igst|gst|vat|discount|grand total|amount due|total)\b/i;

  for (const line of lines) {
    if (!line) continue;
    const section = line.match(/^(?:line\s*items?|items?)\s*:\s*(.*)$/i);
    if (section) {
      finish();
      inItems = true;
      current = {};
      if (section[1]) current.description = section[1].trim();
      continue;
    }
    if (!inItems) continue;
    if (summaryLine.test(line)) {
      finish();
      inItems = false;
      continue;
    }

    const field = line.match(/^(description|item|quantity|qty|unit\s*price|price\s*per\s*unit|rate|declared\s+line\s+total|line\s+total)\s*[:#-]\s*(.+)$/i);
    if (field) {
      const name = field[1].toLowerCase().replace(/\s+/g, ' ');
      if (name === 'description' || name === 'item') {
        finish();
        current = { description: field[2].trim() };
      } else {
        current ||= {};
        if (name === 'quantity' || name === 'qty') current.quantity = toNumber(field[2]);
        else if (name === 'unit price' || name === 'price per unit' || name === 'rate') current.unitPrice = toNumber(field[2]);
        else current.lineTotal = toNumber(field[2]);
      }
      continue;
    }

    current ||= {};
    if (!current.description) current.description = line;
  }
  finish();
  return items.filter(item => item.description);
}

function parseVerticalTable(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let idx = -1;
  for (let i = 0; i < lines.length - 2; i++) {
    if (/^description$/i.test(lines[i]) && /^quantity$/i.test(lines[i + 1]) && /unit\s*price/i.test(lines[i + 2])) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return { items: [] };
  const values = [];
  for (let i = idx + 4; i < lines.length; i++) {
    if (/^(subtotal|sub total|tax|gst|vat|grand total|amount due|total)$/i.test(lines[i])) break;
    values.push(lines[i]);
  }
  const items = [];
  for (let i = 0; i + 3 < values.length; i += 4) {
    const qty = toNumber(values[i + 1]);
    const unitPrice = toNumber(values[i + 2]);
    if (qty == null || unitPrice == null) break;
    items.push({ description: values[i], quantity: qty, unitPrice });
  }
  return { items };
}

export function parseInvoiceText(text) {
  const invoiceNumber = findValue(text, ['Invoice Number', 'Invoice No', 'Invoice #', 'Invoice Id']) || `UNPARSED-${Date.now()}`;
  const vendor = findValue(text, ['Vendor Name', 'Vendor', 'Supplier Name', 'Supplier']);
  const taxId = findValue(text, ['Tax ID', 'GSTIN', 'GSTIN Number', 'VAT Number']);
  const poNumber = findValue(text, ['PO Reference', 'PO Number', 'PO No', 'Purchase Order Number', 'Purchase Order']);
  const invoiceDate = dateValue(text);
  const quantity = money(text, ['Quantity', 'Qty', 'Units']);
  const unitPrice = money(text, ['Unit Price', 'Price Per Unit', 'Rate']);
  const subtotal = money(text, ['Subtotal', 'Sub Total', 'Net Amount']);
  const cgst = money(text, ['CGST']);
  const sgst = money(text, ['SGST']);
  const igst = money(text, ['IGST']);
  const tax = money(text, ['Tax', 'Total Tax', 'GST', 'VAT'])
    ?? (cgst != null && sgst != null
      ? cgst + sgst + (igst ?? 0)
      : igst != null && cgst == null && sgst == null
        ? igst
        : null);
  const discount = money(text, ['Discount']);
  const total = money(text, ['Grand Total', 'Amount Due', 'Total']);
  const currency = /\b(USD|EUR|GBP|INR|₹|\$|€|£)\b/i.test(text) ? (/USD/i.test(text) ? 'USD' : /EUR/i.test(text) ? 'EUR' : /GBP/i.test(text) ? 'GBP' : 'INR') : 'INR';
  let lineItems = parseLineItems(text);
  if (!lineItems.length) lineItems = parseLabeledLineItems(text);
  if (!lineItems.length) lineItems = parseVerticalTable(text).items;
  const derivedQuantity = quantity != null && quantity > 0
    ? quantity
    : lineItems.length && lineItems.every(item => item.quantity != null)
      ? lineItems.reduce((sum, item) => sum + item.quantity, 0)
      : null;
  const derivedUnitPrice = unitPrice != null && unitPrice > 0 ? unitPrice : (lineItems.length === 1 ? lineItems[0].unitPrice : null);
  return {
    invoiceNumber,
    vendor,
    taxId,
    poNumber,
    invoiceDate,
    quantity: derivedQuantity,
    unitPrice: derivedUnitPrice,
    subtotal,
    tax,
    cgst,
    sgst,
    igst,
    discount,
    total,
    currency,
    lineItems
  };
}
