import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { CloudflareApi, Installer, STOCK_DIGEST, configuration, names, plan, privateJson, readJson, withStateLock } from './lib/private-install.mjs';
import { regctlPlatform, REGCTL_HASHES } from './lib/private-image.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = { schemaVersion: 1, accountId: 'a'.repeat(32), instance: 'isolated-test', accessTeamDomain: 'https://fixture.cloudflareaccess.com', allowedEmails: ['owner@example.com'] };
const lifecycle = () => ({ runs: { active: 0, archived: 0, trashed: 0, purging: 0, total: 0 }, activeAttempt: false, pendingPublications: 0, preparingInput: false, pendingPurges: 0, safeToUninstall: true });

async function fixture(t) {
  const parent = await mkdtemp(join(tmpdir(), 'pentcloud-install-test-'));
  const directory = join(parent, 'state'); await mkdir(directory);
  t.after(() => rm(parent, { recursive: true, force: true }));
  const n = names(config), base = `/accounts/${config.accountId}`;
  const remote = { onboarding:{version:1,targets:[],credentials:[],defaults:[],definitions:[]},definitionBodies:new Map(),appCalls:[], namespace: null, store: [], secrets: [], access: [], serviceTokens: [], scripts: [], workflows: [], containers: [], settings: {}, routes: {}, prep: 'ready', calls: [], commands: [], runs: [], lifecycle: lifecycle() };
  const api = {
    async list(path) {
      if (path.endsWith('/workers/scripts')) return remote.scripts;
      if (path.endsWith('/workflows')) return remote.workflows;
      if (path.endsWith('/access/identity_providers')) return [{ id: 'otp', type: 'onetimepin' }];
      if (path.endsWith('/access/apps')) return remote.access;
      if (path.endsWith('/access/apps/access-fixture/policies')) return remote.access[0].policies;
      if (path.endsWith('/access/service_tokens')) return remote.serviceTokens;
      if (path.endsWith('/secrets_store/stores')) return remote.store;
      if (path.endsWith('/secrets')) return remote.secrets;
      if (path.endsWith('/repos')) return [];
      throw new Error(`Unmocked list ${path}`);
    },
    async request(path, options = {}) {
      remote.calls.push({ path, ...options });
      const method = options.method ?? 'GET';
      if (path === base) return { id: config.accountId };
      if (path.endsWith('/workers/subdomain')) return { subdomain: 'fixture' };
      if (path.endsWith('/access/organizations')) return { auth_domain: 'fixture.cloudflareaccess.com' };
      if (path.endsWith('/containers/applications')) return remote.containers;
      if (path.endsWith('/containers/image-preparations')) return { status: remote.prep, artifact_digest: remote.prep === 'ready' ? 'sha256:fixture' : undefined };
      if (method === 'DELETE') {
        if(path.includes('/access/apps/access-fixture/policies/')){remote.access[0].policies=remote.access[0].policies.filter(p=>!path.endsWith('/'+p.id));return null;}
        if (path.includes('/workers/scripts/')) remote.scripts = remote.scripts.filter((script) => !path.endsWith(`/${script.id}`));
        if (path.endsWith(`/artifacts/namespaces/${n.namespace}`)) remote.namespace = null;
        if (path.includes('/secrets_store/stores/') && path.includes('/secrets/')) remote.secrets = remote.secrets.filter((item) => !path.endsWith(`/${item.id}`));
        else if (path.includes('/secrets_store/stores/')) remote.store = remote.store.filter((item) => !path.endsWith(`/${item.id}`));
        if (path.includes('/access/apps/')) remote.access = remote.access.filter((item) => !path.endsWith(`/${item.id}`));
        if (path.includes('/access/service_tokens/')) remote.serviceTokens = remote.serviceTokens.filter((item) => !path.endsWith(`/${item.id}`));
        if (path.includes('/containers/applications/')) remote.containers = remote.containers.filter((item) => !path.endsWith(`/${item.id}`));
        return null;
      }
      if (path.endsWith(`/artifacts/namespaces/${n.namespace}`)) return remote.namespace;
      if (path.endsWith('/artifacts/namespaces')) return remote.namespace = { id: n.namespace, namespace: n.namespace };
      if (path.endsWith('/secrets_store/stores')) { const store = { id: 'store-fixture', name: options.body.name }; remote.store.push(store); return store; }
      if (path.endsWith('/access/service_tokens')) { const token = { id: 'service-fixture', name: options.body.name, client_id: 'fixture-access-id', client_secret: 'fixture-access-secret' }; remote.serviceTokens.push({ id: token.id, name: token.name }); return token; }
      if (path.endsWith('/access/apps') && method === 'POST') { const app = { ...options.body, id: 'access-fixture', aud: 'aud-fixture' }; remote.access.push(app); return app; }
      if (path.endsWith('/access/apps/access-fixture')) {if(method==='PUT')Object.assign(remote.access[0],options.body);return remote.access[0];}
      if (path.includes('/secrets_store/') && path.endsWith('/secrets')) { const created = options.body.map((item) => ({ id: 'secret-fixture', name: item.name })); remote.secrets.push(...created); return created; }
      const worker = path.match(/\/workers\/scripts\/([^/]+)\/(settings|subdomain|secrets)$/);
      if (worker) {
        if (worker[2] === 'settings') return remote.settings[worker[1]];
        if (worker[2] === 'secrets') {remote.workerSecrets??={};const values=remote.workerSecrets[worker[1]]??=[];if(method==='PUT'&&!values.some(v=>v.name===options.body.name))values.push({name:options.body.name,type:'secret_text'});return method==='GET'?values:{};}
        if (method === 'POST') remote.routes[worker[1]] = options.body;
        return remote.routes[worker[1]] ?? { enabled: false };
      }
      throw new Error(`Unmocked request ${method} ${path}`);
    },
  };
  const run = async (kind, args) => {
    remote.commands.push({ kind, args });
    if (args.includes('list') && args.includes('images')) return Buffer.from('[]');
    if (kind === 'wrangler' && args[0] === 'deploy' || kind === 'node' && args[0].endsWith('deploy-native-app.mjs')) {
      const file = args[args.indexOf('--config') + 1], worker = await readJson(file);
      if(worker.name===n.gateway&&worker.services?.some(s=>s.entrypoint==='TargetEgress'))assert(remote.appSupportsTargetEgress,'TargetEgress provider must be upgraded before its consumer');
      if(worker.name===n.app)remote.appSupportsTargetEgress=true;
      if (!remote.scripts.some((script) => script.id === worker.name)) remote.scripts.push({ id: worker.name });
      remote.settings[worker.name] = { bindings: [...(worker.secrets_store_secrets??[]).map((item) => ({ ...item, name: item.binding })),
        ...(worker.services ?? []).map((item) => ({ ...item, name: item.binding })), ...(worker.artifacts ?? []).map((item) => ({ ...item, name: item.binding })),
        ...(worker.durable_objects?.bindings ?? []).map((item) => ({ ...item, namespace_id: 'namespace-' + item.name }))] };
      if (worker.containers && !remote.containers.length) remote.containers.push({ id: 'container-fixture', name: n.container, durable_objects: { namespace_id: 'namespace-KALI_TOOLBOX' } });
      remote.routes[worker.name] = { enabled: worker.workers_dev };
    }
    return Buffer.alloc(0);
  };
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname;
    remote.appCalls.push({path,method:options.method??'GET',body:options.body});
    if (!options.headers.get?.("cf-access-token")) return Response.json({}, { status: 401 });
    if (path.endsWith('/lifecycle/prepare-uninstall')) { if(options.body&&JSON.parse(options.body).deleteOnboarding===true&&remote.lifecycle.canDeleteOnboarding){remote.lifecycle.safeToUninstall=true;} remote.lifecycle.quiesced = true; return Response.json({ safeToUninstall: remote.lifecycle.safeToUninstall, quiesced: true }); }
    if (path.endsWith('/lifecycle')) return Response.json(remote.lifecycle);
    if (path.endsWith('/runs')) return Response.json({ runs: remote.runs });
    if(path.endsWith('/onboarding'))return Response.json(remote.onboarding);
    if(path.endsWith('/onboarding/export'))return Response.json(remote.onboarding);
    if(path.endsWith('/onboarding/metadata.import')){remote.onboarding=JSON.parse(options.body).data;return Response.json({imported:true});}
    if(path.includes('/targets/')&&path.endsWith('/definition')){const id=path.split('/').at(-2);if(options.method==='POST'){remote.definitionBodies.set(id,Buffer.from(options.body));return Response.json({version:1},{status:201});}return new Response(remote.definitionBodies.get(id));}
    throw new Error('Unmocked app request');
  };
  const installer = new Installer({ config, stateDirectory: directory, root, api, run, fetcher, session:async()=>"fixture-access-session",
    environment: { OPENCODE_GO_API_KEY: 'fixture-own-model-key' },
    importImage: async () => ({ exactManifestBytes: true, configBlobDigestVerified: true }) });
  return { installer, remote, directory, n };
}

