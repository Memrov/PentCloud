import assert from 'node:assert/strict';
import {test} from 'node:test';
import {configuration} from './lib/private-install.mjs';
import {configureEmail,emailBindings} from './lib/private-email.mjs';
const base={schemaVersion:1,accountId:'a'.repeat(32),instance:'email-test',accessTeamDomain:'https://fixture.cloudflareaccess.com',allowedEmails:['owner@example.com']};
const email={cloudflare:{zoneId:'b'.repeat(32),address:'verification@auth.example.com'},agentmail:{inbox:'owned@agentmail.to',storeId:'c'.repeat(32),secretName:'own-agentmail-key'}};
test('accepts only explicit receiving references, rendering native addresses and Secrets Store binding',()=>{
 const config=configuration({...base,email});assert.deepEqual(config.email,email);
 assert.deepEqual(emailBindings(config.email),{addresses:['verification@auth.example.com'],vars:{PENTCLOUD_VERIFICATION_EMAIL:'verification@auth.example.com',PENTCLOUD_AGENTMAIL_INBOX:'owned@agentmail.to'},secrets_store_secrets:[{binding:'AGENTMAIL_API_KEY',store_id:'c'.repeat(32),secret_name:'own-agentmail-key'}]});
 for(const invalid of [{agentmail:{...email.agentmail,apiKey:'not-allowed'}},{cloudflare:{...email.cloudflare,address:'*@auth.example.com'}},{cloudflare:{...email.cloudflare,address:'verification+tag@auth.example.com'}},{agentmail:{...email.agentmail,inbox:'https://attacker.example/'}}])assert.throws(()=>configuration({...base,email:invalid}));
});
function fixture({foreign=false,mx='route1.mx.cloudflare.net',enabled=true}={}){
 const calls=[];const api={request:async(path,options={})=>{calls.push({path,...options});if(path==='/zones/'+email.cloudflare.zoneId)return {name:'example.com',account:{id:foreign?'d'.repeat(32):base.accountId}};if(path.includes('/dns_records?'))return {result:mx?[{type:'MX',content:mx}]:[],result_info:{total_pages:1}};if(path.endsWith('/email/routing/dns')){enabled=true;return {enabled:true};}if(path.endsWith('/email/routing'))return {enabled,support_subaddress:true};throw Error('unmocked');},list:async path=>path.endsWith('/rules')?[]:path.endsWith('/secrets')?[{name:'own-agentmail-key',scopes:['workers']}]:[{id:'c'.repeat(32)}]};return {calls,api};
}
test('checks selected account, zone and key metadata without retrieving a secret value',async()=>{
 const f=fixture();await configureEmail(f.api,{...base,email},'email-test-app');assert(f.calls.every(c=>(c.method??'GET')==='GET'));
 await assert.rejects(configureEmail(fixture({foreign:true}).api,{...base,email},'email-test-app'),/account/);
 const missing=fixture();missing.api.list=async()=>[];await assert.rejects(configureEmail(missing.api,{...base,email:{agentmail:email.agentmail}},'email-test-app'),/store/i);
});
test('never replaces foreign MX or guesses subdomain onboarding',async()=>{
 for(const options of [{mx:'mail.other.example'},{mx:'',enabled:false}]){const f=fixture(options);await assert.rejects(configureEmail(f.api,{...base,email:{cloudflare:email.cloudflare}},'email-test-app'),/MX|subdomain/);assert(f.calls.every(c=>(c.method??'GET')==='GET'));}
 const f=fixture({mx:'',enabled:false});await configureEmail(f.api,{...base,email:{cloudflare:{...email.cloudflare,address:'verification@example.com'}}},'email-test-app');assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});
