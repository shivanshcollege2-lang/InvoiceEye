import nodemailer from 'nodemailer';

const CHANNELS = new Set(['email','whatsapp','sms']);

export function getProviderConfiguration(channel, env=process.env) {
  if (!CHANNELS.has(channel)) return { configured:false, provider:'unknown', missing:['supported channel'] };
  if (channel === 'email') {
    const required=['SMTP_HOST','SMTP_PORT','SMTP_USER','SMTP_PASS','SMTP_FROM'];
    const missing=required.filter(key=>!String(env[key]||'').trim());
    return { configured:missing.length===0, provider:'SMTP', missing };
  }
  if (channel === 'whatsapp') {
    const required=['WHATSAPP_ACCESS_TOKEN','WHATSAPP_PHONE_NUMBER_ID','WHATSAPP_TEMPLATE_NAME','WHATSAPP_LANGUAGE_CODE','WHATSAPP_GRAPH_API_VERSION'];
    const missing=required.filter(key=>!String(env[key]||'').trim());
    return { configured:missing.length===0, provider:'Meta WhatsApp Business Cloud API', missing };
  }
  const required=['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN','TWILIO_FROM_NUMBER'];
  const missing=required.filter(key=>!String(env[key]||'').trim());
  return { configured:missing.length===0, provider:'Twilio SMS', missing };
}

export function isValidNotificationRecipient(channel, recipient) {
  const value=String(recipient||'').trim();
  if (channel === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  if (channel === 'whatsapp' || channel === 'sms') return /^\+[1-9]\d{7,14}$/.test(value);
  return false;
}

export function renderVendorNotification({channel,vendor,invoice,reason,env=process.env}) {
  if (!CHANNELS.has(channel)) throw new Error('Unsupported notification channel.');
  const invoiceNumber=String(invoice.invoice_number||invoice.invoice_id);
  const vendorName=String(vendor.name||'Vendor');
  const decision=String(invoice.status);
  const exactReason=String(reason||'');
  const subject=`InvoiceEye: ${invoiceNumber} — ${decision}`;
  const body=`Hello ${vendorName},\n\nInvoice ${invoiceNumber} has a decision of ${decision}.\n\nReason: ${exactReason}\n\nInvoiceEye`;
  const preview=channel==='whatsapp'
    ? `Approved Meta template: ${env.WHATSAPP_TEMPLATE_NAME||'[not configured]'}\n${vendorName} · ${invoiceNumber} · ${decision}\n${exactReason}`
    : channel==='sms'
      ? `${invoiceNumber}: ${decision}. ${exactReason}`
      : body;
  return { channel,invoiceNumber,decision,reason:exactReason,subject,body,preview };
}

function makeProviderError(message,{statusCode=null,response=null,uncertain=false}={}) {
  const error=new Error(message);
  error.providerStatusCode=statusCode;
  error.providerResponse=response;
  error.uncertain=uncertain;
  return error;
}

export async function sendVendorNotification({channel,recipient,rendered,env=process.env,fetchImpl=globalThis.fetch,transportFactory=nodemailer.createTransport}) {
  const configuration=getProviderConfiguration(channel,env);
  if (!configuration.configured) throw makeProviderError(`Integration Not Configured: ${configuration.missing.join(', ')}`,{statusCode:503});

  if (channel === 'email') {
    const transporter=transportFactory({
      host:env.SMTP_HOST,
      port:Number(env.SMTP_PORT),
      secure:String(env.SMTP_SECURE||'').toLowerCase()==='true' || Number(env.SMTP_PORT)===465,
      auth:{ user:env.SMTP_USER, pass:env.SMTP_PASS },
      connectionTimeout:10000,
      greetingTimeout:10000,
      socketTimeout:20000
    });
    try {
      const info=await transporter.sendMail({ from:env.SMTP_FROM, to:recipient, subject:rendered.subject, text:rendered.body });
      return {
        provider:configuration.provider,
        providerStatus:'accepted_by_smtp',
        providerMessageId:info.messageId||null,
        response:{ accepted:info.accepted||[], rejected:info.rejected||[], response:info.response||null }
      };
    } catch(error) {
      throw makeProviderError(error.message||'SMTP submission failed.',{
        statusCode:error.responseCode||null,
        response:{ code:error.code||null, responseCode:error.responseCode||null, response:error.response||null },
        uncertain:!error.responseCode
      });
    } finally { transporter.close(); }
  }

  if (channel === 'whatsapp') {
    const url=`https://graph.facebook.com/${env.WHATSAPP_GRAPH_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    const payload={
      messaging_product:'whatsapp',
      recipient_type:'individual',
      to:recipient.replace(/^\+/,''),
      type:'template',
      template:{
        name:env.WHATSAPP_TEMPLATE_NAME,
        language:{code:env.WHATSAPP_LANGUAGE_CODE},
        components:[{type:'body',parameters:[
          {type:'text',text:rendered.invoiceNumber},
          {type:'text',text:rendered.decision},
          {type:'text',text:rendered.reason}
        ]}]
      }
    };
    let response;
    try {
      response=await fetchImpl(url,{method:'POST',headers:{Authorization:`Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(payload)});
    } catch(error) {
      throw makeProviderError(error.message||'WhatsApp provider connection failed.',{uncertain:true});
    }
    const data=await response.json().catch(()=>({}));
    if (!response.ok) throw makeProviderError(data.error?.message||`WhatsApp provider returned HTTP ${response.status}.`,{
      statusCode:response.status,response:data,uncertain:response.status>=500
    });
    return { provider:configuration.provider,providerStatus:data.messages?.[0]?.message_status||'accepted',providerMessageId:data.messages?.[0]?.id||null,response:data };
  }

  const accountSid=env.TWILIO_ACCOUNT_SID;
  const url=`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const params=new URLSearchParams({To:recipient,From:env.TWILIO_FROM_NUMBER,Body:rendered.preview});
  let response;
  try {
    response=await fetchImpl(url,{
      method:'POST',
      headers:{Authorization:`Basic ${Buffer.from(`${accountSid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,'Content-Type':'application/x-www-form-urlencoded'},
      body:params
    });
  } catch(error) {
    throw makeProviderError(error.message||'SMS provider connection failed.',{uncertain:true});
  }
  const data=await response.json().catch(()=>({}));
  if (!response.ok) throw makeProviderError(data.message||`SMS provider returned HTTP ${response.status}.`,{
    statusCode:response.status,response:data,uncertain:response.status>=500
  });
  return { provider:configuration.provider,providerStatus:data.status||'accepted',providerMessageId:data.sid||null,response:data };
}