async function legacy(f){
  const {installer,remote,directory,n}=f;
  remote.store=[{id:'legacy-store',name:n.store}];
  remote.secrets=[{id:'legacy-secret',name:n.operatorSecret,comment:`PentCloud installation ${installer.state.installationId}`}];
  remote.serviceTokens=[{id:'legacy-service',name:n.serviceToken}];
  Object.assign(installer.state.resources,{store:{id:'legacy-store',status:'ready'},operatorSecret:{id:'legacy-secret',status:'ready'},serviceToken:{id:'legacy-service',status:'ready'}});
  remote.access[0].policies.push({id:'legacy-policy',name:n.access+'-installer',decision:'non_identity',include:[{service_token:{token_id:'legacy-service'}}]});
  delete remote.access[0].oauth_configuration;
  await privateJson(join(directory,'credentials.json'),{operator:'legacy-private-operator',mcp:'legacy-private-mcp',accessClientId:'legacy-client',accessClientSecret:'legacy-private-access'});
  await installer.save();
}
test('installation wires private target egress after the app exists and keeps the gateway unexposed',async t=>{
 const f=await fixture(t);await f.installer.install();
 const binding=f.remote.settings[f.n.gateway].bindings.find(item=>item.name==='TARGET_EGRESS');
 assert.deepEqual(binding,{binding:'TARGET_EGRESS',name:'TARGET_EGRESS',service:f.n.app,entrypoint:'TargetEgress'});
 assert.equal(f.remote.routes[f.n.gateway].enabled,false);
});
test('upgrades the existing app provider before adding its new gateway capability',async t=>{
 const f=await fixture(t);await f.installer.install();f.remote.appSupportsTargetEgress=false;
 await f.installer.install({upgrade:true});assert.equal(f.remote.appSupportsTargetEgress,true);
});
test('upgrade proves native access before retiring only owned legacy credentials, preserving MCP and the Store',async t=>{
  const f=await fixture(t);await f.installer.install();await legacy(f);
  const {installer,remote,directory}=f;
  const written=remote.calls.filter(c=>c.method==='PUT'&&c.path.endsWith('/secrets')).length;
  let observed=false;
  installer.session=async()=>{assert.equal(remote.serviceTokens.length,1);observed=true;installer.session=async()=>'fixture-access-session';return 'fixture-access-session';};
  await installer.install({upgrade:true});
  assert(observed);assert.equal(remote.serviceTokens.length,0);assert.equal(remote.secrets.length,0);
  assert.equal(remote.store.length,1);assert.equal(remote.access[0].policies.length,1);
  assert.equal(remote.calls.filter(c=>c.method==='PUT'&&c.path.endsWith('/secrets')).length,written);
  assert.equal(await readJson(join(directory,'credentials.json'),null),null);
});
test('failed native login leaves legacy recovery credentials and remote secrets in place',async t=>{
  const f=await fixture(t);await f.installer.install();await legacy(f);
  f.installer.session=async()=>{throw Error('login required');};
  await assert.rejects(f.installer.install({upgrade:true}),/login required/);
  assert.equal(f.remote.serviceTokens.length,1);assert.equal(f.remote.secrets.length,1);
  assert(await readJson(join(f.directory,'credentials.json')));
});
test('upgrade refuses unrelated machine policy rather than overwriting or deleting it',async t=>{
  const f=await fixture(t);await f.installer.install();await legacy(f);
  f.remote.access[0].policies[1].include.push({service_token:{token_id:'unrelated'}});
  f.remote.calls.length=0;
  await assert.rejects(f.installer.install({upgrade:true}),/Unrelated machine policy/);
  assert(!f.remote.calls.some(c=>c.method==='DELETE'));
});
test('legacy retirement inventories external Access apps and Worker bindings before any deletion',async t=>{
  for(const kind of ['access-token','access-any-token','access-group','worker-secret','unsettled-runtime'])await t.test(kind,async t=>{
    const f=await fixture(t);await f.installer.install();await legacy(f);
    const list=f.installer.api.list,request=f.installer.api.request;
    f.installer.api.list=async path=>{
      if(path.endsWith('/access/apps')&&kind.startsWith('access-'))return [...f.remote.access,{id:'external-app'}];
      if(path.endsWith('/external-app/policies'))return [{id:'external-policy',include:[kind==='access-any-token'?{any_valid_service_token:{}}:kind==='access-group'?{group:{id:'external-group'}}:{service_token:{token_id:'legacy-service'}}]}];
      if(path.endsWith('/access/groups'))return [{id:'external-group',include:[{service_token:{token_id:'legacy-service'}}]}];
      if(path.endsWith('/workers/scripts')&&kind==='worker-secret')return [...f.remote.scripts,{id:'external-worker'}];
      return list(path);
    };
    f.installer.api.request=async(path,options)=>path.endsWith('/external-worker/settings')?{bindings:[{type:'secrets_store_secret',store_id:'legacy-store',secret_name:f.n.operatorSecret}]}:request(path,options);
    if(kind==='unsettled-runtime')f.remote.lifecycle.activeAttempt=true;
    f.remote.calls.length=0;
    await assert.rejects(f.installer.install({upgrade:true}),/Legacy credentials retained/);
    assert(!f.remote.calls.some(c=>c.method==='DELETE'));
    assert.equal(f.remote.serviceTokens.length,1);assert.equal(f.remote.secrets.length,1);
    assert(await readJson(join(f.directory,'credentials.json')));
    assert(f.installer.state.legacyCredentialConsumers.length>0);
  });
});
test('lost MCP write reply resumes from native secret metadata without rotation',async t=>{
  const f=await fixture(t),request=f.installer.api.request;let lost=false;
  f.installer.api.request=async(path,options={})=>{const result=await request(path,options);if(!lost&&options.method==='PUT'&&options.body.name==='KALI_MCP_TOKEN'){lost=true;throw Error('lost MCP write reply');}return result;};
  await assert.rejects(f.installer.install(),/lost MCP/);await f.installer.install();
  assert.equal(f.remote.calls.filter(c=>c.method==='PUT'&&c.body.name==='KALI_MCP_TOKEN').length,1);
});

