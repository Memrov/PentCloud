import {reviewTargetAccess} from './target-access.mjs';
export default {async fetch(request,env,ctx){
  if(!env.QA_ACCESS_AUD||!env.QA_ORIGIN||!env.QA_BROWSER_ID)return new Response('QA authorization not configured',{status:403});
  // This standalone Worker has no Static Assets router or Service Binding caller.
  // Access creates this trusted context for the direct, Service Auth protected invocation.
  if(ctx?.access?.aud!==env.QA_ACCESS_AUD)return new Response('Unauthorized',{status:403});
  if(request.method==='GET'&&new URL(request.url).pathname==='/health')return Response.json({ready:true,taskId:env.QA_RUN_ID},{headers:{'Cache-Control':'no-store'}});
  if(request.method!=='POST'||new URL(request.url).pathname!=='/run')return new Response('Not found',{status:404});
  const input=await request.json();if(input.origin!==env.QA_ORIGIN||input.targetAccess!==true)return new Response('Wrong installation',{status:400});
  return Response.json(await reviewTargetAccess(env,input),{headers:{'Cache-Control':'no-store'}});
}};
