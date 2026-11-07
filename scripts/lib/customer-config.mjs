import assert from 'node:assert/strict';
import {configuration} from './private-install.mjs';

export function customerConfiguration(value){
  assert(value&&typeof value==='object'&&!Array.isArray(value),'PC_CONFIG_OBJECT');
  assert(Object.keys(value).every(key=>['schemaVersion','accountId','instance','accessTeamDomain','allowedEmails','domain','email','accessBootstrap'].includes(key)),'PC_CONFIG_FIELDS');
  assert.equal(value.schemaVersion,2,'PC_CONFIG_VERSION');
  const base=configuration({...Object.fromEntries(Object.entries(value).filter(([key])=>!['domain','accessBootstrap','schemaVersion'].includes(key))),schemaVersion:1});
  const domain=value.domain;
  assert(domain&&Object.keys(domain).length===2&&Object.keys(domain).every(key=>['zoneId','hostname'].includes(key)),'PC_DOMAIN_FIELDS');
  assert.match(domain.zoneId??'',/^[a-f0-9]{32}$/,'PC_DOMAIN_ZONE');
  assert.match(domain.hostname??'',/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,'PC_DOMAIN_HOSTNAME');
  assert(domain.hostname.length<=253,'PC_DOMAIN_HOSTNAME');
  let accessBootstrap;
  if(value.accessBootstrap!==undefined){
    const b=value.accessBootstrap;
    assert(b&&Object.keys(b).length===2&&Object.keys(b).every(key=>['organizationName','onetimepin'].includes(key)),'PC_ACCESS_BOOTSTRAP_FIELDS');
    assert(typeof b.organizationName==='string'&&b.organizationName.trim()===b.organizationName&&b.organizationName.length>0&&b.organizationName.length<=128&&!/[\x00-\x1f\x7f]/.test(b.organizationName)&&b.onetimepin===true,'PC_ACCESS_BOOTSTRAP');
    accessBootstrap={organizationName:b.organizationName,onetimepin:true};
  }
  return {...base,schemaVersion:2,domain:{...domain},...(accessBootstrap?{accessBootstrap}:{})};
}
export function packageBaseConfiguration(config){
  return configuration({...Object.fromEntries(Object.entries(config).filter(([key])=>!['domain','accessBootstrap','schemaVersion'].includes(key))),schemaVersion:1});
}
export function customerPlan(config){
  return {schemaVersion:2,backend:'tool-packages',instance:config.instance,hostname:config.domain.hostname,toolPacks:11,operatorCount:config.allowedEmails.length,
    actions:['Verify selected account, domain ownership, prerequisites and immutable image/source pins',
      'Checkpoint private installation ownership and image provenance in native Artifacts',
      ...(config.accessBootstrap?['Create only missing Zero Trust team/email login settings explicitly requested in this configuration']:[]),
      'Build or reuse verified tool images in the selected account',
      'Deploy the private package gateway and Access-protected application',
      'Verify native services and retire task-owned test runtimes'],modelInference:'requires separate explicit setup/test',productionBilling:'configure required plans directly in Cloudflare'};
}
export function installationBackend(raw,prior,command){
  if(prior?.packageProfile){assert(raw?.schemaVersion===2,'PC_PACKAGE_CONFIG_REQUIRED');return 'packages';}
  if(prior&&Object.keys(prior.resources??{}).length){assert(raw?.schemaVersion===1,'PC_LEGACY_CONVERSION_REQUIRES_MIGRATION');return 'legacy';}
  assert(raw?.schemaVersion===2,'PC_NEW_INSTALL_REQUIRES_PACKAGE_CONFIG');
  return 'packages';
}