test('configuration requires an explicit account and owner policy, rejects secrets/overrides', () => {
  assert.throws(() => configuration({ ...config, instance: '../production' }));
  assert.throws(() => configuration({ ...config, accountId: '' }));
  assert.throws(() => configuration({ ...config, allowedEmails: [] }));
  assert.throws(() => configuration({ ...config, OPENCODE_GO_API_KEY: 'secret' }));
  assert.throws(() => configuration({ ...config, image: 'registry.example/owner' }));
  const output = JSON.stringify(plan(configuration(config)));
  for (const forbidden of ['Doppler', 'AWS', 'pentagi-']) assert(!output.includes(forbidden));
  assert.equal(JSON.parse(output).accountId, config.accountId);
  assert(output.includes(STOCK_DIGEST));
});

test('a fresh installation can reach authenticated setup without a model key', async t => {
  const {installer,remote}=await fixture(t);
  delete installer.environment.OPENCODE_GO_API_KEY;
  const result=await installer.install();
  assert.equal(result.status,'verified-resource-and-auth-checks');
  assert.equal(installer.state.steps.model,undefined);
  assert(!remote.commands.some(c=>JSON.stringify(c).includes('OPENCODE_GO_API_KEY')));
  assert.equal(result.modelCalls,0);
  assert.equal(result.scannerCalls,0);
});

