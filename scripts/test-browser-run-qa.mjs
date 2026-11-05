import assert from 'node:assert/strict';
import {test} from 'node:test';
import {qaOrigin,withQAAccess,withQAServiceAuth,cloudflareAPI,qaPermissions,nativeSnapshot} from './browser-run-qa.mjs';
import {accountAuthorization} from './lib/native-auth.mjs';
import {privateProcess} from './lib/private-process.mjs';
import {developmentApp} from './browser-run-interactive-qa.mjs';

const accountId='a'.repeat(32),origin='https://app.example';
test('remote binding auth selects only the same-account Workers development app',()=>{
  const apps=[{id:'other',type:'self_hosted',domain:'*.other.workers.dev'},{id:'dev',type:'self_hosted',domain:'*.ours.workers.dev'}];
  assert.equal(developmentApp(apps,'https://app.ours.workers.dev').id,'dev');
  assert.equal(developmentApp(apps,'https://custom.example'),undefined);
  assert.equal(developmentApp(apps,'https://app.unknown.workers.dev'),undefined);
  assert.throws(()=>developmentApp([...apps,apps[1]],'https://app.ours.workers.dev'),/Ambiguous/);
});
test('trace sanitizer strips headers, cookies, credentials, bodies and unsafe paths',async()=>{
  await privateProcess('python3',['scripts/test-sanitize-qa-trace.py']);
});
function fixture({lostPolicy=false,lostToken=false}={}) {
  const original={id:'owner-policy',name:'Owner',precedence:1,decision:'allow',include:[{email:{email:'owner@example.com'}}]};
  const policies=[original],tokens=[],calls=[];
  const api=async(method,path,body)=>{
    calls.push({method,path,body});
    if(method==='GET'&&path.includes('/access/apps?'))return [{id:'app-id',domain:'app.example',type:'self_hosted'}];
    if(method==='GET'&&path.endsWith('/policies'))return structuredClone(policies);
    if(method==='GET'&&path.endsWith('/service_tokens'))return structuredClone(tokens);
    if(method==='POST'&&path.endsWith('/service_tokens')) {
      const t={id:'qa-token',client_id:'fixture-client',client_secret:'fixture-secret',...body};tokens.push(t);
      if(lostToken)throw Error('Lost token create response');return t;
    }
    if(method==='POST'&&path.endsWith('/policies')) {
      const p={id:'qa-policy',...body};policies.push(p);
      if(lostPolicy)throw Error('Lost policy create response');return p;
    }
    if(method==='DELETE') {
      const list=path.includes('/policies/')?policies:tokens;
      const id=path.split('/').at(-1),index=list.findIndex(x=>x.id===id);
      assert(index>=0);list.splice(index,1);return null;
    }
    throw Error('Unexpected fixture request');
  };
  return {api,original,policies,tokens,calls};
}
test('QA rejects ambiguous installation URLs',()=>{
  for(const url of ['http://app.example','https://app.example/path','https://secret@app.example','https://app.example?token=x'])assert.throws(()=>qaOrigin(url));
  assert.equal(qaOrigin(origin),origin);

});
test('QA uses a bounded exact-token Service Auth policy and removes only its resources',async()=>{
  const f=fixture(),proof={};
  await withQAAccess({api:f.api,accountId,origin,proof},async({headers})=>{
    assert.deepEqual(headers,{'CF-Access-Client-Id':'fixture-client','CF-Access-Client-Secret':'fixture-secret'});
    assert.equal(f.tokens[0].duration,'60m');
    assert.deepEqual(f.policies[1].include,[{service_token:{token_id:'qa-token'}}]);
    assert.equal(f.policies[1].decision,'non_identity');assert.equal(f.policies[1].precedence,2);
  });
  assert.deepEqual(f.policies,[f.original]);assert.deepEqual(f.tokens,[]);
  assert.deepEqual(proof.cleanup,{policy:'removed',serviceToken:'removed'});
  assert(!JSON.stringify(proof).includes('fixture-secret'));
});
test('sharing QA Service Auth across two apps removes the extra policy without revoking its parent credential',async()=>{
  const f=fixture(),credential={id:'existing-qa',client_id:'fixture-client',client_secret:'fixture-secret'};
  f.tokens.push(credential);
  await withQAServiceAuth({api:f.api,accountId,app:{id:'app-id',type:'self_hosted'},proof:{},existingCredential:credential},async headers=>{assert.equal(headers['CF-Access-Client-Id'],'fixture-client');});
  assert.deepEqual(f.tokens,[credential]);assert.deepEqual(f.policies,[f.original]);
  assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/service_tokens')).length,0);
});
test('failed QA and lost create responses still revoke newly issued access without retrying creation',async()=>{
  for(const options of [{},{lostPolicy:true},{lostToken:true}]) {
    const f=fixture(options),proof={};
    await assert.rejects(withQAAccess({api:f.api,accountId,origin,proof},async()=>{throw Error('QA failed');}));
    assert.deepEqual(f.policies,[f.original]);assert.deepEqual(f.tokens,[]);
    assert.equal(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/service_tokens')).length,1);
    assert(f.calls.filter(c=>c.method==='POST'&&c.path.endsWith('/policies')).length<=1);
  }
});
test('QA refuses a wildcard-only Access app before issuing credentials',async()=>{
  const f=fixture();const api=(method,path,body)=>path.includes('/access/apps?')?[{id:'broad-app',domain:'*.example',type:'self_hosted'}]:f.api(method,path,body);
  await assert.rejects(withQAAccess({api,accountId,origin,proof:{}},()=>assert.fail()),/exact-host/);
  assert.equal(f.calls.length,0);
});
test('API client confines account auth and errors never echo provider secrets',async()=>{
  let calls=0;
  const api=cloudflareAPI('fixture-account',async(url,options)=>{
    calls++;assert(url.startsWith('https://api.cloudflare.com/client/v4/accounts/'));
    assert.equal(options.redirect,'manual');return new Response('fixture-secret',{status:403});
  });
  await assert.rejects(api('GET',`/accounts/${accountId}/access/apps`),e=>e.message.includes('403')&&!e.message.includes('fixture-secret'));
  await assert.rejects(api('GET','https://other.example/'));assert.equal(calls,1);
});
test('QA account lease asks only for Access management permissions',async()=>{
  let created;
  const run=async(_command,args)=>{
    if(args.includes('permission-groups'))return Buffer.from(JSON.stringify(qaPermissions.map((name,i)=>({id:String(i),name,scopes:['com.cloudflare.api.account']}))));
    if(args.includes('create')){created=JSON.parse(args.at(-1));return Buffer.from(JSON.stringify({id:'lease',value:'fixture-value'}));}
    return Buffer.from('{}');
  };
  const lease=await accountAuthorization({accountId,run,environment:{},permissionNames:qaPermissions,purpose:'browser qa'});
  assert.equal(created.policies[0].permission_groups.length,2);
  assert(created.name.startsWith('PentCloud browser qa '));await lease.close();
});
test('Browser Run captures use private stdin and native CLI auth, never secret command arguments',async()=>{
  const calls=[];
  const capture=await nativeSnapshot({accountId,body:{setExtraHTTPHeaders:{'CF-Access-Client-Secret':'fixture-secret'}},run:async(command,args,options)=>{calls.push({command,args,options});return Buffer.from(JSON.stringify({content:'fixture'}));}});
  assert.equal(capture.content,'fixture');
  const c=calls[0];assert.equal(c.command,'cf');assert(c.options.accountAuthorization);
  assert.equal(c.options.env.CLOUDFLARE_ACCOUNT_ID,accountId);
  assert(c.args.includes('@/dev/stdin'));assert(!JSON.stringify(c.args).includes('fixture-secret'));
  assert.equal(JSON.parse(c.options.input).setExtraHTTPHeaders['CF-Access-Client-Secret'],'fixture-secret');
});
test('private process pipes JSON through stdin and captures output without echoing credentials',async()=>{
  const output=await privateProcess(process.execPath,['-e',"let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.stdout.write(String(s.length)));"],{input:'fixture-private-json'});
  assert.equal(output.toString(),String('fixture-private-json'.length));
});
