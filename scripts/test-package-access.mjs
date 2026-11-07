import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ensurePackageAccess} from './lib/package-access.mjs';
function fixture({team=null,providers=[]}={}){
  const calls=[],i={base:'/accounts/'+'a'.repeat(32),config:{instance:'customer',accessTeamDomain:'https://customer.cloudflareaccess.com'},state:{},async save(){calls.push('save');},api:{async request(path,{method='GET',body}={}){calls.push({path,method,body});if(method==='POST'){if(path.endsWith('/organizations'))return team={...body};const p={...body,id:'new-provider'};providers.push(p);return p;}return team;},async list(){return providers;}}};return {i,calls,getTeam:()=>team};
}
test('missing Access settings require explicit bootstrap and checkpoint before creation',async()=>{
 const f=fixture();await assert.rejects(ensurePackageAccess(f.i),/PC_ACCESS_TEAM_REQUIRED/);assert(!f.calls.some(x=>x.method==='POST'));
 f.calls.length=0;
 const result=await ensurePackageAccess(f.i,{organizationName:'Customer',onetimepin:true});
 const creates=f.calls.map((v,n)=>v.method==='POST'?n:-1).filter(n=>n>=0);
 assert.equal(creates.length,2);for(const n of creates)assert.equal(f.calls[n-1],'save');
 assert.equal(result.organization.auth_domain,'customer.cloudflareaccess.com');assert.equal(result.providers[0].type,'onetimepin');
 assert.equal(f.i.state.accessBootstrap.organization.status,'ready');
});
test('existing account-wide team and providers are preserved',async()=>{
 const f=fixture({team:{auth_domain:'customer.cloudflareaccess.com',name:'Existing'},providers:[{id:'existing',type:'oidc'}]});
 await ensurePackageAccess(f.i,{organizationName:'Ignored',onetimepin:true});assert(!f.calls.some(x=>x.method==='POST'));
 const other=fixture({team:{auth_domain:'foreign.cloudflareaccess.com'}});await assert.rejects(ensurePackageAccess(other.i,{organizationName:'Customer',onetimepin:true}),/PC_ACCESS_TEAM_MISMATCH/);assert(!other.calls.some(x=>x.method==='POST'));
});
test('a failed bootstrap checkpoint stops the remote mutation',async()=>{
 const f=fixture();f.i.save=async()=>{throw Error('checkpoint unavailable');};await assert.rejects(ensurePackageAccess(f.i,{organizationName:'Customer',onetimepin:true}));assert(!f.calls.some(x=>x.method==='POST'));
});