test('target export and restore preserve API definition bytes and require key re-entry',async t=>{
  const first=await fixture(t);await first.installer.install();
  const bytes=Buffer.from('{"openapi":"3.1.0","paths":{}}');
  const {createHash}=await import('node:crypto'),sha256=createHash('sha256').update(bytes).digest('hex');
  first.remote.onboarding={version:1,targets:[{id:'owned-api',kind:'api',name:'Owned API',url:'https://api.example/v1/',revision:1}],
    credentials:[{id:'key-one',purpose:'model',label:'OpenCode',version:1,missing:true}],defaults:[],definitions:[{targetId:'owned-api',version:1,name:'openapi.json',sha256,size:bytes.length}]};
  first.remote.definitionBodies.set('owned-api',bytes);
  const output=join(dirname(first.directory),'targets-export.json');
  await first.installer.exportInstallation(output);
  const data=await readJson(output);
  assert.equal(data.onboarding.credentials[0].missing,true);
  assert.deepEqual(await readFile(join(output+'.git-bundles',data.definitionFiles[0].file)),bytes);
  const second=await fixture(t);await second.installer.install();
  const restored=await second.installer.importTargets(output);
  assert.equal(restored.credentialsNeedReentry,true);
  assert.equal(restored.restoredExecutionHistory,false);
  assert.deepEqual(second.remote.definitionBodies.get('owned-api'),bytes);
});

