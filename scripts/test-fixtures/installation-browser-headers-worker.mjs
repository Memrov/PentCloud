// Static local workerd fixture. Test inputs are data bindings, never source text.
import {request} from '@cloudflare/playwright';
import {installationBrowserResponse} from '../lib/installation-probe-worker.mjs';
import {get} from 'node:http';

export default {
  async fetch(_request,env){
    const origin=env.FIXTURE_ORIGIN;
    const node=await new Promise(resolve=>get(origin+'/fixture.js',response=>{
      response.resume();resolve({type:response.headers['content-type']??null,rawCount:response.rawHeaders.length});
    }));
    const client=await request.newContext();
    try{
      const api=await client.get(origin+'/fixture.js'),collected=[];
      for(const path of ['/fixture.js','/fixture.js?gzip','/fixture.html']){
        const result=await installationBrowserResponse({
          url:()=>origin+path,method:()=>path.includes('gzip')?'POST':'GET',
          headers:()=>({Host:'foreign.invalid','Content-Length':'999','Accept-Encoding':'fixture-unsupported',Connection:'x-fixture-hop','X-Fixture-Hop':'drop-me'}),
          postDataBuffer:()=>new TextEncoder().encode('owned request body'),
        },{origin,headers:{'CF-Access-Client-Id':'owned-id','CF-Access-Client-Secret':'owned-secret'}});
        collected.push({
          type:result.headers['content-type'],encoding:result.headers['content-encoding']??null,
          length:result.headers['content-length'],bytes:result.body.length,
          sourceMatches:result.body.toString()===env.FIXTURE_SCRIPT,
          htmlMatches:result.body.toString()==='<main>owned fixture</main>',
          csp:result.headers['content-security-policy']==="script-src 'self'",
          setCookie:result.headers['set-cookie']??null,
        });
      }
      return Response.json({node,playwrightType:api.headers()['content-type']??null,collected});
    }finally{await client.dispose();}
  },
};
