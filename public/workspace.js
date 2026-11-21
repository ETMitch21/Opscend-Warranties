(()=>{'use strict';const $=id=>document.getElementById(id);let token='',all=[],selected=null;function textNode(tag,text,cls=''){const e=document.createElement(tag);e.textContent=text;e.className=cls;return e}let noticeTimer;function notify(message,error=false){const container=$('toast');if(!container)return;clearTimeout(noticeTimer);container.replaceChildren(textNode('div',message,`notice ${error?'error':'success'}`));noticeTimer=setTimeout(()=>container.replaceChildren(),3200)}async function api(path,method='GET',body){if(!token)throw Error('Connect to the app first');const response=await fetch(path,{method,headers:{Authorization:`Bearer ${token}`,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store'});const data=await response.json().catch(()=>({}));if(response.status===401&&window.parent!==window)window.parent.postMessage({protocol:'opscend-app-v1',type:'READY'},parentOrigin);if(!response.ok)throw Error(data.error||`Request failed: ${response.status}`);return data}async function guard(fn){try{await fn()}catch(e){notify(e.message,true)}}async function load(){const result=await api('/staff/claims');all=result.data;$('dashboard').classList.remove('hidden');$('login').classList.add('hidden');$('authNotice').classList.add('hidden');$('total').textContent=all.length;$('review').textContent=all.filter(x=>['submitted','needs_inspection','under_review'].includes(x.status)).length;$('approved').textContent=all.filter(x=>['ready_to_schedule','awaiting_payment'].includes(x.status)).length;renderList();void showCustomerRequestLink()}function renderList(){const filter=$('filter').value;const tbody=$('claims');tbody.replaceChildren();for(const item of all.filter(x=>!filter||x.status===filter)){const tr=document.createElement('tr');tr.dataset.id=item.id;for(const value of [item.customer_name,item.device_description,new Date(item.submitted_at).toLocaleDateString(),item.status.replaceAll('_',' ')])tr.append(textNode('td',value));tr.onclick=()=>guard(()=>detail(item.id));tbody.append(tr)}if(!tbody.children.length){const tr=document.createElement('tr'),td=textNode('td','No claims found.','empty');td.colSpan=4;tr.append(td);tbody.append(tr)}}async function detail(id){const data=await api(`/staff/claims/${id}`);selected=data.data;$('detail').classList.remove('hidden');$('listCard').classList.add('hidden');$('detailTitle').textContent=`${selected.customer_name} · ${selected.device_description}`;$('detailStatus').textContent=selected.status.replaceAll('_',' ');$('detailIssue').textContent=selected.issue;const box=$('detailInfo');box.replaceChildren();for(const [label,val] of [['Email',selected.customer_email],['Phone',selected.customer_phone||'Not supplied'],['Repair reference',selected.original_repair_id||'Not supplied'],['Submitted',new Date(selected.submitted_at).toLocaleString()]])box.append(textNode('div',`${label}: ${val}`));$('verified').textContent=selected.original_repair_verified_at?`Verified by ${selected.original_repair_verified_by} on ${new Date(selected.original_repair_verified_at).toLocaleString()}`:'Original repair not verified — approval blocked';$('originRef').value=selected.original_repair_id||'';$('verifyNote').value=selected.original_repair_verification_note||'';$('inspectionMode').value=String(selected.inspection_required);$('evidence').replaceChildren();for(const file of data.evidence){const row=document.createElement('div');row.className='log';row.append(textNode('span',`${file.mime_type} · ${file.confirmed_at?'Confirmed':'Pending upload'} `));if(file.confirmed_at){const btn=textNode('button','View','secondary');btn.onclick=()=>guard(async()=>{const d=await api(`/staff/claims/${selected.id}/evidence/${file.id}`);window.open(d.url,'_blank','noopener,noreferrer')});row.append(btn)}$('evidence').append(row)}if(!data.evidence.length)$('evidence').append(textNode('p','No evidence uploaded.','muted'));$('events').replaceChildren();for(const event of data.events){const entry=document.createElement('div');entry.className='log';entry.append(textNode('div',event.event.replaceAll('.',' · ').replaceAll('_',' ')));entry.append(textNode('div',`${new Date(event.created_at).toLocaleString()} · ${event.actor_type}`,'caption'));$('events').append(entry)}const finalized=!['submitted','under_review','needs_inspection'].includes(selected.status);for(const id of ['verify','saveInspection','completeInspection','saveDecision'])$(id).disabled=finalized;$('completeInspection').disabled=finalized||selected.status!=='needs_inspection'}const parentOrigin=window.OPSCEND_PARENT_ORIGIN; if(!parentOrigin){notify('Parent app origin is not configured',true);}else{window.addEventListener('message',event=>{if(event.source!==window.parent||event.origin!==parentOrigin||event.data?.protocol!=='opscend-app-v1'||event.data?.type!=='LAUNCH'||typeof event.data.token!=='string')return;token=event.data.token;guard(load)});window.parent.postMessage({protocol:'opscend-app-v1',type:'READY'},parentOrigin);}// The URL remains visible and manually selectable if the browser disallows
// clipboard writes inside the embedded workspace. No prompt() or modals.
let customerRequestUrl='';
async function showCustomerRequestLink(){
  const field=$('customerWarrantyUrl');
  const copy=$('copyWarrantyLinkCard');
  copy.disabled=true;
  field.placeholder='Loading your request link…';
  try{
    const result=await api('/staff/customer-request-link');
    const url=result?.data?.url;
    if(typeof url!=='string'||!url.startsWith('https://'))throw Error('A secure customer request URL is not available');
    customerRequestUrl=url;
    field.value=url;
    field.placeholder='';
    copy.disabled=false;
  }catch(err){
    customerRequestUrl='';
    field.value='';
    field.placeholder='Request link unavailable';
    notify(err.message||'Unable to load request link',true);
  }
}
let copyRequestId=0;
const waitingCopies=new Map();
window.addEventListener('message', event=>{
  if(event.source!==window.parent || event.origin!==parentOrigin ||
     event.data?.protocol!=='opscend-app-v1' || event.data?.type!=='COPY_RESULT')return;
  const pending=waitingCopies.get(event.data.requestId);
  if(!pending)return;
  waitingCopies.delete(event.data.requestId);
  clearTimeout(pending.timer);
  pending.resolve(event.data.ok===true);
});
function copyViaParent(text){
  if(window.parent===window || !parentOrigin)return Promise.resolve(false);
  const requestId=`warranty-copy-${++copyRequestId}`;
  return new Promise(resolve=>{
    const timer=setTimeout(()=>{waitingCopies.delete(requestId);resolve(false)},2000);
    waitingCopies.set(requestId,{resolve,timer});
    window.parent.postMessage({protocol:'opscend-app-v1',type:'COPY_TEXT',requestId,text},parentOrigin);
  });
}
function copyLegacy(text){
  const textarea=document.createElement('textarea');
  textarea.value=text;
  textarea.setAttribute('readonly','');
  textarea.style.cssText='position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.append(textarea);
  let copied=false;
  try{textarea.focus();textarea.select();copied=document.execCommand('copy')===true;}catch{}
  finally{textarea.remove();}
  return copied;
}
async function copyCustomerRequestLink(){
  if(!customerRequestUrl){notify('The warranty link is not available yet',true);return;}
  const button=$('copyWarrantyLinkCard');
  if(button.disabled)return;
  let copied=false;
  // Try synchronous copy in the click activation, before any await.
  copied=copyLegacy(customerRequestUrl);
  if(!copied){
    try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(customerRequestUrl);copied=true;}}catch{}
  }
  if(!copied)copied=await copyViaParent(customerRequestUrl);
  if(copied){
    button.classList.add('copied');
    button.setAttribute('aria-label','Link copied');
    button.title='Copied!';
    notify('Link copied');
    setTimeout(()=>{button.classList.remove('copied');button.setAttribute('aria-label','Copy warranty request link');button.title='Copy link';},1400);
  }else notify('Copy blocked by browser permissions',true);
}
$('copyWarrantyLinkCard').onclick=()=>guard(copyCustomerRequestLink);
$('refresh').onclick=()=>guard(load);$('filter').onchange=renderList;$('back').onclick=()=>{$('detail').classList.add('hidden');$('listCard').classList.remove('hidden')};async function verify(){const originalRepairId=$('originRef').value.trim();if(!originalRepairId)throw Error('Enter the original Opscend repair ID');const result=await api(`/staff/claims/${selected.id}/verify-origin`,'POST',{originalRepairId,notes:$('verifyNote').value.trim()||undefined});notify(`Verified ${result.repair.id} against Opscend`);await detail(selected.id)}$('verify').onclick=()=>guard(verify);$('saveInspection').onclick=()=>guard(async()=>{await api(`/staff/claims/${selected.id}/inspection`,'POST',{required:$('inspectionMode').value==='true',notes:'Updated from warranty workspace'});notify('Inspection requirement updated');await detail(selected.id)});$('completeInspection').onclick=()=>guard(async()=>{await api(`/staff/claims/${selected.id}/inspection/complete`,'POST',{findings:$('findings').value});notify('Inspection completed');await detail(selected.id)});$('decision').onchange=()=>{$('chargeField').classList.toggle('hidden',$('decision').value!=='partial')};$('saveDecision').onclick=()=>guard(async()=>{const decision=$('decision').value;const reason=$('reason').value.trim();if(!reason)throw Error('Decision explanation is required');const body={decision,reason};if(decision==='partial'){const dollars=Number($('charge').value);if(!Number.isFinite(dollars)||dollars<=0||Math.round(dollars*100)!==dollars*100)throw Error('Enter a valid charge with no more than two decimal places');body.customerChargeCents=Math.round(dollars*100)}if(!confirm('Finalize this decision? This cannot be changed in the current V1 workflow.'))return;await api(`/staff/claims/${selected.id}/decision`,'POST',body);notify('Decision recorded');await load();await detail(selected.id)})})();