test('destructive uninstall explicitly includes only this installation onboarding data',async t=>{
  const {installer,remote}=await fixture(t);await installer.install();
  remote.lifecycle.safeToUninstall=false;remote.lifecycle.canDeleteOnboarding=true;
  await installer.uninstall({data:'delete',confirm:config.instance});
  const call=remote.appCalls.find(c=>c.path.endsWith('/lifecycle/prepare-uninstall'));
  assert.deepEqual(JSON.parse(call.body),{deleteOnboarding:true});
});
test('API failure discards echoed write-only values and rejects cross-account URL escapes', async () => {
  const api = new CloudflareApi('operator-secret', async () => Response.json({ success: false, errors: [{ code: 1000, message: 'model-secret operator-secret' }] }, { status: 403 }));
  await assert.rejects(api.request('/accounts/a/secrets', { method: 'POST', body: { value: 'model-secret' } }), (error) => !error.message.includes('secret') && error.message.includes('403'));
  await assert.rejects(api.request('https://attacker.example/accounts/a'));
});
test('cursor pagination never omits repositories or loops on repeated cursors', async () => {
  let index = 0;
  const api = new CloudflareApi('fixture', async () => Response.json({ result: [{ name: ++index }], result_info: { cursor: index === 1 ? 'next' : null } }));
  assert.equal((await api.list('/accounts/a/repos', { cursor: true })).length, 2);
  const bad = new CloudflareApi('fixture', async () => Response.json({ result: [], result_info: { cursor: 'same' } }));
  await assert.rejects(bad.list('/accounts/a/repos', { cursor: true }), /repeated/);
});
test('owned resource creation refuses uncertain creates and unrelated collisions', async (t) => {
  const { installer } = await fixture(t);
  await installer.load({ create: true });
  let found = null;
  await assert.rejects(installer.owned('fixture', async () => found, async () => { found = { id: 'ours' }; throw new Error('connection lost'); }));
  await assert.rejects(installer.owned('fixture', async () => found, async () => assert.fail()), /manual reconciliation/);
  await assert.rejects(installer.owned('unrelated', async () => ({ id: 'other' }), async () => assert.fail()), /Refusing to adopt/);
});
test('fresh install is ordered, private until configured and repeatable without rotating secrets', async (t) => {
  const { installer, remote, directory, n } = await fixture(t);
  const result = await installer.install();
  assert.equal(result.modelCalls, 0); assert.equal(result.scannerCalls, 0); assert.equal(result.runCount, 0);
  assert.equal(await readJson(join(directory, 'credentials.json'),null),null);
  const first = remote.commands.filter((item) => item.kind === 'wrangler' && item.args[0] === 'deploy')[0];
  assert(first.args.includes(join(directory, 'gateway.wrangler.json')));
  const app = await readJson(join(directory, 'app.wrangler.json'));
  assert.equal(app.vars.ARTIFACTS_NAMESPACE, n.namespace);
  assert.equal(Object.hasOwn(app.vars,'OPENCODE_BYOK_PROVIDERS'),false,'fresh installs must not inherit personal provider connections');
  assert.equal(app.workers_dev, true);
  assert.deepEqual(app.assets.run_worker_first, ['/*'], 'Every hosted UI response must pass through its privacy policy');
  assert(!JSON.stringify(app).includes('fixture-own-model-key'));
  const manifest = await readFile(join(directory, 'manifest.json'), 'utf8');
  assert(!manifest.includes('fixture-access-session'));
  assert.equal(remote.serviceTokens.length,0); assert.equal(remote.secrets.length,0);
  assert.equal(app.secrets_store_secrets,undefined);
  assert.equal(remote.access[0].oauth_configuration.enabled,true);
  const created = remote.calls.filter((item) => item.method === 'POST' && (item.path.endsWith('/stores') || item.path.endsWith('/access/apps'))).length;
  await installer.install({ upgrade: true });
  assert.equal(await readJson(join(directory, 'credentials.json'),null),null);
  assert.equal(remote.calls.filter((item) => item.method === 'POST' && (item.path.endsWith('/stores') || item.path.endsWith('/access/apps'))).length, created);
  assert.equal(remote.calls.filter(c=>c.method==='PUT'&&c.path.endsWith('/secrets')&&c.body.name==='KALI_MCP_TOKEN').length,1);
});
test('pending/failed image preparation blocks deploy and resumes from exact copied image', async (t) => {
  const { installer, remote } = await fixture(t);
  remote.prep = 'pending';
  await assert.rejects(installer.install(), /preparation is pending/);
  assert(!remote.commands.some((item) => item.args[0] === 'deploy'));
  assert.equal(installer.state.image.copied, true);
  installer.importImage = async () => assert.fail('Already copied stock bytes must be reused');
  remote.prep = 'error'; await assert.rejects(installer.install(), /preparation is error/);
  remote.prep = 'ready'; await installer.install();
});
test('existing Worker and manifest account drift fail closed before mutation', async (t) => {
  const { installer, remote, directory } = await fixture(t);
  remote.scripts.push({ id: installer.names.app });
  await assert.rejects(installer.install(), /Refusing to overwrite/);
  assert(!remote.calls.some((item) => item.method === 'POST'));
  const saved = await readJson(join(directory, 'manifest.json'));
  saved.config.accountId = 'b'.repeat(32); await privateJson(join(directory, 'manifest.json'), saved);
  await assert.rejects(installer.load(), /different account/);
});
test('uninstall requires exact confirmation and keeps all data on retain', async (t) => {
  const { installer, remote } = await fixture(t); await installer.install();
  await assert.rejects(installer.uninstall({ data: 'delete', confirm: 'other' }));
  await assert.rejects(installer.uninstall({ confirm: config.instance }));
  remote.calls.length = 0;
  assert.equal((await installer.uninstall({ data: 'retain', confirm: config.instance })).status, 'disabled');
  assert(!remote.calls.some((item) => item.method === 'DELETE'));
  assert.equal(Object.values(installer.state.resources).filter((item) => item.status === 'ready').length, 5);
});
test('destructive uninstall refuses archived/trash/ownership state and quiesces before scoped teardown', async (t) => {
  const { installer, remote } = await fixture(t); await installer.install();
  remote.lifecycle.runs.trashed = 1; remote.lifecycle.runs.total = 1; remote.lifecycle.safeToUninstall = false;
  remote.runs = [{ id: 'trashed', lifecycle: 'trashed' }]; remote.calls.length = 0;
  await assert.rejects(installer.uninstall({ data: 'delete', confirm: config.instance }), /Purge every run/);
  assert(!remote.calls.some((item) => item.method === 'DELETE'));
  remote.lifecycle = lifecycle(); remote.runs = [];
  const result = await installer.uninstall({ data: 'delete', confirm: config.instance });
  assert.equal(result.status, 'removed'); assert.equal(remote.lifecycle.quiesced, true);
  const deletions = remote.calls.filter((item) => item.method === 'DELETE');
  assert(deletions.length > 5);
  assert(deletions.every((item) => item.path.startsWith(`/accounts/${config.accountId}/`)));
  assert(deletions.every((item) => !item.path.includes('force=')));
});
test('metadata export contains ownership/inventory but no credentials and declares backup limits', async (t) => {
  const { installer, directory } = await fixture(t); await installer.install();
  const output = join(dirname(directory), 'export.json');
  const report = await installer.exportInstallation(output);
  assert.equal(report.completeSystemBackup, false);
  const exported = await readFile(output, 'utf8');
  assert(!exported.includes('fixture-access-session'));
  assert(exported.includes('Not a complete system backup'));
});
test('shared account Store is reused without adopting unrelated secrets or owning its deletion', async (t) => {
  const { installer, remote } = await fixture(t);
  remote.store.push({ id: 'shared-account-store', name: 'existing-platform-store' });
  remote.secrets.push({ id: 'unrelated-secret', name: 'other-application-key' });
  await installer.install();
  assert.equal(installer.state.resources.store, undefined);
  assert(!remote.calls.some((item) => item.method === 'POST' && item.path.endsWith('/secrets_store/stores')));
  remote.calls.length = 0;
  await installer.uninstall({ data: 'delete', confirm: config.instance });
  assert(!remote.calls.some((item) => item.method === 'DELETE' && item.path.endsWith('/secrets_store/stores/shared-account-store')));
  assert(!remote.calls.some((item) => item.method === 'DELETE' && item.path.includes('unrelated-secret')));
});
test('Git export preserves real commit objects and revokes its scoped read token without persisting auth', async (t) => {
  const { installer, directory } = await fixture(t); await installer.install();
  const repository = join(directory, 'fixture-git');
  const git = (args, env) => execFileSync('git', args, { env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', repository]);
  await writeFile(join(repository, 'proof.txt'), 'isolated export fixture\n');
  git(['-C', repository, 'add', 'proof.txt']);
  git(['-C', repository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Export fixture']);
  const head = git(['-C', repository, 'rev-parse', 'HEAD']).toString().trim();
  const metadata = await installer.exportMetadata();
  metadata.repositories = [{ id: 'repo-fixture', name: 'run-fixture', default_branch: 'master', remote: `https://${config.accountId}.artifacts.cloudflare.net/git/${installer.names.namespace}/run-fixture.git` }];
  installer.exportMetadata = async () => metadata;
  let revoked = false;
  installer.api.request = async (path, options) => {
    if (options.method === 'POST') { assert.deepEqual(options.body, { repo: 'run-fixture', scope: 'read', ttl: 900 }); return { id: 'read-token-fixture', plaintext: 'ephemeral-git-fixture-secret' }; }
    assert(path.endsWith('/tokens/read-token-fixture')); revoked = true;
  };
  installer.run = async (kind, args, options) => {
    assert.equal(kind, 'git');
    assert(!args.some((item) => item.includes('ephemeral-git-fixture-secret')));
    const safe = args.map((arg) => arg === metadata.repositories[0].remote ? repository : arg);
    return git(safe, options.env);
  };
  const output = join(dirname(directory), 'git-export.json');
  await installer.exportInstallation(output);
  assert.equal(revoked, true);
  const exported = await readJson(output), bundle = exported.gitBundles[0];
  assert(bundle.refs.some((ref) => ref.endsWith(head)));
  assert.match(bundle.sha256, /^[a-f0-9]{64}$/);
  const restored = join(directory, 'restored');
  git(['clone', bundle.file, restored]);
  assert.equal(git(['-C', restored, 'rev-parse', head + '^{commit}']).toString().trim(), head);
  assert(!(await readFile(output, 'utf8')).includes('ephemeral-git-fixture-secret'));
});
test('local operation lock prevents simultaneous manifests and is released after failure', async (t) => {
  const { directory } = await fixture(t);
  await withStateLock(directory, async () => { await assert.rejects(withStateLock(directory, async () => {}), /operation.lock/); });
  await assert.rejects(withStateLock(directory, async () => { throw new Error('fixture'); }));
  await withStateLock(directory, async () => {});
  await writeFile(join(directory, 'unrelated.txt'), 'preserve');
  await assert.rejects(withStateLock(directory, async () => assert.fail()), /unrelated files/);
});
test('portable stock transfer supports four pinned binaries, rejects unsupported platforms', () => {
  assert.equal(Object.keys(REGCTL_HASHES).length, 4);
  assert.equal(regctlPlatform('darwin', 'arm64'), 'darwin-arm64');
  assert.equal(regctlPlatform('linux', 'x64'), 'linux-amd64');
  assert.throws(() => regctlPlatform('win32', 'x64'));
});
test('teardown resumes each lost successful DELETE response using the durable authorization journal', async (t) => {
  for (const key of ['namespace', 'access', 'container', 'app']) await t.test(key, async (t) => {
    const { installer, remote, directory } = await fixture(t); await installer.install();
    const request = installer.api.request;
    const id = installer.state.resources[key].id;
    let lost = false;
    installer.api.request = async (path, options = {}) => {
      const result = await request(path, options);
      if (!lost && options.method === 'DELETE' && path.endsWith(`/${id}`)) { lost = true; throw new Error('successful DELETE response lost'); }
      return result;
    };
    await assert.rejects(installer.uninstall({ data: 'delete', confirm: config.instance }), /response lost/);
    assert.equal((await readJson(join(directory, 'manifest.json'))).steps.deleteAuthorized, true);
    assert.equal((await installer.uninstall({ data: 'delete', confirm: config.instance })).status, 'removed');
    assert(!remote.calls.some((item) => item.path.includes('/undefined')));
  });
});
test('teardown reconciles a lost image-delete response through its exact owned tag listing', async (t) => {
  const { installer } = await fixture(t); await installer.install();
  const run = installer.run; let present = true;
  installer.run = async (kind, args) => {
    if (args.includes('images') && args.includes('list')) return Buffer.from(JSON.stringify(present ? [{ name: installer.names.imageRepository, tags: ['stock'] }] : []));
    if (args.includes('images') && args.includes('delete')) { present = false; throw new Error('image DELETE response lost'); }
    return run(kind, args);
  };
  await assert.rejects(installer.uninstall({ data: 'delete', confirm: config.instance }), /response lost/);
  assert.equal((await installer.uninstall({ data: 'delete', confirm: config.instance })).status, 'removed');
});
test('failed gateway deployment cleans claims both before Worker creation and before Container creation', async (t) => {
  for (const createdWorker of [false, true]) await t.test(String(createdWorker), async (t) => {
    const { installer, remote } = await fixture(t);
    const run = installer.run;
    installer.run = async (kind, args) => {
      if (kind === 'wrangler' && args[0] === 'deploy') {
        if (createdWorker) await run(kind, args);
        remote.containers = [];
        throw new Error('gateway deploy failed before Container creation');
      }
      return run(kind, args);
    };
    await assert.rejects(installer.install(), /gateway deploy failed/);
    if (createdWorker) {
      await assert.rejects(installer.uninstall({ data: 'delete', confirm: config.instance }), /manual reconciliation/);
      assert(remote.scripts.some(item => item.id === installer.names.gateway));
    } else {
      assert.equal((await installer.uninstall({ data: 'delete', confirm: config.instance })).status, 'removed');
      assert.equal(remote.namespace, null); assert.equal(remote.secrets.length, 0); assert.equal(remote.access.length, 0); assert.equal(remote.serviceTokens.length, 0);
    }
  });
});
test('lost Access/token create responses require manual reconciliation before deletion', async (t) => {
  for (const endpoint of ['/access/apps']) await t.test(endpoint, async (t) => {
    const { installer, remote } = await fixture(t);
    const request = installer.api.request; let lost = false;
    installer.api.request = async (path, options = {}) => {
      const result = await request(path, options);
      if (!lost && options.method === 'POST' && path.endsWith(endpoint)) { lost = true; throw new Error('create response lost'); }
      return result;
    };
    await assert.rejects(installer.install(), /create response lost/);
    remote.calls.length = 0;
    await assert.rejects(installer.uninstall({ data: 'delete', confirm: config.instance }), /manual reconciliation/);
    assert(!remote.calls.some((item) => item.method === 'DELETE'));
    assert(endpoint.endsWith('apps') ? remote.access.length : remote.serviceTokens.length);
  });
});
test('teardown refuses a resolved ready ownership ID that drifted to another resource', async (t) => {
  const { installer, remote } = await fixture(t); await installer.install();
  remote.access[0].id = 'replacement-resource'; remote.calls.length = 0;
  await assert.rejects(installer.uninstall({ data: 'delete', confirm: config.instance }), /identity changed/);
  assert(!remote.calls.some((item) => item.method === 'DELETE'));
});

test('uncertain creates and colliding pending claims never adopt or delete by name', async (t) => {
  for (const endpoint of ['/artifacts/namespaces', '/access/apps']) {
    for (const scenario of ['lost response', 'collision after failed create']) await t.test(`${endpoint}: ${scenario}`, async (t) => {
      const { installer, remote } = await fixture(t);
      const request = installer.api.request; let injected = false, saved;
      installer.api.request = async (path, options = {}) => {
        if (!injected && options.method === 'POST' && path.endsWith(endpoint)) {
          injected = true; saved = { path, options };
          if (scenario === 'lost response') await request(path, options);
          throw new Error('injected uncertain create');
        }
        return request(path, options);
      };
      await assert.rejects(installer.install(), /injected uncertain create/);
      if (scenario === 'collision after failed create') await request(saved.path, saved.options);
      remote.calls.length = 0;
      await assert.rejects(installer.install(), /manual reconciliation/);
      await assert.rejects(installer.uninstall({ data: 'delete', confirm: config.instance }), /manual reconciliation/);
      assert(!remote.calls.some(call => call.method === 'DELETE'));
    });
  }
});
test('exports refuse state paths, symlink aliases, existing outputs and bundle directories', async (t) => {
  const { installer, directory } = await fixture(t); await installer.install();
  const parent = dirname(directory), alias = join(parent, 'state-alias');
  await symlink(directory, alias);
  const manifest = await readFile(join(directory, 'manifest.json'));
  const credentials = await readJson(join(directory, 'credentials.json'),null);
  for (const name of ['manifest.json', 'credentials.json', 'new.json']) {
    for (const base of [directory, alias]) await assert.rejects(installer.exportInstallation(join(base, name)), /outside the state/);
  }
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), manifest);
  assert.deepEqual(await readJson(join(directory, 'credentials.json'),null), credentials);
  const existing = join(parent, 'existing.json'); await writeFile(existing, 'preserve');
  await assert.rejects(installer.exportInstallation(existing), /EEXIST/);
  assert.equal(await readFile(existing, 'utf8'), 'preserve');
  const output = join(parent, 'bundle-collision.json'), bundle = `${output}.git-bundles`;
  await mkdir(bundle); await writeFile(join(bundle, 'keep'), 'preserve');
  await assert.rejects(installer.exportInstallation(output), /EEXIST/);
  assert.equal(await readFile(join(bundle, 'keep'), 'utf8'), 'preserve');
  const aliasBundle = join(parent, 'bundle-symlink.json');
  await symlink(directory, `${aliasBundle}.git-bundles`);
  await assert.rejects(installer.exportInstallation(aliasBundle), /EEXIST/);
  assert.deepEqual(await readFile(join(directory, 'manifest.json')), manifest);
});

test('pending Worker deploys and image copies reject existing colliding names', async (t) => {
  for (const key of ['app', 'gateway']) await t.test(key, async (t) => {
    const { installer, remote } = await fixture(t);
    await installer.load({create:true});
    installer.state.resources[key]={status:'pending',id:installer.names[key]}; await installer.save();
    remote.scripts.push({id:installer.names[key]});
    await assert.rejects(installer.install(), /manual reconciliation/);
    remote.calls.length=0;
    await assert.rejects(installer.uninstall({data:'delete',confirm:config.instance}), /manual reconciliation/);
    assert(!remote.calls.some(call=>call.method==='DELETE'));
  });
  await t.test('image', async t=>{
    const { installer }=await fixture(t);
    await installer.load({create:true});
    installer.state.image={status:'copy-pending'}; await installer.save();
    const run=installer.run;
    installer.run=async (kind,args,options)=>args.includes('images') && args.includes('list')
      ? Buffer.from(JSON.stringify([{name:installer.names.imageRepository,tags:['stock']}])) : run(kind,args,options);
    await assert.rejects(installer.install(), /manual reconciliation/);
  });
});

test('uncertain image copy blocks uninstall before any teardown mutation', async (t) => {
  for (const data of ['retain', 'delete']) for (const nameForm of ['short', 'account']) for (const scenario of ['lost copy response', 'failed copy with collision']) {
    await t.test(`${data}: ${nameForm}: ${scenario}`, async (t) => {
      const {installer, remote, directory} = await fixture(t);
      await installer.install();
      // Model a retry on an existing installation so ingress and all owned resources exist.
      installer.state.image = {status:'copy-pending'}; await installer.save();
      let images = [];
      const run = installer.run;
      installer.run = async (kind,args,options) => args.includes('images') && args.includes('list')
        ? Buffer.from(JSON.stringify(images)) : run(kind,args,options);
      const name = nameForm === 'short' ? installer.names.imageRepository : `${config.accountId}/${installer.names.imageRepository}`;
      installer.importImage = async () => {
        if (scenario === 'lost copy response') images = [{name,tags:['stock'],digest:STOCK_DIGEST}];
        throw new Error('injected image copy failure');
      };
      await assert.rejects(installer.install({upgrade:true}), /injected image copy failure/);
      if (scenario === 'failed copy with collision') images = [{name,tags:['other']}];
      const manifest = await readFile(join(directory,'manifest.json'));
      const credentials = await readJson(join(directory,'credentials.json'),null);
      const before = structuredClone({namespace:remote.namespace,store:remote.store,secrets:remote.secrets,access:remote.access,
        serviceTokens:remote.serviceTokens,scripts:remote.scripts,workflows:remote.workflows,containers:remote.containers,
        routes:remote.routes,settings:remote.settings,lifecycle:remote.lifecycle});
      remote.calls.length = 0; remote.commands.length = 0;
      await assert.rejects(installer.uninstall({data,confirm:config.instance}), /manual reconciliation/);
      assert.deepEqual(await readFile(join(directory,'manifest.json')), manifest);
      assert.deepEqual(await readJson(join(directory,'credentials.json'),null), credentials);
      assert.deepEqual({namespace:remote.namespace,store:remote.store,secrets:remote.secrets,access:remote.access,
        serviceTokens:remote.serviceTokens,scripts:remote.scripts,workflows:remote.workflows,containers:remote.containers,
        routes:remote.routes,settings:remote.settings,lifecycle:remote.lifecycle},before);
      assert.equal(remote.calls.length,0);
      assert.equal(remote.commands.length,0);
    });
  }
});
test('absent uncertain image permits partial uninstall; proven copy still removes its tag', async (t) => {
  await t.test('absent uncertain copy', async (t) => {
    const {installer} = await fixture(t);
    installer.importImage=async()=>{throw new Error('copy failed');};
    await assert.rejects(installer.install(), /copy failed/);
    assert.equal((await installer.uninstall({data:'delete',confirm:config.instance})).status,'removed');
  });
  await t.test('proven copy before preparation', async (t) => {
    const {installer} = await fixture(t); await installer.install();
    installer.state.image.status='copy-pending'; await installer.save();
    const run=installer.run; let deleted=false;
    installer.run=async (kind,args,options)=>{
      if(args.includes('images') && args.includes('list')) return Buffer.from(JSON.stringify([{name:installer.names.imageRepository,tags:['stock']}]));
      if(args.includes('images') && args.includes('delete')) {deleted=true;return Buffer.alloc(0);}
      return run(kind,args,options);
    };
    assert.equal((await installer.uninstall({data:'delete',confirm:config.instance})).status,'removed');
    assert.equal(deleted,true);
  });
});
