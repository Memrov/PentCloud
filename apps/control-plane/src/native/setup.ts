// First-run configuration only. Resource deployment remains Cloudflare's job.
type Repo = Disposable & {info():Promise<{id:string;description?:string|null}>;listTokens():Promise<{tokens:{id:string;state:string}[]}>;revokeToken(token:string):Promise<unknown>};
interface SetupEnv {
  ARTIFACTS?:{get(name:string):Promise<Repo>;list?(options:{limit:number}):Promise<{repos:{id:string}[]}>;create(name:string,options:{description:string;setDefaultBranch:string}):Promise<{token:string}>};
  COORDINATOR?:unknown;ATTEMPTS?:unknown;MODEL_TESTS?:unknown;RESULTS?:unknown;
  BROWSER?:unknown;AI?:unknown;LOADER?:unknown;TOOL_PACKS?:unknown;TOOLBOX?:unknown;
  OPENCODE_GO_API_KEY?:unknown;OPENCODE_API_KEY?:unknown;CF_VERSION_METADATA?:{id:string};
}
const workspace='pentcloud-setup',description='PentCloud setup connection check';
const activeTokens=async(repo:Repo)=>(await repo.listTokens()).tokens.filter(token=>token.state==='active');
const errorCode=(error:unknown)=>error&&typeof error==='object'&&'code'in error?error.code:undefined;
async function workspaceReady(env:SetupEnv){
  try{using repo=await env.ARTIFACTS!.get(workspace);const info=await repo.info();return !!info.id&&(info.description!==description||(await activeTokens(repo)).length===0);}
  catch(error){if(errorCode(error)!=='NOT_FOUND')throw error;return !!(await env.ARTIFACTS!.list?.({limit:1}))?.repos.length;}
}
export async function setupStatus(env:SetupEnv){
  const missing=(['COORDINATOR','ATTEMPTS','MODEL_TESTS','ARTIFACTS','RESULTS','BROWSER','AI','LOADER','CF_VERSION_METADATA'] as const).filter(name=>!env[name]) as string[];
  if(!env.TOOL_PACKS&&!env.TOOLBOX)missing.push('TOOL_PACKS');
  let storage=false;try{if(env.ARTIFACTS)storage=await workspaceReady(env);}catch{/* Public status never includes provider errors. */}
  const models=!!(env.OPENCODE_GO_API_KEY||env.OPENCODE_API_KEY);
  return {schemaVersion:1,access:true,missing,storage,models,ready:missing.length===0&&storage&&models};
}
export async function prepareSetupStorage(env:Pick<SetupEnv,'ARTIFACTS'>){
  try{
    if(!env.ARTIFACTS)throw Error();
    try{if(await workspaceReady(env))return;}catch(error){if(errorCode(error)!=='NOT_FOUND')throw error;}
    try{await env.ARTIFACTS.create(workspace,{description,setDefaultBranch:'main'});}
    catch(error){if(errorCode(error)!=='ALREADY_EXISTS')throw error;}
    using repo=await env.ARTIFACTS.get(workspace);
    const info=await repo.info();
    // This reserved connection-check repo needs no Git credentials, including on retry.
    if(info.description===description)for(const token of await activeTokens(repo))await repo.revokeToken(token.id);
    if(!info.id||!(await workspaceReady(env)))throw Error();
  }catch{throw Error('503: Could not prepare storage. Check the Artifacts binding and try again.');}
}
export async function saveSetupKey(env:Pick<SetupEnv,'CF_VERSION_METADATA'>,input:Record<string,unknown>,fetcher:typeof fetch=fetch){
  const {accountId,worker,apiToken,key,route}=input;
  if(Object.keys(input).some(name=>!['accountId','worker','apiToken','key','route'].includes(name))||
    typeof accountId!=='string'||!/^[a-f0-9]{32}$/.test(accountId)||
    typeof worker!=='string'||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)||
    typeof apiToken!=='string'||!/^[\w-]{20,512}$/.test(apiToken)||
    typeof key!=='string'||key.length<8||key.length>8192||/[\x00-\x20\x7f]/.test(key)||typeof route!=='string'||!['go','console'].includes(route))
    throw Error('400: Enter the account ID, Worker name, setup token and model key.');
  const version=env.CF_VERSION_METADATA?.id;
  if(!version||!/^[a-f0-9-]{36}$/.test(version))throw Error('503: Deploy the Worker with its version metadata binding first.');
  const base=`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}`;
  async function call(url:string,init:RequestInit={}){
    let response:Response;
    try{response=await fetcher(url,{...init,headers:{Authorization:`Bearer ${apiToken}`,'Content-Type':'application/json'},redirect:'manual',signal:AbortSignal.timeout(15000)});}
    catch{throw Error('503: Cloudflare could not be reached. Try again.');}
    if(!response.ok){await response.body?.cancel();throw Error('403: Check the account, Worker name and Workers Scripts Edit permission.');}
    try{if((await response.json() as {success?:boolean}).success!==true)throw Error();}
    catch{throw Error('503: Cloudflare did not confirm the change. Check its dashboard before retrying.');}
  }
  // An administrator cannot accidentally change a different installation.
  await call(`${base}/versions/${version}`);
  await call(`${base}/secrets`,{method:'PUT',body:JSON.stringify({name:route==='go'?'OPENCODE_GO_API_KEY':'OPENCODE_API_KEY',type:'secret_text',text:key})});
}
