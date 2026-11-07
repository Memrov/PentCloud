// Disposable installation probe; it has no model keys, public scanner interface or logs.
import {launch} from '@cloudflare/playwright';
const packs=['recon','http','nuclei','sqlmap','service','web-context','pcap','file-analysis','password','reference','metasploit'];
const check=(ok,message)=>{if(!ok)throw Error(message);};
const networkErrors=['ERR_ABORTED','ERR_FAILED','ERR_BLOCKED_BY_CLIENT','ERR_BLOCKED_BY_RESPONSE','ERR_CONNECTION_CLOSED','ERR_CONNECTION_RESET','ERR_CONNECTION_REFUSED','ERR_NAME_NOT_RESOLVED','ERR_TIMED_OUT','ERR_CERT_AUTHORITY_INVALID','ERR_HTTP_RESPONSE_CODE_FAILURE','ERR_CONTENT_DECODING_FAILED','ERR_INVALID_RESPONSE'];
const runtimeErrors=['Error','TypeError','ReferenceError','SyntaxError','RangeError','SecurityError','AbortError'];
export default {
  async fetch(request,env){
    if(!env.CI_PROBE_TOKEN||!/^\d{13}$/.test(env.CI_PROBE_EXPIRES_AT??'')||Date.now()>=Number(env.CI_PROBE_EXPIRES_AT)||request.headers.get('Authorization')!=='Bearer '+env.CI_PROBE_TOKEN)return new Response('Not found',{status:404});
    let input={},checkpoint,httpStatus,browserDiagnostics;
    try{
      input=await request.json();
      if(input.action==='ready')return Response.json({ready:'passed'});
      if(input.action==='artifacts'){
        check(/^[A-Za-z0-9._-]+$/.test(input.repo)&&/^[a-f0-9]{40}$/.test(input.commit),'Invalid evidence identity');
        using repo=await env.ARTIFACTS.get(input.repo);
        const file=await repo.readFile({ref:input.commit,path:'evidence.txt'});
        check(file&&await file.text()===input.expected,'Native Artifacts binding read mismatch');
        return Response.json({artifacts:'passed'});
      }
      if(input.action==='loader'){
        checkpoint='loader-create';
        const child=env.LOADER.get(null,()=>({compatibilityDate:'2026-10-30',mainModule:'worker.js',modules:{'worker.js':'export default {fetch(){return new Response("pentcloud-ci-loader")}}'},globalOutbound:null}));
        checkpoint='loader-fetch';
        check(await (await child.getEntrypoint().fetch('https://ci.internal/')).text()==='pentcloud-ci-loader','Dynamic Worker failed');
        return Response.json({loader:'passed'});
      }
      if(input.action==='markdown'){
        checkpoint='markdown-convert';
        const converted=await env.AI.toMarkdown({name:'ci.html',blob:new Blob(['<html><body><h1>PentCloud CI conversion</h1></body></html>'],{type:'text/html'})});
        const value=Array.isArray(converted)?converted[0]:converted;
        checkpoint='markdown-result';
        check(typeof value?.data==='string'&&value.data.includes('PentCloud CI conversion'),'Workers AI conversion failed');
        return Response.json({markdown:'passed'});
      }
      if(input.action==='browser'){
        check(Object.keys(input.headers??{}).sort().join(',')==='CF-Access-Client-Id,CF-Access-Client-Secret','Invalid Access headers');
        check(new URL(env.APP_ORIGIN).origin===env.APP_ORIGIN&&env.APP_ORIGIN.startsWith('https://'),'Invalid app origin');
        checkpoint='browser-launch';
        const browser=await launch(env.BROWSER);
        let page,browserApiJson;
        const counts={scriptResponses:{ok:0,redirect:0,clientError:0,serverError:0},scriptMime:{javascript:0,html:0,other:0},scriptBodies:{empty:0,nonEmpty:0},consoleErrors:{mimeMismatch:0,cspScript:0,cspEval:0,Other:0},requestFailures:{},runtimeErrors:{}},increment=(record,key)=>{record[key]=Math.min(20,(record[key]??0)+1);};
        try{
          checkpoint='browser-context';
          const context=await browser.newContext({serviceWorkers:'block'});
          checkpoint='browser-access';
          const deadline=Date.now()+60000;
          for(;;){
            const access=await context.request.get(env.APP_ORIGIN+'/v1/runs',{headers:input.headers,maxRedirects:0,timeout:15000});
            const status=access.status();httpStatus=status;
            if(status===200){try{browserApiJson=Array.isArray((await access.json())?.runs);}catch{browserApiJson=false;}}
            await access.dispose();
            if(status===200)break;
            check([302,303,401,403].includes(status)&&Date.now()<deadline,'Browser Access did not become ready');
            await new Promise(resolve=>setTimeout(resolve,2000));
          }
          page=await context.newPage();
          page.on('response',response=>{try{if(response.request().resourceType()!=='script')return;const status=response.status(),key=status>=200&&status<300?'ok':status>=300&&status<400?'redirect':status>=400&&status<500?'clientError':status>=500&&status<600?'serverError':null;if(key)increment(counts.scriptResponses,key);}catch{}});
          page.on('requestfailed',request=>{try{const code=/^(?:net::)?(ERR_[A-Z_]+)(?:$|\s)/.exec(request.failure()?.errorText??'')?.[1];increment(counts.requestFailures,networkErrors.includes(code)?code:'Other');}catch{}});
          page.on('pageerror',error=>increment(counts.runtimeErrors,runtimeErrors.includes(error?.name)?error.name:'Other'));
          page.on('console',message=>{try{if(message.type()!=='error')return;const text=message.text(),key=/MIME type|strict MIME type checking/i.test(text)?'mimeMismatch':/unsafe-eval|Refused to evaluate a string as JavaScript|Evaluating a string as JavaScript violates/i.test(text)?'cspEval':/Refused to (?:load|execute).*script|script-src|Content Security Policy directive.*script/i.test(text)?'cspScript':'Other';increment(counts.consoleErrors,key);}catch{}});
          await context.route('**/*',async route=>{
            if(new URL(route.request().url()).origin!==env.APP_ORIGIN)return route.abort();
            // route.continue header overrides survive redirects. Fetch privately
            // without following redirects, then fulfill only the exact-origin response.
            checkpoint='browser-request';httpStatus=undefined;
            const response=await route.fetch({headers:{...route.request().headers(),...input.headers},maxRedirects:0,timeout:60000});httpStatus=response.status();
            if(route.request().resourceType?.()==='script'){
              try{const mime=(response.headers()['content-type']??'').split(';')[0].trim().toLowerCase();increment(counts.scriptMime,/^(?:text|application)\/(?:javascript|ecmascript|x-javascript)$/.test(mime)?'javascript':['text/html','application/xhtml+xml'].includes(mime)?'html':'other');}catch{}
              // Observe only emptiness. Script bytes remain private and are never
              // logged, returned or substituted into fulfillment by diagnostics.
              try{increment(counts.scriptBodies,(await response.body()).length===0?'empty':'nonEmpty');}catch{}
            }
            try{if(response.status()>=300&&response.status()<400){checkpoint='browser-redirect';await route.abort();}else{checkpoint='browser-fulfill';await route.fulfill({response});}}
            finally{await response.dispose();}
          });
          checkpoint='browser-navigate';
          const result=await page.goto(env.APP_ORIGIN,{waitUntil:'networkidle',timeout:60000});
          httpStatus=result?.status();
          check(result?.status()===200,'Protected app did not load in Browser Run');
          checkpoint='browser-content';
          await page.locator('#root :text-is("PentCloud"):visible').first().waitFor({state:'visible',timeout:30000});
          check((await page.locator('body').innerText()).includes('PentCloud'),'Browser received a login page instead of PentCloud');
          return Response.json({browser:'passed',status:result.status()});
        }catch{
          if(page){
            let dom;try{dom=await page.evaluate(()=>{const root=document.querySelector('#root'),url=new URL(location.href);return {hasRoot:!!root,documentTitlePentCloud:document.title.includes('PentCloud'),hasRenderedPentCloud:!!root&&root.innerText.includes('PentCloud'),isAccessLoginPage:url.pathname.startsWith('/cdn-cgi/access/')||url.hostname.endsWith('.cloudflareaccess.com')||!!document.querySelector('form[action*="/cdn-cgi/access/"]'),hasCloudflareChallenge:!!document.querySelector('#challenge-running,#challenge-stage,[name="cf-turnstile-response"]')||document.title.includes('Just a moment'),rootChildCount:Math.min(20,root?.childElementCount??0)};});}catch{}
            browserDiagnostics={...counts,...(typeof browserApiJson==='boolean'?{browserApiJson}:{})};
            for(const key of ['hasRoot','documentTitlePentCloud','hasRenderedPentCloud','isAccessLoginPage','hasCloudflareChallenge'])if(typeof dom?.[key]==='boolean')browserDiagnostics[key]=dom[key];
            if(Number.isInteger(dom?.rootChildCount)&&dom.rootChildCount>=0&&dom.rootChildCount<=20)browserDiagnostics.rootChildCount=dom.rootChildCount;
          }
          throw Error('Installation browser probe failed');
        }finally{await browser.close();}
      }
      if(input.action==='pack'){
        check(packs.includes(input.pack)&&/^[A-Za-z0-9._-]+$/.test(input.id)&&typeof input.expectedImage==='string'&&input.expectedImage.length>0,'Invalid package probe');
        const scope={runId:input.id,attemptId:input.pack,role:'maintenance'};
        try{
          checkpoint='pack-ready';
          const ready=await env.TOOL_PACKS.ready(scope,input.pack);
          check(ready?.image===input.expectedImage,'Tool-pack image does not match selected image');
          if(input.pack==='http'){
            checkpoint='pack-command';
            const result=await env.TOOL_PACKS.run(scope,{pack:'http',request:{tool:'curl',target:env.APP_ORIGIN}},{});
            check(result?.exitCode===0,'Bounded HTTP package execution failed');
          }
          return Response.json({pack:input.pack,status:'passed'});
        }finally{const prior=checkpoint;checkpoint='pack-stop';check((await env.TOOL_PACKS.stop(scope,[input.pack])).stopped,'Owned tool runtime did not retire');checkpoint=prior;}
      }
      return new Response('Not found',{status:404});
    }catch{
      const action=['ready','artifacts','loader','markdown','browser','pack'].includes(input?.action)?input.action:undefined;
      return Response.json({error:'Installation probe failed',...(action?{action}:{}),...(packs.includes(input?.pack)?{pack:input.pack}:{}),...(checkpoint?{checkpoint}:{}),...(Number.isInteger(httpStatus)&&httpStatus>=100&&httpStatus<=599?{httpStatus}:{}),...(browserDiagnostics?{browserDiagnostics}:{})},{status:500});
    }
  },
};

