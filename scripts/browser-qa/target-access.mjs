import {connect} from '@cloudflare/playwright';
import {OnboardingStore} from '../../apps/control-plane/src/native/onboarding';
import {ScopeCatalog} from '../../apps/control-plane/src/native/scope-catalog';
import {fillLogin,validateBrowserState,guardBrowserCDP} from '../../apps/control-plane/src/native/browser-target-access';
import {connectBrowserSession} from 'agents/browser';
import {assertTargetRequest,requestHeaders,resolveTargetHeaders,targetSecretBindings} from '../../shared/target-access';
import {RunBrowserAuth} from '../../apps/control-plane/src/native/run-browser-auth';
import {interceptBrowserContext} from '../../apps/control-plane/src/native/browser-interception';
const check=(value,message)=>{if(!value)throw Error(message);};
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');

/** Actual built UI and production stores, with synthetic program/target responses only. */
export async function reviewTargetAccess(env,input){
 const targetOrigin=new URL(input.fixtureOrigin).origin;
 const result={mode:'Cloudflare Browser Run / target setup fixtures',sessionId:env.QA_BROWSER_ID,cases:[],captures:[],events:[],modifiedConditions:['Built UI assets served through Playwright routes','Synthetic program and task-owned reachable target; no model requests'],startedAt:new Date().toISOString()};
 let browser;
 try{
  check(input.assets&&Object.keys(input.assets).length<1000,'Built UI fixture assets are required');
  browser=await connect(env.BROWSER,env.QA_BROWSER_ID);
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
   const records=new Map(),secrets=new Map(),store=new OnboardingStore({readTargetSecret:async name=>secrets.get(name),get:k=>structuredClone(records.get(k)),put:(k,v)=>records.set(k,structuredClone(v)),list:p=>[...records].filter(([k])=>k.startsWith(p)).map(([,v])=>structuredClone(v)),remove:k=>records.delete(k)});
   const program={schema_version:1,id:'hackerone:pentcloud-fixture',name:'PentCloud QA program',platform:'hackerone',url:'https://hackerone.com/pentcloud-fixture',source_status:{value:'open'},targets:{in_scope:[{type:'URL',value:targetOrigin+'/'}],out_of_scope:[{type:'URL',value:targetOrigin+'/admin/'}]}};
   const file=JSON.stringify(program),path='programs/hackerone/'+await hash(program.id)+'.json',index=JSON.stringify({schema_version:1,programs:[{id:program.id,name:program.name,platform:program.platform,url:program.url,path,scope_counts:{in_scope:1,out_of_scope:1}}]});
   const manifest={schema_version:1,published_at:new Date().toISOString(),source:{commit:'b'.repeat(40)},files:{'index.json':await hash(index),[path]:await hash(file)}};
   const catalog=new ScopeCatalog({get:k=>records.get(k),put:(k,v)=>records.set(k,v),fetcher:async url=>String(url).endsWith('/git/ref/heads/catalog')?Response.json({object:{sha:'a'.repeat(40)}}):String(url).endsWith('/manifest.json')?Response.json(manifest):new Response(String(url).endsWith('/index.json')?index:file)});
   const context=await browser.newContext({viewport}),page=await context.newPage();page.setDefaultTimeout(15000);
   page.on('pageerror',error=>result.events.push({viewport:viewport.width,kind:'pageerror',message:error.message.slice(0,200)}));
   await context.routeWebSocket('**/*',socket=>{socket.send(JSON.stringify({type:'cf_agent_identity',name:'global',agent:'coordinator',stateFollows:true}));socket.send(JSON.stringify({type:'cf_agent_state',state:{revision:1,runs:[],jobs:[]}}));});
   await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.hostname!=='ui.pentcloud.test')return route.abort();
    if(url.pathname.startsWith('/v1/ui/')){
     const value=request.postData()?request.postDataJSON():{},name=url.pathname.split('/').at(-1);let body;
     try{
      if(name==='onboarding')body={targets:store.targets(),credentials:[],defaults:[]};
      else if(name==='runs')body={runs:[]};
      else if(name==='models')body={models:[],stale:false,fetchedAt:new Date().toISOString()};
      else if(name==='target.save')body=store.saveTarget(value,value.revision,'qa');
      else if(name==='access.save')body=store.saveTargetAccess(value.id,value.revision,value.access,'qa');
      else if(name==='scope.names')body=await catalog.names();
      else if(name==='access.check')body=await store.checkTargetSecret(value.id,value.revision,value.kind,'qa');
      else if(name==='scope.preview')body=await catalog.preview(value.programId);
      else if(name==='scope.import'){const target=store.target(value.id);body=store.saveTargetAccess(target.id,value.revision,target.access??{headers:[]},'qa',await catalog.import(value.programId,target.url));}
      else if(name==='source.list')body={repos:[]};
      else throw Error('Unexpected fixture action');
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
     }catch(error){return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:error.message})});}
    }
    const asset=input.assets[url.pathname==='/'?'/index.html':url.pathname]??input.assets['/index.html'];
    return route.fulfill({status:200,contentType:asset.type,body:Buffer.from(asset.body,'base64')});
   });
   const capture=async name=>{
    await page.waitForFunction(()=>document.getAnimations().every(a=>a.playState!=='running'||a.effect?.getComputedTiming().iterations===Infinity));
    const layout=await page.evaluate(()=>({width:innerWidth,documentWidth:document.documentElement.scrollWidth,smallControls:[...document.querySelectorAll('button,input,textarea')].filter(e=>e.getBoundingClientRect().width>0&&parseFloat(getComputedStyle(e).fontSize)<14).length}));
    check(layout.documentWidth<=viewport.width+2,'Target setup overflows the viewport');check(layout.smallControls===0,'Target setup includes undersized controls');
    result.captures.push({name,viewport,layout,screenshot:name+'-'+viewport.width+'.png',png:Buffer.from(await page.screenshot({fullPage:false})).toString('base64')});
   };
   try{
    await page.goto('https://ui.pentcloud.test/');await page.getByRole('heading',{name:'Your targets',exact:true}).waitFor();
    await page.getByRole('button',{name:'Find a bounty program',exact:true}).click();
    await page.getByRole('combobox',{name:'Program',exact:true}).fill('PentCloud');await page.getByRole('option',{name:'PentCloud QA program · hackerone',exact:true}).click();
    await page.getByRole('combobox',{name:'Website or API',exact:true}).click();await page.getByRole('option',{name:targetOrigin+'/',exact:true}).click();
    await page.getByRole('button',{name:'Use selected program',exact:true}).click();
    await page.getByRole('textbox',{name:'Name',exact:true}).fill('QA target');
    await page.getByRole('button',{name:'Save target',exact:true}).click();
    await page.getByRole('button',{name:'Network and login settings',exact:true}).click();
    const target=store.targets()[0],names=await targetSecretBindings(target.id);
    await page.getByRole('checkbox',{name:'Required request headers',exact:true}).check();
    await page.getByRole('checkbox',{name:'Browser login',exact:true}).check();
    await page.getByRole('button',{name:'Check password',exact:true}).click();await page.getByText('Missing or unreadable in Cloudflare',{exact:true}).waitFor();
    secrets.set(names.username,'qa-user');secrets.set(names.password,'qa-fixture-password');secrets.set(names.headers,JSON.stringify({'X-Researcher':'fixture'}));
    for(const label of ['username','password','headers'])await page.getByRole('button',{name:'Check '+label,exact:true}).click();
    check(await page.getByText('Ready in Cloudflare · authentication not tested',{exact:true}).count()===3,'Secret readiness check did not update');
    check(await page.locator('input[type="password"]').count()===0,'The app accepts a raw password');
    await capture('target-access-form');
    await page.getByRole('button',{name:'Save target settings',exact:true}).click();
    await page.getByText('Target settings saved for future runs.',{exact:true}).waitFor();
    const saved=store.targets()[0];check(saved.access.program.deny.length===1&&saved.access.login.passwordBinding===names.password,'Settings did not persist on target');
    await page.reload();await page.getByRole('button',{name:'QA target',exact:false}).first().click();
    await page.getByRole('button',{name:'Network and login settings',exact:true}).click();
    check(await page.getByRole('button',{name:'Copy Password secret name',exact:true}).count()===1,'Saved target lost its native copy control');
    await capture('target-access-saved');result.cases.push({name:'program-import-and-target-reuse',viewport:viewport.width,result:'passed'});
    const loginContext=await browser.newContext({serviceWorkers:'block'}),loginPage=await loginContext.newPage();
    const user='qa-user',secret='qa-fixture-password',seen=[];
    loginPage.on('requestfailed',r=>result.events.push({kind:'fixture-login-failed-request',path:new URL(r.url()).pathname,method:r.method()}));
    const cdp=await loginContext.newCDPSession(loginPage),contextId=(await cdp.send('Target.getTargetInfo')).targetInfo.browserContextId;await cdp.detach();
    const configured=await resolveTargetHeaders(saved,async name=>secrets.get(name));
    const policy=async request=>{assertTargetRequest(configured,request.url);const headers=requestHeaders(configured,request.headers,{cookies:true,targetContext:true});seen.push({path:new URL(request.url).pathname,researcher:headers.get('X-Researcher')});return headers;};
    const interception=await interceptBrowserContext(env.BROWSER,env.QA_BROWSER_ID,contextId,policy,async()=>{await loginContext.close();});
    const rawCDP=await connectBrowserSession(env.BROWSER,env.QA_BROWSER_ID),guarded=guardBrowserCDP(rawCDP,saved,contextId,interception.assertConnected);
    const targets=(await guarded.send('Target.getTargets')).targetInfos;check(targets.length&&targets.every(t=>t.browserContextId===contextId),'SDK exposed another browser context');
    const pageSession=await guarded.attachToTarget(targets.find(t=>t.type==='page').targetId);
    await guarded.send('Input.insertText',{text:'fixture'},{sessionId:pageSession});
    let denied=0;for(const [method,params,options] of [['Fetch.disable',{},{}],['Network.setRequestInterception',{patterns:[]},{}],['Network.continueInterceptedRequest',{interceptionId:'unowned'},{}],['Target.detachFromTarget',{sessionId:'not-owned'},{}],['Page.navigate',{url:'https://outside.example/'},{sessionId:pageSession}]])try{await guarded.send(method,params,options);}catch{denied++;}check(denied===5,'SDK policy operations were permitted');
    await loginPage.goto(targetOrigin+'/login');
    await fillLogin(saved,loginPage,{pageURL:loginPage.url(),usernameSelector:'#username',passwordSelector:'#password'},async name=>name.endsWith('USERNAME')?user:secret);
    check(await loginPage.locator('#username').inputValue()===user&&await loginPage.locator('#password').inputValue()===secret,'Native credential fill failed');
    await loginPage.getByRole('button',{name:'Log in',exact:true}).click();try{await loginPage.waitForURL(targetOrigin+'/private',{timeout:12000});}catch(error){result.events.push({kind:'fixture-login-redirect',path:new URL(loginPage.url()).pathname,requests:seen.map(r=>r.path)});throw error;}check((await loginPage.textContent('body')).includes('Welcome'),'Authenticated destination was not reached');
    const state=validateBrowserState(saved,await loginContext.storageState());
    const auth=new RunBrowserAuth({get:k=>records.get(k),put:(k,v)=>records.set(k,v),remove:k=>records.delete(k)});auth.write('run-qa-one',saved,state);
    check(!auth.read('run-qa-two',saved),'Login leaked into another run');
    const reused=await browser.newContext({storageState:auth.read('run-qa-one',saved)});
    check((await reused.cookies(targetOrigin+'/')).some(c=>c.name==='session'&&c.value==='fixture-session'),'Browser authentication state did not restore');
    let blocked=false;try{await loginPage.goto(targetOrigin+'/admin/');}catch{blocked=true;}check(blocked,'Excluded target path was reachable');
    let redirectedBlocked=false;try{await loginPage.goto(targetOrigin+'/redirect-excluded');}catch{redirectedBlocked=true;}check(redirectedBlocked,'Excluded redirect was reachable');
    // Target auto-attachment must mediate the first request in a popup as well.
    const extra=await loginContext.newPage();await extra.goto(targetOrigin+'/private');
    const popupReady=extra.waitForEvent('popup');await extra.evaluate(()=>window.open('/admin/'));const popup=await popupReady;await popup.waitForLoadState().catch(()=>{});await popup.close();
    const binary=await extra.evaluate(async()=>[...new Uint8Array(await(await fetch('/binary')).arrayBuffer())]);check(binary.join(',')==='0,128,255','Binary browser response changed');
    const upload=await extra.evaluate(async()=>[...new Uint8Array(await(await fetch('/echo',{method:'POST',body:new Uint8Array([0,128,255])})).arrayBuffer())]);check(upload.join(',')==='0,128,255','Binary browser request changed');
    result.events.push({kind:'fixture-dispatched-paths',paths:seen.map(r=>r.path),requiredHeaders:seen.every(r=>r.researcher==='fixture')});
    check(['/login','/session','/private','/redirect-excluded','/binary'].every(path=>seen.some(r=>r.path===path))&&!seen.some(r=>r.path.startsWith('/admin'))&&seen.every(r=>r.researcher==='fixture'),'Required header or excluded-path boundary failed');
    check(!JSON.stringify([...records].filter(([key])=>!key.startsWith('browser-auth:')).map(([,value])=>value)).includes(secret),'Raw password entered persisted app records');
    await interception.disconnect();check(extra.isClosed(),'Lost interception left its context open');
    let staleDenied=false;try{await guarded.send('Target.getTargets');}catch{staleDenied=true;}check(staleDenied,'Old SDK connection remained usable after interception loss');
    const recovered=await browser.newContext({storageState:state,serviceWorkers:'block'}),recoveredPage=await recovered.newPage(),recoveredCDP=await recovered.newCDPSession(recoveredPage),recoveredId=(await recoveredCDP.send('Target.getTargetInfo')).targetInfo.browserContextId;await recoveredCDP.detach();
    const recoveredInterception=await interceptBrowserContext(env.BROWSER,env.QA_BROWSER_ID,recoveredId,policy,async()=>{await recovered.close();});
    await recoveredPage.goto(targetOrigin+'/private');check((await recoveredPage.textContent('body')).includes('Welcome'),'Guarded reconnect lost target authentication');
    await recoveredInterception.disconnect();
    result.cases.push({name:'native-login-state-header-and-exclusion',viewport:viewport.width,result:'passed'});
    result.cases.push({name:'native-interception-loss-and-reconnect',viewport:viewport.width,result:'passed'});
    auth.clear('run-qa-one');check(!auth.read('run-qa-one',saved),'Run login survived cleanup');
    await rawCDP.close();await reused.close();
   }catch(error){result.cases.push({name:'target-access-journey',viewport:viewport.width,result:'failed',reason:String(error.message).split('\n')[0].slice(0,240)});try{await capture('target-access-failed');}catch{}}
   finally{await context.close();}
  }
 }catch(error){result.cases.push({name:'fixture-setup',result:'failed',reason:String(error.message).split('\n')[0].slice(0,240)});}
 finally{await browser?.close().catch(()=>{});try{const r=await env.BROWSER.fetch('https://browser-binding.invalid/v1/devtools/browser/'+env.QA_BROWSER_ID,{method:'DELETE'});result.closeRequested=r.ok||r.status===404;}catch{result.closeRequested=false;}}
 result.finishedAt=new Date().toISOString();result.result=result.cases.some(c=>c.result==='failed')?'issues-found':'checks-passed';return result;
}
