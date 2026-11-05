import assert from 'node:assert/strict';
const id=/^[a-f0-9]{32}$/,address=/^[a-z0-9_.-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
export function emailConfiguration(raw){
 if(raw===undefined)return;
 assert(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).every(k=>['cloudflare','agentmail'].includes(k)),'Invalid optional email configuration');
 const next={};
 if(raw.cloudflare){const c=raw.cloudflare;assert(Object.keys(c).every(k=>['zoneId','address'].includes(k))&&id.test(c.zoneId)&&typeof c.address==='string'&&c.address.length<=90&&address.test(c.address),'Use an explicit zoneId and literal base email address without plus tags');next.cloudflare={zoneId:c.zoneId,address:c.address};}
 if(raw.agentmail){const a=raw.agentmail;assert(Object.keys(a).every(k=>['inbox','storeId','secretName'].includes(k))&&id.test(a.storeId)&&typeof a.inbox==='string'&&a.inbox.length<=254&&address.test(a.inbox)&&typeof a.secretName==='string'&&/^[a-zA-Z0-9_.-]{1,255}$/.test(a.secretName),'Use an existing AgentMail inbox, storeId and secretName; never a key value');next.agentmail={inbox:a.inbox,storeId:a.storeId,secretName:a.secretName};}
 assert(Object.keys(next).length,'Choose at least one email receiver');return next;
}
export function emailBindings(email){
 const result={vars:{}};
 if(email?.cloudflare){result.addresses=[email.cloudflare.address];result.vars.PENTCLOUD_VERIFICATION_EMAIL=email.cloudflare.address;}
 if(email?.agentmail){const a=email.agentmail;result.vars.PENTCLOUD_AGENTMAIL_INBOX=a.inbox;result.secrets_store_secrets=[{binding:'AGENTMAIL_API_KEY',store_id:a.storeId,secret_name:a.secretName}];}
 return result;
}
/** Native DNS onboarding and Wrangler rule ownership; never replaces a mailbox. */
export async function configureEmail(api,config,worker,{apply=true}={}){
 const email=config.email;if(!email)return;
 if(email.agentmail){const a=email.agentmail,base=`/accounts/${config.accountId}/secrets_store/stores`;assert((await api.list(base)).some(s=>s.id===a.storeId),'AgentMail Secrets Store is missing from this account');const secrets=await api.list(`${base}/${a.storeId}/secrets`);assert(secrets.some(s=>s.name===a.secretName&&s.scopes?.includes('workers')),'AgentMail secret is missing or lacks workers scope');}
 if(!email.cloudflare)return;
 const c=email.cloudflare,path='/zones/'+c.zoneId,zone=await api.request(path),domain=c.address.split('@')[1];
 assert.equal(zone.account?.id,config.accountId,'Email zone belongs to another account');assert(domain===zone.name||domain.endsWith('.'+zone.name),'Receiver is outside the selected zone');
 const dns=await api.request(`${path}/dns_records?name=${encodeURIComponent(domain)}&per_page=100`,{envelope:true});assert(Array.isArray(dns.result)&&(dns.result_info?.total_pages??1)<=1,'Inspect receiving domain DNS before enabling email');
 const mx=dns.result.filter(r=>r.type==='MX'),spf=dns.result.filter(r=>r.type==='TXT'&&/^v=spf1\b/i.test(r.content));
 assert(mx.every(r=>/^route\d+\.mx\.cloudflare\.net\.?$/i.test(r.content)),'Existing MX belongs to another mail service; use an unused domain or subdomain');
 let routing=await api.request(path+'/email/routing');
 if(domain!==zone.name)assert(mx.length&&routing.enabled,'Enable this subdomain in Cloudflare Email Routing Settings first; existing mail DNS will not be changed');
 if(!routing.enabled){
  assert(!mx.length&&!spf.length,'Existing mail DNS needs review before Email Routing onboarding');assert(apply,'Cloudflare receiving is not enabled');
  await api.request(path+'/email/routing/dns',{method:'POST',body:{name:zone.name}});routing=await api.request(path+'/email/routing');
 }
 assert(routing.enabled,'Cloudflare Email Routing is not enabled');
 if(!routing.support_subaddress){assert(apply,'Enable Email Routing plus addressing');await api.request(path+'/email/routing',{method:'PUT',body:{support_subaddress:true}});}
 const rules=await api.list(path+'/email/routing/rules'),matches=rules.filter(r=>r.matchers?.some(m=>m.type==='literal'&&m.value?.toLowerCase()===c.address));
 if(!apply)assert(matches.length===1&&matches[0].enabled,'Native Cloudflare receiver route is missing or disabled');
 for(const rule of matches){assert(rule.source==='wrangler'&&rule.actions?.length===1&&rule.actions[0].type==='worker'&&rule.actions[0].value?.length===1&&rule.actions[0].value[0]===worker,'Email address is already managed elsewhere; choose an unused address or reconcile its native Wrangler ownership');}
}
