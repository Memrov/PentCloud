// Package-only installation profile. Legacy Kali installations use Installer.
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {Installer, configuration, privateJson, readJson} from './private-install.mjs';
import {emailBindings} from './private-email.mjs';

export const PACK_CLASSES={
  recon:'ReconRunner',http:'HttpRunner',nuclei:'NucleiRunner',sqlmap:'SqlmapRunner',
  service:'ServiceRunner','web-context':'WebContextRunner',pcap:'PcapRunner',
  'file-analysis':'FileRunner',password:'PasswordRunner',reference:'ReferenceRunner',metasploit:'MetasploitRunner',
};
export function packageProfile(config,value){
  assert(value&&Object.keys(value).every(k=>['domain','images'].includes(k)),'Invalid package installation profile');
  const d=value.domain;
  assert(d&&Object.keys(d).every(k=>['zoneId','hostname'].includes(k)),'Provide the selected custom domain');
  assert.match(d.zoneId??'',/^[a-f0-9]{32}$/,'Select a domain zone');
  assert.match(d.hostname??'',/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,'Use a literal lowercase hostname');
  assert(value.images&&Object.keys(value.images).length===11&&Object.keys(PACK_CLASSES).every(k=>typeof value.images[k]==='string'),'Provide the complete eleven-pack image set');
  for(const image of Object.values(value.images)){
    assert(image.startsWith('registry.cloudflare.com/'+config.accountId+'/'),'Use immutable images in the selected account');
    assert.match(image,/^registry\.cloudflare\.com\/[a-f0-9]{32}\/[a-z0-9][a-z0-9._-]*@sha256:[a-f0-9]{64}$/,'Use immutable image references');
    assert(!/kali/i.test(image),'Kali is not part of the package profile');
  }
  return {domain:{...d},images:{...value.images}};
}

