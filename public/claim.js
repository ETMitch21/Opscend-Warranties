(()=>{'use strict';const $=id=>document.getElementById(id), shop=decodeURIComponent(location.pathname.split('/').pop()||'');let claimId='',accessToken='';function msg(text,kind='notice'){const d=document.createElement('div');d.className=`notice ${kind}`;d.textContent=text;$('message').replaceChildren(d)}async function api(path,options={}){const headers={'Content-Type':'application/json',...(accessToken?{'x-warranty-access-token':accessToken}:{}),...options.headers};const r=await fetch(path,{...options,headers,cache:'no-store'});const data=await r.json().catch(()=>({}));if(!r.ok)throw Error(data.error||`Request failed (${r.status})`);return data}
async function loadShopBranding(){
  try {
    const response=await fetch(`/public/shops/${encodeURIComponent(shop)}/branding`,{cache:'no-store'});
    if(!response.ok)throw Error('Unable to load shop branding');
    const data=await response.json(), brand=data.shop||{};
    const name=String(brand.name||'Warranty service').slice(0,160);
    $('shopName').textContent=name;
    $('footerShopName').textContent=name;
    document.title=`Warranty request | ${name}`;
    const color=String(brand.primaryColor||'').trim();
    if(/^#[0-9a-fA-F]{6}$/.test(color)){
      document.documentElement.style.setProperty('--shop-accent',color);
      const rgb=[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255);
      const light=rgb.map(c=>c<=.04045?c/12.92:Math.pow((c+.055)/1.055,2.4));
      const luminance=.2126*light[0]+.7152*light[1]+.0722*light[2];
      document.documentElement.style.setProperty('--shop-accent-text',luminance>.36?'#171717':'#fff');
    }
    const logo=String(brand.logoUrl||'');
    if(logo){try{const u=new URL(logo);if(u.protocol==='https:'){
      const img=$('shopLogo');img.src=u.href;img.alt=`${name} logo`;
      img.onload=()=>img.classList.remove('hidden');img.onerror=()=>img.classList.add('hidden');
    }}catch{}}
    const contact=$('shopContact');
    const phone=String(brand.phone||'').trim();const email=String(brand.email||'').trim();
    if(phone||email){
      contact.hidden=false;contact.replaceChildren();
      const lead=document.createElement('span');lead.textContent=`Questions? Contact ${name}: `;contact.append(lead);
      if(phone){const a=document.createElement('a');a.href=`tel:${phone.replace(/[^+\d]/g,'')}`;a.textContent=phone;contact.append(a);}
      if(phone&&email)contact.append(document.createTextNode(' · '));
      if(email&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
        const a=document.createElement('a');a.href=`mailto:${email}`;a.textContent=email;contact.append(a);
      }
    }
  }catch(err){console.warn('Shop branding could not be loaded',err);}
}
void loadShopBranding();
 $('claimForm').addEventListener('submit',async e=>{e.preventDefault();$('submit').disabled=true;try{const data=await api(`/public/shops/${encodeURIComponent(shop)}/claims`,{method:'POST',body:JSON.stringify({originalRepairId:$('repair').value||undefined,customerName:$('name').value,customerEmail:$('email').value,customerPhone:$('phone').value||undefined,smsOptIn:$('smsOptIn').checked,deviceDescription:$('device').value,issue:$('issue').value})});claimId=data.id;accessToken='';$('claimForm').classList.add('hidden');$('submitted').classList.remove('hidden');$('reference').textContent=claimId;msg('Check your email for a six-digit verification code.','success')}catch(err){msg(err.message,'error')}finally{$('submit').disabled=false}});$('verifyEmail').onclick=async()=>{try{const d=await api(`/public/claims/${claimId}/verify-email`,{method:'POST',body:JSON.stringify({code:$('emailCode').value})});accessToken=d.accessToken;$('accessCode').value=accessToken;$('verifyBox').classList.add('hidden');$('accessTools').classList.remove('hidden');$('uploadCard').classList.remove('hidden');$('status').disabled=false;msg('Email verified. Save your access code safely.','success');await status()}catch(err){msg(err.message,'error')}};$('copyCode').onclick=()=>navigator.clipboard.writeText($('accessCode').value).then(()=>msg('Access code copied.','success')).catch(()=>msg('Copy the access code manually.','error'));async function status(){try{const d=await api(`/public/claims/${encodeURIComponent(claimId)}`);$('claimStatus').replaceChildren();const p=document.createElement('p');p.textContent=`Current status: ${d.status.replaceAll('_',' ')}${d.decisionReason?' — '+d.decisionReason:''}`;$('claimStatus').append(p);if(d.canPay){const pay=document.createElement('button');pay.textContent='Pay approved amount';pay.onclick=async()=>{try{const check=await api(`/public/claims/${claimId}/payment-checkout`,{method:'POST',body:'{}'});location.assign(check.url)}catch(e){msg(e.message,'error')}};$('claimStatus').append(pay)}}catch(err){msg(err.message,'error')}}$('status').onclick=status;$('upload').onclick=async()=>{const files=Array.from($('photos').files||[]);if(!files.length||files.length>4){msg('Select between one and four photos.','error');return}$('upload').disabled=true;const state=$('uploadState');try{for(let i=0;i<files.length;i++){const f=files[i];if(!['image/jpeg','image/png','image/webp','image/heic'].includes(f.type)||f.size>10*1024*1024)throw Error('Photos must be JPG, PNG, WebP, or HEIC and no larger than 10 MB');state.textContent=`Uploading photo ${i+1} of ${files.length}…`;const up=await api(`/public/claims/${claimId}/evidence/upload`,{method:'POST',body:JSON.stringify({mimeType:f.type,sizeBytes:f.size})});const r=await fetch(up.uploadUrl,{method:'PUT',headers:{'Content-Type':up.contentType,...up.headers},body:f});if(!r.ok)throw Error(`Photo upload failed (${r.status})`);await api(`/public/claims/${claimId}/evidence/${up.evidenceId}/confirm`,{method:'POST',body:'{}'})}state.textContent='Photos uploaded successfully.';msg('Evidence attached to your warranty request.','success')}catch(err){state.textContent='Upload incomplete.';msg(err.message,'error')}finally{$('upload').disabled=false}}})();
