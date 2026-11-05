// Installation control plane; every operation uses explicitly selected configuration.
import assert from 'node:assert/strict';
import { accessSession, appRequest } from './native-auth.mjs';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, lstat, writeFile, rename, chmod, open, rm, realpath } from 'node:fs/promises';
import { join, resolve, relative, dirname, basename, isAbsolute, sep } from 'node:path';

export const STOCK_DIGEST = 'sha256:d895dcd0e2faafcdda26d5f6e716a1241002aedf790c64c2a729c16f151e4491';
export const STOCK_SOURCE = `docker.io/vxcontrol/kali-linux@${STOCK_DIGEST}`;
export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function configuration(value) {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Configuration must be an object');
  const allowed = ['schemaVersion', 'accountId', 'instance', 'accessTeamDomain', 'allowedEmails'];
  assert(Object.keys(value).every((key) => allowed.includes(key)), 'Unknown configuration key; credentials and resource overrides are not supported');
  assert.equal(value.schemaVersion, 1, 'Unsupported configuration schema');
  assert.match(value.accountId ?? '', /^[a-f0-9]{32}$/, 'Select an explicit Cloudflare accountId');
  assert.match(value.instance ?? '', /^[a-z][a-z0-9-]{2,37}$/, 'instance must be 3–38 lowercase letters, digits or hyphens');
  assert.match(value.accessTeamDomain ?? '', /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/, 'Use the existing account Zero Trust team HTTPS domain');
  assert(Array.isArray(value.allowedEmails) && value.allowedEmails.length > 0 && value.allowedEmails.every((email) => typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)), 'Explicit allowedEmails are required');
  return { schemaVersion: 1, accountId: value.accountId, instance: value.instance,
    accessTeamDomain: value.accessTeamDomain, allowedEmails: [...new Set(value.allowedEmails)].sort() };
}
export function names(config) {
  const prefix = config.instance;
  return { app: `${prefix}-app`, gateway: `${prefix}-toolbox`, namespace: `${prefix}-work`,
    workflow: `${prefix}-results`, store: `${prefix}-operator`, access: `${prefix}-operators`,
    imageRepository: `${prefix}-kali`, container: `${prefix}-kali`, serviceToken: `${prefix}-installer`, operatorSecret: `${prefix}-control-token` };
}
export function plan(config) {
  return { schemaVersion: 1, accountId: config.accountId, instance: config.instance, resources: names(config),
    stockImage: STOCK_SOURCE, inference: 'never automatic', scanners: 'never automatic',
    actions: ['Check account, Workers subdomain, Zero Trust team and resource collisions',
      'Create a private Artifacts namespace; keep the stock MCP credential only in a Worker secret',
      'Copy pinned stock image bytes to this account and await native image preparation',
      'Create an Access application with only the configured email allow policy',
      'Build and deploy private ToolboxGateway before the app; preserve DO migration tags',
      'Set own model key; enable app only after authentication is configured',
      'Read back bindings and verify unauthenticated rejection and authenticated API access'] };
}
export async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; if(error instanceof SyntaxError)throw Error('Invalid local JSON; inspect configuration or state privately'); throw error; }
}
export async function privateJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  await chmod(file, 0o600);
}
export async function withStateLock(directory, callback) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assert(!(await lstat(directory)).isSymbolicLink(), 'State directory must not be a symlink');
  const entries = await readdir(directory);
  assert(entries.length === 0 || entries.includes('manifest.json') || entries.every((name) => name === 'operation.lock'),
    'Existing state directory contains unrelated files; choose a new empty directory');
  await chmod(directory, 0o700);
  const lockPath = join(directory, 'operation.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Another operation holds operation.lock; reconcile any interrupted remote operation before removing this lock'); throw error; }
  try { return await callback(); }
  finally { await lock.close(); await rm(lockPath); }
}
export class CloudflareApi {
  constructor(token, fetcher = fetch) {
    assert(token, 'Set CLOUDFLARE_API_TOKEN with permissions for the selected account');
    this.token = token; this.fetcher = fetcher;
  }
  async request(path, { method = 'GET', body, missing = false, envelope = false } = {}) {
    assert(path.startsWith('/accounts/'), 'Only account-scoped Cloudflare endpoints are supported');
    let response;
    try { response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(90_000),
    }); } catch { throw new Error(`Cloudflare ${method} request failed; reconcile state before retrying a mutation`); }
    if (response.status === 404 && missing) return null;
    let data;
    try { data = response.status === 204 ? { success: true, result: null } : await response.json(); }
    catch { throw new Error(`Cloudflare ${method} returned HTTP ${response.status} without a valid envelope`); }
    if (!response.ok || data.success === false) {
      // Provider errors may echo request fields (including write-only secrets).
      throw new Error(`Cloudflare ${method} failed (HTTP ${response.status}; codes ${(data.errors ?? []).map((item) => Number(item.code)).join(',')})`);
    }
    return envelope ? data : data.result;
  }
  async list(path, { cursor = false } = {}) {
    const items = []; const seen = new Set(); let page = 1, next;
    do {
      const query = new URLSearchParams(cursor ? { limit: '200', ...(next ? { cursor: next } : {}) } : { per_page: '100', page: String(page) });
      const data = await this.request(`${path}?${query}`, { envelope: true });
      assert(Array.isArray(data.result), 'Cloudflare list endpoint returned an unexpected shape');
      items.push(...data.result);
      next = cursor ? data.result_info?.cursor : page < (data.result_info?.total_pages ?? 1) ? String(page + 1) : undefined;
      if (next) { assert(!seen.has(next), 'Cloudflare returned a repeated pagination cursor'); seen.add(next); }
      page++;
    } while (next);
    return items;
  }
}
export class Installer {
  constructor({ config, stateDirectory, root, api, run, importImage, log = () => {}, fetcher = fetch, environment = process.env, session }) {
    this.config = configuration(config); this.directory = resolve(stateDirectory); this.root = root;
    this.api = api; this.run = run; this.importImage = importImage; this.log = log; this.fetcher = fetcher; this.environment = environment;
    this.session = session ?? (()=>accessSession(this.state.appUrl,this.run));
    this.names = names(this.config); this.base = `/accounts/${this.config.accountId}`;
  }
  async load({ create = false } = {}) {
    const existing = await readJson(join(this.directory, 'manifest.json'), null);
    if (existing) {
      assert.equal(existing.schemaVersion, 1, 'Unsupported ownership manifest');
      assert.deepEqual(existing.config, this.config, 'Configuration changed; ownership manifest cannot adopt a different account, instance or auth policy');
      assert.deepEqual(existing.names, this.names, 'Ownership manifest names changed');
      this.state = existing;
    } else {
      assert(create, 'No installation manifest exists in --state');
      this.state = { schemaVersion: 1, installationId: randomUUID(), config: this.config, names: this.names, resources: {}, steps: {}, createdAt: new Date().toISOString() };
      await this.save();
    }
    return this.state;
  }
  async save() { await privateJson(join(this.directory, 'manifest.json'), this.state); }
  // A pre-request claim records uncertainty, not evidence of remote ownership.
  async owned(key, lookup, create) {
    const claim = this.state.resources[key];
    const found = await lookup(claim);
    if (found) {
      assert(claim, `Refusing to adopt existing ${key}; choose a fresh instance name`);
      assert(claim.status !== 'pending' && claim.id, `Uncertain ${key} ownership; manual reconciliation required`);
      assert.equal(found.id, claim.id, `Owned ${key} identity changed`);
      if (claim.status !== 'ready') { this.state.resources[key] = { ...claim, id: found.id, status: 'ready' }; await this.save(); }
      return found;
    }
    assert(!claim || claim.status === 'pending', `Owned ${key} is missing; stop and investigate instead of recreating data`);
    this.state.resources[key] = { status: 'pending' }; await this.save();
    const made = await create();
    assert(made?.id, `Cannot record ${key} ownership without a provider identity`);
    this.state.resources[key] = { status: 'ready', id: made.id }; await this.save();
    this.log({ stage: key, status: 'ready' });
    return made;
  }
  async preflight() {
    await this.api.request(this.base);
    const domain = await this.api.request(`${this.base}/workers/subdomain`);
    assert.match(domain?.subdomain ?? '', /^[a-z0-9-]+$/, 'Configure a Workers subdomain in this account first');
    const organization = await this.api.request(`${this.base}/access/organizations`);
    assert.equal(`https://${organization.auth_domain}`, this.config.accessTeamDomain, 'Access team does not belong to selected account');
    const providers = await this.api.list(`${this.base}/access/identity_providers`);
    assert(providers.length > 0, 'Configure a Zero Trust identity provider or one-time PIN before installation');
    this.state.appUrl = `https://${this.names.app}.${domain.subdomain}.workers.dev`;
    const scripts = await this.api.list(`${this.base}/workers/scripts`);
    for (const key of ['app', 'gateway']) {
      const exists = scripts.find((item) => item.id === this.names[key]);
      assert(!exists || this.state.resources[key]?.status === 'ready', `Refusing to overwrite existing or uncertain ${key} Worker; manual reconciliation required`);
    }
    const workflows = await this.api.list(`${this.base}/workflows`);
    assert(!workflows.some((item) => item.name === this.names.workflow) || this.state.resources.app?.status === 'ready', 'Workflow name is already in use');
    const containers = await this.api.request(`${this.base}/containers/applications`);
    assert(Array.isArray(containers), 'Container application listing returned an unexpected shape');
    assert(!containers.some((item) => item.name === this.names.container) || this.state.resources.gateway?.status === 'ready', 'Container application name is already in use');
    const selector = join(this.directory, 'account.wrangler.json');
    await privateJson(selector, { name: `${this.config.instance}-installer`, account_id: this.config.accountId, compatibility_date: '2026-10-30' });
    if (!this.state.image?.copied) {
      const images = JSON.parse((await this.run('wrangler', ['containers', 'images', 'list', '--json', '--config', selector])).toString());
      assert(Array.isArray(images), 'Registry image listing returned an unexpected shape');
      assert(!images.some((item) => item.name === this.names.imageRepository || item.name === `${this.config.accountId}/${this.names.imageRepository}`), 'Image repository is already in use or an interrupted copy is uncertain; manual reconciliation required');
    }
    await this.save();
  }
  async render(publicApp = false) {
    const app = await readJson(join(this.root, 'templates/private-install/app.json'));
    const gateway = await readJson(join(this.root, 'templates/private-install/gateway.json'));
    const common = { account_id: this.config.accountId };
    for (const [key, template] of [['app', app], ['gateway', gateway]]) {
      const prior = await readJson(join(this.directory, `${key}.wrangler.json`), null);
      if (prior) assert.deepEqual(template.migrations.slice(0, prior.migrations.length), prior.migrations,
        'Upgrade must preserve existing DO migration tags/classes; review migration compatibility before continuing');
    }
    Object.assign(app, common, { name: this.names.app, main: join(this.root, 'apps/control-plane/src/worker.ts'), workers_dev: publicApp,
      assets: { binding: 'ASSETS', directory: join(this.root, 'apps/control-plane/dist/client'), not_found_handling: 'single-page-application', run_worker_first: ['/*'] },
      artifacts: [{ binding: 'ARTIFACTS', namespace: this.names.namespace }],
      services: [{ binding: 'TOOLBOX', service: this.names.gateway, entrypoint: 'ToolboxGateway' }],
      workflows: [{ binding: 'RESULTS', name: this.names.workflow, class_name: 'ResultValidation' }],
      triggers: { events: [{ type: 'cf.artifacts.repo.pushed', filter: { namespace: this.names.namespace }, targets: [{ type: 'workflow', workflow_name: this.names.workflow }] }] },
      vars: { CONTROL_BASE_URL: this.state.appUrl, ACCESS_TEAM_DOMAIN: this.config.accessTeamDomain, ACCESS_AUD: this.state.resources.access.aud, ARTIFACTS_NAMESPACE: this.names.namespace },
    });
    Object.assign(gateway, common, { name: this.names.gateway, main: join(this.root, 'infra/aws-toolbox/control/src/worker.ts'),
      containers: [{ name: this.names.container, class_name: 'KaliToolbox', scheduling_policy: 'durable_object', images: { stock: { image: this.state.image.image } } }] });
    // Worker secrets are provisioned before the public route is enabled. They
    // are not put into configs, arguments, dry-run output or the manifest.
    await privateJson(join(this.directory, 'app.wrangler.json'), app);
    await privateJson(join(this.directory, 'gateway.wrangler.json'), gateway);
    return { app, gateway };
  }
  async workerSecret(worker, name, value) {
    await this.api.request(`${this.base}/workers/scripts/${worker}/secrets`, { method: 'PUT', body: { name, text: value, type: 'secret_text' } });
  }
  async deploy(key) {
    const config = join(this.directory, `${key}.wrangler.json`);
    if (!this.state.resources[key]) { this.state.resources[key] = { status: 'pending' }; await this.save(); }
    if (key === 'gateway') await this.run('wrangler', ['deploy', '--config', config]);
    else {
      const output = join(this.directory, 'app-build');
      await this.run('node', [join(this.root, 'scripts/build-native-app.mjs'), '--config', config, '--output', output]);
      await this.run('node', [join(this.root, 'scripts/deploy-native-app.mjs'), '--config', config, '--output', output]);
    }
    this.state.resources[key] = { status: 'ready', id: this.names[key] }; await this.save();
    if (key === 'gateway') await this.recordContainer();
  }
  async recordContainer({ optional = false } = {}) {
    const applications = await this.api.request(`${this.base}/containers/applications`);
    assert(Array.isArray(applications), 'Container application listing returned an unexpected shape');
    const container = applications.find((item) => item.name === this.names.container);
    if (!container && optional) return null;
    assert(container, 'Deployed gateway Container application was not found');
    const settings = await this.api.request(`${this.base}/workers/scripts/${this.names.gateway}/settings`);
    const binding = settings.bindings.find((item) => item.name === 'KALI_TOOLBOX');
    assert(binding?.namespace_id && container.durable_objects?.namespace_id === binding.namespace_id, 'Container does not belong to the gateway DO namespace');
    const prior = this.state.resources.container;
    if (prior?.id) assert.equal(container.id, prior.id, 'Owned Container application identity changed');
    this.state.resources.container = { id: container.id, namespaceId: binding.namespace_id, status: 'ready' }; await this.save();
  }
  async reconcileTeardownClaims() {
    const claims = this.state.resources;
    const reconcile = async (key, found) => {
      const claim = claims[key];
      if (!claim || claim.status === 'deleted') return;
      if (found) {
        assert(found.id, `Cannot resolve ${key} ownership identity`);
        assert(claim.status !== 'pending' && claim.id, `Uncertain ${key} ownership; manual reconciliation required`);
        assert.equal(found.id, claim.id, `Owned ${key} identity changed`);
      } else {
        assert(claim.status === 'pending' || this.state.steps.deleteAuthorized, `Owned ${key} disappeared before teardown authorization`);
        claim.status = 'deleted';
      }
      await this.save();
    };
    if (claims.app || claims.gateway) {
      const workers = await this.api.list(`${this.base}/workers/scripts`);
      for (const key of ['app', 'gateway']) await reconcile(key, workers.find((item) => item.id === this.names[key]));
    }
    if (claims.namespace?.status !== 'deleted' && claims.namespace) {
      const found = await this.api.request(`${this.base}/artifacts/namespaces/${this.names.namespace}`, { missing: true });
      await reconcile('namespace', found ? { id: this.names.namespace } : null);
    }
    if (claims.store?.status !== 'deleted' && claims.store) {
      const stores = await this.api.list(`${this.base}/secrets_store/stores`);
      const store = stores.find((item) => item.name === (claims.store.shared ? claims.store.name : this.names.store));
      await reconcile('store', store);
      if (claims.operatorSecret?.status !== 'deleted' && claims.operatorSecret) {
        const secrets = store ? await this.api.list(`${this.base}/secrets_store/stores/${store.id}/secrets`) : [];
        await reconcile('operatorSecret', secrets.find((item) => item.name === this.names.operatorSecret));
      }
    } else if (claims.store?.status === 'deleted') await reconcile('operatorSecret', null);
    if (claims.access?.status !== 'deleted' && claims.access) await reconcile('access', (await this.api.list(`${this.base}/access/apps`)).find((item) => item.name === this.names.access));
    if (claims.serviceToken?.status !== 'deleted' && claims.serviceToken) await reconcile('serviceToken', (await this.api.list(`${this.base}/access/service_tokens`)).find((item) => item.name === this.names.serviceToken));
  }
  async install({ upgrade = false } = {}) {
    await this.load({ create: !upgrade });
    assert(!this.state.removed, 'This installation has been removed; choose a fresh state directory and instance');
    await this.preflight();
    await this.owned('namespace', async () => {
      const item = await this.api.request(`${this.base}/artifacts/namespaces/${this.names.namespace}`, { missing: true });
      return item ? { ...item, id: this.names.namespace } : null;
    }, async () => { await this.api.request(`${this.base}/artifacts/namespaces`, { method: 'POST', body: { namespace: this.names.namespace } }); return { id: this.names.namespace }; });
    if (!this.state.image?.copied) {
      this.state.image = { image: `registry.cloudflare.com/${this.config.accountId}/${this.names.imageRepository}@${STOCK_DIGEST}`, status: 'copy-pending' }; await this.save();
      const proof = await this.importImage(this);
      assert(proof.exactManifestBytes && proof.configBlobDigestVerified, 'Stock image copy did not prove byte parity');
      this.state.image = { ...this.state.image, copied: true, proof }; await this.save();
    }
    const preparation = await this.api.request(`${this.base}/containers/image-preparations`, { method: 'POST', body: { image: this.state.image.image } });
    this.state.image.status = preparation.status;
    this.state.image.artifactDigest = preparation.artifact_digest; await this.save();
    assert.equal(preparation.status, 'ready', `Native image preparation is ${preparation.status}; installation remains private. Rerun install to observe preparation; terminal errors need provider investigation`);
    const access = await this.owned('access', async () => (await this.api.list(`${this.base}/access/apps`)).find((item) => item.name === this.names.access),
      () => this.api.request(`${this.base}/access/apps`, { method: 'POST', body: { name: this.names.access, domain: new URL(this.state.appUrl).hostname, type: 'self_hosted', session_duration: '12h', oauth_configuration: {enabled:true,dynamic_client_registration:{enabled:true,allow_any_on_localhost:true,allow_any_on_loopback:true},grant:{access_token_lifetime:'5m',session_duration:'12h'}},
        policies: [{ name: `${this.names.access}-allow`, decision: 'allow', precedence: 1, include: this.config.allowedEmails.map((email) => ({ email: { email } })) }] } }));
    // GET/PUT the complete application: enabling native OAuth must retain
    // existing allow rules and platform options, including during an upgrade.
    const currentAccess=await this.api.request(`${this.base}/access/apps/${access.id}`);
    if(!currentAccess.oauth_configuration?.enabled){
      await this.api.request(`${this.base}/access/apps/${access.id}`,{method:'PUT',body:{...currentAccess,oauth_configuration:{...currentAccess.oauth_configuration,enabled:true,dynamic_client_registration:{...currentAccess.oauth_configuration?.dynamic_client_registration,enabled:true,allow_any_on_localhost:true,allow_any_on_loopback:true},grant:{...currentAccess.oauth_configuration?.grant,access_token_lifetime:'5m',session_duration:currentAccess.oauth_configuration?.grant?.session_duration??currentAccess.session_duration??'12h'}}}});
    }
    assert(access.aud, 'Access application has no audience');
    this.state.resources.access.aud = access.aud; await this.save();
    await this.render(false);
    await this.run('build', []);
    await this.deploy('gateway');
    if (!this.state.steps.mcp) {
      const bound=await this.api.request(`${this.base}/workers/scripts/${this.names.gateway}/secrets`);
      assert(Array.isArray(bound),'Worker secret metadata unavailable');
      if(!bound.some(item=>item.name==='KALI_MCP_TOKEN'))await this.workerSecret(this.names.gateway,'KALI_MCP_TOKEN',randomBytes(32).toString('base64url'));
      this.state.steps.mcp=true; await this.save();
    }
    await this.deploy('app');
    for(const [name,step] of [['OPENCODE_GO_API_KEY','model'],['OPENCODE_API_KEY','consoleModel']])if(!this.state.steps[step]&&this.environment[name]){await this.workerSecret(this.names.app,name,this.environment[name]);this.state.steps[step]=true;await this.save();}
    await this.render(true);
    // Only routing changes; use the same bundle proof after regenerating it.
    await this.deploy('app');
    this.state.steps.installed = true; this.state.updatedAt = new Date().toISOString(); await this.save();
    const proof=await this.doctor({allowLegacy:true});
    this.state.steps.nativeAccessVerified=true; await this.save();
    await this.retireLegacyCredentials();
    return this.doctor();
  }
  async retireLegacyCredentials(){
    assert(this.state.steps.nativeAccessVerified,'Verify native authentication before retiring credentials');
    const resources=this.state.resources;
    // Creation ownership does not prove exclusive consumption. Inventory all
    // account app policies (including nested groups) and current Worker bindings
    // before deleting either account-level credential. An unavailable inventory
    // fails closed before any DELETE, leaving the old recovery path intact.
    const consumers=[];
    if(resources.serviceToken?.status==='ready'){
      let groups;
      const references=async(value,seen=new Set())=>{
        if(!value||typeof value!=='object')return false;
        if(value.service_token?.token_id===resources.serviceToken.id||'any_valid_service_token' in value)return true;
        const groupId=value.group?.id??value.access_group?.id;
        if(groupId){
          assert(!seen.has(groupId),'Cyclic Access group; cannot prove legacy token has no consumers');
          groups??=await this.api.list(`${this.base}/access/groups`);
          const group=groups.find(g=>g.id===groupId);
          assert(group,'Access group unavailable; cannot prove legacy token has no consumers');
          const next=new Set(seen);next.add(groupId);
          if(await references({include:group.include,exclude:group.exclude,require:group.require},next))return true;
        }
        for(const child of Object.values(value))if(await references(child,seen))return true;
        return false;
      };
      for(const app of await this.api.list(`${this.base}/access/apps`)){
        if(app.id===resources.access.id)continue;
        const policies=await this.api.list(`${this.base}/access/apps/${app.id}/policies`);
        for(const policy of policies)if(await references(policy))consumers.push({kind:'access-policy',applicationId:app.id,policyId:policy.id});
      }
    }
    if(resources.operatorSecret?.status==='ready'){
      for(const worker of await this.api.list(`${this.base}/workers/scripts`)){
        const settings=await this.api.request(`${this.base}/workers/scripts/${encodeURIComponent(worker.id)}/settings`);
        assert(Array.isArray(settings.bindings),'Worker binding inventory unavailable');
        if(settings.bindings.some(b=>b.store_id===resources.store.id&&(b.secret_name===this.names.operatorSecret||b.secret_id===resources.operatorSecret.id)))consumers.push({kind:'worker-binding',worker:worker.id});
      }
      const response=await this.probe('/v1/lifecycle',true);
      assert.equal(response.status,200,'Cannot prove settled execution before credential retirement');
      const status=await response.json();
      if(status.activeAttempt!==false||status.pendingPublications!==0||status.preparingInput!==false||status.pendingPurges!==0)consumers.push({kind:'unsettled-runtime'});
    }
    this.state.legacyCredentialConsumers=consumers;await this.save();
    assert.equal(consumers.length,0,'Legacy credentials retained: dependent consumers remain. Inspect legacyCredentialConsumers in the private manifest and migrate them before retirement; no credentials were removed');
    const service=resources.serviceToken;
    if(service&&service.status!=='deleted'){
      assert(service.status==='ready'&&service.id,'Uncertain installer token ownership; manual reconciliation required');
      const tokens=await this.api.list(`${this.base}/access/service_tokens`),owned=tokens.find(t=>t.id===service.id);
      assert(!owned||owned.name===this.names.serviceToken,'Installer token ownership changed');
      const policies=await this.api.list(`${this.base}/access/apps/${resources.access.id}/policies`);
      for(const policy of policies.filter(p=>p.decision==='non_identity')){
        assert(policy.name===`${this.names.access}-installer`&&policy.id&&JSON.stringify(policy.include)===JSON.stringify([{service_token:{token_id:service.id}}]),'Unrelated machine policy; preserve it for manual review');
        await this.api.request(`${this.base}/access/apps/${resources.access.id}/policies/${policy.id}`,{method:'DELETE',missing:true});
      }
      await this.api.request(`${this.base}/access/service_tokens/${service.id}`,{method:'DELETE',missing:true});
      service.status='deleted'; await this.save();
    }
    const secret=resources.operatorSecret;
    if(secret&&secret.status!=='deleted'){
      assert(secret.status==='ready'&&secret.id&&resources.store?.id,'Uncertain operator secret ownership; manual reconciliation required');
      const secrets=await this.api.list(`${this.base}/secrets_store/stores/${resources.store.id}/secrets`);
      const owned=secrets.find(s=>s.id===secret.id);
      assert(!owned||owned.name===this.names.operatorSecret&&owned.comment===`PentCloud installation ${this.state.installationId}`,'Operator secret ownership changed');
      await this.api.request(`${this.base}/secrets_store/stores/${resources.store.id}/secrets/${secret.id}`,{method:'DELETE',missing:true});
      secret.status='deleted';resources.store.retained=true;await this.save();
    }
    const file=join(this.directory,'credentials.json');
    let info;try{info=await lstat(file);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(info){
      assert(info.isFile()&&!info.isSymbolicLink(),'Legacy credentials must be an owned regular file');
      assert(resources.serviceToken?.status==='deleted'&&resources.operatorSecret?.status==='deleted','Local credentials have no proven retired resource owners; preserve for manual review');
      const values=await readJson(file);
      assert(Object.keys(values).every(k=>['operator','mcp','accessClientId','accessClientSecret'].includes(k)),'Unexpected local credential contents; preserve for review');
      await rm(file);
    }
    this.state.steps.legacyCredentialsRetired=true;await this.save();
  }
  async probe(path, authenticated = false, options = {}) {
    if(authenticated)return appRequest({origin:this.state.appUrl,path,session:this.session,fetcher:this.fetcher,options});
    try{return await this.fetcher(`${this.state.appUrl}${path}`,{headers:new Headers(),redirect:'manual',signal:AbortSignal.timeout(30_000)});}
    catch{throw Error('Anonymous authentication probe failed');}
  }
  async doctor({allowLegacy=false}={}) {
    if (!this.state) await this.load();
    const checks = [];
    for (const key of ['gateway', 'app']) {
      const settings = await this.api.request(`${this.base}/workers/scripts/${this.names[key]}/settings`);
      const bindings = settings.bindings ?? [];
      assert(!bindings.some(item=>['CONTROL_AUTH','CONTROL_TOKEN'].includes(item.name)),`${key} retains a legacy operator credential binding`);
      if (key === 'app') {
        assert(bindings.some((item) => item.name === 'TOOLBOX' && item.service === this.names.gateway && item.entrypoint === 'ToolboxGateway'), 'Private gateway service binding mismatch');
        assert(bindings.some((item) => item.name === 'ARTIFACTS' && item.namespace === this.names.namespace), 'Private Artifacts namespace binding mismatch');
        assert(!bindings.some((item) => item.name === 'LEGACY_STATE_COMMIT'), 'Fresh installs must not import legacy history');
      }
      checks.push(`${key} bindings`);
    }
    const gatewayRoute = await this.api.request(`${this.base}/workers/scripts/${this.names.gateway}/subdomain`);
    assert.equal(gatewayRoute.enabled, false, 'Gateway must have no public workers.dev route');
    const app = await this.api.request(`${this.base}/access/apps/${this.state.resources.access.id}`);
    assert.equal(app.aud, this.state.resources.access.aud, 'Access audience changed');
    assert.equal(app.domain, new URL(this.state.appUrl).hostname, 'Access application domain changed');
    const policies = await this.api.list(`${this.base}/access/apps/${this.state.resources.access.id}/policies`);
    const allow = policies.filter((item) => item.decision === 'allow'), machine = policies.filter((item) => item.decision === 'non_identity');
    assert(app.oauth_configuration?.enabled===true,'Access Managed OAuth must be enabled');
    const legacy=allowLegacy&&this.state.resources.serviceToken?.status==='ready';
    assert(allow.length===1&&policies.length===1+machine.length&&(legacy?machine.length<=1:machine.length===0),'Access policy set changed');
    assert.deepEqual(allow[0].include,this.config.allowedEmails.map(email=>({email:{email}})),'Access email allowlist changed');
    if(machine.length)assert.deepEqual(machine[0].include,[{service_token:{token_id:this.state.resources.serviceToken.id}}],'Unrelated machine policy; preserve for review');
    const anonymous = await this.probe('/v1/runs');
    assert([302, 303, 401, 403].includes(anonymous.status), `Unauthenticated API unexpectedly returned ${anonymous.status}`);
    const authenticated = await this.probe('/v1/runs?view=all', true);
    assert.equal(authenticated.status, 200, 'Cloudflare Access user authentication failed');
    const runs = await authenticated.json();
    const setup=await this.probe('/v1/onboarding',true);
    assert.equal(setup.status,200,'Authenticated onboarding is unavailable');
    const readiness=await setup.json();
    return { status: 'verified-resource-and-auth-checks', accountId: this.config.accountId, instance: this.config.instance, appUrl: this.state.appUrl,
      checks: [...checks, 'private gateway', 'Access audience', 'anonymous rejection', 'native Access read-only access'],
      runCount: Array.isArray(runs) ? runs.length : Array.isArray(runs.runs) ? runs.runs.length : null,
      onboarding:{targetCount:readiness.targets?.length??0,modelKeyConfigured:(readiness.credentials??[]).some(c=>c.purpose==='model'&&!c.revoked&&!c.missing),connectionTestsPerformed:false},
      modelCalls: 0, scannerCalls: 0, independentAccountProof: false };
  }
  async exportMetadata() {
    await this.load();
    const repos = this.state.resources.namespace && this.state.resources.namespace.status !== 'deleted' ? await this.api.list(`${this.base}/artifacts/namespaces/${this.names.namespace}/repos`, { cursor: true }) : [];
    return { schemaVersion: 1, kind: 'installation-metadata-export', exportedAt: new Date().toISOString(), manifest: this.state,
      repositories: repos.map(({ id, name, remote, default_branch }) => ({ id, name, remote, default_branch })),
      limitations: ['Contains no secret values', 'Not a backup of Durable Object/session/workspace data or Git objects', 'Retain installation resources until a separately verified data backup exists'] };
  }
  async exportInstallation(output) {
    // Resolve the existing parent to catch symlink aliases into the private state.
    const target = join(await realpath(dirname(resolve(output))), basename(resolve(output)));
    const state = await realpath(this.directory);
    const destination = `${target}.git-bundles`;
    for (const path of [target, destination]) {
      const inside = relative(state, path);
      assert(inside && (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)),
        'Export destination and bundle directory must be outside the state directory');
    }
    // Reserve both names exclusively before contacting the provider. Existing
    // paths, including symlinks, are never replaced; failed exports stay reserved.
    const outputFile = await open(target, 'wx', 0o600);
    try {
      await mkdir(destination, { mode: 0o700 });
      const metadata = await this.exportMetadata();
      const setupResponse=await this.probe('/v1/onboarding/export',true);
      assert.equal(setupResponse.status,200,'Cannot export saved targets and profiles');
      metadata.onboarding=await setupResponse.json();
      assert.equal(metadata.onboarding.version,1,'Unsupported target export');
      metadata.definitionFiles=[];
      for(const definition of metadata.onboarding.definitions??[]){
        assert.match(definition.targetId,/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/);
        assert(Number.isSafeInteger(definition.version)&&definition.version>0,'Invalid definition version');
        const response=await this.probe('/v1/targets/'+encodeURIComponent(definition.targetId)+'/definition?version='+definition.version,true);
        assert.equal(response.status,200,'Cannot export API definition');
        const data=Buffer.from(await response.arrayBuffer());
        assert(data.length<=2*1024*1024&&hash(data)===definition.sha256,'API definition bytes changed during export');
        const filename='target-'+definition.targetId+'-'+definition.version+'.definition';
        const file=await open(join(destination,filename),'wx',0o600);try{await file.writeFile(data);}finally{await file.close();}
        metadata.definitionFiles.push({targetId:definition.targetId,name:definition.name,file:filename,sha256:definition.sha256,size:data.length});
      }
      const statusResponse = await this.probe('/v1/lifecycle', true);
      assert.equal(statusResponse.status, 200, 'Cannot verify settled execution before export');
      const status = await statusResponse.json();
      assert(status.activeAttempt === false && status.pendingPublications === 0 && status.preparingInput === false && status.pendingPurges === 0,
        'Stop and settle all execution/publication/purge ownership before exporting');
      const network = ['PATH', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'LANG', 'TMPDIR'];
      const env = Object.fromEntries(network.filter((key) => this.environment[key]).map((key) => [key, this.environment[key]]));
      Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
      const bundles = [];
      for (const repo of metadata.repositories) {
        assert.match(repo.name, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Unexpected Artifacts repository name');
        const remote = new URL(repo.remote);
        assert.equal(remote.protocol, 'https:');
        assert.equal(remote.hostname, `${this.config.accountId}.artifacts.cloudflare.net`, 'Export remote belongs to a different account');
        assert(remote.pathname.startsWith(`/git/${this.names.namespace}/`) && !remote.username && !remote.password && !remote.search, 'Export remote is outside the owned namespace');
        const token = await this.api.request(`${this.base}/artifacts/namespaces/${this.names.namespace}/tokens`, { method: 'POST', body: { repo: repo.name, scope: 'read', ttl: 900 } });
        const scratch = await mkdtemp(join(this.directory, 'git-export-'));
        try {
          const gitEnv = { ...env, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: `http.${remote.origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token.plaintext}`, GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '' };
          const git = (args) => this.run('git', args, { env: gitEnv, timeout: 600_000 });
          await git(['init', '--bare', scratch]);
          await git(['-C', scratch, 'fetch', '--force', remote.href, '+refs/*:refs/*']);
          const refs = (await git(['-C', scratch, 'for-each-ref', '--format=%(refname) %(objectname)'])).toString().trim();
          if (!refs) { bundles.push({ name: repo.name, empty: true, refs: [] }); continue; }
          const file = join(destination, `${repo.name}.bundle`);
          await git(['-C', scratch, 'bundle', 'create', file, '--all']);
          await chmod(file, 0o600);
          await git(['-C', scratch, 'bundle', 'verify', file]);
          bundles.push({ name: repo.name, file, sha256: hash(await readFile(file)), refs: refs.split('\n') });
        } finally {
          await rm(scratch, { force: true, recursive: true });
          await this.api.request(`${this.base}/artifacts/namespaces/${this.names.namespace}/tokens/${token.id}`, { method: 'DELETE', missing: true });
        }
      }
      const after = await this.probe('/v1/lifecycle', true);
      assert.equal(after.status, 200, 'Cannot verify lifecycle after export');
      assert.deepEqual(await after.json(), status, 'Lifecycle changed during export; settle work and export again');
      metadata.kind = 'installation-metadata-and-git-export'; metadata.gitBundles = bundles; metadata.lifecycle = status;
      metadata.limitations = ['Contains no credential values', 'Git bundles preserve fetched refs/commits, verified by git bundle verify',
        'Saved target/profile metadata and API definition files are included; credential values require re-entry',
        'Not a complete system backup: native DO sessions, execution authority, staged chat files and workspace storage are not exported',
        'Keep live resources and use product downloads for required files; native Durable Object data is not exported'];
      await outputFile.writeFile(JSON.stringify(metadata, null, 2) + '\n');
      return { status: 'metadata-and-git-exported', output: target, gitBundles: bundles.length, completeSystemBackup: false };
    } finally { await outputFile.close(); }
  }
  async importTargets(input) {
    await this.load();
    const path=resolve(input),metadata=await readJson(path),base=await realpath(path+'.git-bundles');
    assert(metadata.onboarding?.version===1,'Input is not a target/profile export');
    const files=[];
    for(const item of metadata.definitionFiles??[]){
      assert.match(item.targetId,/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/);
      assert(typeof item.file==='string'&&basename(item.file)===item.file,'Definition path must be a filename');
      const file=await realpath(join(base,item.file)),inside=relative(base,file);
      assert(inside&&!inside.startsWith('..'+sep)&&!isAbsolute(inside),'Definition path is outside the export');
      const bytes=await readFile(file);
      assert(bytes.length<=2*1024*1024&&bytes.length===item.size&&hash(bytes)===item.sha256,'Definition file integrity failed');
      files.push({item,bytes});
    }
    const token=true;
    const imported=await this.probe('/v1/onboarding/metadata.import',token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:metadata.onboarding})});
    assert.equal(imported.status,200,'Target import requires an empty library and valid metadata');
    for(const {item,bytes} of files){
      const response=await this.probe('/v1/targets/'+encodeURIComponent(item.targetId)+'/definition?name='+encodeURIComponent(item.name),token,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Content-SHA256':item.sha256,'If-Match':'0'},body:bytes});
      assert.equal(response.status,201,'Definition restore incomplete; retained metadata identifies the file to re-upload');
    }
    return {status:'targets-imported',targetCount:metadata.onboarding.targets.length,definitions:files.length,credentialsNeedReentry:true,sourcesNeedReattachment:metadata.onboarding.targets.some(target=>target.sources?.length),restoredExecutionHistory:false};
  }
  async uninstall({ data, confirm }) {
    assert(['retain', 'delete'].includes(data), 'Choose --data retain or --data delete explicitly');
    assert.equal(confirm, this.config.instance, '--confirm must match the installation name');
    await this.load();
    if (this.state.removed) return { status: 'removed', alreadyRemoved: true };
    // A pre-copy journal does not prove ownership of a published registry image.
    // Check before disabling ingress, recording authorization, or deleting anything.
    if (this.state.image?.status === 'copy-pending' && !this.state.image.copied) {
      const selector = join(this.directory, 'account.wrangler.json');
      const images = JSON.parse((await this.run('wrangler', ['containers', 'images', 'list', '--json', '--config', selector])).toString());
      assert(Array.isArray(images), 'Registry image listing returned an unexpected shape');
      assert(!images.some((item) => item.name === this.names.imageRepository || item.name === `${this.config.accountId}/${this.names.imageRepository}`),
        'Interrupted image copy has uncertain ownership; manual reconciliation required before uninstall');
    }
    if (data === 'retain') {
      assert(!this.state.resources.app || this.state.resources.app.status === 'ready' || this.state.resources.app.status === 'deleted', 'Uncertain app ownership; manual reconciliation required');
      if (this.state.resources.app?.status === 'ready') await this.api.request(`${this.base}/workers/scripts/${this.names.app}/subdomain`, { method: 'POST', body: { enabled: false, previews_enabled: false } });
      this.state.disabled = true; await this.save();
      return { status: 'disabled', data: 'retained', resources: this.state.resources, warning: 'Public ingress is disabled; Workers, DO data, events and private resources remain installed' };
    }
    await this.reconcileTeardownClaims();
    if (!this.state.steps.deleteAuthorized && this.state.resources.app?.status !== 'deleted' && this.state.resources.app) {
      const lifecycle = await this.probe('/v1/lifecycle', true);
      const runs = await this.probe('/v1/runs?view=all', true);
      assert.equal(lifecycle.status, 200, 'Cannot verify lifecycle ownership; destructive uninstall is blocked');
      assert.equal(runs.status, 200, 'Cannot list all runs; destructive uninstall is blocked');
      const status = await lifecycle.json(), payload = await runs.json();
      const all = Array.isArray(payload) ? payload : payload.runs;
      assert((status.safeToUninstall === true || status.canDeleteOnboarding === true) && status.runs?.total === 0 && Array.isArray(all) && all.length === 0,
        'Purge every run through the product lifecycle and reconcile scanner/publication ownership before uninstall');
      const quiesced = await this.probe('/v1/lifecycle/prepare-uninstall', true, { method: 'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({deleteOnboarding:true}) });
      assert.equal(quiesced.status, 200, 'Cannot atomically quiesce admissions; destructive uninstall is blocked');
      const receipt = await quiesced.json();
      assert(receipt.safeToUninstall === true && receipt.quiesced === true, 'Missing atomic quiescence receipt');
    }
    const repos = this.state.resources.namespace && this.state.resources.namespace.status !== 'deleted' ? await this.api.list(`${this.base}/artifacts/namespaces/${this.names.namespace}/repos`, { cursor: true }) : [];
    assert.equal(repos.length, 0, 'Owned namespace still contains repositories; export/purge them through the product lifecycle before uninstall');
    if (this.state.resources.store && this.state.resources.store.status !== 'deleted') {
      const stores = await this.api.list(`${this.base}/secrets_store/stores`);
      const store = stores.find((item) => item.id === this.state.resources.store?.id);
      assert(store && store.name === (this.state.resources.store.shared ? this.state.resources.store.name : this.names.store), 'Store ownership metadata changed');
      const secrets = await this.api.list(`${this.base}/secrets_store/stores/${store.id}/secrets`);
      const owned = secrets.find((item) => item.name === this.names.operatorSecret);
      if (this.state.resources.operatorSecret && this.state.resources.operatorSecret.status !== 'deleted') assert(owned && owned.id === this.state.resources.operatorSecret.id, 'Operator secret ownership metadata changed');
      if (!this.state.resources.store.shared && !this.state.resources.store.retained) assert(secrets.every((item) => item.id === this.state.resources.operatorSecret?.id), 'Store contains unrelated secrets; preserve the Store and review ownership');
    }
    // The empty-instance receipt permits resuming a partially completed teardown
    // after app ingress/Worker has gone; no arbitrary namespace reset is used.
    this.state.steps.deleteAuthorized = true; await this.save();
    const remove = async (key, path) => {
      const resource = this.state.resources[key];
      if (!resource || resource.status === 'deleted') return;
      if (key === 'access') {
        const current = await this.api.request(path, { missing: true });
        assert(!current || current.name === this.names.access, 'Access ownership metadata changed');
      }
      if (key === 'serviceToken') {
        const current = (await this.api.list(`${this.base}/access/service_tokens`)).find((item) => item.id === resource.id);
        assert(!current || current.name === this.names.serviceToken, 'Access service token ownership metadata changed');
      }
      if (key === 'container') {
        const current = (await this.api.request(`${this.base}/containers/applications`)).find((item) => item.id === resource.id);
        assert(!current || current.name === this.names.container && current.durable_objects?.namespace_id === resource.namespaceId, 'Container ownership metadata changed');
      }
      await this.api.request(path, { method: 'DELETE', missing: true });
      resource.status = 'deleted'; await this.save();
    };
    if (this.state.resources.app?.status !== 'deleted' && this.state.resources.app) {
      await this.api.request(`${this.base}/workers/scripts/${this.names.app}/subdomain`, { method: 'POST', body: { enabled: false, previews_enabled: false } });
      await this.api.request(`${this.base}/workflows/${this.names.workflow}`, { method: 'DELETE', missing: true });
      await remove('app', `${this.base}/workers/scripts/${this.names.app}`);
    }
    if (this.state.resources.gateway && !this.state.resources.container && this.state.resources.gateway.status !== 'deleted') await this.recordContainer({ optional: true });
    if (this.state.resources.container) await remove('container', `${this.base}/containers/applications/${this.state.resources.container.id}`);
    await remove('gateway', `${this.base}/workers/scripts/${this.names.gateway}`);
    if (this.state.resources.namespace?.status !== 'deleted') await remove('namespace', `${this.base}/artifacts/namespaces/${this.names.namespace}`);
    if (this.state.resources.store) await remove('operatorSecret', `${this.base}/secrets_store/stores/${this.state.resources.store.id}/secrets/${this.state.resources.operatorSecret?.id}`);
    if (this.state.resources.store && !this.state.resources.store.shared && !this.state.resources.store.retained) await remove('store', `${this.base}/secrets_store/stores/${this.state.resources.store.id}`);
    if (this.state.resources.access) await remove('access', `${this.base}/access/apps/${this.state.resources.access.id}`);
    if (this.state.resources.serviceToken) await remove('serviceToken', `${this.base}/access/service_tokens/${this.state.resources.serviceToken.id}`);
    if (this.state.image?.copied && !this.state.image.deleted) {
      const selector = join(this.directory, 'account.wrangler.json');
      const images = JSON.parse((await this.run('wrangler', ['containers', 'images', 'list', '--json', '--config', selector])).toString());
      assert(Array.isArray(images), 'Registry image listing returned an unexpected shape');
      if (images.some((item) => item.name === this.names.imageRepository && item.tags?.includes('stock'))) {
        await this.run('wrangler', ['containers', 'images', 'delete', `${this.names.imageRepository}:stock`, '--skip-confirmation', '--config', selector]);
      }
      this.state.image.deleted = true; await this.save();
    }
    this.state.removed = true; await this.save();
    return { status: 'removed', data: 'owned live resources deleted', manifestRetained: true,
      limitations: 'Provider log/backup retention is separate; deletion does not promise erasure from all platform backups' };
  }
}
