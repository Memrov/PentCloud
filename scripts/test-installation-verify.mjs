import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {withNativeTestHarness} from './lib/native-test-harness.mjs';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';

const root=resolve(import.meta.dirname,'..'),accountId='a'.repeat(32),zoneId='b'.repeat(32),instance='customer';
test('native Browser relay preserves upstream MIME, decoded bytes and safe headers in real workerd',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-browser-headers-')),received=[];
  const source='globalThis.fixtureLoaded=true;';
  const upstream=createServer((request,response)=>{
    let input='';request.on('data',part=>{input+=part;});request.on('end',()=>{received.push({method:request.method,headers:request.headers,body:input});const gzip=request.url.includes('gzip'),html=request.url.includes('html'),body=html?'<main>owned fixture</main>':source,bytes=gzip?gzipSync(body):Buffer.from(body);response.writeHead(200,{'Content-Type':html?'text/html':'text/javascript','Content-Length':String(bytes.length),'Content-Security-Policy':"script-src 'self'",'Set-Cookie':['fixture=owned; HttpOnly; SameSite=Strict','second=owned; Secure'],...(gzip?{'Content-Encoding':'gzip'}:{})});response.end(bytes);});
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+upstream.address().port;
  try{
    await writeFile(join(directory,'worker.mjs'),`import {request} from ${JSON.stringify(join(root,'node_modules/@cloudflare/playwright/lib/index.js'))};import {installationBrowserResponse} from ${JSON.stringify(join(root,'scripts/lib/installation-probe-worker.mjs'))};import {get} from 'node:http';export default {async fetch(){const node=await new Promise(resolve=>get(${JSON.stringify(origin+'/fixture.js')},response=>{response.resume();resolve({type:response.headers['content-type']??null,rawCount:response.rawHeaders.length});}));const client=await request.newContext();try{const api=await client.get(${JSON.stringify(origin+'/fixture.js')});const collected=[];for(const path of ['/fixture.js','/fixture.js?gzip','/fixture.html']){const result=await installationBrowserResponse({url:()=>${JSON.stringify(origin)}+path,method:()=>path.includes('gzip')?'POST':'GET',headers:()=>({Host:'foreign.invalid','Content-Length':'999','Accept-Encoding':'fixture-unsupported',Connection:'x-fixture-hop','X-Fixture-Hop':'drop-me'}),postDataBuffer:()=>new TextEncoder().encode('owned request body')},{origin:${JSON.stringify(origin)},headers:{'CF-Access-Client-Id':'owned-id','CF-Access-Client-Secret':'owned-secret'}});collected.push({type:result.headers['content-type'],encoding:result.headers['content-encoding']??null,length:result.headers['content-length'],bytes:result.body.length,sourceMatches:result.body.toString()===${JSON.stringify(source)},htmlMatches:result.body.toString()==='<main>owned fixture</main>',csp:result.headers['content-security-policy']==="script-src 'self'",cookie:result.headers['set-cookie']?.includes('fixture=owned')===true&&result.headers['set-cookie']?.includes('second=owned')===true&&result.headers['set-cookie']?.split('\\n').length===2});}return Response.json({node,playwrightType:api.headers()['content-type']??null,collected});}finally{await client.dispose();}}};`);
    await writeFile(join(directory,'wrangler.json'),JSON.stringify({name:'browser-headers-fixture',main:'worker.mjs',compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat']}));
    await withNativeTestHarness({root:directory,workers:[{configPath:'wrangler.json'}]},async server=>{
      const result=await (await server.fetch('https://fixture.test/')).json();assert.equal(result.node.type,'text/javascript');
      assert([null,'text/javascript'].includes(result.playwrightType));
      assert.equal(result.collected.length,3);
      for(const [index,item]of result.collected.entries()){assert.equal(item.type,index===2?'text/html':'text/javascript');assert.equal(item.encoding,null);assert.equal(Number(item.length),item.bytes);assert.equal(item.csp,true);assert.equal(item.cookie,true);assert.equal(index===2?item.htmlMatches:item.sourceMatches,true);}
    });
    for(const request of received.slice(-3)){assert.notEqual(request.headers.host,'foreign.invalid');assert.equal(request.headers['x-fixture-hop'],undefined);assert.notEqual(request.headers['accept-encoding'],'fixture-unsupported');assert.equal(request.headers['cf-access-client-secret'],'owned-secret');if(request.method==='POST')assert.equal(request.body,'owned request body');else assert.equal(request.body,'');}
  }finally{await new Promise(resolve=>upstream.close(resolve));await rm(directory,{recursive:true,force:true});}
});
async function fixture(check){
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-verification-'));
  const shared=await import('./lib/owned-probe.mjs');
  const owner={accountId,instance,operationId:'1762452000000-0123456789ab'};
  const path=shared.verificationJournalPath(directory);
  try{const journal=await shared.createVerificationJournal({temporaryDirectory:directory,owner,namespace:'customer-work'});await check({shared,directory,path,journal,persist:()=>shared.saveCleanupJournal(path,journal)});}
  finally{await rm(directory,{recursive:true,force:true});}
}
function provider(){
  const scripts=new Set(),domains=[],dns=[],tokens=[],policies=[{id:'owner-policy',name:'Owner',decision:'allow'}],repos=[],deletes=[];
  let appRemoved=false;
  const api={async request(path,{method='GET',body,envelope=false}={}){
    const url=new URL(path,'https://fixture.invalid'),p=url.pathname;
    if(p==='/zones/'+zoneId)return {id:zoneId,name:'customer.example',status:'active',account:{id:accountId}};
    if(p==='/zones/'+zoneId+'/dns_records')return envelope?{result:dns}:{...dns};
    if(p.endsWith('/workers/domains'))return domains.map(x=>({...x}));
    if(p.includes('/workers/domains/')){const i=domains.findIndex(x=>x.id===p.split('/').at(-1));if(method==='DELETE'){domains.splice(i,1);deletes.push(p);return null;}return i<0?null:{...domains[i]};}
    const worker=p.match(/\/workers\/scripts\/([^/]+)(?:\/settings)?$/);
    if(worker){if(method==='DELETE'){scripts.delete(worker[1]);deletes.push(p);return null;}return scripts.has(worker[1])?{name:worker[1]}:null;}
    if(p.endsWith('/access/apps/app-owned'))return appRemoved?null:{id:'app-owned',type:'self_hosted',domain:'app.customer.example'};
    const isRepo=p.includes('/repos'),list=isRepo?repos:p.includes('/access/service_tokens')?tokens:policies;
    const collection=p.endsWith('/repos')||p.endsWith('/service_tokens')||p.endsWith('/policies');
    if(method==='GET')return collection?list.map(x=>({...x})):list.find(x=>x.name===p.split('/').at(-1)||x.id===p.split('/').at(-1))??null;
    if(method==='POST'){const value={...body,id:isRepo?'repo-owned':body.decision?'policy-owned':'token-owned',client_id:'PRIVATE_CLIENT',client_secret:'PRIVATE_SECRET'};list.push(value);return value;}
    if(method==='DELETE'){const id=p.split('/').at(-1),i=list.findIndex(x=>x.id===id||x.name===id);if(i>=0)list.splice(i,1);deletes.push(p);return null;}
    throw Error('Unexpected fixture request');
  }};
  api.list=path=>api.request(path);
  return {api,scripts,domains,dns,tokens,policies,repos,deletes,removeApp(){appRemoved=true;policies.length=0;}};
}
test('shared probe uses the selected customer zone and records intent before deployment',async()=>fixture(async({shared,journal,path,persist})=>{
  const p=provider();await shared.deployProbe({api:p.api,journal,persist,zoneId,deploy:async()=>{
    const disk=JSON.parse(await readFile(path));assert(disk.probe.attempted&&disk.domain.attempted);
    p.scripts.add(journal.probe.name);p.domains.push({id:'domain-owned',hostname:shared.probeHostname(journal),service:journal.probe.name,zone_id:zoneId,environment:'production'});
  }});
  assert(shared.probeHostname(journal).endsWith('.customer.example'));assert.equal(journal.domain.id,'domain-owned');
  await shared.cleanupOwnedResources({api:p.api,journal,persist});assert.equal(p.scripts.size,0);assert.equal(p.domains.length,0);
  assert(p.deletes[0].endsWith('/workers/domains/domain-owned'));
}));
test('shared evidence reconciles a lost create response and removes only its exact nonce and ID',async()=>fixture(async({shared,journal,persist})=>{
  const p=provider();p.repos.push({id:'foreign',name:'user-data',description:'User evidence'});
  const request=p.api.request.bind(p.api);p.api.request=async(path,options)=>{const result=await request(path,options);if(options?.method==='POST'&&path.endsWith('/repos'))throw Error('PRIVATE_PROVIDER_ERROR');return result;};
  await assert.rejects(shared.createEvidenceRepository({api:p.api,journal,persist}));assert(journal.evidence.attempted&&journal.evidence.absentBeforeCreate);
  await shared.cleanupOwnedResources({api:p.api,journal,persist});assert.deepEqual(p.repos.map(x=>x.name),['user-data']);assert(journal.evidence.removed);
}));
test('shared evidence collisions are not adopted and changed receipts block deletion',async()=>{
  for(const mode of ['collision','id','description'])await fixture(async({shared,journal,persist})=>{
    const p=provider();if(mode==='collision')p.repos.push({id:'foreign',name:journal.evidence.name,description:journal.evidence.description});
    if(mode==='collision'){await assert.rejects(shared.createEvidenceRepository({api:p.api,journal,persist}));await shared.cleanupOwnedResources({api:p.api,journal,persist});}
    else{await shared.createEvidenceRepository({api:p.api,journal,persist});p.repos[0][mode]='foreign';await assert.rejects(shared.cleanupOwnedResources({api:p.api,journal,persist}));}
    assert.equal(p.deletes.length,0);assert.equal(p.repos.length,1);
  });
});
test('shared evidence cleanup waits for an accepted asynchronous delete without repeating mutation',async()=>fixture(async({shared,journal,persist})=>{
  const p=provider();await shared.createEvidenceRepository({api:p.api,journal,persist});
  const request=p.api.request.bind(p.api);let pending=0,deleteCalls=0,time=0;
  p.api.request=async(path,options)=>{
    if(path.includes('/repos/')&&options?.method==='DELETE'){deleteCalls++;pending=2;return {id:'repo-owned'};}
    if(path.includes('/repos/')&&pending&&!--pending)p.repos.length=0;
    return request(path,options);
  };
  await shared.cleanupOwnedResources({api:p.api,journal,persist,now:()=>time,sleep:async ms=>{time+=ms;}});
  assert.equal(deleteCalls,1);assert.equal(p.repos.length,0);assert(journal.evidence.removed);assert(time>0);
}));
test('shared cleanup rejects a journal from a different installation',async()=>fixture(async({shared,directory})=>{
  const p=provider();await assert.rejects(shared.cleanupInstallationVerification({api:p.api,temporaryDirectory:directory,accountId,instance:'foreign'}));assert.equal(p.deletes.length,0);
}));
test('headless Access preserves Owner and removes exact token even when uninstall deletes its app',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-access-')),p=provider();
  const {withInstallationAccess}=await import('./lib/owned-probe.mjs');
  const installer={api:p.api,config:{accountId,instance},state:{appUrl:'https://app.customer.example',resources:{access:{id:'app-owned'}}},names:{namespace:'customer-work'}};
  try{
    const result=await withInstallationAccess({installer,temporaryDirectory:join(directory,'verification')},async({headers})=>{assert.equal(headers['CF-Access-Client-Secret'],'PRIVATE_SECRET');assert(p.policies.some(x=>x.name==='Owner'));p.removeApp();return 'done';});
    assert.equal(result,'done');assert.equal(p.tokens.length,0);assert(!p.deletes.some(x=>x.includes('owner-policy')));
    await assert.rejects(readFile(join(directory,'verification','owned-verification.json')),/ENOENT/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('headless Access failures expose a bounded code and never persist credentials',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-access-private-')),p=provider();
  const {withInstallationAccess}=await import('./lib/owned-probe.mjs');
  const installer={api:p.api,config:{accountId,instance},state:{appUrl:'https://app.customer.example',resources:{access:{id:'app-owned'}}},names:{namespace:'customer-work'}};
  try{await assert.rejects(withInstallationAccess({installer,temporaryDirectory:directory},async()=>{throw Error('PRIVATE_PROVIDER_ERROR');}),error=>!String(error).includes('PRIVATE'));assert.equal(p.tokens.length,0);}
  finally{await rm(directory,{recursive:true,force:true});}
});
test('a new operation reconciles the previous exact evidence repository before creating Access credentials',async()=>fixture(async({shared,directory,journal,persist})=>{
  const p=provider();await shared.createEvidenceRepository({api:p.api,journal,persist});
  const installer={api:p.api,config:{accountId,instance},state:{appUrl:'https://app.customer.example',resources:{access:{id:'app-owned'}}},names:{namespace:'customer-work'}};
  await shared.withInstallationAccess({installer,temporaryDirectory:directory},async()=>{assert.equal(p.repos.length,0);assert.equal(p.tokens.length,1);});
  assert.equal(p.tokens.length,0);assert.deepEqual(p.policies.map(x=>x.name),['Owner']);
}));
test('shared cleanup preserves a temporary policy whose exact token rule changed',async()=>fixture(async({shared,journal,persist})=>{
  const p=provider();await assert.rejects(shared.withCIProbeAccess({api:p.api,journal,persist,appId:'app-owned',origin:'https://app.customer.example'},async()=>{p.policies.find(x=>x.id==='policy-owned').include=[{everyone:{}}];}));
  assert(p.policies.some(x=>x.id==='policy-owned'));assert(!p.deletes.some(x=>x.endsWith('/policy-owned')));
}));
test('shared cleanup rejects added principals on its token policy',async()=>fixture(async({shared,journal,persist})=>{
  const p=provider();await assert.rejects(shared.withCIProbeAccess({api:p.api,journal,persist,appId:'app-owned',origin:'https://app.customer.example'},async()=>{p.policies.find(x=>x.id==='policy-owned').include[0].everyone={};}));
  assert(!p.deletes.some(x=>x.endsWith('/policy-owned')));
}));
test('shared verifier reports bounded native checks and passes private exact image references',async()=>{
  const {verifyPackageInstallation}=await import('./lib/installation-verify.mjs');
  assert.equal(typeof verifyPackageInstallation,'function');
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-verifier-')),p=provider(),requests=[],logs=[],gitCommit='c'.repeat(40);let probeConfig,ref,doctorCalls=0,workflowRead=false,failure;
  const images=Object.fromEntries(['recon','http','nuclei','sqlmap','service','web-context','pcap','file-analysis','password','reference','metasploit'].map(pack=>[pack,'registry.example/private/'+pack+':selected']));
  const installer={api:p.api,config:{accountId,instance},names:{namespace:'customer-work',gateway:'customer-packs',workflow:'customer-results'},profile:{domain:{zoneId,hostname:'app.customer.example'},images},state:{appUrl:'https://app.customer.example',resources:{access:{id:'app-owned'}}},async workerSecret(){},async doctor(options){assert.deepEqual(options,{authenticate:false});assert.equal(p.tokens.length,0);assert.equal(p.policies.length,1);doctorCalls++;}};
  const request=p.api.request.bind(p.api);p.api.request=async(path,options)=>{
    if(path.includes('/workflows/')){
      if(path.includes('?per_page=')){if(!workflowRead){workflowRead=true;return [];}return [{id:'synthetic-event',trigger_source:'event'}];}
      return {status:'complete',params:{type:'cf.artifacts.repo.pushed',source:{type:'artifacts.repo',namespace:'customer-work',repoName:p.repos[0].name},payload:{ref,after:gitCommit}},trigger:{source:'event'},steps:[{type:'step',name:'validate committed result',success:true}]};
    }
    if(path.endsWith('/tokens')&&options?.method==='POST')return {id:'git-token',plaintext:'private-git-token'};
    if(path.endsWith('/tokens/git-token'))return null;
    const result=await request(path,options);if(path.includes('/repos/')&&result&&!Array.isArray(result))return {...result,remote:`https://${accountId}.artifacts.cloudflare.net/git/customer-work/${result.name}.git`};return result;
  };
  const run=async(kind,args)=>{
    if(kind==='wrangler'){
      probeConfig=JSON.parse(await readFile(args[args.indexOf('--config')+1]));p.scripts.add(probeConfig.name);p.domains.push({id:'domain-owned',hostname:probeConfig.routes[0].pattern,service:probeConfig.name,zone_id:zoneId});return Buffer.alloc(0);
    }
    if(kind==='git'){if(args.includes('push'))ref=args.at(-1).split(':')[1];if(args.includes('rev-parse'))return Buffer.from(gitCommit+'\n');return Buffer.alloc(0);}
    throw Error('Unexpected run kind');
  };
  const previousFetch=globalThis.fetch;globalThis.fetch=async(url,options={})=>{
    const u=new URL(url);if(u.hostname==='app.customer.example')return new Response(null,{status:failure?.path===u.pathname?500:u.pathname==='/v1/toolbox/status'?404:200});
    const input=JSON.parse(options.body);requests.push(input);if(input.action==='ready')return Response.json({ready:'passed'});
    if(failure?.action===input.action)return Response.json({error:'PRIVATE_PROVIDER_BODY',checkpoint:failure.checkpoint,provider:'PRIVATE_PROVIDER_ID',status:999,httpStatus:failure.httpStatus,browserDiagnostics:failure.diagnostics},{status:502});
    if(input.action==='pack'){assert.equal(input.expectedImage,images[input.pack]);return Response.json({pack:input.pack,status:'passed'});}
    return Response.json({[input.action]:'passed'});
  };
  try{
    const result=await verifyPackageInstallation({installer,root,run,temporaryDirectory:directory,sourceCommit:'d'.repeat(40),log:value=>logs.push(value)});
    assert.equal(result.status,'verified-package-installation');assert.equal(result.toolPacks,11);assert.equal(result.noKali,true);assert.equal(result.modelCalls,0);assert.equal(doctorCalls,1);assert.equal(requests.filter(x=>x.action==='pack').length,11);
    assert.equal(probeConfig.workers_dev,false);assert.equal(probeConfig.preview_urls,false);assert.deepEqual(probeConfig.observability,{enabled:false});assert(probeConfig.routes[0].pattern.endsWith('.customer.example'));
    assert.equal(p.scripts.size,0);assert.equal(p.domains.length,0);assert.equal(p.repos.length,0);assert(!JSON.stringify(logs).includes('registry.example'));assert(!JSON.stringify(result).includes(accountId));
    workflowRead=false;
    const second=await verifyPackageInstallation({installer,root,run,temporaryDirectory:directory,sourceCommit:'d'.repeat(40),log:value=>logs.push(value)});
    assert.deepEqual(second,result);assert.equal(doctorCalls,2);assert.equal(requests.filter(x=>x.action==='pack').length,22);assert.equal(p.repos.length,0);assert.equal(p.scripts.size,0);
    for(const scenario of [
      {path:'/v1/runs',stage:'api-runs'},{path:'/v1/onboarding',stage:'api-onboarding'},{path:'/v1/lifecycle',stage:'api-lifecycle'},{path:'/v1/toolbox/status',stage:'no-kali'},
      {action:'loader',checkpoint:'loader-create',stage:'native-loader'},{action:'markdown',checkpoint:'markdown-result',stage:'native-markdown'},{action:'browser',checkpoint:'browser-navigate',stage:'native-browser'},
      {action:'browser',checkpoint:'browser-access',httpStatus:403,stage:'native-browser'},
      {action:'browser',checkpoint:'browser-request',httpStatus:999,stage:'native-browser'},
      {action:'browser',checkpoint:'browser-content',stage:'native-browser',diagnostics:{hasRoot:true,rootChildCount:0,url:'PRIVATE_URL',runtimeErrors:{TypeError:1,message:'PRIVATE_TEXT'}}},
      {action:'browser',checkpoint:'PRIVATE_PROVIDER_BODY',stage:'native-browser'},
    ]){
      failure=scenario;
      await assert.rejects(verifyPackageInstallation({installer,root,run,temporaryDirectory:directory,sourceCommit:'d'.repeat(40),log:value=>logs.push(value)}),error=>{
        assert.equal(error.code,'PC_INSTALLATION_VERIFICATION');assert.equal(error.verificationStage,scenario.stage);assert.equal(error.probeStatus,scenario.httpStatus===403?403:scenario.path?500:502);
        assert.equal(error.probeCheckpoint,scenario.checkpoint==='PRIVATE_PROVIDER_BODY'?undefined:scenario.checkpoint);
        assert.deepEqual(error.browserDiagnostics,scenario.diagnostics?{hasRoot:true,rootChildCount:0,runtimeErrors:{TypeError:1}}:undefined);assert(!JSON.stringify(error).includes('PRIVATE_'));return true;
      });
      assert.equal(p.tokens.length,0);assert.equal(p.scripts.size,0);assert.equal(p.domains.length,0);
    }
    assert(!JSON.stringify(logs).includes('PRIVATE_'));
  }catch(error){error.message+=' '+JSON.stringify(logs);throw error;}
  finally{globalThis.fetch=previousFetch;await rm(directory,{recursive:true,force:true});}
});
test('shared worker requires the selected pack image and always retires its runtime',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'pentcloud-image-probe-'));
  try{
    await writeFile(join(directory,'worker.mjs'),`import probe from ${JSON.stringify(join(root,'scripts/lib/installation-probe-worker.mjs'))};let stops=0;export default {fetch(request){if(new URL(request.url).pathname==='/stops')return Response.json({stops});return probe.fetch(request,{CI_PROBE_TOKEN:'fixture-token',CI_PROBE_EXPIRES_AT:String(Date.now()+60000),TOOL_PACKS:{ready:async()=>({image:'registry.example/private:wrong',instance:'private-instance'}),stop:async()=>{stops++;return {stopped:true}}}})}};`);
    await writeFile(join(directory,'wrangler.json'),JSON.stringify({name:'image-probe-fixture',main:'worker.mjs',compatibility_date:'2026-10-30',compatibility_flags:['nodejs_compat']}));
    await withNativeTestHarness({root:directory,workers:[{configPath:'wrangler.json'}]},async server=>{
      const r=await server.fetch('https://probe.test/',{method:'POST',headers:{Authorization:'Bearer fixture-token'},body:JSON.stringify({action:'pack',pack:'recon',id:'owned',expectedImage:'registry.example/private:expected'})});
      assert.equal(r.status,500);const body=await r.text();assert(!body.includes('registry.example'));assert(!body.includes('private-instance'));assert.match(body,/pack-ready/);
      assert.deepEqual(await (await server.fetch('https://probe.test/stops')).json(),{stops:1});
    });
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('Browser probe waits for visible rendered root content while confining credentials and redirects',async()=>{
  const origin='https://app.customer.example',headers={'CF-Access-Client-Id':'private-client','CF-Access-Client-Secret':'private-secret'},events=[];let handler,failFetch=false,rendered=false;
  const prior=globalThis.__installationProbeLaunch,previousFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{assert.equal(new URL(url).origin,origin);assert.equal(options.redirect,'manual');assert.equal(options.headers.get('CF-Access-Client-Secret'),headers['CF-Access-Client-Secret']);if(failFetch)throw Error('PRIVATE_FETCH_ERROR');events.push('fetch');return new Response('owned bytes',{status:String(url).endsWith('/redirect')?302:200,headers:{'content-type':'text/html'}});};
  globalThis.__installationProbeLaunch=async()=>({async newContext(options){
    assert.equal(options.extraHTTPHeaders,undefined);assert.equal(options.serviceWorkers,'block');
    return {request:{async get(url,options){assert.equal(url,origin+'/v1/runs');assert.equal(options.maxRedirects,0);assert.deepEqual(options.headers,headers);events.push('ready');return {status:()=>200,json:async()=>({runs:[]}),async dispose(){}};}},async route(pattern,callback){handler=callback;},async newPage(){return {async goto(){
      for(const url of [origin,origin+'/redirect','https://foreign.invalid'])await handler({request:()=>({url:()=>url,headers:()=>({accept:'text/html'})}),async fetch(options){assert.equal(new URL(url).origin,origin);assert.equal(options.maxRedirects,0);assert.equal(options.headers['CF-Access-Client-Secret'],headers['CF-Access-Client-Secret']);if(failFetch)throw Error('PRIVATE_FETCH_ERROR');events.push('fetch');return {status:()=>url.endsWith('/redirect')?302:200,async dispose(){events.push('dispose');}};},async fulfill(){events.push('fulfill');},async abort(){events.push('abort');},async continue(){throw Error('unsafe redirect propagation');}});
      return {status:()=>200};},on(){},evaluate:async()=>({hasRoot:true,documentTitlePentCloud:true,hasRenderedPentCloud:false,rootChildCount:0}),locator:selector=>({first(){return this;},async waitFor(options){assert.equal(selector,'#root :text-is("PentCloud"):visible');assert.deepEqual(options,{state:'visible',timeout:30000});rendered=true;events.push('visible');},innerText:async()=>rendered?'PentCloud':'Loading'})};}};
  },async close(){events.push('close');}});
  try{
    // Replace only the external Browser Run dependency; exercise the shipped handler.
    const source=(await readFile(join(root,'scripts/lib/installation-probe-worker.mjs'),'utf8')).replace("import {launch} from '@cloudflare/playwright';",'const launch=globalThis.__installationProbeLaunch;');
    const {default:probe}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    const response=await probe.fetch(new Request('https://probe.invalid',{method:'POST',headers:{Authorization:'Bearer fixture-token'},body:JSON.stringify({action:'browser',headers})}),{APP_ORIGIN:origin,CI_PROBE_TOKEN:'fixture-token',CI_PROBE_EXPIRES_AT:String(Date.now()+60000)});
    assert.equal(response.status,200);assert.equal((await response.json()).browserDiagnostics,undefined);assert.deepEqual(events,['ready','fetch','fulfill','fetch','abort','abort','visible','close']);
    failFetch=true;
    const failed=await probe.fetch(new Request('https://probe.invalid',{method:'POST',headers:{Authorization:'Bearer fixture-token'},body:JSON.stringify({action:'browser',headers})}),{APP_ORIGIN:origin,CI_PROBE_TOKEN:'fixture-token',CI_PROBE_EXPIRES_AT:String(Date.now()+60000)});
    assert.equal(failed.status,500);assert.deepEqual(await failed.json(),{error:'Installation probe failed',action:'browser',checkpoint:'browser-request',browserDiagnostics:{hasRoot:true,documentTitlePentCloud:true,hasRenderedPentCloud:false,browserApiJson:true,rootChildCount:0,scriptResponses:{ok:0,redirect:0,clientError:0,serverError:0},scriptMime:{javascript:0,html:0,other:0},scriptBodies:{empty:0,nonEmpty:0},consoleErrors:{mimeMismatch:0,cspScript:0,cspEval:0,Other:0},requestFailures:{},runtimeErrors:{}}});
  }finally{globalThis.fetch=previousFetch;if(prior===undefined)delete globalThis.__installationProbeLaunch;else globalThis.__installationProbeLaunch=prior;}
});
test('Browser diagnostics admit only fixed booleans, capped counts and known error categories',async()=>{
  const verifier=await import('./lib/installation-verify.mjs');assert.equal(typeof verifier.sanitizeBrowserDiagnostics,'function');
  const input={hasRoot:true,documentTitlePentCloud:true,hasRenderedPentCloud:false,isAccessLoginPage:false,hasCloudflareChallenge:true,browserApiJson:false,rootChildCount:3,scriptResponses:{ok:2,redirect:0,clientError:1,serverError:0,url:'PRIVATE_URL'},scriptMime:{javascript:2,html:1,other:0,PRIVATE_MIME:1},scriptBodies:{empty:1,nonEmpty:2,bytes:'PRIVATE_BODY'},consoleErrors:{mimeMismatch:1,cspScript:2,cspEval:3,Other:4,PRIVATE_MESSAGE:1},requestFailures:{ERR_CONTENT_DECODING_FAILED:1,PRIVATE_URL:2,ERR_FAILED:99},runtimeErrors:{TypeError:1,PRIVATE_MESSAGE:2},url:'PRIVATE_URL',html:'PRIVATE_HTML',text:'PRIVATE_TEXT'};
  assert.deepEqual(verifier.sanitizeBrowserDiagnostics(input),{hasRoot:true,documentTitlePentCloud:true,hasRenderedPentCloud:false,isAccessLoginPage:false,hasCloudflareChallenge:true,browserApiJson:false,rootChildCount:3,scriptResponses:{ok:2,redirect:0,clientError:1,serverError:0},scriptMime:{javascript:2,html:1,other:0},scriptBodies:{empty:1,nonEmpty:2},consoleErrors:{mimeMismatch:1,cspScript:2,cspEval:3,Other:4},requestFailures:{ERR_CONTENT_DECODING_FAILED:1},runtimeErrors:{TypeError:1}});
  assert.equal(verifier.sanitizeBrowserDiagnostics({url:'PRIVATE_URL'}),undefined);assert.equal(verifier.sanitizeBrowserDiagnostics(null),undefined);assert.equal(verifier.sanitizeBrowserDiagnostics([]),undefined);
});
test('Browser failure diagnostics cap script, network and runtime counts without forwarding private values',async()=>{
  const prior=globalThis.__installationProbeLaunch,previousFetch=globalThis.fetch,handlers={},pendingResponses=[];let routeHandler;
  globalThis.fetch=async(url,options)=>{assert.equal(new URL(url).origin,'https://app.customer.example');assert.equal(options.redirect,'manual');const [mime,body]=pendingResponses.shift();return new Response(body,{headers:{'content-type':mime}});};
  globalThis.__installationProbeLaunch=async()=>({async newContext(){return {request:{async get(){return {status:()=>200,async dispose(){}};}},async route(pattern,callback){routeHandler=callback;},async newPage(){return {on(name,callback){handlers[name]=callback;},async goto(){
    for(let i=0;i<25;i++){handlers.response({request:()=>({resourceType:()=>'script'}),status:()=>200});handlers.pageerror({name:'TypeError',message:'PRIVATE_RUNTIME_MESSAGE'});}
    handlers.response({request:()=>({resourceType:()=>'script'}),status:()=>404});handlers.requestfailed({failure:()=>({errorText:'net::ERR_CONTENT_DECODING_FAILED https://PRIVATE_URL'})});handlers.requestfailed({failure:()=>({errorText:'PRIVATE_NETWORK_MESSAGE'})});handlers.pageerror({name:'PRIVATE_RUNTIME_NAME'});
    for(const [mime,body]of [['text/javascript',''],['application/javascript; charset=utf-8','PRIVATE_SOURCE'],['text/html','PRIVATE_HTML'],['PRIVATE_MIME','']]){pendingResponses.push([mime,body]);await routeHandler({request:()=>({url:()=>'https://app.customer.example/private.js',resourceType:()=>'script',headers:()=>({})}),async fetch(){return {status:()=>200,headers:()=>({'content-type':mime}),body:async()=>Buffer.from(body),async dispose(){}};},async fulfill(options){assert.equal(options.headers['content-type'],mime);assert.equal(options.body.toString(),body);},async abort(){}});}
    for(let i=0;i<25;i++)handlers.console({type:()=>'error',text:()=>'Failed module MIME type PRIVATE_URL'});
    for(const message of ["Refused to load script violates script-src PRIVATE_URL","Refused to evaluate a string as JavaScript unsafe-eval PRIVATE_URL",'PRIVATE_CONSOLE_MESSAGE'])handlers.console({type:()=>'error',text:()=>message});return {status:()=>200};
  },locator(){return {first(){return this;},async waitFor(){throw Error('PRIVATE_TIMEOUT_MESSAGE');}};},async evaluate(){return {hasRoot:true,documentTitlePentCloud:true,hasRenderedPentCloud:false,isAccessLoginPage:false,hasCloudflareChallenge:true,rootChildCount:0,html:'PRIVATE_HTML'};}};}};},async close(){}});
  try{
    const source=(await readFile(join(root,'scripts/lib/installation-probe-worker.mjs'),'utf8')).replace("import {launch} from '@cloudflare/playwright';",'const launch=globalThis.__installationProbeLaunch;')+'\n// Bounded failure diagnostic fixture\n';
    const {default:probe}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
    const result=await probe.fetch(new Request('https://probe.invalid',{method:'POST',headers:{Authorization:'Bearer fixture-token'},body:JSON.stringify({action:'browser',headers:{'CF-Access-Client-Id':'private-id','CF-Access-Client-Secret':'private-secret'}})}),{APP_ORIGIN:'https://app.customer.example',CI_PROBE_TOKEN:'fixture-token',CI_PROBE_EXPIRES_AT:String(Date.now()+60000)});
    assert.equal(result.status,500);const body=await result.json();assert(!JSON.stringify(body).includes('PRIVATE_'));assert.deepEqual(body.browserDiagnostics,{hasRoot:true,documentTitlePentCloud:true,hasRenderedPentCloud:false,isAccessLoginPage:false,hasCloudflareChallenge:true,browserApiJson:false,rootChildCount:0,scriptResponses:{ok:20,redirect:0,clientError:1,serverError:0},scriptMime:{javascript:2,html:1,other:1},scriptBodies:{empty:2,nonEmpty:2},consoleErrors:{mimeMismatch:20,cspScript:1,cspEval:1,Other:1},requestFailures:{ERR_CONTENT_DECODING_FAILED:1,Other:1},runtimeErrors:{TypeError:20,Other:1}});
  }finally{globalThis.fetch=previousFetch;if(prior===undefined)delete globalThis.__installationProbeLaunch;else globalThis.__installationProbeLaunch=prior;}
});
