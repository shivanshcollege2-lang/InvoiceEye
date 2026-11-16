function toScaledInteger(value, precision = 2) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const match = String(value).trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const sign = match[1] === '-' ? -1n : 1n;
  const fraction = match[3] || '';
  const exponent = Number(match[4] || 0) - fraction.length + precision;
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 30) return null;
  let scaled = BigInt(`${match[2]}${fraction}`);
  if (exponent >= 0) {
    scaled *= 10n ** BigInt(exponent);
  } else {
    const divisor = 10n ** BigInt(-exponent);
    const remainder = scaled % divisor;
    scaled /= divisor;
    if (remainder * 2n >= divisor) scaled += 1n;
  }
  return scaled * sign;
}

function toMinorUnits(value) {
  return toScaledInteger(value, 2);
}

function minorUnitsEqual(value, expected, tolerance = 100n) {
  const observed = toMinorUnits(value);
  return observed !== null && expected !== null && (observed >= expected
    ? observed - expected <= tolerance
    : expected - observed <= tolerance);
}

function moneyEqual(a, b, tolerance = 1) {
  const expected = toMinorUnits(b);
  const toleranceMinor = toMinorUnits(tolerance);
  return expected !== null && toleranceMinor !== null
    && minorUnitsEqual(a, expected, toleranceMinor);
}

function productMinorUnits(quantity, unitPrice) {
  const quantityHundredths = toScaledInteger(quantity, 2);
  const priceHundredths = toScaledInteger(unitPrice, 2);
  if (quantityHundredths === null || priceHundredths === null) return null;
  const product = quantityHundredths * priceHundredths;
  const cents = product / 100n;
  const remainder = product % 100n;
  return cents + (remainder >= 50n ? 1n : remainder <= -50n ? -1n : 0n);
}

function billedBase(invoice) {
  if (invoice.lineItems?.length) {
    return invoice.lineItems.reduce((sum, item) => {
      const lineTotal = item.lineTotal == null
        ? productMinorUnits(item.quantity, item.unitPrice ?? item.unit_price)
        : toMinorUnits(item.lineTotal);
      return lineTotal === null ? null : sum === null ? null : sum + lineTotal;
    }, 0n);
  }
  if (invoice.unitPrice == null || invoice.quantity == null) return null;
  return productMinorUnits(invoice.quantity, invoice.unitPrice);
}

