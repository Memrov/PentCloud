// First-run configuration only. Resource deployment remains Cloudflare's job.
type Repo = Disposable & {info():Promise<{id:string;description?:string|null}>;listTokens():Promise<{tokens:{id:string;state:string}[]}>;revokeToken(token:string):Promise<unknown>};
interface SetupEnv {
  ARTIFACTS?:{get(name:string):Promise<Repo>;list?(options:{limit:number}):Promise<{repos:{id:string}[]}>;create(name:string,options:{description:string;setDefaultBranch:string}):Promise<{token:string}>};
  COORDINATOR?:unknown;ATTEMPTS?:unknown;MODEL_TESTS?:unknown;RESULTS?:unknown;
  BROWSER?:unknown;AI?:unknown;LOADER?:unknown;TOOL_PACKS?:unknown;TOOLBOX?:unknown;
  ACCESS_TEAM_DOMAIN?:string;ACCESS_AUD?:string;PENTCLOUD_ACCOUNT_ID?:string;PENTCLOUD_WORKER_NAME?:string;
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
  return {schemaVersion:1,access:true,accountId:env.PENTCLOUD_ACCOUNT_ID,worker:env.PENTCLOUD_WORKER_NAME,missing,storage,models,ready:missing.length===0&&storage&&models};
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
type Credentials={accountId:string;worker:string;apiToken:string};
function credentials(input:Record<string,unknown>):Credentials {
  const {accountId,worker,apiToken}=input;
  if(typeof accountId!=='string'||!/^[a-f0-9]{32}$/.test(accountId)||typeof worker!=='string'||!/^[a-z0-9][a-z0-9-]{0,62}$/.test(worker)||typeof apiToken!=='string'||!/^[\w-]{20,512}$/.test(apiToken))throw Error('400: Enter the account ID, Worker name and scoped setup token.');
  return {accountId,worker,apiToken};
}
async function setupClient(env:Pick<SetupEnv,'CF_VERSION_METADATA'>,input:Credentials,fetcher:typeof fetch){
  const {accountId,worker,apiToken}=input,version=env.CF_VERSION_METADATA?.id;
  if(!version||!/^[a-f0-9-]{36}$/.test(version))throw Error('503: Deploy the Worker with its version metadata binding first.');
  const base=`/accounts/${accountId}`,script=`${base}/workers/scripts/${worker}`;
  async function call<T=unknown>(path:string,init:RequestInit={}):Promise<T>{
    let response:Response;
    try{response=await fetcher('https://api.cloudflare.com/client/v4'+path,{...init,headers:{Authorization:`Bearer ${apiToken}`,'Content-Type':'application/json'},redirect:'manual',signal:AbortSignal.timeout(15000)});}
    catch{throw Error('503: Cloudflare could not be reached. Try again.');}
    if(!response.ok){await response.body?.cancel();throw Error('403: Check the account, Worker name and required setup-token permissions.');}
    try{const value=await response.json() as {success?:boolean;result:T};if(value.success!==true)throw Error();return value.result;}
    catch{throw Error('503: Cloudflare did not confirm the change. Check its dashboard before retrying.');}
  }
  // The supplied token must administer this exact deployed Worker before any mutation.
  await call(`${script}/versions/${version}`);
  return {base,script,call};
}
function modelSecret(input:Record<string,unknown>,optional=false){
  const {key,route}=input;
  if(optional&&(key===undefined||key===''))return {};
  if(typeof key!=='string'||key.length<8||key.length>8192||/[\x00-\x20\x7f]/.test(key)||typeof route!=='string'||!['go','console'].includes(route))throw Error('400: Enter a model key and choose Go or Console.');
  const name=route==='go'?'OPENCODE_GO_API_KEY':'OPENCODE_API_KEY';return {[name]:{name,type:'secret_text',text:key}};
}
export async function saveSetupKey(env:Pick<SetupEnv,'CF_VERSION_METADATA'>,input:Record<string,unknown>,fetcher:typeof fetch=fetch){
  if(Object.keys(input).some(name=>!['accountId','worker','apiToken','key','route'].includes(name)))throw Error('400: Unexpected setup field.');
  const secret=modelSecret(input),client=await setupClient(env,credentials(input),fetcher);
  await client.call(`${client.script}/secrets`,{method:'PUT',body:JSON.stringify(Object.values(secret)[0])});
}
export async function configureSetupAccess(env:Pick<SetupEnv,'CF_VERSION_METADATA'|'ACCESS_AUD'|'ACCESS_TEAM_DOMAIN'>,input:Record<string,unknown>,requestURL:string,fetcher:typeof fetch=fetch){
  if(env.ACCESS_AUD||env.ACCESS_TEAM_DOMAIN)throw Error('409: Access is already configured. Manage it in Cloudflare.');
  if(Object.keys(input).some(name=>!['accountId','worker','apiToken','email','key','route'].includes(name))||typeof input.email!=='string'||input.email.length>254||!/^\S+@[^@\s]+\.[^@\s]+$/.test(input.email))throw Error('400: Enter the owner email address.');
  const secret=modelSecret(input,true),target=credentials(input),url=new URL(requestURL);
  if(url.protocol!=='https:')throw Error('400: Open the deployed HTTPS application first.');
  const {call,base,script}=await setupClient(env,target,fetcher);
  const organization=await call<{auth_domain:string}>(`${base}/access/organizations`);
  if(!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(organization?.auth_domain??''))throw Error('503: Finish Cloudflare Zero Trust setup, then retry.');
  type App={id:string;aud:string;name:string;domain:string;type:string};
  const domain=url.hostname,name=`PentCloud ${target.worker}`,existing=await call<App[]>(`${base}/access/apps?domain=${encodeURIComponent(domain)}&exact=true`);
  if(!Array.isArray(existing)||existing.length>1)throw Error('409: Review the existing hostname policy in Cloudflare.');
  let app=existing[0];
  if(app){
    if(app.name!==name||app.domain!==domain||app.type!=='self_hosted')throw Error('409: Review the existing hostname policy in Cloudflare.');
    const policies=await call<{decision:string;include:{email?:{email:string}}[];require?:unknown[];exclude?:unknown[]}[]>(`${base}/access/apps/${app.id}/policies`);
    if(policies.length!==1||policies[0]!.decision!=='allow'||policies[0]!.include.length!==1||policies[0]!.include[0]?.email?.email!==input.email||policies[0]!.require?.length||policies[0]!.exclude?.length)throw Error('409: Review the existing hostname policy in Cloudflare.');
  }else app=await call<App>(`${base}/access/apps`,{method:'POST',body:JSON.stringify({name,type:'self_hosted',domain,session_duration:'24h',policies:[{name:'Owner',decision:'allow',precedence:1,include:[{email:{email:input.email}}],require:[],exclude:[]}]})});
  if(!/^[a-f0-9]{64}$/.test(app.aud))throw Error('503: Cloudflare did not confirm Access. Check its dashboard.');
  const secrets={...secret,ACCESS_TEAM_DOMAIN:{name:'ACCESS_TEAM_DOMAIN',type:'secret_text',text:'https://'+organization.auth_domain},ACCESS_AUD:{name:'ACCESS_AUD',type:'secret_text',text:app.aud}};
  await call(`${script}/secrets-bulk`,{method:'PATCH',body:JSON.stringify({secrets})});
}
