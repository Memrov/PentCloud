// Disposable installation probe; it has no model keys, public scanner interface or logs.
import {launch} from '@cloudflare/playwright';
const packs=['recon','http','nuclei','sqlmap','service','web-context','pcap','file-analysis','password','reference','metasploit'];
const check=(ok,message)=>{if(!ok)throw Error(message);};
export default {
  async fetch(request,env){
    if(!env.CI_PROBE_TOKEN||request.headers.get('Authorization')!=='Bearer '+env.CI_PROBE_TOKEN)return new Response('Not found',{status:404});
    const input=await request.json();
    try{
      if(input.action==='artifacts'){
        check(/^[A-Za-z0-9._-]+$/.test(input.repo)&&/^[a-f0-9]{40}$/.test(input.commit),'Invalid evidence identity');
        using repo=await env.ARTIFACTS.get(input.repo);
        const bytes=await repo.readFile({ref:input.commit,path:'evidence.txt'});
        check(new TextDecoder().decode(bytes)===input.expected,'Native Artifacts binding read mismatch');
        return Response.json({artifacts:'passed'});
      }
      if(input.action==='loader'){
        const child=env.LOADER.get(null,()=>({compatibilityDate:'2026-10-30',mainModule:'worker.js',modules:{'worker.js':'export default {fetch(){return new Response("pentcloud-ci-loader")}}'},globalOutbound:null}));
        check(await (await child.getEntrypoint().fetch('https://ci.internal/')).text()==='pentcloud-ci-loader','Dynamic Worker failed');
        return Response.json({loader:'passed'});
      }
      if(input.action==='markdown'){
        const converted=await env.AI.toMarkdown({name:'ci.html',blob:new Blob(['<html><body><h1>PentCloud CI conversion</h1></body></html>'],{type:'text/html'})});
        const value=Array.isArray(converted)?converted[0]:converted;
        check(typeof value?.data==='string'&&value.data.includes('PentCloud CI conversion'),'Workers AI conversion failed');
        return Response.json({markdown:'passed'});
      }
      if(input.action==='browser'){
        check(Object.keys(input.headers??{}).sort().join(',')==='CF-Access-Client-Id,CF-Access-Client-Secret','Invalid Access headers');
        const browser=await launch(env.BROWSER);
        try{
          const context=await browser.newContext({extraHTTPHeaders:input.headers});
          const page=await context.newPage();
          await context.route('**/*',route=>new URL(route.request().url()).origin===env.APP_ORIGIN?route.continue():route.abort());
          const result=await page.goto(env.APP_ORIGIN,{waitUntil:'networkidle',timeout:60000});
          check(result?.status()===200,'Protected app did not load in Browser Run');
          check((await page.locator('body').innerText()).includes('PentCloud'),'Browser received a login page instead of PentCloud');
          return Response.json({browser:'passed',status:result.status()});
        }finally{await browser.close();}
      }
      if(input.action==='pack'){
        check(packs.includes(input.pack)&&/^[A-Za-z0-9._-]+$/.test(input.id),'Invalid package probe');
        const scope={runId:input.id,attemptId:input.pack,role:'maintenance'};
        try{
          const ready=await env.TOOL_PACKS.ready(scope,input.pack);
          check(typeof ready?.image==='string','Tool-pack readiness returned no image');
          if(input.pack==='http'){
            const result=await env.TOOL_PACKS.run(scope,{pack:'http',request:{tool:'curl',target:env.APP_ORIGIN}},{});
            check(result?.exitCode===0,'Bounded HTTP package execution failed');
          }
          return Response.json({pack:input.pack,status:'passed',instance:ready.instance});
        }finally{check((await env.TOOL_PACKS.stop(scope,[input.pack])).stopped,'Owned tool runtime did not retire');}
      }
      return new Response('Not found',{status:404});
    }catch{
      return Response.json({error:'Installation probe failed',action:input.action,pack:input.pack},{status:500});
    }
  },
};

