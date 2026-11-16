import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, PieChart, Pie, Cell } from 'recharts';
import { MAX_BATCH_CONCURRENCY, runWithConcurrency } from './batchProcessing.js';
import './styles.css';
import './overrides.css';

const API='/api';
const COLORS=['#67e8f9','#4ade80','#facc15','#fb7185'];

async function api(path, options={}){
  const token=localStorage.getItem('ie_token');
  const headers={...(options.body instanceof FormData?{}:{'Content-Type':'application/json'}),...(token?{Authorization:`Bearer ${token}`}:{})};
  let res;
  try {
    res=await fetch(API+path,{...options,headers});
  } catch {
    throw new Error('Cannot reach the InvoiceEye API. Run `npm run dev` from the InvoiceEye_Full folder.');
  }
  const data=await res.json().catch(()=>({}));
  if(!res.ok) {
    const error=new Error(data.message || data.processingFailure?.message || (res.status===502 || res.status===503
      ? 'InvoiceEye API or database is unavailable. Check the API server and database configuration.'
      : 'Request failed'));
    error.status=res.status;
    error.data=data;
    throw error;
  }
  return data;
}

function uploadInvoiceFile(path,form,onProgress){
  return new Promise((resolve,reject)=>{
    const request=new XMLHttpRequest();
    request.open('POST',API+path);
    const token=localStorage.getItem('ie_token');
    if(token)request.setRequestHeader('Authorization',`Bearer ${token}`);
    request.upload.addEventListener('progress',event=>{
      if(event.lengthComputable)onProgress(Math.min(100,Math.round(event.loaded/event.total*100)));
    });
    request.addEventListener('load',()=>{
      let data={};
      try{data=JSON.parse(request.responseText||'{}');}catch{}
      if(request.status<200||request.status>=300){
        const error=new Error(data.message||data.processingFailure?.message||'Invoice upload failed');
        error.status=request.status;
        error.data=data;
        reject(error);
      }else resolve(data);
    });
    request.addEventListener('error',()=>reject(new Error('Network error while uploading invoice.')));
    request.addEventListener('abort',()=>reject(new Error('Invoice upload was cancelled.')));
    request.send(form);
  });
}

function App(){
  const [user,setUser]=useState(null);
  const [tab,setTab]=useState('overview');
  const [summary,setSummary]=useState(null);
  const [invoices,setInvoices]=useState([]);
  const [selected,setSelected]=useState(null);
  const [toast,setToast]=useState('');
  const [connection,setConnection]=useState({status:'unknown', message:'Database health pending'});
  const [summaryLoading,setSummaryLoading]=useState(false);
  const [summaryError,setSummaryError]=useState('');
  const [processingState,setProcessingState]=useState('Idle');

  useEffect(()=>{
    const raw=localStorage.getItem('ie_user');
    if(!raw)return;
    try{
      const savedUser=JSON.parse(raw);
      if(!savedUser||typeof savedUser.name!=='string'||typeof savedUser.role!=='string')throw new Error('Invalid saved user');
      setUser(savedUser);
    }catch{
      localStorage.removeItem('ie_token');
      localStorage.removeItem('ie_user');
    }
  },[]);

  useEffect(()=>{
    let cancelled=false;
    const refreshHealth=async()=>{
      try {
        const next=await api('/health');
        if(!cancelled) setConnection({
          status: next?.database?.status === 'ok' ? 'ok' : 'down',
          message: next?.database?.message || (next?.database?.status === 'ok' ? 'Database connected' : 'Database unavailable')
        });
      } catch (e) {
        if(!cancelled) setConnection({ status:'down', message: e.message || 'Database unavailable' });
      }
    };
    refreshHealth();
    const timer=setInterval(refreshHealth,30000);
    return ()=>{cancelled=true; clearInterval(timer);};
  },[]);

  const reload=async()=>{
    if(!user)return;
    setSummaryLoading(true);
    setSummaryError('');
    try {
      const [s,i]=await Promise.all([api('/summary'),api('/invoices')]);
      setSummary(s);
      setInvoices(i);
    } catch (e) {
      if(e.status===401){logout();return;}
      setSummaryError(e.message);
    } finally {setSummaryLoading(false);}
  };
  useEffect(()=>{ reload(); },[user]);
  const logout=()=>{localStorage.removeItem('ie_token');localStorage.removeItem('ie_user');setUser(null)};
  if(!user) return <Login onLogin={u=>setUser(u)} />;

  const adminNav=[['overview','Overview','◈'],['invoices','Invoice Register','▣'],['review','Review Queue','✓'],['verify','Verify Invoice','＋'],['vendors','Vendors','◉'],['purchase-orders','Purchase Orders','⌘'],['vendor-insights','Vendor Insights','⌕'],['audit','Audit Trail','◌']];
  const vendorNav=[['overview','Overview','◈'],['verify','Register Invoice','＋'],['invoices','My Submissions','▣'],['review','My Review Cases','✓'],['vendors','My Profile','◉'],['purchase-orders','Purchase Orders','⌘'],['audit','Notification History','◌']];
  const nav = user.role === 'vendor' ? vendorNav : adminNav;
  const processingLabel=Number(summary?.currentlyProcessing||0)>0?'Processing':processingState;
  const databaseLabel=connection.status==='ok'?'Database Connected':connection.status==='down'?'Database Disconnected':'Checking Database…';

  return <div className="app">
    <aside className="sidebar">
      <div className="brand"><div className="logo">IE</div><div><b>InvoiceEye</b><span>Verification Intelligence</span></div></div>
      <div className="navgroup"><small>WORKSPACE</small>{nav.map(([id,label,icon])=><button key={id} className={tab===id?'active':''} onClick={()=>setTab(id)}><i>{icon}</i>{label}</button>)}</div>
      <div className="sidefoot"><div className="avatar">{user.name.slice(0,2).toUpperCase()}</div><div><b>{user.name}</b><span>{user.role}</span></div><button onClick={logout}>↪</button></div>
    </aside>
    <main className="main">
      <header className="topbar"><div><div className="eyebrow">FINANCIAL CONTROL / DOCUMENT VERIFICATION</div><h1>{tabTitle(tab,user.role)}</h1></div><div className="headeractions"><span title={connection.message} className={`statuspill database-${connection.status}`}><i/>{databaseLabel}</span><span className={`statuspill processing processing-${processingLabel.toLowerCase()}`}><i/>Invoice Processing: {processingLabel}</span><span className="rolepill">{user.role.toUpperCase()}</span></div></header>
      {toast && <div className="toast">{toast}</div>}
      {tab==='overview' && (user.role==='vendor'
        ? <VendorDashboard summary={summary} invoices={invoices} onSelect={setSelected} loading={summaryLoading} error={summaryError}/>
        : <AdminDashboard summary={summary} invoices={invoices} onSelect={setSelected} loading={summaryLoading} error={summaryError}/>)} 
      {tab==='invoices' && <InvoiceRegister invoices={invoices} onSelect={setSelected}/>} 
      {tab==='review' && <InvoiceRegister invoices={invoices} onSelect={setSelected} forcedStatus="NEEDS REVIEW"/>}
      {tab==='verify' && <VerifyPage user={user} onSelect={setSelected} onProcessingChange={setProcessingState} onDone={(msg)=>{setToast(msg);reload();setTimeout(()=>setToast(''),3500)}}/>}
      {tab==='vendors' && <Vendors user={user}/>} 
      {tab==='purchase-orders' && <PurchaseOrders user={user}/>} 
      {tab==='vendor-insights' && user.role==='admin' && <VendorInsights onSelect={setSelected}/>}
      {tab==='audit' && <Audit/>}
      {selected && <InvoiceDrawer data={selected} user={user} onClose={()=>setSelected(null)} onUpdated={()=>{setSelected(null);reload();}}/>}
    </main>
  </div>
}

function tabTitle(t,role){
  const map = {
    overview:'Verification Overview',
    invoices:'Invoice Register',
    review:'Verification Review',
    verify: role === 'vendor' ? 'Register Invoice' : 'Verify an Invoice',
    vendors: role === 'vendor' ? 'My Profile' : 'Vendor Master',
    'purchase-orders':'Purchase Orders',
    'vendor-insights':'Vendor Insights & Recommendations',
    audit: role === 'vendor' ? 'Notification History' : 'Audit Trail'
  };
  return map[t] || 'InvoiceEye';
}

function Login({ onLogin }) {
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [setupMessage,setSetupMessage]=useState('');

  useEffect(() => {
    let cancelled = false;
    api('/health').then(status => {
      if (!cancelled && !status.ownerConfigured) {
        setSetupMessage('Owner account is not initialized. Set OWNER_PASSWORD in your local .env file, then restart InvoiceEye.');
      }
    }).catch(healthError => {
      if (!cancelled) setSetupMessage(healthError.message);
    });
    return () => { cancelled = true; };
  }, []);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      localStorage.setItem('ie_token', data.token);
      localStorage.setItem('ie_user', JSON.stringify(data.user));
      onLogin(data.user);
    } catch (loginError) {
      setError(loginError.message);
    } finally {
      setBusy(false);
    }
  };

  return <div className="login"><form className="loginCard" onSubmit={submit}>
    <div className="logo large">IE</div>
    <div className="eyebrow">DOCUMENT INTELLIGENCE</div>
    <h1>InvoiceEye</h1>
    <p>Smart invoice verification for finance and procurement teams.</p>
    <input type="email" value={email} onChange={event => setEmail(event.target.value)} placeholder="Email" required />
    <input type="password" value={password} onChange={event => setPassword(event.target.value)} placeholder="Password" required />
    <button className="primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    {setupMessage && <div className="error" role="alert">{setupMessage}</div>}
    {error && <div className="error">{error}</div>}
  </form></div>;
}

