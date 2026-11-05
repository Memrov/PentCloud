// Official Cloudflare clients own login, refresh and credential caches. This
// adapter captures token output privately; it never reads their credential files.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const permissions = ['Account Settings Read', 'Workers Scripts Write', 'Workers Containers Write',
  'Artifacts Write', 'Access: Apps and Policies Write',
  'Access: Organizations, Identity Providers, and Groups Read'];
const result = buffer => { const value=JSON.parse(buffer.toString()); return value.result ?? value; };
export async function accountAuthorization({accountId, run, environment=process.env, legacy=false, permissionNames=permissions, purpose='setup'}) {
  assert.match(accountId,/^[a-f0-9]{32}$/,'Select an explicit account');
  if(environment.CLOUDFLARE_API_TOKEN)return {token:environment.CLOUDFLARE_API_TOKEN,close:async()=>{}};
  const env={...environment,CLOUDFLARE_ACCOUNT_ID:accountId};
  // cf uses its own official login. A lease has no token-management permission;
  // revocation uses the original CLI session, never the minted credential.
  const cf=args=>run('cf',args,{env,accountAuthorization:true});
  let groups;
  try { groups=result(await cf(['accounts','tokens','permission-groups','list'])); }
  catch { throw Error('Cloudflare account authorization unavailable; run cf auth login and grant the selected account token-management and deployment permissions'); }
  assert(Array.isArray(groups),'Cloudflare permission listing returned an unexpected shape');
  const ids=[...permissionNames,...(legacy?['Secrets Store Write','Access: Service Tokens Write']:[])].map(name=>{
    const matches=groups.filter(g=>g.name===name && (g.scopes??g.meta?.scopes??[]).includes('com.cloudflare.api.account'));
    assert.equal(matches.length,1,`Cloudflare account permission unavailable or ambiguous: ${name}`);
    return {id:matches[0].id};
  });
  assert.match(purpose,/^[a-z][a-z -]{0,40}$/,'Use a nonsecret credential purpose');
  const body={name:`PentCloud ${purpose} ${randomUUID()}`,expires_on:new Date(Date.now()+2*60*60*1000).toISOString().replace(/\.\d{3}Z$/,'Z'),
    policies:[{effect:'allow',permission_groups:ids,resources:{[`com.cloudflare.api.account.${accountId}`]:'*'}}]};
  let lease;
  try { lease=result(await cf(['accounts','tokens','create','--body',JSON.stringify(body)])); }
  catch { throw Error('Cloudflare deployment credential creation failed; inspect native account token metadata before retrying (any issued lease expires within two hours)'); }
  const close=async()=>{
    try { await cf(['accounts','tokens','delete',lease.id,'--force']); }
    catch { throw Error('Cloudflare deployment lease revocation failed; revoke the PentCloud setup token in Cloudflare account API tokens (it expires within two hours)'); }
  };
  assert(lease?.id,'Cloudflare did not return a deployment lease identity; inspect account token metadata before retrying');
  if(!lease.value){await close();throw Error('Cloudflare did not return the deployment credential');}
  return {token:lease.value,id:lease.id,name:body.name,expiresOn:body.expires_on,close};
}
function application(origin){
  const url=new URL(origin);
  assert(url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&url.pathname==='/', 'Use the HTTPS installation origin');
  return url;
}
export async function accessSession(origin,run){
  const url=application(origin);
  try {
    // --quiet prevents login printing the JWT. cloudflared validates/renews its
    // own cache at the edge; token stdout below is captured, never streamed.
    await run('cloudflared',['access','login','--quiet',url.href],{timeout:300_000});
    const token=(await run('cloudflared',['access','token','--app',url.href])).toString().trim();
    assert(token && !/\s/.test(token),'empty token'); return token;
  }catch{throw Error('Cloudflare Access session unavailable; complete cloudflared access login --quiet for this installation, then retry');}
}
export async function appRequest({origin,path,session,fetcher=fetch,options={}}){
  const base=application(origin),url=new URL(path,base);
  assert(path.startsWith('/')&&!path.startsWith('//')&&!path.includes('\\')&&url.origin===base.origin&&!url.hash&&url.pathname.startsWith('/v1/'),'Application request must stay within this installation API');
  const headers=new Headers(options.headers);
  for(const key of ['Authorization','Cookie','CF-Access-Client-Id','CF-Access-Client-Secret','Cf-Access-Jwt-Assertion'])headers.delete(key);
  headers.set('cf-access-token',await session());
  try {return await fetcher(url.href,{...options,headers,redirect:'manual',signal:AbortSignal.timeout(30_000)});}
  catch {throw Error('Application request failed; reconcile state before retrying a mutation');}
}
