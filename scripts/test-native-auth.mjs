import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountAuthorization, accessSession, appRequest } from './lib/native-auth.mjs';

test('explicit account token is never replaced or revoked', async () => {
  const auth = await accountAuthorization({accountId:'a'.repeat(32),environment:{CLOUDFLARE_API_TOKEN:'fixture-account'},run:()=>assert.fail('no CLI')});
  assert.equal(auth.token,'fixture-account'); await auth.close();
});
test('native account lease is bounded, account scoped and revoked on close', async () => {
  const calls=[];
  const run=async(kind,args,options)=>{calls.push({kind,args,options});
    if(args.includes('permission-groups'))return Buffer.from(JSON.stringify(['Account Settings Read','Workers Scripts Write','Workers Containers Write','Artifacts Write','Access: Apps and Policies Write','Access: Organizations, Identity Providers, and Groups Read','Secrets Store Write','Access: Service Tokens Write'].map((name,i)=>({id:String(i),name,scopes:['com.cloudflare.api.account']}))));
    if(args.includes('create'))return Buffer.from(JSON.stringify({id:'lease-id',value:'fixture-lease'}));return Buffer.from('{}');};
  const auth=await accountAuthorization({accountId:'a'.repeat(32),environment:{PATH:'/bin'},run});
  assert.equal(auth.token,'fixture-lease');
  const body=JSON.parse(calls.find(c=>c.args.includes('create')).args.at(-1));
  assert.deepEqual(body.policies[0].resources,{['com.cloudflare.api.account.'+'a'.repeat(32)]:'*'});
  assert(Date.parse(body.expires_on)-Date.now()<=2*60*60*1000);
  // Account token API rejects fractional seconds even though Date.parse accepts them.
  assert.match(body.expires_on,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert(!JSON.stringify(calls).includes('fixture-lease'));
  await auth.close(); assert(calls.at(-1).args.includes('lease-id')); assert(calls.at(-1).args.includes('--force'));
});
test('missing permission fails before creating a lease', async()=>{
  await assert.rejects(accountAuthorization({accountId:'a'.repeat(32),environment:{},run:async()=>Buffer.from('[]')}),/permission/);
});
test('optional email authorization limits zone permissions to the selected zone',async()=>{
 const calls=[],zoneId='b'.repeat(32),accountId='a'.repeat(32);
 const accountNames=['Account Settings Read','Workers Scripts Write','Workers Containers Write','Artifacts Write','Access: Apps and Policies Write','Access: Organizations, Identity Providers, and Groups Read','Secrets Store Read','Email Routing Account Rules Read'];
 const zoneNames=['Zone Read','DNS Read','Zone Settings Write','Email Routing Rules Write'];
 const run=async(_kind,args)=>{calls.push(args);if(args.includes('permission-groups'))return Buffer.from(JSON.stringify([...accountNames.map(name=>({id:name,name,scopes:['com.cloudflare.api.account']})),...zoneNames.map(name=>({id:name,name,scopes:['com.cloudflare.api.account.zone']}))]));if(args.includes('create'))return Buffer.from(JSON.stringify({id:'lease',value:'fixture-lease'}));return Buffer.from('{}');};
 const auth=await accountAuthorization({accountId,run,environment:{},additionalPermissions:['Secrets Store Read'],zoneId});
 const body=JSON.parse(calls.find(a=>a.includes('create')).at(-1));assert(body.policies[0].permission_groups.some(g=>g.id==='Email Routing Account Rules Read'),'Native Wrangler planning requires its account read permission');assert.equal(body.policies.length,2);assert.deepEqual(body.policies[1].resources,{['com.cloudflare.api.account.zone.'+zoneId]:'*'});assert.equal(body.policies[1].permission_groups.length,4);await auth.close();
});
test('Access session uses official client with private output and no credential file',async()=>{
  const calls=[]; const run=async(kind,args)=>{calls.push([kind,args]);return Buffer.from(args.includes('token')?'fixture-session':'');};
  assert.equal(await accessSession('https://app.example',run),'fixture-session');
  assert.deepEqual(calls,[['cloudflared',['access','login','--quiet','https://app.example/']],['cloudflared',['access','token','--app','https://app.example/']]]);
});
test('app request confines credentials, disables redirects and never retries mutations',async()=>{
  let sent=0;const fetcher=async(url,options)=>{sent++;assert.equal(url,'https://app.example/v1/test');assert.equal(options.headers.get('cf-access-token'),'fixture-session');assert.equal(options.redirect,'manual');throw Error('private provider detail');};
  await assert.rejects(appRequest({origin:'https://app.example',path:'/v1/test',session:async()=>'fixture-session',fetcher,options:{method:'POST'}}),/reconcile/);
  assert.equal(sent,1);
  for(const path of ['https://other.example/v1/test','//other.example/v1/test','/\\other.example/v1/test'])await assert.rejects(appRequest({origin:'https://app.example',path,session:()=>assert.fail('no credential lookup')}));
});
test('provider auth output never becomes error text',async()=>{
  await assert.rejects(accessSession('https://app.example',async()=>{throw Error('fixture-secret');}),e=>!e.message.includes('fixture-secret')&&e.message.includes('cloudflared'));
});
