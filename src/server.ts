import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Pool } from 'pg';
import { z } from 'zod';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const required = (key: string) => { const v = process.env[key]; if (!v) throw Error(`${key} is required`); return v; };
const secret = required('OPSCEND_APP_RUNTIME_TOKEN');
if (Buffer.byteLength(secret, 'utf8') < 32) throw Error('Runtime token must contain at least 32 bytes');
const pool = new Pool({ connectionString: required('DATABASE_URL'), ssl: process.env.PG_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
const bucket = process.env.EVIDENCE_BUCKET;
const s3 = bucket ? new S3Client({ region: process.env.AWS_REGION || 'us-east-1' }) : null;
const app = Fastify({ logger: true, bodyLimit: 128 * 1024, trustProxy: process.env.TRUST_PROXY === 'true' });
const assetsRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../public');
const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024;
const CORE = (process.env.OPSCEND_API_URL || '').replace(/\/$/, '');
const APP_KEY = 'opscend-warranties';
const claimCooldown = new Map<string, {count:number, expires:number}>();
function throttle(key:string, limit:number, windowMs:number) {
  const now=Date.now(); if (claimCooldown.size > 15000) for (const [k,v] of claimCooldown) if(v.expires<=now) claimCooldown.delete(k);
  const current=claimCooldown.get(key); const state=!current||current.expires<=now ? {count:1,expires:now+windowMs} : {count:current.count+1,expires:current.expires};
  claimCooldown.set(key,state); if(state.count>limit) fail(429,'Too many requests. Try again later');
}
await app.register(cors, { origin: process.env.APP_ORIGIN ? [process.env.APP_ORIGIN] : false });

function same(a: string, b: string) { const x=Buffer.from(a), y=Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x,y); }
function hash(token: string) { return crypto.createHash('sha256').update(token).digest('hex'); }
function fail(code: number, message: string): never { throw Object.assign(new Error(message), { statusCode: code }); }
function runtimeAuth(req: any) {
  const token=String(req.headers.authorization ?? '').replace(/^Bearer /,'');
  if (!same(token,secret)) fail(401,'Invalid runtime credentials');
}
function staffAuth(req: any): { shopId:string; userId:string; scopes:string[] } {
  const token=String(req.headers.authorization ?? '').replace(/^Bearer /,'');
  const parts=token.split('.'); if(parts.length!==2) fail(401,'Missing app launch assertion');
  const expected=crypto.createHmac('sha256',secret).update(parts[0]).digest('base64url');
  if(!same(expected,parts[1])) fail(401,'Invalid app launch assertion');
  let payload: any; try {payload=JSON.parse(Buffer.from(parts[0], 'base64url').toString());} catch {fail(401,'Invalid assertion payload');}
  const now=Math.floor(Date.now()/1000);
  if(payload.iss!=='opscend'||payload.aud!=='opscend-warranties'||!payload.shopId||!payload.userId||!Number.isInteger(payload.iat)||!Number.isInteger(payload.exp)||payload.exp<=now||payload.iat>now+30||payload.exp-payload.iat>300) fail(401,'Expired or invalid assertion');
  return { shopId: payload.shopId, userId: payload.userId, scopes: Array.isArray(payload.scopes)?payload.scopes.filter((x:unknown)=>typeof x==='string'):[] };
}
// Only the Railway service may use the plugin runtime credential.
// It is never sent to the embedded browser or the customer portal.
async function opscendRepair(shopId: string, repairId: string): Promise<any> {
  const base = required('OPSCEND_API_URL').replace(/\/$/, '');
  const upstream = new URL(base);
  if (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && ['localhost','127.0.0.1'].includes(upstream.hostname))) fail(503, 'Opscend API URL must use HTTPS');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${base}/v1/app-runtime/shops/${encodeURIComponent(shopId)}/repairs/${encodeURIComponent(repairId)}`, {
      headers: { Authorization: `Bearer ${secret}`, 'x-opscend-app-key': 'opscend-warranties', Accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 404) fail(404, 'Original repair was not found in this shop');
    if (response.status === 403) fail(403, 'The app lacks repairs:read permission or is not installed');
    if (!response.ok) fail(502, 'Unable to verify repair with Opscend');
    return await response.json();
  } catch (err) {
    if (err instanceof Error && 'statusCode' in err) throw err;
    fail(502, 'Opscend repair lookup is temporarily unavailable');
  } finally { clearTimeout(timeout); }
}
async function coreCall(shopId:string, route:string, method='GET', body?:unknown, idempotencyKey?:string): Promise<any> {
  if (!CORE) fail(503,'Opscend API is not configured');
  const u=new URL(CORE);
  if(u.protocol!=='https:' && !(u.protocol==='http:' && ['localhost','127.0.0.1'].includes(u.hostname))) fail(503,'Invalid Opscend API URL');
  const controller=new AbortController(), timeout=setTimeout(()=>controller.abort(),10000);
  try {
    const r=await fetch(`${CORE}/v1/app-runtime/shops/${encodeURIComponent(shopId)}/${route}`, {
      method,signal:controller.signal,
      headers:{Authorization:`Bearer ${secret}`,'x-opscend-app-key':APP_KEY,'Content-Type':'application/json',...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})
    });
    const data=await r.json().catch(()=>({}));
    if(!r.ok) fail(r.status>=500?502:r.status, data.error||'Opscend service could not complete this action');
    return data;
  } catch(err) {if(err instanceof Error && 'statusCode' in err) throw err; fail(502,'Opscend service unavailable');}
  finally {clearTimeout(timeout);}
}
async function enqueue(client:any,claimId:string,kind:string) {
  // SMS is opt-in only; notification retries use the same durable queue with a separate kind.
  if (!kind.startsWith('sms:')) {
    const opt=await client.query('SELECT sms_opt_in,customer_phone FROM warranty_claims WHERE id=$1',[claimId]);
    if(opt.rows[0]?.sms_opt_in && opt.rows[0]?.customer_phone && kind!=='submitted')
      await client.query(`INSERT INTO warranty_notifications(id,claim_id,kind) VALUES($1,$2,$3) ON CONFLICT(claim_id,kind) DO NOTHING`,[crypto.randomUUID(),claimId,`sms:${kind}`]);
  }
  await client.query(`INSERT INTO warranty_notifications (id,claim_id,kind) VALUES ($1,$2,$3) ON CONFLICT (claim_id,kind) DO NOTHING`,[crypto.randomUUID(),claimId,kind]);
}
async function dispatchNotifications(max=20) {
  const rows=await pool.query(`UPDATE warranty_notifications SET locked_until=NOW()+INTERVAL '60 seconds',attempts=attempts+1
    WHERE id IN (SELECT id FROM warranty_notifications WHERE delivered_at IS NULL AND attempts<12 AND (locked_until IS NULL OR locked_until<NOW()) ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING id,claim_id,kind,attempts`,[max]);
  for(const row of rows.rows) {
    try {
      const claim=await pool.query(`SELECT c.*,s.installed FROM warranty_claims c JOIN warranty_shops s ON s.shop_id=c.shop_id WHERE c.id=$1`,[row.claim_id]);
      if(!claim.rowCount || !claim.rows[0].installed) throw Error('Claim is unavailable');
      const c=claim.rows[0];
      const titles:Record<string,string>={submitted:'Warranty request received',needs_inspection:'Warranty inspection needed',inspection_scheduled:'Warranty inspection scheduled',approved:'Warranty request approved',partial:'Warranty decision and payment',denied:'Warranty request decision',payment_received:'Warranty payment received',ready_to_schedule:'Warranty repair scheduling',scheduled:'Warranty appointment scheduled',completed:'Warranty repair complete'};
      const status=String(c.status).replaceAll('_',' ');
      const sms=row.kind.startsWith('sms:');
      const kind=sms?row.kind.slice(4):row.kind;
      const body=`Hello ${c.customer_name},\n\nYour warranty request (${c.id}) has an update: ${kind.replaceAll('_',' ')}.\nCurrent status: ${status}.\n${c.decision_reason?'Decision: '+c.decision_reason+'\n':''}${c.customer_charge_cents&&kind==='partial'?'Amount to pay: $'+(c.customer_charge_cents/100).toFixed(2)+'\n':''}\nTo view your claim or complete an approved payment, visit ${required('PUBLIC_BASE_URL').replace(/\/$/,'')}/claim-status/${c.id} and enter your saved claim access code.\n\nPlease contact the shop if you need assistance. Do not send device passwords or sensitive data by email.`;
      if(sms){
        const digits=String(c.customer_phone||'').replace(/\D/g,'');
        const to=digits.length===10?'+1'+digits:digits.length===11&&digits.startsWith('1')?'+'+digits:null;
        if(!c.sms_opt_in||!to) throw Error('SMS consent or valid US phone number missing');
        const message=`Warranty claim ${c.id}: ${kind.replaceAll('_',' ')}. Status: ${status}. Check your email for details or contact the shop.`;
        await coreCall(c.shop_id,'notifications/sms','POST',{to,body:message,notificationId:row.id},row.id);
      } else await coreCall(c.shop_id,'notifications/email','POST',{to:c.customer_email,subject:titles[kind]||'Warranty request update',body,notificationId:row.id},row.id);
      await pool.query('UPDATE warranty_notifications SET delivered_at=NOW(),locked_until=NULL,last_error=NULL WHERE id=$1',[row.id]);
    }catch(err){await pool.query(`UPDATE warranty_notifications SET locked_until=NOW()+LEAST(3600,POWER(2,attempts)*30)*INTERVAL '1 second',last_error=$2 WHERE id=$1`,[row.id,String(err).slice(0,300)]);}
  }
  return rows.rowCount||0;
}
function sameContact(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  if (a.includes('@') || b.includes('@')) return a.trim().toLowerCase() === b.trim().toLowerCase();
  const digits = (v:string) => v.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return digits(a).length >= 10 && digits(a) === digits(b);
}
function canDecide(user:{scopes:string[]}) {
  if (!user.scopes.some(s=>s==='*'||s==='repairs:*'||s==='repairs:write')) fail(403,'Repair write permission required');
}
async function activeShop(shopId:string) {
  const r=await pool.query('SELECT settings FROM warranty_shops WHERE shop_id=$1 AND installed=TRUE',[shopId]);
  if(!r.rowCount) fail(404,'Warranty app is not enabled for this shop');
  return r.rows[0].settings as Record<string,unknown>;
}
async function event(client:any,claimId:string,actorType:string,actorId:string|null,action:string,details:any={}) {
  await client.query('INSERT INTO warranty_events (id,claim_id,actor_type,actor_id,event,details) VALUES ($1,$2,$3,$4,$5,$6)',[crypto.randomUUID(),claimId,actorType,actorId,action,JSON.stringify(details)]);
}
const params=z.object({ id:z.string().uuid() });
const safeMime=z.enum(['image/jpeg','image/png','image/webp','image/heic']);

app.post('/opscend/lifecycle/install',async(req:any)=>{
  runtimeAuth(req); const body=z.object({installation:z.object({shopId:z.string().min(1)})}).parse(req.body);
  await pool.query(`INSERT INTO warranty_shops (shop_id,installed) VALUES ($1,TRUE) ON CONFLICT (shop_id) DO UPDATE SET installed=TRUE,updated_at=NOW()`,[body.installation.shopId]); return {ok:true};
});
app.post('/opscend/lifecycle/disable',async(req:any)=>{
  runtimeAuth(req); const body=z.object({installation:z.object({shopId:z.string().min(1)})}).parse(req.body);
  await pool.query('UPDATE warranty_shops SET installed=FALSE,updated_at=NOW() WHERE shop_id=$1',[body.installation.shopId]); return {ok:true};
});
app.post('/opscend/setup-status',async(req:any)=>{
  runtimeAuth(req);
  const body=z.object({installation:z.object({shopId:z.string(),settings:z.record(z.unknown()).optional()})}).parse(req.body);
  await pool.query(`INSERT INTO warranty_shops (shop_id,settings,installed) VALUES ($1,$2,TRUE) ON CONFLICT (shop_id) DO UPDATE SET settings=$2,updated_at=NOW()`,[body.installation.shopId,JSON.stringify(body.installation.settings??{})]);
  return {ready:Boolean(bucket)};
});
app.get('/health',async()=>({ok:true}));
app.get('/claim/:shopId',async(req:any,reply)=>{z.string().min(1).max(200).parse(req.params.shopId);return reply.type('text/html; charset=utf-8').send(readFileSync(resolve(assetsRoot,'claim.html'),'utf8'));});
// The parent origin is configured by the app owner; do not trust a caller-supplied origin.
app.get('/runtime-config.js', async (_req,reply) => {
  const parentOrigin = new URL(required('APP_ORIGIN')).origin;
  return reply.header('Cache-Control','no-store').type('application/javascript; charset=utf-8')
    .send(`window.OPSCEND_PARENT_ORIGIN=${JSON.stringify(parentOrigin)};`);
});
app.get('/workspace', async (_req, reply) =>
  reply
    .header(
      'Content-Security-Policy',
      "frame-ancestors 'self' https://app.opscend.app https://*.app.opscend.app"
    )
    .type('text/html; charset=utf-8')
    .send(readFileSync(resolve(assetsRoot, 'workspace.html'), 'utf8'))
);
app.get('/ui.css',async(_req,reply)=>reply.type('text/css; charset=utf-8').send(readFileSync(resolve(assetsRoot,'ui.css'),'utf8')));
app.get('/claim.js',async(_req,reply)=>reply.type('application/javascript; charset=utf-8').send(readFileSync(resolve(assetsRoot,'claim.js'),'utf8')));
app.get('/workspace.js',async(_req,reply)=>reply.type('application/javascript; charset=utf-8').send(readFileSync(resolve(assetsRoot,'workspace.js'),'utf8')));
app.get('/claim-status/:id',async(req:any,reply)=>{params.parse(req.params);return reply.header('Cache-Control','no-store').type('text/html; charset=utf-8').send(readFileSync(resolve(assetsRoot,'status.html'),'utf8'));});
app.get('/status.js',async(_req,reply)=>reply.header('Cache-Control','no-store').type('application/javascript; charset=utf-8').send(readFileSync(resolve(assetsRoot,'status.js'),'utf8')));
app.get('/ready',async()=>{ await pool.query('SELECT 1'); return {ok:true}; });

// Customer creates a claim; the customer-facing link must be scoped to a known installation.
app.post('/public/shops/:shopId/claims',async(req:any,reply)=>{
  const shopId=z.string().min(1).max(200).parse(req.params.shopId);
  const settings=await activeShop(shopId);
  throttle(`submit:${req.ip}:${shopId}`,5,3600000);
  const body=z.object({
    originalRepairId:z.string().trim().max(200).optional(), customerId:z.string().trim().max(200).optional(),
    customerName:z.string().trim().min(2).max(160), customerEmail:z.string().email().max(254), customerPhone:z.string().max(40).optional(), smsOptIn:z.boolean().default(false),
    deviceDescription:z.string().trim().min(2).max(200), issue:z.string().trim().min(10).max(4000),
  }).parse(req.body);
  const id=crypto.randomUUID(), token=crypto.randomBytes(32).toString('base64url'), otp=String(crypto.randomInt(100000,1000000));
  const inspectionRequired=settings.reviewMode==='required';
  const client=await pool.connect(); try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO warranty_claims (id,shop_id,original_repair_id,customer_id,customer_name,customer_email,customer_phone,device_description,issue,inspection_required,public_token_hash,status,sms_opt_in) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,shopId,body.originalRepairId??null,body.customerId??null,body.customerName,body.customerEmail,body.customerPhone??null,body.deviceDescription,body.issue,inspectionRequired,hash(token),inspectionRequired?'needs_inspection':'submitted',body.smsOptIn]);
    await client.query("INSERT INTO warranty_access_challenges (claim_id,otp_hash,expires_at) VALUES ($1,$2,NOW()+INTERVAL '15 minutes')",[id,hash(id+':'+otp+':'+secret)]);
    await event(client,id,'customer',null,'claim.submitted'); await enqueue(client,id,'submitted'); await client.query('COMMIT');
  } catch(err) { await client.query('ROLLBACK');throw err; } finally {client.release();}
  // No claim access until possession of the email address is proved.
  // Send the OTP using the shop's existing Opscend email provider.
  try {await coreCall(shopId,'notifications/email','POST',{to:body.customerEmail,subject:'Verify your warranty request',body:`Your Opscend warranty request ${id} verification code is ${otp}. It expires in 15 minutes. If you did not request this, ignore this message.`,notificationId:id},`claim-verify-${id}`);}
  catch(err){await pool.query('DELETE FROM warranty_events WHERE claim_id=$1',[id]);await pool.query('DELETE FROM warranty_notifications WHERE claim_id=$1',[id]);await pool.query('DELETE FROM warranty_access_challenges WHERE claim_id=$1',[id]);await pool.query('DELETE FROM warranty_claims WHERE id=$1',[id]);throw err;}
  return reply.code(201).send({id,status:'email_verification_required'});
});
app.post('/public/claims/:id/verify-email',async(req:any)=>{
  throttle(`verify:${req.ip}`,8,3600000);
  const {id}=params.parse(req.params);
  const {code}=z.object({code:z.string().regex(/^\d{6}$/)}).parse(req.body);
  const client=await pool.connect();try{
    await client.query('BEGIN');
    const claim=await client.query(`SELECT c.id,c.shop_id,s.installed FROM warranty_claims c JOIN warranty_shops s ON s.shop_id=c.shop_id WHERE c.id=$1 FOR UPDATE`,[id]);
    if(!claim.rowCount||!claim.rows[0].installed)fail(404,'Claim not found');
    const challenge=await client.query('SELECT otp_hash,expires_at,attempts,verified_at FROM warranty_access_challenges WHERE claim_id=$1 FOR UPDATE',[id]);
    if(!challenge.rowCount||challenge.rows[0].verified_at||challenge.rows[0].attempts>=5||new Date(challenge.rows[0].expires_at).getTime()<Date.now()) fail(401,'Verification code expired or unavailable');
    await client.query('UPDATE warranty_access_challenges SET attempts=attempts+1 WHERE claim_id=$1',[id]);
    if(!same(hash(id+':'+code+':'+secret),challenge.rows[0].otp_hash)) {await client.query('COMMIT');fail(401,'Invalid verification code');}
    const token=crypto.randomBytes(32).toString('base64url');
    await client.query('UPDATE warranty_claims SET public_token_hash=$2 WHERE id=$1',[id,hash(token)]);
    await client.query('UPDATE warranty_access_challenges SET verified_at=NOW() WHERE claim_id=$1',[id]);
    await event(client,id,'customer',null,'customer.email_verified');
    await client.query('COMMIT');return {accessToken:token};
  }catch(err){try{await client.query('ROLLBACK');}catch{}throw err;}finally{client.release();}
});
// Re-issue a one-time email verification challenge for customers who lose access.
// The claim identifier and matching email are required; do not disclose email addresses.
app.post('/public/claims/:id/recover',async(req:any)=>{
  throttle(`recover:${req.ip}`,4,3600000);
  const {id}=params.parse(req.params);
  const {email}=z.object({email:z.string().email().max(254)}).parse(req.body);
  const claim=await pool.query(`SELECT c.shop_id,c.customer_email FROM warranty_claims c JOIN warranty_shops s ON s.shop_id=c.shop_id WHERE c.id=$1 AND s.installed=TRUE`,[id]);
  if(!claim.rowCount||!sameContact(email,claim.rows[0].customer_email)) return {ok:true};
  const code=String(crypto.randomInt(100000,1000000));
  const client=await pool.connect();try{await client.query('BEGIN');
    await client.query(`INSERT INTO warranty_access_challenges(claim_id,otp_hash,expires_at,attempts,verified_at)
      VALUES($1,$2,NOW()+INTERVAL '15 minutes',0,NULL)
      ON CONFLICT(claim_id) DO UPDATE SET otp_hash=$2,expires_at=NOW()+INTERVAL '15 minutes',attempts=0,verified_at=NULL`,[id,hash(id+':'+code+':'+secret)]);
    await event(client,id,'customer',null,'customer.access_recovery_requested');await client.query('COMMIT');
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
  await coreCall(claim.rows[0].shop_id,'notifications/email','POST',{to:claim.rows[0].customer_email,subject:'Your warranty access code',body:`Your verification code for warranty claim ${id} is ${code}. It expires in 15 minutes. If you did not request this, ignore this email.`,notificationId:crypto.randomUUID()});
  return {ok:true};
});
async function publicClaim(req:any) {
  const {id}=params.parse(req.params);
  const token=String(req.headers['x-warranty-access-token']??'');
  if(token.length<32) fail(401,'Claim access token required');
  const result=await pool.query(`SELECT c.*, s.settings FROM warranty_claims c JOIN warranty_shops s ON c.shop_id=s.shop_id WHERE c.id=$1 AND c.public_token_hash=$2 AND s.installed=TRUE`,[id,hash(token)]);
  if(!result.rowCount) fail(404,'Claim not found'); return result.rows[0];
}
app.get('/public/claims/:id',async(req:any)=>{
  const c=await publicClaim(req);
  return {id:c.id,status:c.status,deviceDescription:c.device_description,issue:c.issue,customerName:c.customer_name,decision:c.decision,decisionReason:c.decision_reason,customerChargeCents:c.customer_charge_cents,submittedAt:c.submitted_at,paymentVerified:!!c.payment_verified_at,inspectionAppointmentId:c.inspection_appointment_id,originalRepairVerified:!!c.original_repair_verified_at,canPay:c.status==='awaiting_payment'};
});

// Upload flow requires S3 storage, uses short-lived, per-claim object keys.
app.post('/public/claims/:id/evidence/upload',async(req:any)=>{
  throttle(`upload:${req.ip}`,30,3600000);
  const c=await publicClaim(req); if(!s3||!bucket) fail(503,'Evidence storage not configured');
  const input=z.object({mimeType:safeMime, sizeBytes:z.number().int().min(1).max(MAX_EVIDENCE_BYTES)}).parse(req.body);
  const id=crypto.randomUUID(), ext=({ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/heic':'heic' } as Record<string,string>)[input.mimeType];
  const key=`warranties/${c.shop_id}/${c.id}/${id}.${ext}`;
  const url=await getSignedUrl(s3,new PutObjectCommand({Bucket:bucket,Key:key,ContentType:input.mimeType, Metadata:{'expected-bytes':String(input.sizeBytes)}}),{expiresIn:300});
  await pool.query('INSERT INTO warranty_evidence (id,claim_id,object_key,mime_type,uploaded_by,expected_bytes) VALUES ($1,$2,$3,$4,$5,$6)',[id,c.id,key,input.mimeType,'customer',input.sizeBytes]);
  return {evidenceId:id,uploadUrl:url,method:'PUT',contentType:input.mimeType,headers:{'x-amz-meta-expected-bytes':String(input.sizeBytes)},expiresIn:300};
});
// Finalize only after the private object is actually present and matches declared length.
app.post('/public/claims/:id/evidence/:evidenceId/confirm',async(req:any)=>{
  throttle(`confirm:${req.ip}`,50,3600000);
  const c=await publicClaim(req); if(!s3||!bucket) fail(503,'Evidence storage not configured');
  const evidenceId=z.string().uuid().parse(req.params.evidenceId);
  const record=await pool.query('SELECT object_key,mime_type,expected_bytes,confirmed_at FROM warranty_evidence WHERE id=$1 AND claim_id=$2',[evidenceId,c.id]);
  if(!record.rowCount) fail(404,'Evidence not found');
  if(record.rows[0].confirmed_at) return {ok:true};
  let head; try {head=await s3.send(new HeadObjectCommand({Bucket:bucket,Key:record.rows[0].object_key}));}
  catch {fail(409,'Upload has not been received');}
  if(head.ContentLength!==Number(record.rows[0].expected_bytes) || head.ContentType!==record.rows[0].mime_type || !head.ContentLength || head.ContentLength>MAX_EVIDENCE_BYTES) fail(409,'Uploaded evidence does not match declared file');
  await pool.query('UPDATE warranty_evidence SET confirmed_at=NOW() WHERE id=$1 AND claim_id=$2',[evidenceId,c.id]);
  return {ok:true};
});
app.get('/staff/claims',async(req:any)=>{
  const user=staffAuth(req);await activeShop(user.shopId);
  const filter=z.object({status:z.string().max(40).optional()}).parse(req.query);
  const rows=await pool.query(`SELECT id,customer_name,device_description,status,customer_charge_cents,submitted_at FROM warranty_claims WHERE shop_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY submitted_at DESC LIMIT 200`,[user.shopId,filter.status??null]);
  return {data:rows.rows};
});
app.get('/staff/claims/:id',async(req:any)=>{
  const user=staffAuth(req);await activeShop(user.shopId);const {id}=params.parse(req.params);
  const result=await pool.query('SELECT id,original_repair_id,customer_id,customer_name,customer_email,customer_phone,device_description,issue,status,inspection_required,inspection_completed_at,original_repair_verified_at,original_repair_verified_by,original_repair_verification_note,decision,decision_reason,customer_charge_cents,replacement_repair_id,inspection_repair_id,inspection_appointment_id,repair_appointment_id,payment_reference,payment_verified_at,submitted_at FROM warranty_claims WHERE id=$1 AND shop_id=$2',[id,user.shopId]);
  if(!result.rowCount) fail(404,'Claim not found');
  const events=await pool.query('SELECT actor_type,actor_id,event,details,created_at FROM warranty_events WHERE claim_id=$1 ORDER BY created_at',[id]);
  const evidence=await pool.query('SELECT id,mime_type,uploaded_by,created_at,confirmed_at FROM warranty_evidence WHERE claim_id=$1',[id]);
  return {data:result.rows[0],events:events.rows,evidence:evidence.rows};
});
app.get('/staff/claims/:id/evidence/:evidenceId',async(req:any)=>{
  const user=staffAuth(req);await activeShop(user.shopId);if(!s3||!bucket) fail(503,'Evidence storage not configured');
  const {id}=params.parse(req.params);
  const evidenceId=z.string().uuid().parse(req.params.evidenceId);
  const result=await pool.query('SELECT e.object_key FROM warranty_evidence e JOIN warranty_claims c ON e.claim_id=c.id WHERE e.id=$1 AND c.id=$2 AND c.shop_id=$3 AND e.confirmed_at IS NOT NULL',[evidenceId,id,user.shopId]);
  if(!result.rowCount) fail(404,'Evidence not found');
  return {url:await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket,Key:result.rows[0].object_key}),{expiresIn:120})};
});
app.post('/staff/claims/:id/inspection',async(req:any)=>{
  const user=staffAuth(req);canDecide(user);await activeShop(user.shopId);const {id}=params.parse(req.params);
  const input=z.object({required:z.boolean(),notes:z.string().max(3000).optional()}).parse(req.body);
  const client=await pool.connect();try { await client.query('BEGIN');
    const r=await client.query(`UPDATE warranty_claims SET inspection_required=$3,status=CASE WHEN $3 THEN 'needs_inspection' ELSE 'under_review' END,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND status IN ('submitted','needs_inspection','under_review') RETURNING id`,[id,user.shopId,input.required]);
    if(!r.rowCount) fail(409,'Claim cannot be inspected in its current state');
    await event(client,id,'staff',user.userId,'inspection.requirement_updated',input);if(input.required)await enqueue(client,id,'needs_inspection');await client.query('COMMIT');return {ok:true};
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});
// Live origin verification (no manual "verified" switch that bypasses the source of truth).
app.post('/staff/claims/:id/verify-origin', async (req:any) => {
  const user=staffAuth(req);canDecide(user);await activeShop(user.shopId);
  const {id}=params.parse(req.params);
  const body=z.object({originalRepairId:z.string().trim().min(1).max(120),notes:z.string().trim().max(3000).optional()}).parse(req.body);
  const existing=await pool.query(`SELECT customer_email,customer_phone,status FROM warranty_claims WHERE id=$1 AND shop_id=$2`,[id,user.shopId]);
  if(!existing.rowCount) fail(404,'Claim not found');
  if(!['submitted','needs_inspection','under_review'].includes(existing.rows[0].status)) fail(409,'Claim is already finalized');
  const repair=await opscendRepair(user.shopId,body.originalRepairId);
  // Require a strong contact match; staff cannot attest on behalf of a different customer.
  if(!sameContact(existing.rows[0].customer_email,repair.customer?.email)) {
    fail(409,'Verified claimant email does not match the original repair. Contact the shop to resolve an email change before approval');
  }
  if(repair.status !== 'picked_up') fail(409,'Original repair must be completed and picked up before warranty verification');
  const client=await pool.connect();try {
    await client.query('BEGIN');
    const result=await client.query(`UPDATE warranty_claims SET original_repair_verified_at=NOW(),original_repair_verified_by=$3,
      original_repair_verification_note=$4,original_repair_id=$5,customer_id=$6,updated_at=NOW()
      WHERE id=$1 AND shop_id=$2 AND status IN ('submitted','needs_inspection','under_review') RETURNING id`,
      [id,user.shopId,user.userId,body.notes??'Verified against Opscend repair and customer contact',repair.repairId,repair.customerId]);
    if(!result.rowCount) fail(409,'Claim was finalized during verification');
    await event(client,id,'staff',user.userId,'claim.origin_verified',{
      originalRepairId:repair.repairId,source:'opscend_live',status:repair.status,
      device:repair.device?.displayName,notes:body.notes??null,
    });
    await client.query('COMMIT');
    return {ok:true,repair:{id:repair.repairId,status:repair.status,device:repair.device?.displayName}};
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});
app.post('/staff/claims/:id/decision',async(req:any)=>{
  const user=staffAuth(req);canDecide(user);const settings=await activeShop(user.shopId);const {id}=params.parse(req.params);
  const input=z.discriminatedUnion('decision',[
    z.object({decision:z.literal('approved'),reason:z.string().max(3000).optional()}),
    z.object({decision:z.literal('denied'),reason:z.string().trim().min(1).max(3000)}),
    z.object({decision:z.literal('partial'),reason:z.string().trim().min(1).max(3000),customerChargeCents:z.number().int().positive()}),
  ]).parse(req.body);
  if(settings.requireDecisionReason!==false&&!input.reason?.trim()) fail(400,'Decision reason is required');
  const client=await pool.connect();try {await client.query('BEGIN');
    const found=await client.query(`SELECT status,inspection_required,inspection_completed_at,original_repair_verified_at FROM warranty_claims WHERE id=$1 AND shop_id=$2 FOR UPDATE`,[id,user.shopId]);
    if(!found.rowCount) fail(404,'Claim not found');
    if(!['submitted','needs_inspection','under_review'].includes(found.rows[0].status)) fail(409,'Decision has already been finalized');
    if(input.decision!=='denied' && !found.rows[0].original_repair_verified_at) fail(409,'Original repair must be verified by staff before approval');
    if(input.decision!=='denied' && found.rows[0].inspection_required && !found.rows[0].inspection_completed_at) fail(409,'Inspection must be completed before approval');
    if(input.decision!=='denied' && settings.requirePhotos!==false) { const photos=await client.query('SELECT COUNT(*)::int AS n FROM warranty_evidence WHERE claim_id=$1 AND confirmed_at IS NOT NULL',[id]); if(photos.rows[0].n<1) fail(409,'At least one confirmed photo is required'); }
    const charge=input.decision==='partial'?input.customerChargeCents:0;
    const status=input.decision==='denied'?'denied':input.decision==='partial'?'awaiting_payment':'ready_to_schedule';
    await client.query('UPDATE warranty_claims SET status=$3,decision=$4,decision_reason=$5,customer_charge_cents=$6,updated_at=NOW() WHERE id=$1 AND shop_id=$2',[id,user.shopId,status,input.decision,input.reason??null,charge]);
    await event(client,id,'staff',user.userId,'claim.decision',{decision:input.decision,reason:input.reason,customerChargeCents:charge});await enqueue(client,id,input.decision==='approved'?'approved':input.decision==='partial'?'partial':'denied');
    await client.query('COMMIT');return {id,status,customerChargeCents:charge};
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});
app.post('/staff/claims/:id/inspection/complete',async(req:any)=>{
  const user=staffAuth(req);canDecide(user);await activeShop(user.shopId);const {id}=params.parse(req.params);
  const body=z.object({findings:z.string().trim().min(1).max(4000)}).parse(req.body);
  const client=await pool.connect();try{await client.query('BEGIN');
    const r=await client.query(`UPDATE warranty_claims SET status='under_review',inspection_completed_at=NOW(),updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND status='needs_inspection' RETURNING id`,[id,user.shopId]);
    if(!r.rowCount) fail(409,'Claim is not awaiting inspection');
    await event(client,id,'staff',user.userId,'inspection.completed',body);await client.query('COMMIT');return {status:'under_review'};
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
});


// Payment is collected through the shop's own Stripe Connect account, never by the plugin.
app.post('/public/claims/:id/payment-checkout',async(req:any)=>{
  throttle(`payment:${req.ip}`,12,3600000);
  const c=await publicClaim(req);
  if(c.status!=='awaiting_payment'||c.customer_charge_cents<50) fail(409,'Claim is not awaiting an eligible payment');
  const result=await coreCall(c.shop_id,'warranty-checkouts','POST',{
    claimId:c.id,amountCents:c.customer_charge_cents,customerEmail:c.customer_email,
    successUrl:`${required('PUBLIC_BASE_URL').replace(/\/$/,'')}/claim-status/${c.id}?payment=returned`,
    cancelUrl:`${required('PUBLIC_BASE_URL').replace(/\/$/,'')}/claim-status/${c.id}?payment=canceled`
  },`warranty-checkout-${c.id}`);
  await pool.query('UPDATE warranty_claims SET payment_reference=$2 WHERE id=$1 AND status=$3',[c.id,result.sessionId,'awaiting_payment']);
  return {url:result.url};
});
app.post('/public/claims/:id/payment-refresh',async(req:any)=>{
  throttle(`paymentcheck:${req.ip}`,20,3600000);
  const c=await publicClaim(req);
  if(c.status!=='awaiting_payment') return {status:c.status,inspectionAppointmentId:c.inspection_appointment_id,originalRepairVerified:!!c.original_repair_verified_at};
  if(!c.payment_reference) return {status:c.status};
  const result=await coreCall(c.shop_id,`warranty-checkouts/${encodeURIComponent(c.payment_reference)}/status`);
  if(result.claimId!==c.id || result.amountCents!==c.customer_charge_cents || result.paid!==true) return {status:c.status};
  const client=await pool.connect();try {await client.query('BEGIN');
    const changed=await client.query(`UPDATE warranty_claims SET status='ready_to_schedule',payment_verified_at=NOW(),updated_at=NOW()
      WHERE id=$1 AND shop_id=$2 AND status='awaiting_payment' AND payment_reference=$3 RETURNING id`,[c.id,c.shop_id,c.payment_reference]);
    if(changed.rowCount){await event(client,c.id,'system',null,'payment.confirmed',{sessionId:c.payment_reference});await enqueue(client,c.id,'payment_received');}
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  const actual=await pool.query('SELECT status FROM warranty_claims WHERE id=$1',[c.id]);return {status:actual.rows[0]?.status||'awaiting_payment'};
});
// Reconcile paid checkouts even when customers do not return to the portal.
async function reconcilePayments() {
  const waiting=await pool.query(`SELECT id,shop_id,payment_reference,customer_charge_cents FROM warranty_claims WHERE status='awaiting_payment' AND payment_reference IS NOT NULL ORDER BY updated_at LIMIT 30`);
  for(const c of waiting.rows){try{
    const paid=await coreCall(c.shop_id,`warranty-checkouts/${encodeURIComponent(c.payment_reference)}/status`);
    if(paid.paid!==true||paid.claimId!==c.id||paid.amountCents!==c.customer_charge_cents)continue;
    const client=await pool.connect();try{await client.query('BEGIN');
      const r=await client.query(`UPDATE warranty_claims SET status='ready_to_schedule',payment_verified_at=NOW(),updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND status='awaiting_payment' AND payment_reference=$3 RETURNING id`,[c.id,c.shop_id,c.payment_reference]);
      if(r.rowCount){await event(client,c.id,'system',null,'payment.confirmed',{sessionId:c.payment_reference});await enqueue(client,c.id,'payment_received');}
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }catch(e){app.log.warn({claimId:c.id,err:String(e)},'Payment reconciliation failed');}}
}
// Pre-inspection uses a separate, tagged Opscend work order. It never modifies the original repair.
async function provisionInspection(c:any) {
  if (!c.inspection_required || c.status!=='needs_inspection') fail(409,'Claim does not require pre-inspection');
  if (!c.original_repair_verified_at || !c.original_repair_id) fail(409,'Verify the original repair before scheduling an inspection');
  const result=await coreCall(c.shop_id,'warranty-inspections','POST',
    {claimId:c.id,originalRepairId:c.original_repair_id,issue:c.issue},`warranty-inspection-${c.id}`);
  if(!result.repairId) fail(502,'Opscend did not return an inspection work order');
  const changed=await pool.query(`UPDATE warranty_claims SET inspection_repair_id=$3,updated_at=NOW()
    WHERE id=$1 AND shop_id=$2 AND (inspection_repair_id IS NULL OR inspection_repair_id=$3) RETURNING id`,
    [c.id,c.shop_id,result.repairId]);
  if(!changed.rowCount) fail(409,'A different inspection work order already exists');
  return result.repairId;
}
app.get('/public/claims/:id/inspection/slots',async(req:any)=>{
  throttle(`inspection-slots:${req.ip}`,20,3600000);
  const c=await publicClaim(req);
  const repairId=await provisionInspection(c);
  const from=new Date(),to=new Date(from.getTime()+7*86400000);
  return coreCall(c.shop_id,`warranty-repairs/${encodeURIComponent(repairId)}/slots?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&durationMinutes=30`);
});
app.post('/public/claims/:id/inspection/book',async(req:any)=>{
  throttle(`inspection-book:${req.ip}`,10,3600000);
  const c=await publicClaim(req);
  if(c.inspection_appointment_id) fail(409,'Inspection has already been scheduled');
  const body=z.object({startAt:z.string().datetime(),endAt:z.string().datetime(),assignedUserId:z.string().min(1).max(120)}).parse(req.body);
  const repairId=await provisionInspection(c);
  const booking=await coreCall(c.shop_id,`warranty-repairs/${encodeURIComponent(repairId)}/appointments`,'POST',body,`warranty-inspection-booking-${c.id}`);
  const client=await pool.connect();try{await client.query('BEGIN');
    const result=await client.query(`UPDATE warranty_claims SET inspection_appointment_id=$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2
      AND status='needs_inspection' AND (inspection_appointment_id IS NULL OR inspection_appointment_id=$3) RETURNING id`,
      [c.id,c.shop_id,booking.appointmentId]);
    if(!result.rowCount) fail(409,'Inspection appointment changed; contact the shop');
    await event(client,c.id,'customer',null,'inspection.scheduled',{appointmentId:booking.appointmentId,repairId});
    await enqueue(client,c.id,'inspection_scheduled');await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  return {inspectionAppointmentId:booking.appointmentId,startAt:body.startAt};
});
// A customer can revoke SMS consent using their authenticated claim access token.
app.post('/public/claims/:id/sms-opt-out',async(req:any)=>{
  throttle(`sms-optout:${req.ip}`,10,3600000);
  const c=await publicClaim(req);
  await pool.query('UPDATE warranty_claims SET sms_opt_in=FALSE,updated_at=NOW() WHERE id=$1 AND shop_id=$2',[c.id,c.shop_id]);
  await pool.query(`DELETE FROM warranty_notifications WHERE claim_id=$1 AND kind LIKE 'sms:%' AND delivered_at IS NULL`,[c.id]);
  return {ok:true};
});
// Create the linked warranty repair exactly once after approval and any required payment.
async function provisionWarrantyRepair(c:any) {
  if(c.status!=='ready_to_schedule' && c.status!=='scheduled') fail(409,'Claim is not ready for repair');
  if(!c.original_repair_verified_at||!c.original_repair_id) fail(409,'Original repair must be verified');
  if(c.customer_charge_cents>0&&!c.payment_verified_at) fail(409,'Payment must be confirmed before scheduling');
  const result=await coreCall(c.shop_id,'warranty-repairs','POST',{claimId:c.id,originalRepairId:c.original_repair_id,issue:c.issue},`warranty-repair-${c.id}`);
  if(!result.repairId) fail(502,'Opscend did not return a warranty repair');
  const client=await pool.connect();try {await client.query('BEGIN');
    const updated=await client.query(`UPDATE warranty_claims SET replacement_repair_id=$3,updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND (replacement_repair_id IS NULL OR replacement_repair_id=$3) RETURNING id`,[c.id,c.shop_id,result.repairId]);
    if(!updated.rowCount) fail(409,'Claim already links another repair');
    if(!c.replacement_repair_id) await event(client,c.id,'system',null,'repair.provisioned',{repairId:result.repairId});await client.query('COMMIT');
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
  return result.repairId;
}
app.get('/public/claims/:id/slots',async(req:any)=>{
  throttle(`slots:${req.ip}`,30,3600000);const c=await publicClaim(req);
  if(c.status!=='ready_to_schedule') fail(409,'Claim is not ready for scheduling');
  const from=new Date(),to=new Date(from.getTime()+7*86400000);
  const repairId=await provisionWarrantyRepair(c);
  return await coreCall(c.shop_id,`warranty-repairs/${encodeURIComponent(repairId)}/slots?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&durationMinutes=60`);
});
app.post('/public/claims/:id/book',async(req:any)=>{
  throttle(`book:${req.ip}`,12,3600000);const c=await publicClaim(req);
  if(!['ready_to_schedule','scheduled'].includes(c.status)) fail(409,'Claim cannot be booked');
  const body=z.object({startAt:z.string().datetime(),endAt:z.string().datetime(),assignedUserId:z.string().min(1).max(120)}).parse(req.body);
  const repairId=await provisionWarrantyRepair(c);
  const booking=await coreCall(c.shop_id,`warranty-repairs/${encodeURIComponent(repairId)}/appointments`,'POST',body,`warranty-booking-${c.id}`);
  const client=await pool.connect();try{await client.query('BEGIN');
    const result=await client.query(`UPDATE warranty_claims SET repair_appointment_id=$3,status='scheduled',updated_at=NOW() WHERE id=$1 AND shop_id=$2 AND status IN ('ready_to_schedule','scheduled') AND (repair_appointment_id IS NULL OR repair_appointment_id=$3) RETURNING id`,[c.id,c.shop_id,booking.appointmentId]);
    if(!result.rowCount) fail(409,'Claim has been booked to a different appointment');
    await event(client,c.id,'customer',null,'appointment.scheduled',{appointmentId:booking.appointmentId,repairId});await enqueue(client,c.id,'scheduled');await client.query('COMMIT');
  }catch(err){await client.query('ROLLBACK');throw err;}finally{client.release();}
  return {status:'scheduled',appointmentId:booking.appointmentId,repairId};
});

// Failed notifications can be replayed by Railway cron or staff. Requires runtime secret.
app.post('/internal/notifications/dispatch',async(req:any)=>{runtimeAuth(req);return {processed:await dispatchNotifications(30)};});
app.get('/staff/notifications',async(req:any)=>{
  const u=staffAuth(req);await activeShop(u.shopId);
  const r=await pool.query(`SELECT n.id,n.kind,n.attempts,n.delivered_at,n.last_error FROM warranty_notifications n JOIN warranty_claims c ON c.id=n.claim_id WHERE c.shop_id=$1 ORDER BY n.created_at DESC LIMIT 100`,[u.shopId]);return {data:r.rows};
});

app.setErrorHandler((error:any,req,reply)=>{
  if(error instanceof z.ZodError) return reply.code(400).send({error:'Invalid request',issues:error.flatten()});
  const code=Number(error.statusCode)||500;
  req.log.error({err:error},'Request failed');
  return reply.code(code).send({error:code>=500?'Internal server error':error.message});
});
await app.listen({port:Number(process.env.PORT||8080),host:'0.0.0.0'});
const runNotifications=()=>dispatchNotifications(20).catch(e=>app.log.error({err:e},'Notification dispatch failed'));
const timer=setInterval(runNotifications,30000);timer.unref();void runNotifications();
const paymentTimer=setInterval(()=>void reconcilePayments().catch(e=>app.log.error({err:e},'Payment reconciliation failed')),60000);paymentTimer.unref();void reconcilePayments().catch(e=>app.log.error({err:e},'Payment reconciliation failed'));