export class PackageInstaller extends Installer {
  constructor({profile,checkpoint=async()=>{},...options}){
    super({...options,importImage:async()=>{throw Error('Kali image import is forbidden in the package profile')}});
    this.profile=packageProfile(this.config,profile);
    this.checkpoint=checkpoint;
    this.names={app:this.config.instance+'-app',gateway:this.config.instance+'-tools',namespace:this.config.instance+'-work',workflow:this.config.instance+'-results',access:this.config.instance+'-operators'};
  }
  async save(){await super.save();await this.checkpoint(this);}
  async load(options={}){
    const state=await super.load(options);
    if(state.packageProfile){
      assert.deepEqual(state.packageProfile.domain,this.profile.domain,'Package domain changed; retain installation ownership');
      if(!options.updateEmail)assert.deepEqual(state.packageProfile.images,this.profile.images,'Image updates require upgrade');
    }else assert(Object.keys(state.resources).length===0,'Cannot convert an existing legacy installation implicitly');
    state.packageProfile=this.profile;await this.save();return state;
  }
  async preflight(){
    await this.api.request(this.base);
    const team=await this.api.request(this.base+'/access/organizations');
    assert.equal('https://'+team.auth_domain,this.config.accessTeamDomain,'Access team belongs to a different account');
    assert((await this.api.list(this.base+'/access/identity_providers')).length,'Configure a Zero Trust login method');
    const zone=await this.api.request('/zones/'+this.profile.domain.zoneId);
    assert.equal(zone.account?.id,this.config.accountId,'Domain belongs to another account');
    assert.equal(zone.status,'active','Domain zone must be active');
    const host=this.profile.domain.hostname;
    assert(host===zone.name||host.endsWith('.'+zone.name),'Hostname is outside the selected zone');
    const domains=await this.api.list(this.base+'/workers/domains');
    const domain=domains.find(x=>x.hostname===host);
    assert(!domain||this.state.resources.domain?.status==='ready'&&domain.id===this.state.resources.domain.id&&domain.service===this.names.app,'Refusing to adopt an existing custom domain');
    if(!domain){
      const dns=await this.api.request('/zones/'+zone.id+'/dns_records?name='+encodeURIComponent(host)+'&per_page=100',{envelope:true});
      assert(Array.isArray(dns.result)&&dns.result.length===0,'Hostname already has DNS records; choose an unused test hostname');
    }
    const scripts=await this.api.list(this.base+'/workers/scripts');
    for(const key of ['gateway','app'])assert(!scripts.some(x=>x.id===this.names[key])||this.state.resources[key]?.status==='ready','Refusing to overwrite an existing or uncertain '+key+' Worker');
    const workflows=await this.api.list(this.base+'/workflows');
    assert(!workflows.some(x=>x.name===this.names.workflow)||this.state.resources.app?.status==='ready','Workflow name is already in use');
    const containers=await this.api.request(this.base+'/containers/applications');
    assert(Array.isArray(containers),'Unexpected Container listing');
    for(const pack of Object.keys(PACK_CLASSES))assert(!containers.some(x=>x.name===this.config.instance+'-'+pack)||this.state.resources['pack-'+pack]?.status==='ready','Tool-pack Container name is already in use');
    this.state.appUrl='https://'+host;await this.save();
  }
  async render(publicApp=false){
    const app=await readJson(join(this.root,'templates/private-install/app.json'));
    const gateway=await readJson(join(this.root,'infra/tool-packs/wrangler.jsonc'));
    for(const [key,template]of [['app',app],['gateway',gateway]]){
      const prior=await readJson(join(this.directory,key+'.wrangler.json'),null);
      if(prior)assert.deepEqual(template.migrations.slice(0,prior.migrations.length),prior.migrations,'Preserve existing DO migration history');
    }
    Object.assign(app,{
      account_id:this.config.accountId,name:this.names.app,main:join(this.root,'apps/control-plane/src/worker.ts'),
      workers_dev:false,preview_urls:false,
      assets:{binding:'ASSETS',directory:join(this.root,'apps/control-plane/dist/client'),not_found_handling:'single-page-application',run_worker_first:['/*']},
      artifacts:[{binding:'ARTIFACTS',namespace:this.names.namespace}],
      services:[{binding:'TOOL_PACKS',service:this.names.gateway,entrypoint:'ToolPackGateway'}],
      workflows:[{binding:'RESULTS',name:this.names.workflow,class_name:'ResultValidation'}],
      triggers:{events:[{type:'cf.artifacts.repo.pushed',filter:{namespace:this.names.namespace},targets:[{type:'workflow',workflow_name:this.names.workflow}]}]},
      vars:{CONTROL_BASE_URL:this.state.appUrl,ACCESS_TEAM_DOMAIN:this.config.accessTeamDomain,ACCESS_AUD:this.state.resources.access.aud,ARTIFACTS_NAMESPACE:this.names.namespace},
      ...(publicApp?{routes:[{pattern:this.profile.domain.hostname,custom_domain:true,zone_id:this.profile.domain.zoneId}]}:{}),
    });
    const mail=emailBindings(this.config.email);Object.assign(app,mail,{vars:{...app.vars,...mail.vars}});
    Object.assign(gateway,{
      name:this.names.gateway,account_id:this.config.accountId,main:join(this.root,'infra/tool-packs/src/worker.ts'),
      workers_dev:false,preview_urls:false,
      containers:Object.entries(PACK_CLASSES).map(([pack,class_name])=>({name:this.config.instance+'-'+pack,class_name,scheduling_policy:'durable_object',images:{[pack]:{image:this.profile.images[pack]}}})),
    });
    await privateJson(join(this.directory,'app.wrangler.json'),app);
    await privateJson(join(this.directory,'gateway.wrangler.json'),gateway);
    return {app,gateway};
  }
  async recordContainer(){
    const containers=await this.api.request(this.base+'/containers/applications');
    const settings=await this.api.request(this.base+'/workers/scripts/'+this.names.gateway+'/settings');
    for(const [pack,className]of Object.entries(PACK_CLASSES)){
      const c=containers.find(x=>x.name===this.config.instance+'-'+pack);
      const binding=settings.bindings.find(x=>x.class_name===className);
      assert(c&&binding?.namespace_id&&c.durable_objects?.namespace_id===binding.namespace_id,'Tool-pack Container/DO association mismatch: '+pack);
      const old=this.state.resources['pack-'+pack];
      if(old?.id)assert.equal(c.id,old.id,'Tool-pack application identity changed');
      this.state.resources['pack-'+pack]={id:c.id,name:c.name,namespaceId:binding.namespace_id,status:'ready',image:this.profile.images[pack]};
    }
    await this.save();
  }
  async install({upgrade=false,verify=true}={}){
    await this.load({create:!upgrade,updateEmail:upgrade});
    assert(!this.state.removed,'Installation was removed');
    await this.preflight();
    await this.owned('namespace',async()=>{
      const n=await this.api.request(this.base+'/artifacts/namespaces/'+this.names.namespace,{missing:true});
      return n?{...n,id:this.names.namespace}:null;
    },async()=>{await this.api.request(this.base+'/artifacts/namespaces',{method:'POST',body:{namespace:this.names.namespace}});return {id:this.names.namespace};});
    for(const [pack,image]of Object.entries(this.profile.images)){
      const result=await this.api.request(this.base+'/containers/image-preparations',{method:'POST',body:{image}});
      assert.equal(result.status,'ready','Tool-pack image preparation is pending: '+pack+'; retain state and resume');
    }
    const access=await this.owned('access',async()=>(await this.api.list(this.base+'/access/apps')).find(x=>x.name===this.names.access),()=>this.api.request(this.base+'/access/apps',{method:'POST',body:{
      name:this.names.access,domain:this.profile.domain.hostname,type:'self_hosted',session_duration:'12h',
      oauth_configuration:{enabled:true,dynamic_client_registration:{enabled:true,allow_any_on_localhost:true,allow_any_on_loopback:true},grant:{access_token_lifetime:'5m',session_duration:'12h'}},
      policies:[{name:this.names.access+'-allow',decision:'allow',precedence:1,include:this.config.allowedEmails.map(email=>({email:{email}}))}],
    }}));
    assert(access.aud,'Access has no audience');this.state.resources.access.aud=access.aud;await this.save();
    await this.render(false);
    await this.run('build',[]);
    await this.deploy('gateway');
    await this.deploy('app');
    for(const name of ['OPENCODE_GO_API_KEY','OPENCODE_API_KEY'])if(this.environment[name]&&!this.state.steps[name]){
      await this.workerSecret(this.names.app,name,this.environment[name]);this.state.steps[name]=true;await this.save();
    }
    await this.render(true);await this.deploy('app');
    const domain=(await this.api.list(this.base+'/workers/domains')).find(x=>x.hostname===this.profile.domain.hostname);
    assert(domain?.id&&domain.service===this.names.app,'Custom domain did not attach to the installed app');
    if(this.state.resources.domain?.id)assert.equal(domain.id,this.state.resources.domain.id,'Custom domain identity changed');
    this.state.resources.domain={status:'ready',id:domain.id};this.state.steps.installed=true;await this.save();
    return this.doctor({authenticate:verify});
  }
  async doctor({authenticate=true}={}){
    if(!this.state)await this.load();
    const app=await this.api.request(this.base+'/workers/scripts/'+this.names.app+'/settings');
    const services=app.bindings??[];
    assert(services.some(x=>x.name==='TOOL_PACKS'&&x.service===this.names.gateway&&x.entrypoint==='ToolPackGateway'),'Package service binding mismatch');
    assert(!services.some(x=>x.name==='TOOLBOX'||x.name==='KALI_MCP_TOKEN'),'Package installation must not bind Kali');
    assert(services.some(x=>x.name==='ARTIFACTS'&&x.namespace===this.names.namespace),'Artifacts binding mismatch');
    for(const key of ['gateway','app'])assert.equal((await this.api.request(this.base+'/workers/scripts/'+this.names[key]+'/subdomain')).enabled,false,'Unexpected public workers.dev endpoint');
    await this.recordContainer();
    const access=await this.api.request(this.base+'/access/apps/'+this.state.resources.access.id);
    assert.equal(access.domain,this.profile.domain.hostname,'Access domain changed');
    assert.equal(access.aud,this.state.resources.access.aud,'Access audience changed');
    const policies=await this.api.list(this.base+'/access/apps/'+access.id+'/policies');
    assert(policies.length===1&&policies[0].decision==='allow','Access policy changed');
    assert.deepEqual(policies[0].include,this.config.allowedEmails.map(email=>({email:{email}})),'Operator policy changed');
    const anon=await this.probe('/v1/runs');
    assert([302,303,401,403].includes(anon.status),'Anonymous API access was not rejected');
    if(authenticate)assert.equal((await this.probe('/v1/runs',true)).status,200,'Owner authentication failed');
    return {status:authenticate?'verified-package-installation':'provisioned-awaiting-owner-verification',appUrl:this.state.appUrl,toolPacks:11,kaliInstalled:false,modelCalls:0,scannerCalls:0};
  }
  async uninstall(){throw Error('Package installation removal requires an explicit reviewed package-resource teardown; legacy uninstall is not applicable');}
}