function formatMinorUnits(value) {
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

function formatCurrency(value, currency) {
  const symbol = ({ INR: '₹', USD: '$', EUR: '€', GBP: '£' })[String(currency || '').toUpperCase()] || `${currency || ''} `;
  return `${symbol}${formatMinorUnits(value)}`;
}

function formatQuantityDifference(value) {
  if (value === null) return 'unknown';
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const fraction = String(absolute % 100n).padStart(2, '0').replace(/0+$/, '');
  return `${sign}${absolute / 100n}${fraction ? `.${fraction}` : ''}`;
}

function normalizedDescription(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function verifyInvoice(invoice, po, duplicateInvoice = false, anomaly = {}, policy = {}) {
  const reasons = [];
  const checks = [];
  let risk = 0;
  let hardReject = false;
  const nonPoPolicy = ['review','allow','reject'].includes(policy.nonPoPolicy) ? policy.nonPoPolicy : 'review';

  const addCheck = (name, passed, message, score = 0, hard = false) => {
    checks.push({ name, passed, message });
    reasons.push(message);
    if (!passed) {
      risk += score;
      if (hard) hardReject = true;
    }
  };

  addCheck('invoice_number', Boolean(invoice.invoiceNumber && !String(invoice.invoiceNumber).startsWith('UNPARSED-')), Boolean(invoice.invoiceNumber && !String(invoice.invoiceNumber).startsWith('UNPARSED-')) ? 'Invoice number captured' : 'Invoice number is missing', 20);
  const vendorKnown = invoice.vendorId === undefined ? Boolean(invoice.vendor) : Boolean(invoice.vendorId);
  const unitPriceValid = invoice.unitPrice != null
    ? Number(invoice.unitPrice) > 0
    : Boolean(invoice.lineItems?.length) && invoice.lineItems.every(item => Number(item.unitPrice ?? item.unit_price) > 0);
  addCheck('vendor', vendorKnown, vendorKnown ? 'Vendor identified in vendor master' : invoice.vendor ? 'Vendor was not found in vendor master' : 'Vendor could not be identified', 35);
  const noPOReference = !invoice.poNumber && !po;
  const poReferencePassed = Boolean(invoice.poNumber) || (noPOReference && nonPoPolicy === 'allow');
  addCheck(
    'purchase_order',
    poReferencePassed,
    invoice.poNumber ? 'Purchase-order number captured' : nonPoPolicy === 'allow'
      ? 'Non-PO invoice is permitted by configured policy'
      : nonPoPolicy === 'reject'
        ? 'Non-PO invoice is rejected by configured policy'
        : 'No purchase-order reference; invoice routed to review by configured policy',
    noPOReference ? 0 : 20,
    noPOReference && nonPoPolicy === 'reject'
  );
  addCheck('quantity', Number(invoice.quantity) > 0, Number(invoice.quantity) > 0 ? 'Invoice quantity is valid' : invoice.quantity == null ? 'Invoice quantity could not be extracted reliably' : 'Invoice quantity must be greater than zero', 20);
  addCheck('unit_price', unitPriceValid, unitPriceValid ? 'Invoice unit price is valid' : 'Invoice unit price must be greater than zero', 20);

  const invoiceBase = billedBase(invoice);
  const calculationItems = invoice.lineItems?.length
    ? invoice.lineItems
    : invoice.quantity != null && invoice.unitPrice != null
      ? [{ description: 'Invoice line', quantity: invoice.quantity, unitPrice: invoice.unitPrice }]
      : [];
  if (!calculationItems.length) {
    addCheck('quantity_price_calculation', false, 'Invoice quantity and unit price could not be extracted for line calculation', 30);
    addCheck('declared_line_total', false, 'Declared line total could not be verified because no line calculation was available', 15);
  } else {
    const calculationResults = calculationItems.map(item => {
      const calculated = productMinorUnits(item.quantity, item.unitPrice ?? item.unit_price);
      if (calculated === null) {
        return { calculated: null, message: `Quantity × unit price for ${item.description || 'invoice item'} could not be calculated from valid extracted values` };
      }
      return { calculated, message: `${item.description || 'Invoice item'}: quantity × unit price calculates to ${formatCurrency(calculated, invoice.currency)}` };
    });
    const calculationsValid = calculationResults.every(result => result.calculated !== null);
    addCheck(
      'quantity_price_calculation',
      calculationsValid,
      calculationResults.map(result => result.message).join('; '),
      calculationsValid ? 0 : 30
    );

    const declaredResults = calculationItems.map((item, index) => {
      const calculated = calculationResults[index].calculated;
      if (calculated === null) {
        return { passed: false, message: `Declared line total for ${item.description || 'invoice item'} could not be compared because quantity × unit price was unavailable` };
      }
      if (item.lineTotal == null) {
        return { passed: false, message: `Declared line total for ${item.description || 'invoice item'} was not extracted; calculated amount is ${formatCurrency(calculated, invoice.currency)}` };
      }
      const declared = toMinorUnits(item.lineTotal);
      if (declared === null) {
        return { passed: false, message: `Declared line total for ${item.description || 'invoice item'} is invalid` };
      }
      const matches = minorUnitsEqual(formatMinorUnits(calculated), declared);
      const difference = calculated >= declared ? calculated - declared : declared - calculated;
      return {
        passed: matches,
        message: matches
          ? `Line total for ${item.description || 'invoice item'} matches quantity × unit price`
          : `Line "${item.description || 'invoice item'}": quantity × unit price is ${formatCurrency(calculated, invoice.currency)}, but the declared line total is ${formatCurrency(declared, invoice.currency)} (difference ${formatCurrency(difference, invoice.currency)})`
      };
    });
    const lineMatches = declaredResults.every(item => item.passed);
    addCheck(
      'declared_line_total',
      lineMatches,
      declaredResults.map(item => item.message).join('; '),
      lineMatches ? 0 : 30
    );
  }

  const parsedTax = toMinorUnits(invoice.tax);
  addCheck(
    'tax_amount',
    parsedTax !== null,
    parsedTax === null ? 'Tax amount was not extracted as a valid value; zero is not assumed' : `Tax amount captured: ${formatCurrency(parsedTax, invoice.currency)}`,
    parsedTax === null ? 15 : 0
  );
  const parsedDiscount = toMinorUnits(invoice.discount);
  addCheck(
    'discount_amount',
    parsedDiscount !== null && parsedDiscount >= 0n,
    parsedDiscount === null
      ? 'Discount was not extracted as a valid value; zero is not assumed'
      : parsedDiscount < 0n
        ? 'Extracted discount cannot be negative'
        : `Discount captured: ${formatCurrency(parsedDiscount, invoice.currency)}`,
    parsedDiscount === null || parsedDiscount < 0n ? 15 : 0
  );
  const taxComponents = [invoice.cgst, invoice.sgst, invoice.igst];
  if (taxComponents.every(value => value != null)) {
    const componentTotal = taxComponents.reduce((sum, value) => sum + (toMinorUnits(value) ?? 0n), 0n);
    const taxComponentsMatch = parsedTax !== null && minorUnitsEqual(formatMinorUnits(componentTotal), parsedTax);
    addCheck(
      'tax_components',
      taxComponentsMatch,
      taxComponentsMatch
        ? 'CGST, SGST, and IGST reconcile with the extracted tax amount'
        : 'Reported CGST, SGST, and IGST do not reconcile with the extracted tax amount',
      20
    );
  }

  if (invoice.subtotal == null || invoiceBase == null) {
    addCheck('subtotal_consistency', false, 'Invoice subtotal or line-item amounts could not be extracted', 30);
  } else {
    const subtotalMatches = minorUnitsEqual(invoice.subtotal, invoiceBase);
    addCheck('subtotal_consistency', subtotalMatches, subtotalMatches ? 'Subtotal reconciles with extracted line amounts' : 'Invoice subtotal does not reconcile with extracted line amounts', 30);
  }

  const invoiceSubtotal = toMinorUnits(invoice.subtotal);
  const invoiceTax = toMinorUnits(invoice.tax);
  const invoiceDiscount = toMinorUnits(invoice.discount);
  const invoiceTotal = toMinorUnits(invoice.total);
  if (invoiceTotal === null || invoiceSubtotal === null || invoiceTax === null || invoiceDiscount === null) {
    const missing = [
      invoiceSubtotal === null && 'subtotal',
      invoiceTax === null && 'tax',
      invoiceDiscount === null && 'discount',
      invoiceTotal === null && 'grand total'
    ].filter(Boolean);
    addCheck('total_consistency', false, `Grand total cannot be verified because ${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} not reliably extracted; missing amounts are not assumed to be zero`, 40);
  } else {
    const totalMatches = minorUnitsEqual(formatMinorUnits(invoiceTotal), invoiceSubtotal + invoiceTax - invoiceDiscount);
    addCheck('total_consistency', totalMatches, totalMatches ? 'Grand total reconciles with subtotal + tax − discount' : `Grand total ${formatCurrency(invoiceTotal, invoice.currency)} does not equal subtotal ${formatCurrency(invoiceSubtotal, invoice.currency)} + tax ${formatCurrency(invoiceTax, invoice.currency)} − discount ${formatCurrency(invoiceDiscount, invoice.currency)}`, 40);
  }

  if (!po) {
    if (noPOReference) {
      addCheck('po_match', nonPoPolicy === 'allow', nonPoPolicy === 'allow'
        ? 'No PO match is required by configured non-PO policy'
        : nonPoPolicy === 'reject'
          ? 'No purchase order is permitted by configured policy'
          : 'No PO reference was provided; manual approval is required by configured policy', 0,
      nonPoPolicy === 'reject');
    } else {
      addCheck('po_match', false, `Purchase-order reference ${invoice.poNumber} was found, but no matching purchase-order record exists`, 60, false);
    }
  } else {
    if (po.status && po.status !== 'APPROVED') {
      addCheck('po_status', false, `Purchase order ${po.po_id || invoice.poNumber} is ${po.status}; an approved PO is required for automatic verification`, 35);
    }
    const expectedQty = toScaledInteger(po.remainingQuantity ?? po.items.reduce((sum, item) => sum + Number(item.quantity || 0), 0), 2);
    const observedQty = toScaledInteger(invoice.quantity, 2);
    let expectedBilledBase = null;
    if (invoice.lineItems?.length) {
      expectedBilledBase = invoice.lineItems.reduce((sum, item) => {
        const matchingPOItem = po.items.find(poItem => item.sku && poItem.sku
          ? String(item.sku).trim().toLowerCase() === String(poItem.sku).trim().toLowerCase()
          : normalizedDescription(item.description) === normalizedDescription(poItem.description));
        const lineTotal = matchingPOItem
          ? productMinorUnits(item.quantity, matchingPOItem.unitPrice ?? matchingPOItem.unit_price)
          : null;
        return lineTotal === null || sum === null ? null : sum + lineTotal;
      }, 0n);
    } else if (po.items.length === 1 && invoice.quantity != null) {
      expectedBilledBase = productMinorUnits(invoice.quantity, po.items[0].unitPrice ?? po.items[0].unit_price);
    }

    if (po.vendor_id != null) {
      const vendorMatchesPO = vendorKnown && String(invoice.vendorId) === String(po.vendor_id);
      addCheck('vendor_po_match', vendorMatchesPO, vendorMatchesPO ? 'Purchase order belongs to the identified vendor' : 'Purchase order belongs to a different or unidentified vendor', 40);
    }

    if (po.currency && invoice.currency) {
      const currencyMatches = String(po.currency).toUpperCase() === String(invoice.currency).toUpperCase();
      addCheck('currency_match', currencyMatches, currencyMatches ? 'Invoice currency matches purchase order' : `Invoice currency ${invoice.currency} differs from purchase-order currency ${po.currency}`, 40);
    }

    if (observedQty !== null && expectedQty !== null && observedQty <= expectedQty) {
      addCheck('quantity_match', true, observedQty === expectedQty
        ? 'Invoice quantity equals the remaining purchase-order quantity'
        : `Invoice quantity is within the remaining purchase-order quantity of ${formatQuantityDifference(expectedQty)} units`);
    } else if (observedQty !== null && observedQty > expectedQty) {
      addCheck('quantity_match', false, `Invoice quantity exceeds purchase-order quantity by ${formatQuantityDifference(observedQty - expectedQty)} units`, 35);
    } else if (observedQty === null) {
      addCheck('quantity_match', false, 'Invoice quantity could not be compared with purchase order', 20);
    } else {
      addCheck('quantity_match', false, `Invoice quantity is below purchase-order quantity by ${formatQuantityDifference(expectedQty - observedQty)} units`, 20);
    }

    if (invoice.lineItems?.length) {
      const billedByPOItem = new Map();
      let lineQuantityValid = true;
      for (const item of invoice.lineItems) {
        const poIndex = po.items.findIndex(poItem => item.sku && poItem.sku
          ? String(item.sku).trim().toLowerCase() === String(poItem.sku).trim().toLowerCase()
          : normalizedDescription(item.description) === normalizedDescription(poItem.description));
        const quantity = toScaledInteger(item.quantity, 2);
        if (poIndex < 0 || quantity === null) {
          lineQuantityValid = false;
          continue;
        }
        billedByPOItem.set(poIndex, (billedByPOItem.get(poIndex) || 0n) + quantity);
      }
      for (const [poIndex, quantity] of billedByPOItem) {
        const available = toScaledInteger(po.remainingItems?.[poIndex]?.remainingQuantity ?? po.items[poIndex].quantity, 2);
        if (available === null || quantity > available) lineQuantityValid = false;
      }
      addCheck('line_quantity_match', lineQuantityValid,
        lineQuantityValid ? 'Invoice line quantities are within each PO line’s remaining quantity' : 'An invoice line quantity exceeds its PO line balance or could not be matched', 35);
    }

    if (po.items.length === 1) {
      const expectedUnitPrice = Number(po.items[0].unitPrice ?? po.items[0].unit_price);
      const observedUnitPrice = invoice.unitPrice ?? (invoice.lineItems?.length === 1 ? invoice.lineItems[0].unitPrice : null);
      if (observedUnitPrice == null) {
        addCheck('price_match', false, 'Invoice unit price could not be extracted', 20);
      } else if (moneyEqual(observedUnitPrice, expectedUnitPrice)) {
        addCheck('price_match', true, 'Unit price matches purchase order');
      } else {
        const observedMinor = toMinorUnits(observedUnitPrice);
        const expectedMinor = toMinorUnits(expectedUnitPrice);
        const difference = observedMinor === null || expectedMinor === null ? 0n : observedMinor - expectedMinor;
        addCheck('price_match', false, `Unit price differs from purchase-order price by ${formatMinorUnits(difference < 0n ? -difference : difference)}`, 35, difference > 0n);
      }
    } else if (invoice.lineItems?.length) {
      const allItemsMatch = invoice.lineItems.every(item => {
        const matchingPOItem = po.items.find(poItem => item.sku && poItem.sku
          ? String(item.sku).trim().toLowerCase() === String(poItem.sku).trim().toLowerCase()
          : normalizedDescription(item.description) === normalizedDescription(poItem.description));
        return matchingPOItem && moneyEqual(item.unitPrice ?? item.unit_price, matchingPOItem.unitPrice ?? matchingPOItem.unit_price);
      });
      addCheck('price_match', allItemsMatch, allItemsMatch ? 'Invoice line prices match purchase-order items' : 'Invoice line items or prices do not match the purchase order', 35);
    } else {
      addCheck('price_match', false, 'Line items are required to verify prices against this multi-item purchase order', 20);
    }

    if (invoiceBase != null && expectedBilledBase !== null) {
      const poValueMatches = minorUnitsEqual(formatMinorUnits(invoiceBase), expectedBilledBase);
      addCheck('po_value_match', poValueMatches, poValueMatches ? 'Billed line values match purchase-order prices' : 'Billed line values differ from the matched purchase-order prices', 25);
    }
  }

  addCheck('duplicate', !duplicateInvoice, !duplicateInvoice ? 'No duplicate invoice number detected' : 'Potential duplicate invoice number detected', 55, duplicateInvoice);

  if (anomaly.score > 0) {
    reasons.push(anomaly.message);
    risk += anomaly.score;
    checks.push({ name:'anomaly', passed:false, message:anomaly.message });
  } else {
    checks.push({ name:'anomaly', passed:true, message:'No supporting anomaly signal detected' });
    reasons.push('No supporting anomaly signal detected');
  }

  risk = Math.min(99, Math.max(0, Math.round(risk)));
  let status = 'ACCEPTED';
  if (hardReject) status = 'REJECTED';
  else if (checks.some(check => !check.passed)) status = 'NEEDS REVIEW';

  return { status, riskScore: risk, duplicate: duplicateInvoice, reasons, checks };
}
