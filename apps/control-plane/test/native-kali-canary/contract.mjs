const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
export function assertCatalog(actual,expected){
  const names=tools=>tools.map(tool=>tool.name).sort();
  if(canonical(names(actual))!==canonical(names(expected)))throw new Error('Stock catalog names differ from baseline');
  const schemas=tools=>tools.map(({name,inputSchema,outputSchema})=>({name,inputSchema,outputSchema})).sort((a,b)=>a.name.localeCompare(b.name));
  if(canonical(schemas(actual))!==canonical(schemas(expected)))throw new Error('Stock catalog schema differs from baseline');
  return {count:actual.length,exactNames:true,exactSchemas:true};
}
export function browserEvidence(result){
  const content=Array.isArray(result?.content)?result.content:[];
  const text=content.filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n');
  return {isError:result?.isError===true,text:text.slice(0,32768),textCharacters:text.length,truncated:text.length>32768,contentTypes:content.map(block=>block.type)};
}
export const BROWSER_DOCUMENT_EVALUATION="() => { const entry = performance.getEntriesByType('navigation')[0]; return {url: location.href, contentType: document.contentType, navigationStatus: typeof entry?.responseStatus === 'number' ? entry.responseStatus : null, text: (document.body?.innerText ?? '').slice(0, 16384)}; }";

/** Observe only native lifecycle RPC. A mismatching pin never permits startup. */
export async function lifecycleContract(toolbox){
  const pinnedGeneration='deliberately-nonmatching-generation';
  const before=await toolbox.status();
  if(!['running','stopped'].includes(before.state)||before.inactivityTimeoutMs!==1800000)throw new Error('Native lifecycle status unavailable or inactivity policy changed');
  if(before.generation===pinnedGeneration)throw new Error('Lifecycle acceptance pin unexpectedly matches the running generation');
  const ready=await toolbox.ready(pinnedGeneration);
  const activity=await toolbox.activity(pinnedGeneration);
  const after=await toolbox.status();
  if(ready.error!=='generation_lost')throw new Error('Pinned readiness did not return typed generation loss');
  if(activity.error!=='generation_lost')throw new Error('Pinned activity did not return typed generation loss');
  if(after.state!==before.state)throw new Error('Native lifecycle state changed during pinned RPC acceptance');
  if(after.generation!==before.generation)throw new Error('Native lifecycle generation changed during pinned RPC acceptance');
  if(after.inactivityTimeoutMs!==before.inactivityTimeoutMs)throw new Error('Native inactivity policy changed during pinned RPC acceptance');
  return {before,ready,activity,after,stateUnchanged:true,generationUnchanged:true,pinnedReadyRejected:true,pinnedActivityRejected:true,modelCalls:0,mcpRequests:0,scanMutations:0};
}
