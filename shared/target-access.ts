/** Serializable target settings. Secret values never belong in this structure. */
export interface ScopeRule {host:string;subdomains:boolean;protocol?:"http:"|"https:";port?:string;path:string}
export interface ProgramScope {
 id:string;name:string;platform:string;url:string;catalogCommit:string;sourceCommit:string;sha256:string;publishedAt:string;importedAt:number;
 allow:ScopeRule[];deny:ScopeRule[];instructions:string[];unsupportedAssets:number;
}
export interface TargetLogin {url:string;usernameBinding:string;passwordBinding:string}
export interface TargetHeader {name:string;value:string}
export interface TargetAPICredential {url:string;binding:string;header:string;scheme:"bearer"|"header"}
export interface TargetAccess {program?:ProgramScope;headers:TargetHeader[];headerBinding?:string;login?:TargetLogin;api?:TargetAPICredential}
export interface ScopedTarget {url:string;access?:TargetAccess}
interface Asset {type:string;value:string;instructions?:string|null;eligible_for_submission?:boolean|null}
export interface ScopeProgram {id:string;name:string;platform:string;url:string;targets:{in_scope:Asset[];out_of_scope:Asset[]}}
const webTypes=new Set(["url","wildcard","website","web-application","api","domain","ip_address","network","cidr","iprange"]);
const forbiddenHeaders=/^(?:host|cookie|authorization|connection|content-length|transfer-encoding|upgrade|te|trailer|proxy-.*|cf-.*|x-forwarded-.*|forwarded|x-real-ip|origin|referer|sec-.*)$/i;
const bindingName=/^PENTCLOUD_TARGET_[A-Z0-9_]{1,96}$/;
function publicURL(raw:string):URL {
 let url:URL;try{url=new URL(raw);}catch{throw new Error("400: Invalid target address");}
 const host=url.hostname.toLowerCase().replace(/\.$/,"");
 if(!["http:","https:"].includes(url.protocol)||url.username||url.password||!host||host.includes("*")||host.includes(":")||
  /^(?:localhost|.*\.localhost|.*\.local|.*\.internal|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host)||/^\d+(?:\.\d+){0,3}$/.test(host))
  throw new Error("400: Target access requires a public HTTP or HTTPS hostname");
 if(url.port&&url.port!=="80"&&url.port!=="443")throw new Error("400: Managed target access supports ports 80 and 443");
 if(/[\\\x00-\x20]/.test(raw)||/%(?:25)*(?:2f|5c|00)/i.test(url.pathname)||url.pathname.includes(";"))throw new Error("403: Ambiguous target path is blocked");
 return url;
}
function normalizedPath(path:string){
 let decoded=path;try{for(let i=0;i<3&&/%[0-9a-f]{2}/i.test(decoded);i++)decoded=decodeURIComponent(decoded);}catch{throw new Error("403: Ambiguous target path is blocked");}
 if(/[%\\;\x00-\x1f]/.test(decoded))throw new Error("403: Ambiguous target path is blocked");
 return new URL("https://scope.invalid"+decoded.replace(/\/+/g,"/")).pathname;
}
function pathMatches(base:string,path:string){const clean=normalizedPath(base).replace(/\/$/,""),value=normalizedPath(path);return clean===""||value===clean||value.startsWith(clean+"/");}
function parseAsset(asset:Asset):ScopeRule|undefined {
 if(!webTypes.has(String(asset.type).toLowerCase())&&!(["other","unknown"].includes(String(asset.type).toLowerCase())&&/^(?:https?:\/\/|\*\.)|^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(asset.value)))return;
 if(typeof asset.value!=="string"||asset.value.length>2048)throw new Error("Unsupported network asset");
 let raw=asset.value.trim(),protocol:ScopeRule["protocol"];
 if(/^https?:\/\//i.test(raw)){protocol=raw.toLowerCase().startsWith("https:")?"https:":"http:";raw=raw.replace(/^https?:\/\//i,"");}
 const wildcard=raw.startsWith("*.");if(wildcard)raw=raw.slice(2);
 if(raw.endsWith("/*"))raw=raw.slice(0,-1);
 if(/[?#[\]{}*\\\s]/.test(raw))throw new Error("Unsupported network asset");
 const url=publicURL((protocol??"https:")+"//"+raw);
 const port=raw.split("/")[0]?.match(/:(\d+)$/)?.[1];
 return {host:url.hostname,subdomains:wildcard,...(protocol?{protocol}:{}),...(port?{port}:{}),path:url.pathname};
}
function matches(rule:ScopeRule,url:URL){
 const host=url.hostname.toLowerCase();return (rule.subdomains?host.endsWith("."+rule.host):host===rule.host)&&
  (!rule.protocol||url.protocol===rule.protocol)&&(!rule.port||(url.port||(url.protocol==="https:"?"443":"80"))===rule.port)&&pathMatches(rule.path,url.pathname);
}
export function compileProgramScope(program:ScopeProgram,source:Pick<ProgramScope,"catalogCommit"|"sourceCommit"|"sha256"|"publishedAt">,targetURL:string):ProgramScope {
 const url=publicURL(targetURL);
 const allow:ScopeRule[]=[],deny:ScopeRule[]=[],instructions:string[]=[];let unsupportedAssets=0;
 if(!program||!program.targets||!Array.isArray(program.targets.in_scope)||!Array.isArray(program.targets.out_of_scope))throw new Error("502: Invalid program scope");
 if(program.targets.in_scope.length+program.targets.out_of_scope.length>10000)throw new Error("413: Program scope is too large");
 for(const [assets,rules,exclusion] of [[program.targets.in_scope,allow,false],[program.targets.out_of_scope,deny,true]] as const)for(const asset of assets){
  if(!exclusion&&asset.eligible_for_submission===false)continue;
  try{const rule=parseAsset(asset);if(rule){rules.push(rule);if((rule.host===url.hostname||rule.subdomains&&url.hostname.endsWith("."+rule.host))&&asset.instructions?.trim()&&instructions.length<8)instructions.push(asset.instructions.slice(0,1500));}else unsupportedAssets++;}
  catch{if(exclusion)throw new Error("409: Program contains an unsupported network exclusion; review its scope before importing");unsupportedAssets++;}
 }
 if(!allow.some(rule=>matches(rule,url))||deny.some(rule=>matches(rule,url)))throw new Error("403: Selected target is outside the program scope or explicitly excluded");
 const relevant=(rule:ScopeRule)=>(rule.host===url.hostname||rule.subdomains&&url.hostname.endsWith("."+rule.host))&&(pathMatches(rule.path,url.pathname)||pathMatches(url.pathname,rule.path));
 return {id:program.id,name:program.name,platform:program.platform,url:program.url,...source,importedAt:Date.now(),allow:allow.filter(relevant),deny:deny.filter(relevant),instructions:[...new Set(instructions)],unsupportedAssets};
}
export function assertTargetRequest(target:ScopedTarget,raw:string):URL {
 const url=publicURL(raw),base=publicURL(target.url);
 if(url.origin!==base.origin||!pathMatches(base.pathname,url.pathname))throw new Error("403: Request is outside this saved target");
 const scope=target.access?.program;
 if(scope&&(!scope.allow.some(rule=>matches(rule,url))||scope.deny.some(rule=>matches(rule,url))))throw new Error("403: Request is outside imported program scope");
 return url;
}
export function validateTargetAccess(url:string,raw:unknown):TargetAccess {
 publicURL(url);if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("400: Invalid target access settings");
 const data=raw as TargetAccess;
 if(!Array.isArray(data.headers)||data.headers.length>12)throw new Error("400: Use at most 12 required headers");
 const names=new Set<string>();
 const headers=data.headers.map(h=>{
  if(!h||typeof h.name!=="string"||!/^[-!#$%&'*+.^_`|~0-9A-Za-z]{1,64}$/.test(h.name)||forbiddenHeaders.test(h.name)||names.has(h.name.toLowerCase())||typeof h.value!=="string"||!h.value.trim()||h.value.length>1024||/[\r\n\0]/.test(h.value))throw new Error("400: Invalid or reserved required header");
  names.add(h.name.toLowerCase());return {name:h.name,value:h.value};
 });
 const next:TargetAccess={headers};
 if(data.headerBinding){if(!bindingName.test(data.headerBinding))throw new Error("400: Invalid required headers binding");next.headerBinding=data.headerBinding;}
 if(data.program){
  const p=data.program;if(!/^[a-f0-9]{40}$/.test(p.catalogCommit)||!/^[a-f0-9]{64}$/.test(p.sha256)||!Array.isArray(p.allow)||!Array.isArray(p.deny)||p.allow.length+p.deny.length>10000)throw new Error("400: Invalid imported program scope");
  if(typeof p.id!=="string"||typeof p.name!=="string"||p.name.length>500||typeof p.platform!=="string"||typeof p.url!=="string"||!Number.isFinite(Date.parse(p.publishedAt))||!Array.isArray(p.instructions)||p.instructions.some(i=>typeof i!=="string"||i.length>2000))throw new Error("400: Invalid program metadata");
  for(const rule of [...p.allow,...p.deny]){
   if(!rule||typeof rule.host!=="string"||typeof rule.subdomains!=="boolean"||typeof rule.path!=="string"||!rule.path.startsWith("/")||rule.path.length>2048||rule.protocol!==undefined&&!["http:","https:"].includes(rule.protocol)||rule.port!==undefined&&!['80','443'].includes(rule.port))throw new Error("400: Invalid scope rule");
   const address=publicURL((rule.protocol??"https:")+"//"+rule.host+(rule.port?":"+rule.port:"")+rule.path);if(address.hostname!==rule.host)throw new Error("400: Invalid scope hostname");
  }
  next.program=structuredClone(p);assertTargetRequest({url,access:next},url);
 }
 if(data.login){
  const login=data.login;assertTargetRequest({url,access:next},login.url);
  if(!bindingName.test(login.usernameBinding)||!bindingName.test(login.passwordBinding))throw new Error("400: Use PENTCLOUD_TARGET_ Cloudflare bindings for login credentials");
  next.login={url:publicURL(login.url).href,usernameBinding:login.usernameBinding,passwordBinding:login.passwordBinding};
 }
 if(data.api){
  const api=data.api;assertTargetRequest({url,access:next},api.url);
  if(!bindingName.test(api.binding)||!/^[-!#$%&'*+.^_`|~0-9A-Za-z]{1,64}$/.test(api.header)||forbiddenHeaders.test(api.header)&&api.header.toLowerCase()!=="authorization"||!["bearer","header"].includes(api.scheme))throw new Error("400: Invalid Cloudflare target API credential");
  next.api={url:publicURL(api.url).href,binding:api.binding,header:api.header,scheme:api.scheme};
 }
 return next;
}
export function browserGuardrails(target:ScopedTarget){return {allowedDomains:[publicURL(target.url).hostname]};}
export function requestHeaders(target:ScopedTarget,initial?:HeadersInit,options:{cookies?:boolean;targetContext?:boolean;credential?:{header:string;value:string}}={}){
 const headers=new Headers(initial);
 for(const name of [...headers.keys()])if(forbiddenHeaders.test(name)&&!(options.cookies&&name.toLowerCase()==="cookie")&&!(options.targetContext&&/^(authorization|origin|referer)$/i.test(name)))headers.delete(name);
 for(const {name,value} of target.access?.headers??[])headers.set(name,value);
 if(options.credential)headers.set(options.credential.header,options.credential.value);
 return headers;
}
export async function readTargetSecret(env:object,name:string):Promise<string>{
 if(!bindingName.test(name))throw new Error("403: Only target credential bindings can be resolved");
 const binding:unknown=Reflect.get(env,name);let value:unknown;
 try{value=typeof binding==="string"?binding:binding&&typeof binding==="object"&&typeof Reflect.get(binding,"get")==="function"?await (binding as {get():Promise<string>}).get():undefined;}catch{throw new Error("503: Cloudflare target secret unavailable");}
 if(typeof value!=="string"||!value.trim())throw new Error("409: Configure the target credential binding in Cloudflare");
 if(value.length>8192||/[\r\n\0]/.test(value))throw new Error("409: Target secret has invalid format");return value;
}
/** Stable names reveal neither the target hostname nor credential values. */
export async function targetSecretBindings(id:string){
 const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(id));
 const prefix="PENTCLOUD_TARGET_"+[...new Uint8Array(bytes)].slice(0,12).map(v=>v.toString(16).padStart(2,"0")).join("").toUpperCase();
 return {username:prefix+"_USERNAME",password:prefix+"_PASSWORD",api:prefix+"_API_KEY",headers:prefix+"_HEADERS"};
}
export function parseTargetHeaders(value:string):TargetHeader[]{
 let data:unknown;try{data=JSON.parse(value);}catch{throw new Error("409: Required headers secret must be a JSON object of header names and values");}
 if(!data||typeof data!=="object"||Array.isArray(data))throw new Error("409: Required headers secret must be a JSON object");
 return validateTargetAccess("https://headers.example/",{headers:Object.entries(data).map(([name,value])=>({name,value}))}).headers;
}
export async function resolveTargetHeaders<T extends ScopedTarget>(target:T,resolve:(name:string)=>Promise<string>):Promise<T>{
 if(!target.access?.headerBinding)return target;
 return {...target,access:{...target.access,headers:[...target.access.headers,...parseTargetHeaders(await resolve(target.access.headerBinding))]}};
}
export function targetAccessBrief(target:ScopedTarget){return {url:target.url,scope:target.access?"Browser and managed HTTP requests stay within this saved target and imported exclusions. Browser WebSockets are unavailable. Kali has direct Internet access: scope is NOT enforced there. Abide by the program rules with every tool.":"Target is guidance, not universal host confinement",...(target.access?.program?{program:target.access.program.name,scopeRevision:target.access.program.catalogCommit,instructions:target.access.program.instructions}:{}),...(target.access?.login?{login:"Use pentcloud_browser_login to fill Cloudflare-held credentials, then submit and inspect the result. Login is fresh for each run and shared only within this run."}:{}),...(target.access?.api?{api:"Use pentcloud_api_request for Cloudflare-held target API credentials."}:{})};}
