function contains(value,query) {
  return String(value||'').toLowerCase().includes(String(query||'').toLowerCase());
}

function priceRanges(samples) {
  const grouped=new Map();
  for(const sample of samples){
    const price=Number(sample.price);
    if(!Number.isFinite(price))continue;
    const currency=String(sample.currency||'INR').toUpperCase();
    const current=grouped.get(currency)||{currency,min:price,max:price,samples:0};
    current.min=Math.min(current.min,price);
    current.max=Math.max(current.max,price);
    current.samples+=1;
    grouped.set(currency,current);
  }
  return [...grouped.values()].sort((a,b)=>a.currency.localeCompare(b.currency));
}

function latestDate(current,value) {
  if(!value)return current;
  const normalized=String(value).slice(0,10);
  return !current||normalized>current?normalized:current;
}

export async function buildVendorInsights(db,queryValue) {
  const query=String(queryValue||'').trim();
  if(query.length<2)return {query,vendors:[],message:'Enter at least two characters to search historical supplier records.'};
  const term=`%${query.slice(0,100)}%`;
  const [invoiceRows]=await db.query(`SELECT i.invoice_id invoiceId,i.invoice_number invoiceNumber,i.invoice_date invoiceDate,
    i.created_at createdAt,i.status,i.currency invoiceCurrency,i.total,v.vendor_id vendorId,v.name vendorName,v.category,
    ii.sku,ii.description,ii.quantity,ii.unit_price unitPrice,ii.declared_line_total declaredLineTotal,
    i.po_id poId,vr.decision_reason decisionReason
    FROM invoices i JOIN vendors v ON v.vendor_id=i.vendor_id
    LEFT JOIN invoice_items ii ON ii.invoice_id=i.invoice_id
    LEFT JOIN verification_results vr ON vr.result_id=(SELECT MAX(result_id) FROM verification_results WHERE invoice_id=i.invoice_id)
    WHERE i.status IN ('ACCEPTED','NEEDS REVIEW','REJECTED')
      AND (ii.description LIKE ? OR ii.sku LIKE ? OR v.category LIKE ?)
    ORDER BY COALESCE(i.invoice_date,i.created_at) DESC,i.invoice_id LIMIT 5000`,[term,term,term]);
  const [poRows]=await db.query(`SELECT p.po_id poId,p.po_date poDate,p.status poStatus,p.currency poCurrency,
    v.vendor_id vendorId,v.name vendorName,v.category,pi.sku,pi.description,pi.quantity,pi.unit_price unitPrice
    FROM purchase_orders p JOIN vendors v ON v.vendor_id=p.vendor_id
    JOIN po_items pi ON pi.po_id=p.po_id
    WHERE pi.description LIKE ? OR pi.sku LIKE ? OR v.category LIKE ?
    ORDER BY p.po_date DESC,p.po_id LIMIT 5000`,[term,term,term]);

  const vendors=new Map();
  const getVendor=row=>{
    if(!vendors.has(row.vendorId))vendors.set(row.vendorId,{
      vendorId:row.vendorId,vendorName:row.vendorName,category:row.category||null,
      approvedInvoices:new Map(),discrepancyInvoices:new Map(),purchaseOrders:new Map(),
      approvedPrices:[],poPrices:[],matchedProducts:new Set(),latestTransactionDate:null,matchReasons:new Set()
    });
    return vendors.get(row.vendorId);
  };

  for(const row of invoiceRows){
    const vendor=getVendor(row);
    const description=String(row.description||'');
    if(description)vendor.matchedProducts.add(description);
    if(contains(row.category,query))vendor.matchReasons.add(`Vendor category “${row.category}” matches the search.`);
    else if(row.sku&&String(row.sku).toLowerCase()===query.toLowerCase())vendor.matchReasons.add(`Exact SKU match: ${row.sku}.`);
    else if(contains(row.description,query))vendor.matchReasons.add(`Invoice line description matches “${query}”.`);
    vendor.latestTransactionDate=latestDate(vendor.latestTransactionDate,row.invoiceDate||row.createdAt);
    const record={invoiceId:row.invoiceId,invoiceNumber:row.invoiceNumber,date:row.invoiceDate||row.createdAt,
      status:row.status,poId:row.poId,description:row.description,sku:row.sku,quantity:row.quantity,
      unitPrice:row.unitPrice,total:row.total,currency:row.invoiceCurrency,reason:row.decisionReason};
    if(row.status==='ACCEPTED'){
      vendor.approvedInvoices.set(row.invoiceId,record);
      if(row.unitPrice!=null)vendor.approvedPrices.push({price:row.unitPrice,currency:row.invoiceCurrency});
    }else{
      vendor.discrepancyInvoices.set(row.invoiceId,record);
    }
  }

  for(const row of poRows){
    const vendor=getVendor(row);
    if(row.description)vendor.matchedProducts.add(row.description);
    if(contains(row.category,query))vendor.matchReasons.add(`Vendor category “${row.category}” matches the search.`);
    else if(row.sku&&String(row.sku).toLowerCase()===query.toLowerCase())vendor.matchReasons.add(`Exact SKU match: ${row.sku}.`);
    else if(contains(row.description,query))vendor.matchReasons.add(`Purchase-order line description matches “${query}”.`);
    vendor.latestTransactionDate=latestDate(vendor.latestTransactionDate,row.poDate);
    if(!vendor.purchaseOrders.has(row.poId))vendor.purchaseOrders.set(row.poId,{
      poId:row.poId,date:row.poDate,status:row.poStatus,currency:row.poCurrency,items:[]
    });
    vendor.purchaseOrders.get(row.poId).items.push({sku:row.sku,description:row.description,quantity:row.quantity,unitPrice:row.unitPrice});
    if(row.unitPrice!=null)vendor.poPrices.push({price:row.unitPrice,currency:row.poCurrency});
  }

  const result=[...vendors.values()].map(vendor=>{
    const approved=[...vendor.approvedInvoices.values()];
    const discrepancies=[...vendor.discrepancyInvoices.values()];
    const purchaseOrders=[...vendor.purchaseOrders.values()];
    const reasons=[...vendor.matchReasons];
    if(approved.length)reasons.push(`Supported by ${approved.length} distinct approved invoice transaction${approved.length===1?'':'s'}.`);
    if(purchaseOrders.length)reasons.push(`Supported by ${purchaseOrders.length} historical purchase order${purchaseOrders.length===1?'':'s'}.`);
    if(!approved.length)reasons.push('No approved invoice transaction matched this search.');
    return {
      vendorId:vendor.vendorId,vendorName:vendor.vendorName,category:vendor.category,
      matchedProducts:[...vendor.matchedProducts].sort(),approvedTransactionCount:approved.length,
      approvedInvoicePriceRanges:priceRanges(vendor.approvedPrices),purchaseOrderPriceRanges:priceRanges(vendor.poPrices),
      discrepancyRecord:{needsReview:discrepancies.filter(item=>item.status==='NEEDS REVIEW').length,
        rejected:discrepancies.filter(item=>item.status==='REJECTED').length,
        records:discrepancies.slice(0,20)},
      latestTransactionDate:vendor.latestTransactionDate,
      recommendationReasons:reasons,
      approvedInvoiceRecords:approved.slice(0,20),purchaseOrderRecords:purchaseOrders.slice(0,20),
      deliveryPerformance:{available:false,reason:'No verified delivery or goods-receipt records exist in the database.'}
    };
  }).sort((a,b)=>b.approvedTransactionCount-a.approvedTransactionCount||a.vendorName.localeCompare(b.vendorName));
  return {query,vendors:result,message:result.length?null:'Insufficient historical evidence to generate a reliable vendor recommendation.'};
}