function AdminDashboard({summary,invoices,onSelect,loading,error}){
  const [trendCurrency,setTrendCurrency]=useState('');
  const pie=summary?[{name:'Approved',value:Number(summary.accepted||0)},{name:'Needs review',value:Number(summary.review||0)},{name:'Rejected',value:Number(summary.rejected||0)}]:[];
  const currencies=[...new Set((summary?.trend||[]).map(point=>point.currency))];
  const selectedCurrency=trendCurrency||currencies[0]||'INR';
  const trend=useMemo(()=>summary?.trend?.filter(point=>point.currency===selectedCurrency).slice().sort((a,b)=>a.month.localeCompare(b.month))||[],[summary,selectedCurrency]);
  if(loading&&!summary)return <DashboardLoading label="Loading organization dashboard from the database…"/>;
  return <>
  {error&&<div className="error" role="alert">{error}</div>}
  <section className="kpis dashboardKpis"><Kpi label="Total invoices" value={summary?.total??'—'} meta="Organization-wide"/><Kpi label="Approved" value={summary?.accepted??'—'} meta="Final invoice decisions" good/><Kpi label="Needs Review" value={summary?.review??'—'} meta="Requires attention" warn/><Kpi label="Rejected" value={summary?.rejected??'—'} meta="Financial decision" bad/><Kpi label="Processing Failed" value={summary?.processingFailed??'—'} meta="Technical failures"/><Kpi label="Currently Processing" value={summary?.currentlyProcessing??'—'} meta="Live batch/invoice work"/><Kpi label="Total vendors" value={summary?.totalVendors??'—'} meta="Vendor master"/></section>
  <section className="dashboardTopGrid"><Card title="Total invoice amount" meta="Database totals, separated by currency"><div className="currencyTotals">{summary?.valueByCurrency?.length?summary.valueByCurrency.map(item=><div key={item.currency}><span>{item.currency}</span><b>{money(item.value,item.currency)}</b></div>):<div className="emptyState">No invoice totals recorded.</div>}</div></Card>
    <Card title="Batch activity" meta="Latest persisted batch results">{summary?.batchActivity?.length?<div className="activityList">{summary.batchActivity.map(batch=><div className="activityRow" key={batch.batchId}><span><b>{batch.batchId}</b><small>{batch.uploaded}/{batch.totalFiles} uploaded · {batch.processed} processed · {batch.failed} failed</small></span><Status value={batch.status}/></div>)}</div>:<div className="emptyState">No batch activity recorded.</div>}</Card>
  </section>
  <section className="grid2"><Card title="Invoice value trend" meta="Monthly totals in the selected currency"><div className="chartHeader"><label htmlFor="trend-currency">Currency</label><select id="trend-currency" value={selectedCurrency} onChange={event=>setTrendCurrency(event.target.value)}>{(currencies.length?currencies:[selectedCurrency]).map(currency=><option key={currency}>{currency}</option>)}</select></div>{trend.length?<div className="chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={trend}><XAxis dataKey="month" stroke="#64748b"/><YAxis stroke="#64748b" tickFormatter={value=>`${selectedCurrency} ${Math.round(value/1000)}k`}/><Tooltip formatter={value=>money(value,selectedCurrency)} contentStyle={{background:'#0d1320',border:'1px solid #263248',borderRadius:10}}/><Area type="monotone" dataKey="value" stroke="#8b7cff" fill="#8b7cff" fillOpacity={0.12} strokeWidth={3}/></AreaChart></ResponsiveContainer></div>:<div className="placeholder">No dated invoices are available to chart yet.</div>}</Card><Card title="Verification outcomes" meta="Portfolio distribution"><div className="donut"><ResponsiveContainer width="58%" height={220}><PieChart><Pie data={pie} dataKey="value" innerRadius={62} outerRadius={88} paddingAngle={4}>{pie.map((_,i)=><Cell key={i} fill={COLORS[i+1]}/>)}</Pie><Tooltip contentStyle={{background:'#0d1320',border:'1px solid #263248'}}/></PieChart></ResponsiveContainer><div className="legend">{pie.map((p,i)=><div key={p.name}><span style={{background:COLORS[i+1]}}/>{p.name}<b>{p.value}</b></div>)}</div></div></Card></section>
  <section className="dashboardTopGrid"><Card title="Recent discrepancies" meta="Needs Review and Rejected invoice records">{summary?.recentDiscrepancies?.length?<div className="tablewrap"><table><thead><tr><th>Invoice</th><th>Vendor</th><th>Status</th><th>Reason</th></tr></thead><tbody>{summary.recentDiscrepancies.map(item=><tr key={item.id} className="clickableRow" onClick={()=>onSelect({id:item.id,invoiceNumber:item.invoiceNumber})}><td>{item.invoiceNumber}</td><td>{item.vendorName||'Unmatched'}</td><td><Status value={item.status}/></td><td>{item.reason||'No decision reason recorded'}</td></tr>)}</tbody></table></div>:<div className="emptyState">No discrepancy records.</div>}</Card>
    <Card title="Recent reviewer decisions" meta="Recorded human review actions">{summary?.reviewerDecisions?.length?<div className="activityList">{summary.reviewerDecisions.map(item=><button type="button" className="activityRow activityButton" key={item.id} onClick={()=>onSelect({id:item.invoiceId,invoiceNumber:item.invoiceNumber})}><span><b>{item.action} · {item.invoiceNumber}</b><small>{item.vendorName||'Unmatched'} · {item.reviewerName} · {new Date(item.createdAt).toLocaleString()}</small>{item.comment&&<small>{item.comment}</small>}</span></button>)}</div>:<div className="emptyState">No reviewer decisions recorded.</div>}</Card>
  </section>
  <section className="card"><div className="cardhead"><div><h3>Recent invoice activity</h3><span>Open any row to inspect the source and verification evidence.</span></div></div><InvoiceTable rows={invoices.slice(0,8)} onSelect={onSelect}/></section>
</>}

function VendorDashboard({summary,invoices,onSelect,loading,error}){
  if(loading&&!summary)return <DashboardLoading label="Loading your company invoice activity…"/>;
  return <>
    {error&&<div className="error" role="alert">{error}</div>}
    <section className="kpis dashboardKpis"><Kpi label="Submitted invoices" value={summary?.total??'—'} meta="Your company records"/><Kpi label="Approved" value={summary?.accepted??'—'} meta="Final decisions" good/><Kpi label="Review required" value={summary?.review??'—'} meta="Clarification may be needed" warn/><Kpi label="Rejected" value={summary?.rejected??'—'} meta="Final decisions" bad/><Kpi label="Pending clarifications" value={summary?.pendingClarifications??'—'} meta="Open review requests"/><Kpi label="Company notifications" value={summary?.companyNotifications?.length??'—'} meta="Recorded communications"/></section>
    <section className="card"><div className="cardhead"><div><h3>Your recent submissions</h3><span>Only invoices associated with your vendor account are shown.</span></div></div>{invoices.length?<InvoiceTable rows={invoices.slice(0,12)} onSelect={onSelect}/>:<div className="emptyState">No invoices have been submitted for this vendor account.</div>}</section>
    <section className="card"><div className="cardhead"><div><h3>Company notifications</h3><span>Communication status for your invoices.</span></div></div>{summary?.companyNotifications?.length?<div className="activityList">{summary.companyNotifications.map(notification=><button type="button" className="activityRow activityButton" key={notification.id} onClick={()=>onSelect({id:notification.invoiceId,invoiceNumber:notification.invoiceNumber})}><span><b>{notification.invoiceNumber} · {notification.decision}</b><small>{notification.channel.toUpperCase()} · {notification.status} · {notification.providerStatus||'Status unavailable'} · {new Date(notification.createdAt).toLocaleString()}</small><small>{notification.message}</small></span></button>)}</div>:<div className="emptyState">No company notifications have been recorded.</div>}</section>
  </>;
}

function DashboardLoading({label}){return <section className="card dashboardLoading" aria-live="polite"><span className="loadingMark"/><span>{label}</span></section>}
function Kpi({label,value,meta,good,warn,bad}){return <div className="kpi"><span>{label}</span><strong>{value}</strong><em className={good?'good':warn?'warn':bad?'bad':''}>{meta}</em></div>}
function Card({title,meta,children}){return <section className="card"><div className="cardhead"><div><h3>{title}</h3><span>{meta}</span></div></div>{children}</section>}

function InvoiceRegister({invoices,onSelect,forcedStatus}) {
  const [q,setQ]=useState('');
  const [status,setStatus]=useState(forcedStatus || '');
  const [rows,setRows]=useState(invoices);
  const [page,setPage]=useState(1);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState('');
  const activeStatus=forcedStatus || status;
  useEffect(()=>{
    let cancelled=false;
    const timer=setTimeout(async()=>{
      setLoading(true);
      setError('');
      try {
        const params=new URLSearchParams({page:'1',limit:'100'});
        if(q.trim()) params.set('q',q.trim());
        if(activeStatus) params.set('status',activeStatus);
        const nextRows=await api(`/invoices?${params}`);
        if(!cancelled){setRows(nextRows);setPage(1);}
      } catch(loadError) {
        if(!cancelled) setError(loadError.message);
      } finally {
        if(!cancelled) setLoading(false);
      }
    },250);
    return ()=>{cancelled=true;clearTimeout(timer);};
  },[q,activeStatus]);
  const loadMore=async()=>{
    setLoading(true);
    setError('');
    try {
      const params=new URLSearchParams({page:String(page+1),limit:'100'});
      if(q.trim()) params.set('q',q.trim());
      if(activeStatus) params.set('status',activeStatus);
      const more=await api(`/invoices?${params}`);
      setRows(current=>[...current,...more]);
      setPage(current=>current+1);
    } catch(loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
    }
  };
  const downloadCsv=async()=>{
    try {
      const token=localStorage.getItem('ie_token');
      const params=new URLSearchParams();
      if(q.trim()) params.set('q',q.trim());
      if(activeStatus) params.set('status',activeStatus);
      const response=await fetch(`${API}/reports/invoices.csv?${params}`,{headers:{Authorization:`Bearer ${token}`}});
      if(!response.ok) throw new Error((await response.json().catch(()=>({}))).message || 'CSV export failed');
      const url=URL.createObjectURL(await response.blob());
      const link=document.createElement('a');
      link.href=url;
      link.download='invoiceeye-invoices.csv';
      link.click();
      URL.revokeObjectURL(url);
    } catch(downloadError) {
      setError(downloadError.message);
    }
  };
  return <section className="card"><div className="toolbar"><div><h3>{forcedStatus?'Review queue':'Invoice register'}</h3><span>{forcedStatus?'Invoices requiring human attention.':'Search, filter and inspect verification evidence.'}</span></div><div className="filters"><input placeholder="Search invoice, vendor or PO" value={q} onChange={e=>setQ(e.target.value)}/>{!forcedStatus&&<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">All statuses</option><option>ACCEPTED</option><option>NEEDS REVIEW</option><option>REJECTED</option><option>PROCESSING FAILED</option></select>}<button type="button" onClick={downloadCsv}>Export CSV</button></div></div>{error&&<div className="error" role="alert">{error}</div>}{loading&&<p className="muted small">Loading invoices…</p>}<InvoiceTable rows={rows} onSelect={onSelect}/>{rows.length===100&&<button className="secondary" disabled={loading} onClick={loadMore}>{loading?'Loading…':'Load more'}</button>}</section>
}
function InvoiceTable({rows,onSelect}){return <div className="tablewrap"><table><thead><tr><th>Invoice</th><th>Vendor</th><th>PO</th><th>Amount</th><th>Risk</th><th>Status</th></tr></thead><tbody>{rows.map(r=><tr key={r.id} onClick={()=>onSelect(r)}><td><b>{r.invoiceNumber}</b>{r.isDemo&&<span className="demoLabel">DEMO</span>}<small>{String(r.invoiceDate||'').slice(0,10)}</small></td><td>{r.vendorName||'Unmatched'}</td><td>{r.poId||'—'}</td><td>{money(r.total,r.currency)}</td><td><span className={`risk ${r.riskScore>=70?'high':r.riskScore>=35?'mid':'low'}`}>{r.riskScore}</span></td><td><Status value={r.status}/></td></tr>)}{!rows.length&&<tr><td colSpan="6" className="empty">No invoices match the current filter. Upload an invoice to get started.</td></tr>}</tbody></table></div>}
function Status({value}){return <span className={`badge ${String(value).replace(/\s/g,'').toLowerCase()}`}>{value}</span>}

function VerifyPage({user,onDone,onSelect,onProcessingChange}) {
  const [mode,setMode]=useState('file');
  const [text,setText]=useState('');
  const [files,setFiles]=useState([]);
  const [batchId,setBatchId]=useState('');
  const [batchDetail,setBatchDetail]=useState(null);
  const [batchHistory,setBatchHistory]=useState([]);
  const [resultTab,setResultTab]=useState('ACCEPTED');
  const [retryItemId,setRetryItemId]=useState('');
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState(null);
  const [fileError,setFileError]=useState('');
  const createId=()=>globalThis.crypto?.randomUUID?.()||`BATCH-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

  const refreshHistory=async()=>{
    try{setBatchHistory(await api('/invoice-batches'));}catch(error){setFileError(error.message);}
  };
  useEffect(()=>{refreshHistory();},[]);

  const applyBatch=details=>{
    setBatchDetail(details);
    setBatchId(details.batch_id);
    setFiles(current=>details.items.map(item=>{
      const local=current.find(file=>file.id===item.itemId);
      const status=item.status==='PROCESSING FAILED'?'processing-failed':item.status==='FAILED'?'failed':
        ['QUEUED','UPLOADING','OCR PROCESSING','VERIFYING'].includes(item.status)?item.status.toLowerCase().replaceAll(' ','-'):'completed';
      const data=item.invoiceId?{id:item.invoiceId,status:item.status,invoiceNumber:item.invoiceNumber,result:{status:item.status}}:
        item.status==='PROCESSING FAILED'?{status:item.status,id:item.invoiceId}:null;
      return {...local,id:item.itemId,file:local?.file||null,name:item.originalName,size:Number(item.fileSize),status,
        attemptNumber:Number(item.latestAttempt),uploadProgress:Number(item.uploadProgress||0),ocrStatus:item.ocrStatus,
        verificationStatus:item.verificationStatus,error:item.error||'',data};
    }));
  };
  const loadBatch=async id=>{
    try{applyBatch(await api(`/invoice-batches/${encodeURIComponent(id)}`));setResult(null);}
    catch(error){setFileError(error.message);}
  };
  const refreshCurrentBatch=async id=>{
    try{const details=await api(`/invoice-batches/${encodeURIComponent(id)}`);applyBatch(details);return details;}
    catch{return null;}
  };

  const selectFiles=fileList=>{
    const selected=Array.from(fileList||[]);
    if(!selected.length)return;
    if(batchId){setFileError('Start a new batch before selecting more documents.');return;}
    const remaining=15-files.length;
    if(remaining<=0){setFileError('A batch can contain at most 15 invoices.');return;}
    const accepted=[];
    const errors=[];
    selected.slice(0,remaining).forEach(file=>{
      if(!/\.(pdf|png|jpe?g|webp|tiff?)$/i.test(file.name))errors.push(`${file.name}: unsupported format.`);
      else if(file.size===0)errors.push(`${file.name}: the file is empty.`);
      else if(file.size>8*1024*1024)errors.push(`${file.name}: exceeds the 8 MB limit.`);
      else accepted.push({id:createId(),file,name:file.name,size:file.size,status:'selected',uploadProgress:0,ocrStatus:'QUEUED',verificationStatus:'QUEUED',error:'',data:null,attemptNumber:1});
    });
    if(selected.length>remaining)errors.push(`Only ${remaining} additional file(s) fit in this 15-document batch.`);
    if(accepted.length)setFiles(current=>[...current,...accepted]);
    setFileError(errors.join(' '));
    setResult(null);
  };

  const recoverSourceFile=async item=>{
    if(item.file)return item.file;
    if(!item.data?.id)throw new Error('The original file is not available in this session. Select it again to retry.');
    const response=await fetch(`${API}/invoices/${encodeURIComponent(item.data.id)}/document`,{
      headers:{Authorization:`Bearer ${localStorage.getItem('ie_token')}`}
    });
    if(!response.ok)throw new Error((await response.json().catch(()=>({}))).message||'Original document could not be loaded for retry.');
    return new File([await response.blob()],item.name,{type:item.file?.type||'application/octet-stream'});
  };

  const processBatch=async(ids,retry=false,replacementFiles=new Map())=>{
    if(busy||!ids.length)return;
    const queue=files.filter(item=>ids.includes(item.id));
    if(!queue.length)return;
    setBusy(true);
    setFileError('');
    onProcessingChange('Uploading');
    let activeBatchId=batchId;
    try{
      if(!activeBatchId){
        activeBatchId=createId();
        await api('/invoice-batches',{method:'POST',body:JSON.stringify({
          batchId:activeBatchId,items:files.map(item=>({itemId:item.id,originalName:item.name,fileSize:item.size}))
        })});
        setBatchId(activeBatchId);
        await refreshHistory();
      }
      const poll=setInterval(()=>{refreshCurrentBatch(activeBatchId);},750);
      await runWithConcurrency(queue,async item=>{
        let attemptNumber=Number(item.attemptNumber||1);
        try{
          const file=await recoverSourceFile({...item,file:replacementFiles.get(item.id)||item.file});
          if(retry){
            const attempt=await api(`/invoice-batches/${encodeURIComponent(activeBatchId)}/items/${encodeURIComponent(item.id)}/retry`,{method:'POST'});
            attemptNumber=attempt.attemptNumber;
          }
          await api(`/invoice-batches/${encodeURIComponent(activeBatchId)}/items/${encodeURIComponent(item.id)}/attempts/${attemptNumber}/start`,{method:'POST'});
          setFiles(current=>current.map(row=>row.id===item.id?{...row,file,attemptNumber,status:'uploading',uploadProgress:0,error:'',data:null}:row));
          const form=new FormData();
          form.append('file',file);
          form.append('batchId',activeBatchId);
          form.append('batchItemId',item.id);
          form.append('batchAttempt',String(attemptNumber));
          let persistedProgress=0;
          let progressWrites=Promise.resolve();
          const data=await uploadInvoiceFile('/invoices/verify',form,progress=>{
            setFiles(current=>current.map(row=>row.id===item.id?{...row,uploadProgress:progress}:row));
            if(progress>=100)onProcessingChange('Processing');
            if(progress===100||progress-persistedProgress>=10){
              persistedProgress=progress;
              progressWrites=progressWrites.then(()=>api(`/invoice-batches/${encodeURIComponent(activeBatchId)}/items/${encodeURIComponent(item.id)}/attempts/${attemptNumber}/progress`,{
                method:'PATCH',body:JSON.stringify({progress})
              })).catch(()=>{});
            }
          });
          await progressWrites;
          const status=data.result?.status||data.status;
          setFiles(current=>current.map(row=>row.id===item.id?{...row,status:status==='PROCESSING FAILED'?'processing-failed':'completed',uploadProgress:100,ocrStatus:'COMPLETE',verificationStatus:status,error:'',data}:row));
        }catch(error){
          if(error.status===422&&error.data?.status==='PROCESSING FAILED'){
            setFiles(current=>current.map(row=>row.id===item.id?{...row,status:'processing-failed',uploadProgress:100,ocrStatus:'FAILED',verificationStatus:'PROCESSING FAILED',error:error.message,data:error.data,attemptNumber}:row));
          }else{
            try{await api(`/invoice-batches/${encodeURIComponent(activeBatchId)}/items/${encodeURIComponent(item.id)}/attempts/${attemptNumber}/failure`,{
              method:'POST',body:JSON.stringify({message:error.message})
            });}catch{}
            setFiles(current=>current.map(row=>row.id===item.id?{...row,status:'failed',verificationStatus:'FAILED',error:error.message,attemptNumber}:row));
          }
        }
      });
      clearInterval(poll);
      const details=await refreshCurrentBatch(activeBatchId);
      await refreshHistory();
      if(details){
        onProcessingChange(details.processingFailures?'Failed':'Completed');
        onDone(`Batch ${activeBatchId}: ${details.totalUploaded} uploaded, ${details.processedSuccessfully} processed, ${details.approved} approved, ${details.needsReview} needs review, ${details.rejected} rejected, ${details.processingFailures} processing failures.`);
      }
    }catch(error){setFileError(error.message);onProcessingChange('Failed');}
    finally{setBusy(false);}
  };

  const submitText=async()=>{
    if(busy||!text.trim())return;
    setBusy(true);
    setResult(null);
    onProcessingChange('Processing');
    const form=new FormData();
    form.append('text',text);
    try{const data=await api('/invoices/verify',{method:'POST',body:form});setResult(data);if(data.result){onProcessingChange('Completed');onDone(`${data.parsed.invoiceNumber} verified — ${data.result.status}`);}else onProcessingChange('Failed');}
    catch(error){setResult({error:error.message,...(error.data||{})});onProcessingChange('Failed');}
    finally{setBusy(false);}
  };
  const onDrop=event=>{event.preventDefault();selectFiles(event.dataTransfer.files);};
  const clearBatch=()=>{setFiles([]);setBatchId('');setBatchDetail(null);setFileError('');setResult(null);};
  const openInvoice=item=>{if(item.data?.id)onSelect({id:item.data.id,invoiceNumber:item.data.invoiceNumber||item.name});};
  const retryable=item=>['failed','processing-failed'].includes(item.status);
  const retryFile=item=>{
    if(item.file||item.data?.id){processBatch([item.id],true);return;}
    setRetryItemId(item.id);
    document.getElementById('batch-retry-file')?.click();
  };
  const visibleResults=(batchDetail?.items||[]).filter(item=>item.status===resultTab);

  return <div className="verifyGrid">
    <section className="card">
      <div className="tabs"><button className={mode==='file'?'sel':''} onClick={()=>setMode('file')}>Document batch</button><button className={mode==='text'?'sel':''} onClick={()=>setMode('text')}>Paste invoice text</button></div>
      {mode==='file'?<div className="drop" onDragOver={event=>event.preventDefault()} onDrop={onDrop}>
        <div className="uploadIcon">⇪</div><h3>Drop invoices here or choose files</h3>
        <p>PDF, PNG, JPG, WEBP or TIFF · up to 15 files · 8 MB each · PDF/image limit: 20 pages</p>
        <input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff" disabled={busy||files.length>=15||Boolean(batchId)} onChange={event=>{selectFiles(event.target.files);event.target.value='';}}/>
        <input id="batch-retry-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff" hidden onChange={event=>{
          const file=event.target.files?.[0];
          event.target.value='';
          const item=files.find(row=>row.id===retryItemId);
          setRetryItemId('');
          if(!file||!item)return;
          if(file.name!==item.name||file.size!==Number(item.size)){
            setFileError(`Choose the original ${item.name} (${(Number(item.size)/1024).toFixed(1)} KB) to retry this batch item.`);
            return;
          }
          processBatch([item.id],true,new Map([[item.id,file]]));
        }}/>
        {fileError&&<div className="error" role="alert">{fileError}</div>}
        {files.length>0&&<div className="batchPanel">
          <div className="toolbar"><div><h3>Batch files</h3><span>{batchId||'Not submitted'} · {files.length}/15 · {MAX_BATCH_CONCURRENCY} concurrent workers</span></div><button type="button" disabled={busy} onClick={clearBatch}>New batch</button></div>
          <div className="tablewrap"><table><thead><tr><th>Document</th><th>Upload</th><th>OCR</th><th>Verification</th><th>Outcome</th><th></th></tr></thead><tbody>
            {files.map(item=><tr key={item.id} onClick={()=>openInvoice(item)} className={item.data?.id?'clickableRow':''}>
              <td><b>{item.name}</b><small>{(Number(item.size||0)/1024).toFixed(1)} KB · {item.id.slice(0,8)}</small></td>
              <td><div className="uploadProgress"><span style={{width:`${item.uploadProgress||0}%`}}/></div><small>{item.status==='selected'?'Ready':`${item.uploadProgress||0}%`}</small></td>
              <td>{item.ocrStatus||'QUEUED'}</td><td>{item.verificationStatus||'QUEUED'}</td>
              <td>{item.data?.result?.status||item.data?.status||item.status}{item.error&&<small className="error">{item.error}</small>}</td>
              <td>{retryable(item)&&<button type="button" disabled={busy} onClick={event=>{event.stopPropagation();retryFile(item);}}>{item.file||item.data?.id?'Retry':'Select to retry'}</button>}{item.status==='selected'&&<button type="button" disabled={busy} onClick={event=>{event.stopPropagation();setFiles(current=>current.filter(file=>file.id!==item.id));}}>Remove</button>}</td>
            </tr>)}
          </tbody></table></div>
          {batchDetail&&<div className="batchSummary"><span>Total uploaded <b>{batchDetail.totalUploaded}</b></span><span>Processed successfully <b>{batchDetail.processedSuccessfully}</b></span><span>Approved <b>{batchDetail.approved}</b></span><span>Needs Review <b>{batchDetail.needsReview}</b></span><span>Rejected <b>{batchDetail.rejected}</b></span><span>Processing failures <b>{batchDetail.processingFailures}</b></span></div>}
          <button className="primary wide" disabled={busy||!files.some(item=>item.status==='selected')} onClick={()=>processBatch(files.filter(item=>item.status==='selected').map(item=>item.id))}>{busy?'Processing batch…':'Upload and process batch'}</button>
          {files.some(retryable)&&<button className="secondary wide" disabled={busy} onClick={()=>processBatch(files.filter(retryable).map(item=>item.id),true)}>Retry failed documents</button>}
        </div>}
      </div>:<textarea className="invoiceText" value={text} onChange={event=>setText(event.target.value)} placeholder="Paste the invoice text to verify."/>}
      {mode==='text'&&<button className="primary wide" disabled={busy||!text.trim()} onClick={submitText}>{busy?'Extracting & verifying…':'Run verification'}</button>}
      <p className="muted small">Each document is validated and processed independently. OCR or file errors do not stop the rest of the batch.</p>
      <section className="batchHistory"><h3>Batch history</h3>{batchHistory.length?batchHistory.map(batch=><button type="button" className="batchHistoryRow" key={batch.batch_id} onClick={()=>loadBatch(batch.batch_id)}><span><b>{batch.batch_id}</b><small>{new Date(batch.created_at).toLocaleString()}</small></span><span>{batch.totalUploaded} files · {batch.processedSuccessfully} processed · {batch.processingFailures} failed</span><Status value={batch.status}/></button>):<p className="muted small">No saved batches.</p>}</section>
    </section>

    <section className="card"><div className="cardhead"><div><h3>{result?'Verification result':'Batch results'}</h3><span>{batchDetail?`${batchDetail.batch_id} · ${batchDetail.status}`:'Select a batch to inspect its outcomes.'}</span></div></div>
      {result?result.status==='PROCESSING FAILED'?<div className="processingFailure"><Status value={result.status}/><p>{result.processingFailure?.message||result.error}</p><small>Case {result.id} was recorded. No financial decision was made.</small></div>:result.error?<div className="error" role="alert">{result.error}</div>:<VerificationResult result={result}/>:batchDetail?<>
        <div className="resultTabs">{[['ACCEPTED','Approved',batchDetail.approved],['NEEDS REVIEW','Needs Review',batchDetail.needsReview],['REJECTED','Rejected',batchDetail.rejected]].map(([key,label,count])=><button type="button" key={key} className={resultTab===key?'selected':''} onClick={()=>setResultTab(key)}>{label} <b>{count}</b></button>)}</div>
        {visibleResults.length?<div className="batchResultList">{visibleResults.map(item=><button type="button" className="batchResultRow" key={item.itemId} onClick={()=>item.invoiceId&&onSelect({id:item.invoiceId,invoiceNumber:item.invoiceNumber||item.originalName})} disabled={!item.invoiceId}><span><b>{item.invoiceNumber||item.originalName}</b><small>{item.originalName} · {item.vendorId||'Vendor unresolved'}</small></span><span>{money(item.total,item.currency)}</span><Status value={item.status}/></button>)}</div>:<div className="placeholder">No {resultTab.toLowerCase()} invoices in this batch.</div>}
      </>:<div className="placeholder">Batch history and saved invoice decisions appear here.</div>}
    </section>
  </div>;
}
function VerificationResult({result}){return <div className="result"><div className="resultTop"><div><span className="label">Decision</span><div className="decision"><Status value={result.result.status}/></div></div><div className="scoreBox"><span>Rule attention score</span><strong>{result.result.riskScore}<small>/99</small></strong></div></div><div className="detailgrid"><Field label="Invoice" value={result.parsed.invoiceNumber}/><Field label="Invoice date" value={result.parsed.invoiceDate}/><Field label="Vendor" value={result.parsed.vendor||'Unmatched'}/><Field label="Tax ID" value={result.parsed.taxId}/><Field label="Purchase Order" value={result.parsed.poNumber||'—'}/><Field label="Source" value={result.extractionMethod}/><Field label="Pages" value={result.pagesProcessed}/><Field label="Subtotal" value={money(result.parsed.subtotal,result.parsed.currency)}/><Field label="CGST" value={money(result.parsed.cgst,result.parsed.currency)}/><Field label="SGST" value={money(result.parsed.sgst,result.parsed.currency)}/><Field label="Tax" value={money(result.parsed.tax,result.parsed.currency)}/><Field label="Discount" value={money(result.parsed.discount,result.parsed.currency)}/><Field label="Total" value={money(result.parsed.total,result.parsed.currency)}/><Field label="Quantity" value={result.parsed.quantity}/><Field label="Unit price" value={money(result.parsed.unitPrice,result.parsed.currency)}/></div>{result.parsed.lineItems?.length>0&&<><h4>Extracted line items</h4><div className="tablewrap"><table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Declared line total</th></tr></thead><tbody>{result.parsed.lineItems.map((item,index)=><tr key={index}><td>{item.description||'—'}</td><td>{item.quantity??'—'}</td><td>{money(item.unitPrice,result.parsed.currency)}</td><td>{money(item.lineTotal,result.parsed.currency)}</td></tr>)}</tbody></table></div></>}<h4>Verification evidence</h4><div className="reasons">{result.result.checks.map((check,index)=><div className={`finding ${check.passed?'passed':'attention'}`} key={index}><b>{String(check.name).replaceAll('_',' ')}: {check.passed?'Pass':'Review'}</b><span>{check.message}</span></div>)}</div></div>}
function Field({label,value}){return <div><span>{label}</span><b>{value??'—'}</b></div>}
function money(v,currency='INR'){
  if(v==null)return '—';
  try{return new Intl.NumberFormat('en-IN',{style:'currency',currency:currency||'INR'}).format(Number(v));}
  catch{return `${currency||''} ${Number(v).toLocaleString('en-IN')}`.trim();}
}
function safeJson(value){if(!value)return []; if(Array.isArray(value))return value; try{return JSON.parse(value)}catch{return []}}

async function downloadInvoiceDocument(invoiceId) {
  const response=await fetch(`${API}/invoices/${encodeURIComponent(invoiceId)}/document`,{
    headers:{Authorization:`Bearer ${localStorage.getItem('ie_token')}`}
  });
  if(!response.ok)throw new Error((await response.json().catch(()=>({}))).message||'Document download failed');
  const url=URL.createObjectURL(await response.blob());
  const link=document.createElement('a');
  link.href=url;
  link.download=`${invoiceId}-source`;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function InvoiceDrawer({data,user,onClose,onUpdated}) {
  const [detail,setDetail]=useState(null);
  const [loadError,setLoadError]=useState('');
  const [busy,setBusy]=useState(false);
  const [comment,setComment]=useState('');
  const [vendorMessage,setVendorMessage]=useState('');
  const [actionError,setActionError]=useState('');
  const [documentError,setDocumentError]=useState('');
  const [notificationChannel,setNotificationChannel]=useState('email');
  const [notificationPreview,setNotificationPreview]=useState(null);
  const [notificationHistory,setNotificationHistory]=useState([]);
  const [notificationBusy,setNotificationBusy]=useState(false);
  const [recipientConfirmation,setRecipientConfirmation]=useState('');
  const [notificationError,setNotificationError]=useState('');
  const [notificationMessage,setNotificationMessage]=useState('');
  useEffect(()=>{
    let active=true;
    api(`/invoices/${encodeURIComponent(data.id)}`).then(async value=>{
      if(!active)return;
      setDetail(value);
      if(user.role==='admin'){
        try{setNotificationHistory(await api(`/invoices/${encodeURIComponent(data.id)}/notifications`));}
        catch(error){if(active)setNotificationError(error.message);}
      }
    }).catch(error=>{if(active)setLoadError(error.message);});
    return ()=>{active=false;};
  },[data.id,user.role]);
  if(!detail)return <div className="overlay"><div className="drawer"><button className="close" onClick={onClose}>×</button>{loadError?<div className="error" role="alert">{loadError}</div>:<div className="placeholder">Loading invoice…</div>}</div></div>;
  const inv=detail.invoice;
  const review=async action=>{
    setBusy(true);
    setActionError('');
    try{await api(`/invoices/${encodeURIComponent(inv.invoice_id)}/review`,{method:'POST',body:JSON.stringify({action,comment,vendorMessage})});onUpdated();}
    catch(error){setActionError(error.message);}
    finally{setBusy(false);}
  };
  const download=async()=>{
    setDocumentError('');
    try{await downloadInvoiceDocument(inv.invoice_id);}
    catch(error){setDocumentError(error.message);}
  };
  const previewNotification=async()=>{
    setNotificationBusy(true);
    setNotificationError('');
    setNotificationMessage('');
    setRecipientConfirmation('');
    try{
      setNotificationPreview(await api(`/invoices/${encodeURIComponent(inv.invoice_id)}/notifications/preview?channel=${encodeURIComponent(notificationChannel)}`));
    }catch(error){setNotificationError(error.message);}
    finally{setNotificationBusy(false);}
  };
  const sendNotification=async()=>{
    if(!notificationPreview?.canSend||recipientConfirmation!==notificationPreview.recipient)return;
    setNotificationBusy(true);
    setNotificationError('');
    try{
      const sent=await api(`/invoices/${encodeURIComponent(inv.invoice_id)}/notifications`,{
        method:'POST',body:JSON.stringify({channel:notificationChannel,recipient:notificationPreview.recipient,confirmed:true})
      });
      setNotificationMessage(sent.status==='ACCEPTED'
        ? `Accepted by ${sent.provider}; delivery confirmation is not available.`
        : `${sent.status}: ${sent.error||sent.providerStatus||'Check provider response.'}`);
      setNotificationPreview(null);
      setRecipientConfirmation('');
      setNotificationHistory(await api(`/invoices/${encodeURIComponent(inv.invoice_id)}/notifications`));
    }catch(error){setNotificationError(error.message);}
    finally{setNotificationBusy(false);}
  };
  const retryNotification=async notificationId=>{
    setNotificationBusy(true);
    setNotificationError('');
    setNotificationMessage('');
    try{
      const retried=await api(`/notifications/${encodeURIComponent(notificationId)}/retry`,{method:'POST'});
      setNotificationMessage(retried.status==='ACCEPTED'
        ? `Retry accepted by ${retried.provider}; delivery confirmation is not available.`
        : `${retried.status}: ${retried.error||retried.providerStatus||'Check provider response.'}`);
      setNotificationHistory(await api(`/invoices/${encodeURIComponent(inv.invoice_id)}/notifications`));
    }catch(error){setNotificationError(error.message);}
    finally{setNotificationBusy(false);}
  };
  return <div className="overlay"><div className="drawer">
    <button className="close" onClick={onClose} aria-label="Close invoice details">×</button>
    <div className="eyebrow">VERIFICATION RECORD</div><h2>{inv.invoice_number}</h2>
    {inv.is_demo&&<span className="demoLabel">SYNTHETIC DEMO RECORD</span>}
    <Status value={inv.status}/>
    {inv.has_document&&<button className="secondary" onClick={download}>Download original document</button>}
    {documentError&&<div className="error" role="alert">{documentError}</div>}
    <div className="detailgrid widegrid">
      <Field label="Vendor" value={inv.vendorName||'Unmatched'}/><Field label="PO" value={inv.po_id||'—'}/>
      <Field label="Invoice date" value={String(inv.invoice_date||'').slice(0,10)}/><Field label="Risk score" value={`${inv.risk_score}/99`}/>
      <Field label="Subtotal" value={money(inv.subtotal,inv.currency)}/><Field label="Tax" value={money(inv.tax,inv.currency)}/>
      <Field label="Total" value={money(inv.total,inv.currency)}/><Field label="Source" value={inv.source_type}/>
    </div>
    {user.role==='admin'&&['ACCEPTED','NEEDS REVIEW','REJECTED'].includes(inv.status)&&<section className="notificationPanel">
      <h4>Notify vendor of final decision</h4>
      <div className="notificationControls"><select aria-label="Notification channel" value={notificationChannel} onChange={event=>{setNotificationChannel(event.target.value);setNotificationPreview(null);setRecipientConfirmation('');}}><option value="email">Email</option><option value="whatsapp">WhatsApp Business</option><option value="sms">SMS</option></select><button className="secondary" disabled={notificationBusy} onClick={previewNotification}>Preview message</button></div>
      {notificationError&&<div className="error" role="alert">{notificationError}</div>}{notificationMessage&&<div className="notificationInfo" role="status">{notificationMessage}</div>}
      {notificationPreview&&<div className="notificationPreview"><b>{notificationPreview.status==='INTEGRATION NOT CONFIGURED'?'Integration Not Configured':notificationPreview.message}</b><Field label="Provider" value={notificationPreview.configuration?.provider}/><Field label="Decision" value={notificationPreview.decision}/><Field label="Recipient" value={notificationPreview.recipient||'No contact recorded'}/><Field label="Contact verified" value={notificationPreview.contact?.verified?'Yes':'No'}/><Field label="Consent recorded" value={notificationPreview.contact?.consent?'Yes':'No'}/>{notificationPreview.channel==='whatsapp'&&<small>Meta sends the configured approved template; verify its body matches the displayed parameters.</small>}<div className="notificationMessagePreview">{notificationPreview.rendered?.preview||notificationPreview.rendered?.body}</div>{notificationPreview.canSend&&<><label className="recipientConfirm">Type the recipient to confirm<input value={recipientConfirmation} onChange={event=>setRecipientConfirmation(event.target.value)} placeholder={notificationPreview.recipient}/></label><button className="primary" disabled={notificationBusy||recipientConfirmation!==notificationPreview.recipient} onClick={sendNotification}>{notificationBusy?'Submitting…':'Confirm and send'}</button></>}</div>}
      {notificationHistory.length>0&&<div className="notificationHistory"><b>Communication history</b>{notificationHistory.map(item=><div className="notificationRecord" key={item.notificationId}><span><b>{item.channel.toUpperCase()} · {item.status}</b><small>{new Date(item.createdAt).toLocaleString()} · attempt {item.attemptNumber} · {item.providerStatus||'No provider status'}</small>{item.providerMessageId&&<small>Provider ID: {item.providerMessageId}</small>}{item.error&&<small className="error">{item.error}</small>}</span>{item.status==='FAILED'&&<button className="secondary" disabled={notificationBusy} onClick={()=>retryNotification(item.notificationId)}>Retry failed send</button>}</div>)}</div>}
    </section>}
    <h4>Verification checks</h4><div className="reasons">{safeJson(detail.verification?.checks_json).map((check,index)=><div key={index}>{check.passed?'✓':'!'} {check.message}</div>)}</div>
    <h4>Line items</h4>{detail.items.map((item,index)=><div className="lineItem" key={index}><span>{item.description}</span><b>{item.quantity} × {money(item.unit_price,inv.currency)}</b></div>)}
    {user.role==='admin'&&<AdminExtractionCorrection detail={detail} onSaved={onUpdated}/>}
    <h4>Reviewer action</h4>
    {['reviewer','admin'].includes(user.role)&&inv.status==='NEEDS REVIEW'&&<><textarea className="comment" value={comment} maxLength={1000} onChange={event=>setComment(event.target.value)} placeholder="Internal review note or decision rationale"/><textarea className="comment" value={vendorMessage} maxLength={1000} onChange={event=>setVendorMessage(event.target.value)} placeholder="Correction or clarification requested from vendor"/><div className="reviewBtns"><button disabled={busy||!comment.trim()} onClick={()=>review('APPROVE')} className="approve">Approve</button><button disabled={busy||!vendorMessage.trim()} onClick={()=>review('REQUEST_REVIEW')} className="request">Request clarification</button><button disabled={busy||!comment.trim()} onClick={()=>review('REJECT')} className="reject">Reject</button></div>{actionError&&<div className="error" role="alert">{actionError}</div>}</>}
    <h4>Status history</h4>
    {detail.history?.length?detail.history.map(entry=><div className="statusHistory" key={entry.id}><div className="historyHeading"><b>{entry.oldStatus?`${entry.oldStatus} → `:''}{entry.newStatus}</b><time>{new Date(entry.createdAt).toLocaleString()}</time></div><span>{entry.eventType==='AUTOMATIC'?'Automatic verification':entry.eventType==='PROCESSING'?'Document processing':`Reviewed by ${entry.actorName||'authorized reviewer'}`}</span>{entry.reason&&<p>{entry.reason}</p>}{entry.vendorMessage&&<p><b>Requested from vendor:</b> {entry.vendorMessage}</p>}{entry.internalNote&&user.role==='admin'&&<p className="internalNote"><b>Internal Admin note:</b> {entry.internalNote}</p>}</div>):<p className="muted small">No status history recorded.</p>}
    {user.role!=='vendor'&&detail.reviews?.length>0&&<><h4>Review actions</h4>{detail.reviews.map(reviewAction=><div className="auditrow" key={reviewAction.review_id}><div className="auditdot"/><div><b>{reviewAction.action}</b><p>{reviewAction.comment||'No internal note'}</p></div><time>{new Date(reviewAction.created_at).toLocaleString()}</time></div>)}</>}
  </div></div>;
}

function AdminExtractionCorrection({detail,onSaved}) {
  const saved=typeof detail.invoice.extracted_json==='string'?safeObject(detail.invoice.extracted_json):detail.invoice.extracted_json||{};
  const extracted=saved.parsed||saved;
  const [lineItemsText,setLineItemsText]=useState(()=>JSON.stringify(extracted.lineItems||detail.items.map(item=>({
    description:item.description,quantity:item.quantity,unitPrice:item.unit_price,lineTotal:item.declared_line_total
  })),null,2));
  const [fields,setFields]=useState(()=>({
    invoiceNumber:extracted.invoiceNumber||detail.invoice.invoice_number||'',
    invoiceDate:extracted.invoiceDate||String(detail.invoice.invoice_date||'').slice(0,10),
    vendor:extracted.vendor||detail.invoice.vendorName||'',
    poNumber:extracted.poNumber||detail.invoice.po_id||'',
    currency:extracted.currency||detail.invoice.currency||'INR',
    quantity:extracted.quantity??detail.items[0]?.quantity??'',
    unitPrice:extracted.unitPrice??detail.items[0]?.unit_price??'',
    subtotal:extracted.subtotal??detail.invoice.subtotal??'',
    tax:extracted.tax??detail.invoice.tax??'',
    discount:extracted.discount??detail.invoice.discount??'',
    total:extracted.total??detail.invoice.total??''
  }));
  const [correctionReason,setCorrectionReason]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const save=async()=>{
    setBusy(true);
    setError('');
    let lineItems;
    try{lineItems=JSON.parse(lineItemsText);}catch{setError('Line items must be valid JSON.');setBusy(false);return;}
    const body={...fields,lineItems,correctionReason};
    for(const field of ['quantity','unitPrice','subtotal','tax','discount','total'])body[field]=fields[field]===''?null:Number(fields[field]);
    try{
      await api(`/invoices/${encodeURIComponent(detail.invoice.invoice_id)}/extraction`,{method:'PATCH',body:JSON.stringify(body)});
      onSaved();
    }catch(saveError){setError(saveError.message);}
    finally{setBusy(false);}
  };
  const update=(field,value)=>setFields(current=>({...current,[field]:value}));
  return <section className="correctionPanel"><h4>Correct extracted fields</h4><div className="formgrid correctionGrid">
    {['invoiceNumber','invoiceDate','vendor','poNumber','currency','quantity','unitPrice','subtotal','tax','discount','total'].map(field=><label key={field}>{field.replace(/[A-Z]/g,letter=>` ${letter.toLowerCase()}`)}<input type={['quantity','unitPrice','subtotal','tax','discount','total'].includes(field)?'number':'text'} step="any" value={fields[field]} onChange={event=>update(field,event.target.value)}/></label>)}
  </div><label className="lineItemsEditor">Line items<textarea className="comment" value={lineItemsText} onChange={event=>setLineItemsText(event.target.value)} spellCheck="false"/></label><textarea className="comment" value={correctionReason} maxLength={1000} onChange={event=>setCorrectionReason(event.target.value)} placeholder="Evidence-based reason for this extraction correction"/><button className="secondary" disabled={busy||!correctionReason.trim()} onClick={save}>{busy?'Rechecking…':'Save corrections and reverify'}</button>{error&&<div className="error" role="alert">{error}</div>}</section>;
}

function safeObject(value){try{return JSON.parse(value)}catch{return {}}}

function VendorInsights({onSelect}){
  const [query,setQuery]=useState('');
  const [results,setResults]=useState(null);
  const [selectedVendor,setSelectedVendor]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const search=async event=>{
    event?.preventDefault();
    if(query.trim().length<2){setError('Enter at least two characters.');return;}
    setBusy(true);setError('');setSelectedVendor(null);
    try{setResults(await api(`/admin/vendor-insights?q=${encodeURIComponent(query.trim())}`));}
    catch(searchError){setError(searchError.message);setResults(null);}
    finally{setBusy(false);}
  };
  const rangeLabel=ranges=>ranges?.length?ranges.map(range=>`${money(range.min,range.currency)}–${money(range.max,range.currency)} (${range.samples} records)`).join(' · '):'No approved price records';
  return <div className="vendorInsights">
    <section className="card"><div className="cardhead"><div><h3>Vendor Insights & Recommendations</h3><span>Historical evidence from approved invoices and company purchase orders. No purchase orders are created here.</span></div></div>
      <form className="insightSearch" onSubmit={search}><input value={query} onChange={event=>setQuery(event.target.value)} placeholder="Search product, SKU or vendor category" aria-label="Search historical supplier records"/><button className="primary" disabled={busy}>{busy?'Searching…':'Search history'}</button></form>
      {error&&<div className="error" role="alert">{error}</div>}
      {results&&<>{results.message?<div className="insightEmpty">Insufficient historical evidence to generate a reliable vendor recommendation.</div>:<div className="tablewrap"><table><thead><tr><th>Vendor</th><th>Historical match</th><th>Approved transactions</th><th>Approved invoice prices</th><th>PO prices</th><th>Discrepancies</th><th>Latest transaction</th></tr></thead><tbody>
        {results.vendors.map(vendor=><tr key={vendor.vendorId} onClick={()=>setSelectedVendor(vendor)} className="clickableRow"><td><b>{vendor.vendorName}</b><small>{vendor.vendorId} · {vendor.category||'Category not recorded'}</small></td><td>{vendor.matchedProducts.join(', ')||'Category record'}</td><td>{vendor.approvedTransactionCount}</td><td>{rangeLabel(vendor.approvedInvoicePriceRanges)}</td><td>{rangeLabel(vendor.purchaseOrderPriceRanges)}</td><td>{vendor.discrepancyRecord.needsReview} needs review · {vendor.discrepancyRecord.rejected} rejected</td><td>{vendor.latestTransactionDate||'Not recorded'}</td></tr>)}
      </tbody></table></div>}</>}
    </section>
    {selectedVendor&&<section className="card insightEvidence"><div className="cardhead"><div><h3>{selectedVendor.vendorName}</h3><span>{selectedVendor.vendorId} · {selectedVendor.category||'Category not recorded'}</span></div><button className="secondary" onClick={()=>setSelectedVendor(null)}>Close evidence</button></div>
      <h4>Why this supplier matched</h4><ul>{selectedVendor.recommendationReasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul>
      <p className="muted small">Historical approved invoice prices describe past transactions only; they are not guaranteed current market prices. This system does not assess inventory availability.</p>
      <p className="muted small">{selectedVendor.deliveryPerformance.reason}</p>
      <h4>Approved invoice evidence</h4>
      {selectedVendor.approvedInvoiceRecords.length?<div className="tablewrap"><table><thead><tr><th>Invoice</th><th>Date</th><th>PO</th><th>Product</th><th>Unit price</th><th>Status</th></tr></thead><tbody>{selectedVendor.approvedInvoiceRecords.map(record=><tr key={`${record.invoiceId}-${record.sku||record.description}`} onClick={()=>onSelect({id:record.invoiceId,invoiceNumber:record.invoiceNumber})} className="clickableRow"><td>{record.invoiceNumber}</td><td>{String(record.date||'').slice(0,10)}</td><td>{record.poId||'—'}</td><td>{record.sku||record.description||'—'}</td><td>{money(record.unitPrice,record.currency)}</td><td><Status value={record.status}/></td></tr>)}</tbody></table></div>:<p className="muted small">No approved invoice transactions matched.</p>}
      <h4>Purchase-order history</h4>{selectedVendor.purchaseOrderRecords.length?selectedVendor.purchaseOrderRecords.map(order=><div className="insightRecord" key={order.poId}><b>{order.poId} · {order.status}</b><span>{order.date||'Date not recorded'} · {order.currency}</span>{order.items.map((item,index)=><p key={index}>{item.sku&&`${item.sku} · `}{item.description} · {item.quantity} × {money(item.unitPrice,order.currency)}</p>)}</div>):<p className="muted small">No matching purchase-order lines found.</p>}
      <h4>Historical discrepancy outcomes</h4>{selectedVendor.discrepancyRecord.records.length?selectedVendor.discrepancyRecord.records.map(record=><div className="insightRecord" key={record.invoiceId}><button className="textAction" onClick={()=>onSelect({id:record.invoiceId,invoiceNumber:record.invoiceNumber})}>{record.invoiceNumber} · {record.status}</button><span>{record.reason||'No recorded verification reason'}</span></div>):<p className="muted small">No matching needs-review or rejected invoice records.</p>}
    </section>}
  </div>;
}

function Vendors({user}){
  const [rows,setRows]=useState([]);
  const [form,setForm]=useState({vendorId:'',name:'',email:'',category:'',taxId:''});
  const [error,setError]=useState('');
  const load=()=>api('/vendors').then(setRows).catch(loadError=>setError(loadError.message));
  useEffect(load,[]);
  const save=async()=>{
    setError('');
    try{await api('/vendors',{method:'POST',body:JSON.stringify(form)});setForm({vendorId:'',name:'',email:'',category:'',taxId:''});await load();}
    catch(saveError){setError(saveError.message);}
  };
  return <div className="vendorManagement"><section className="card"><div className="cardhead"><div><h3>Vendor master</h3><span>Trusted supplier records used during matching.</span></div></div>{error&&<div className="error" role="alert">{error}</div>}<div className="tablewrap"><table><thead><tr><th>ID</th><th>Vendor</th><th>Category</th><th>Status</th></tr></thead><tbody>{rows.map(v=><tr key={v.vendor_id}><td>{v.vendor_id}</td><td><b>{v.name}</b><small>{v.email}</small></td><td>{v.category}</td><td><Status value={v.status}/></td></tr>)}</tbody></table></div></section>
    {user.role==='admin'&&<div className="split"><section className="card"><div className="cardhead"><div><h3>Add vendor</h3><span>Admin-only master-data control.</span></div></div><div className="formgrid"><input placeholder="Vendor ID" value={form.vendorId} onChange={event=>setForm({...form,vendorId:event.target.value})}/><input placeholder="Name" value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/><input placeholder="Email" value={form.email} onChange={event=>setForm({...form,email:event.target.value})}/><input placeholder="Category" value={form.category} onChange={event=>setForm({...form,category:event.target.value})}/><input placeholder="Tax ID" value={form.taxId} onChange={event=>setForm({...form,taxId:event.target.value})}/><button className="primary" onClick={save}>Create vendor</button></div></section><NotificationContactManager vendors={rows}/></div>}
  </div>;
}

function NotificationContactManager({vendors}){
  const [vendorId,setVendorId]=useState('');
  const [channel,setChannel]=useState('email');
  const [recipient,setRecipient]=useState('');
  const [verified,setVerified]=useState(false);
  const [consent,setConsent]=useState(false);
  const [verificationMethod,setVerificationMethod]=useState('');
  const [consentEvidence,setConsentEvidence]=useState('');
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const selectedVendor=vendors.find(vendor=>vendor.vendor_id===vendorId);
  useEffect(()=>{
    if(!vendorId){setRecipient('');setVerified(false);setConsent(false);return;}
    let active=true;
    api(`/vendors/${encodeURIComponent(vendorId)}/notification-contacts`).then(contacts=>{
      if(!active)return;
      const current=contacts.find(contact=>contact.channel===channel);
      setRecipient(current?.recipient||(channel==='email'?selectedVendor?.email||'':''));
      setVerified(Boolean(current?.isVerified));
      setConsent(Boolean(current?.hasConsent));
      setVerificationMethod(current?.verificationMethod||'');
      setConsentEvidence(current?.consentEvidence||'');
    }).catch(loadError=>{if(active)setError(loadError.message);});
    return ()=>{active=false;};
  },[vendorId,channel,selectedVendor?.email]);
  const save=async()=>{
    setError('');setMessage('');
    try{
      await api(`/vendors/${encodeURIComponent(vendorId)}/notification-contacts/${channel}`,{
        method:'PUT',body:JSON.stringify({recipient,verified,consent,verificationMethod,consentEvidence})
      });
      setMessage('Contact verification and consent record saved.');
    }catch(saveError){setError(saveError.message);}
  };
  return <section className="card"><div className="cardhead"><div><h3>Vendor notification contacts</h3><span>Sending stays blocked until verification and consent evidence are recorded.</span></div></div>
    <div className="formgrid"><select value={vendorId} onChange={event=>setVendorId(event.target.value)}><option value="">Select vendor</option>{vendors.map(vendor=><option key={vendor.vendor_id} value={vendor.vendor_id}>{vendor.vendor_id} — {vendor.name}</option>)}</select><select value={channel} onChange={event=>setChannel(event.target.value)}><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select><input value={recipient} onChange={event=>setRecipient(event.target.value)} placeholder={channel==='email'?'vendor@example.com':'+14155550123'} aria-label="Verified notification recipient"/><input value={verificationMethod} onChange={event=>setVerificationMethod(event.target.value)} placeholder="Contact verification evidence"/><input value={consentEvidence} onChange={event=>setConsentEvidence(event.target.value)} placeholder="Consent record or reference"/><label className="contactToggle"><input type="checkbox" checked={verified} onChange={event=>setVerified(event.target.checked)}/> Contact verified</label><label className="contactToggle"><input type="checkbox" checked={consent} onChange={event=>setConsent(event.target.checked)}/> Vendor consent recorded</label><button className="secondary" disabled={!vendorId} onClick={save}>Save contact controls</button></div>
    {error&&<div className="error" role="alert">{error}</div>}{message&&<div className="notificationInfo" role="status">{message}</div>}
  </section>;
}

function PurchaseOrders({user}){
  const [rows,setRows]=useState([]);
  const [vendors,setVendors]=useState([]);
  const [search,setSearch]=useState('');
  const [statusFilter,setStatusFilter]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [items,setItems]=useState([{sku:'',description:'',quantity:'',unitPrice:''}]);
  const [form,setForm]=useState({poId:'',vendorId:'',poDate:'',status:'APPROVED',currency:'INR',notes:''});
  const [importCsv,setImportCsv]=useState('');
  const [preview,setPreview]=useState(null);
  const [importMessage,setImportMessage]=useState('');
  const isAdmin=user.role==='admin';
  const canManage=['admin','finance'].includes(user.role);

  const load=async()=>{
    setError('');
    try{
      const params=new URLSearchParams();
      if(search.trim())params.set('q',search.trim());
      if(statusFilter)params.set('status',statusFilter);
      const [nextRows,nextVendors]=await Promise.all([api(`/purchase-orders?${params}`),api('/vendors')]);
      setRows(nextRows);
      setVendors(nextVendors);
    }catch(loadError){setError(loadError.message);}
  };
  useEffect(()=>{load();},[search,statusFilter]);

  const createPO=async()=>{
    setBusy(true);
    setError('');
    try{
      await api('/purchase-orders',{method:'POST',body:JSON.stringify({
        ...form,items:items.map(item=>({...item,quantity:Number(item.quantity),unitPrice:Number(item.unitPrice)}))
      })});
      setForm({poId:'',vendorId:'',poDate:'',status:'APPROVED',currency:'INR',notes:''});
      setItems([{sku:'',description:'',quantity:'',unitPrice:''}]);
      await load();
    }catch(saveError){setError(saveError.message);}
    finally{setBusy(false);}
  };
  const previewFile=async event=>{
    const file=event.target.files?.[0];
    event.target.value='';
    if(!file)return;
    setImportMessage('');
    try{
      const csv=await file.text();
      setImportCsv(csv);
      setPreview(await api('/purchase-orders/import/preview',{method:'POST',body:JSON.stringify({csv})}));
    }catch(previewError){setPreview(null);setError(previewError.message);}
  };
  const commitImport=async()=>{
    setBusy(true);
    setError('');
    try{
      const result=await api('/purchase-orders/import',{method:'POST',body:JSON.stringify({csv:importCsv})});
      setImportMessage(`${result.imported} purchase orders imported.`);
      setPreview(null);
      setImportCsv('');
      await load();
    }catch(importError){setError(importError.message);}
    finally{setBusy(false);}
  };

  return <div className="poModule">
    <section className="card">
      <div className="toolbar"><div><h3>Purchase-order register</h3><span>{rows.length} records · remaining quantities are calculated from linked invoices</span></div>
        <div className="filters"><input aria-label="Search purchase orders" placeholder="Search PO, vendor or notes" value={search} onChange={event=>setSearch(event.target.value)}/><select aria-label="Filter purchase orders by status" value={statusFilter} onChange={event=>setStatusFilter(event.target.value)}><option value="">All statuses</option>{['DRAFT','APPROVED','CLOSED','CANCELLED'].map(value=><option key={value}>{value}</option>)}</select></div>
      </div>
      {error&&<div className="error" role="alert">{error}</div>}{importMessage&&<div className="successMessage" role="status">{importMessage}</div>}
      <div className="tablewrap poTable"><table><thead><tr><th>PO number</th><th>Vendor</th><th>Date</th><th>Status</th><th>Currency</th><th>Lines</th><th>Ordered</th><th>Invoiced</th><th>Remaining to invoice</th></tr></thead><tbody>
        {rows.map(po=><tr key={po.id}><td><b>{po.id}</b>{po.notes&&<small>{po.notes}</small>}</td><td>{po.vendorName}</td><td>{String(po.poDate||'').slice(0,10)||'—'}</td><td><Status value={po.status}/></td><td>{po.currency}</td><td><div className="poLineList">{po.items.map((item,index)=><span key={`${po.id}-${index}`}>{item.sku&&<b>{item.sku} · </b>}{item.description} · {item.quantity} × {money(item.unitPrice,po.currency)}</span>)}</div></td><td>{po.orderedQuantity}</td><td>{po.invoicedQuantity}</td><td><b>{po.remainingQuantity}</b></td></tr>)}
        {!rows.length&&<tr><td colSpan="9" className="empty">No purchase orders match this search.</td></tr>}
      </tbody></table></div>
    </section>

    {isAdmin&&<section className="card poImport">
      <div className="cardhead"><div><h3>Import existing purchase orders</h3><span>Preview validates every order and line before any rows are written.</span></div></div>
      <label className="poFile">Choose CSV<input type="file" accept=".csv,text/csv" onChange={previewFile}/></label>
      {preview&&<div className="poPreview">
        <div className="batchSummary"><span>CSV rows <b>{preview.rowCount}</b></span><span>POs <b>{preview.orders.length}</b></span><span>Validation errors <b>{preview.errors.length}</b></span></div>
        {preview.errors.length>0&&<div className="poImportErrors" role="alert">{preview.errors.map((item,index)=><p key={`${item.row}-${item.field}-${index}`}>{item.row?`Row ${item.row}: `:''}{item.message}</p>)}</div>}
        {preview.orders.length>0&&<div className="tablewrap"><table><thead><tr><th>PO</th><th>Vendor</th><th>Date</th><th>State</th><th>Currency</th><th>Lines</th></tr></thead><tbody>{preview.orders.map(order=><tr key={order.poId}><td>{order.poId}</td><td>{order.vendorName||order.vendorEmail||order.vendorId}</td><td>{order.poDate}</td><td>{order.status}</td><td>{order.currency}</td><td>{order.items.length}</td></tr>)}</tbody></table></div>}
        <button className="primary" disabled={busy||preview.errors.length>0||preview.orders.length===0} onClick={commitImport}>{busy?'Importing…':'Import validated POs'}</button>
      </div>}
    </section>}

    {canManage&&<section className="card">
      <div className="cardhead"><div><h3>Create purchase order</h3><span>Company procurement record, entered before receiving invoices.</span></div></div>
      <div className="formgrid poHeaderForm"><input placeholder="PO number" value={form.poId} onChange={event=>setForm({...form,poId:event.target.value})}/><select value={form.vendorId} onChange={event=>setForm({...form,vendorId:event.target.value})}><option value="">Select vendor</option>{vendors.map(vendor=><option key={vendor.vendor_id} value={vendor.vendor_id}>{vendor.vendor_id} — {vendor.name}</option>)}</select><input type="date" aria-label="PO date" value={form.poDate} onChange={event=>setForm({...form,poDate:event.target.value})}/><select aria-label="PO status" value={form.status} onChange={event=>setForm({...form,status:event.target.value})}>{['DRAFT','APPROVED','CLOSED','CANCELLED'].map(value=><option key={value}>{value}</option>)}</select><input aria-label="Currency" maxLength="3" value={form.currency} onChange={event=>setForm({...form,currency:event.target.value.toUpperCase()})}/><input placeholder="Procurement notes" value={form.notes} onChange={event=>setForm({...form,notes:event.target.value})}/></div>
      <div className="poItemEditor"><div className="poItemHeading"><b>Line items</b><button type="button" className="secondary" onClick={()=>setItems(current=>[...current,{sku:'',description:'',quantity:'',unitPrice:''}])}>Add line</button></div>{items.map((item,index)=><div className="poItemRow" key={index}><input aria-label={`Line ${index+1} SKU`} placeholder="SKU" value={item.sku} onChange={event=>setItems(current=>current.map((line,lineIndex)=>lineIndex===index?{...line,sku:event.target.value}:line))}/><input aria-label={`Line ${index+1} description`} placeholder="Description" value={item.description} onChange={event=>setItems(current=>current.map((line,lineIndex)=>lineIndex===index?{...line,description:event.target.value}:line))}/><input aria-label={`Line ${index+1} quantity`} type="number" min="0.01" step="any" placeholder="Quantity" value={item.quantity} onChange={event=>setItems(current=>current.map((line,lineIndex)=>lineIndex===index?{...line,quantity:event.target.value}:line))}/><input aria-label={`Line ${index+1} unit price`} type="number" min="0" step="any" placeholder="Unit price" value={item.unitPrice} onChange={event=>setItems(current=>current.map((line,lineIndex)=>lineIndex===index?{...line,unitPrice:event.target.value}:line))}/><button type="button" className="secondary" disabled={items.length===1} aria-label={`Remove line ${index+1}`} onClick={()=>setItems(current=>current.filter((_,lineIndex)=>lineIndex!==index))}>Remove</button></div>)}</div>
      <button className="primary" disabled={busy||!form.poId||!form.vendorId||!form.poDate||items.some(item=>!item.description||!item.quantity||item.unitPrice==='')} onClick={createPO}>{busy?'Saving…':'Create PO'}</button>
    </section>}
  </div>;
}

function Audit(){const [rows,setRows]=useState([]);useEffect(()=>{api('/audit-logs').then(setRows)},[]);return <section className="card"><div className="cardhead"><div><h3>Audit trail</h3><span>Traceability for processing and review decisions.</span></div></div><div>{rows.map(r=><div className="auditrow" key={r.id}><div className="auditdot"/><div><b>{r.action} · {r.status}</b><p>{r.details||'—'} · {r.invoiceId||'system'}</p><span>{r.userName||'system user'}</span></div><time>{new Date(r.createdAt).toLocaleString()}</time></div>)}</div></section>}

createRoot(document.getElementById('root')).render(<App />);
