import assert from 'node:assert/strict';

// Account-wide Access settings are reused, never removed with an installation.
export async function ensurePackageAccess(installer,bootstrap){
  const {api,base,config,state}=installer,path=base+'/access/organizations';
  const expected=new URL(config.accessTeamDomain).hostname;
  let organization=await api.request(path,{missing:true});
  if(!organization){
    assert(bootstrap?.onetimepin===true&&typeof bootstrap.organizationName==='string','PC_ACCESS_TEAM_REQUIRED');
    state.accessBootstrap??={};state.accessBootstrap.organization={status:'pending',authDomain:expected};await installer.save();
    organization=await api.request(path,{method:'POST',body:{name:bootstrap.organizationName,auth_domain:expected}});
    assert(organization?.auth_domain===expected,'PC_ACCESS_TEAM_RECEIPT');
    state.accessBootstrap.organization={status:'ready',authDomain:expected,retainedAccountResource:true};await installer.save();
  }
  assert.equal(organization.auth_domain,expected,'PC_ACCESS_TEAM_MISMATCH');
  let providers=await api.list(base+'/access/identity_providers');
  assert(Array.isArray(providers),'PC_ACCESS_PROVIDER_LIST');
  if(!providers.length){
    assert(bootstrap?.onetimepin===true,'PC_ACCESS_PROVIDER_REQUIRED');
    state.accessBootstrap??={};state.accessBootstrap.provider={status:'pending',name:config.instance+'-email-login'};await installer.save();
    const provider=await api.request(base+'/access/identity_providers',{method:'POST',body:{name:config.instance+'-email-login',type:'onetimepin',config:{}}});
    assert(provider?.id&&provider.type==='onetimepin','PC_ACCESS_PROVIDER_RECEIPT');
    state.accessBootstrap.provider={status:'ready',id:provider.id,retainedAccountResource:true};await installer.save();
    providers=[provider];
  }
  return {organization,providers};
}
