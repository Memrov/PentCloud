import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uninstallPackage } from './lib/package-uninstall.mjs';

const packs = {
  recon: 'ReconRunner', http: 'HttpRunner', nuclei: 'NucleiRunner', sqlmap: 'SqlmapRunner',
  service: 'ServiceRunner', 'web-context': 'WebContextRunner', pcap: 'PcapRunner',
  'file-analysis': 'FileRunner', password: 'PasswordRunner', reference: 'ReferenceRunner', metasploit: 'MetasploitRunner',
};
const clone = value => structuredClone(value);
const config = { accountId: 'a'.repeat(32), instance: 'package-removal-test' };
const names = { app: config.instance + '-app', gateway: config.instance + '-tools', workflow: config.instance + '-results', namespace: config.instance + '-work', access: config.instance + '-operators' };
const base = '/accounts/' + config.accountId;
const domain = { zoneId: 'b'.repeat(32), hostname: 'package-removal.example.com' };
const profile = { domain, images: Object.fromEntries(Object.keys(packs).map(p => [p, 'registry.cloudflare.com/' + config.accountId + '/package-' + p + '@sha256:' + 'c'.repeat(64)])) };
const options = { data: 'delete', confirm: config.instance };

function fixture() {
  const resources = {
    app: { id: names.app, tag: 'immutable-app-tag', status: 'ready' },
    gateway: { id: names.gateway, tag: 'immutable-gateway-tag', status: 'ready' },
    domain: { id: 'owned-domain-id', status: 'ready' },
    namespace: { id: names.namespace, status: 'ready' },
    access: { id: 'owned-access-id', aud: 'owned-audience', status: 'ready' },
    ...Object.fromEntries(Object.keys(packs).map(p => ['pack-' + p, {
      id: 'application-' + p, name: config.instance + '-' + p, namespaceId: 'namespace-' + p, status: 'ready', image: profile.images[p],
    }])),
  };
  const initial = { schemaVersion: 1, installationId: 'installation-uuid', config, names, packageProfile: profile, resources, steps: {}, appUrl: 'https://' + domain.hostname };
  const remote = {
    workers: new Map(['app', 'gateway'].map(k => [names[k], { id: names[k], tag: resources[k].tag, routes: [] }])),
    settings: new Map([
      [names.app, { bindings: [
        { type: 'service', name: 'TOOL_PACKS', service: names.gateway, entrypoint: 'ToolPackGateway' },
        { type: 'artifacts', name: 'ARTIFACTS', namespace: names.namespace },
        { type: 'workflow', name: 'RESULTS', workflow_name: names.workflow, class_name: 'ResultValidation' },
        { type: 'durable_object_namespace', name: 'COORDINATOR', namespace_id: 'namespace-coordinator', class_name: 'Coordinator' },
      ] }],
      [names.gateway, { bindings: Object.entries(packs).map(([p, class_name]) => ({ type: 'durable_object_namespace', name: p.toUpperCase(), class_name, namespace_id: resources['pack-' + p].namespaceId })) }],
    ]),
    subdomains: new Map(['app', 'gateway'].map(k => [names[k], { enabled: true, previews_enabled: true }])),
    domains: new Map([['owned-domain-id', { id: 'owned-domain-id', hostname: domain.hostname, zone_id: domain.zoneId, service: names.app }]]),
    namespaces: [
      { id: 'namespace-coordinator', script: names.app, class: 'Coordinator' },
      ...Object.entries(packs).map(([p, className]) => ({ id: resources['pack-' + p].namespaceId, script: names.gateway, class: className })),
    ],
    containers: new Map(Object.keys(packs).map(p => [resources['pack-' + p].id, { id: resources['pack-' + p].id, name: resources['pack-' + p].name, durable_objects: { namespace_id: resources['pack-' + p].namespaceId } }])),
    active: new Map(),
    instancePages: new Map(),
    workflow: { id: 'owned-workflow-id', name: names.workflow, class_name: 'ResultValidation', script_name: names.app },
    namespace: { namespace: names.namespace }, repos: [],
    access: { id: resources.access.id, name: names.access, domain: domain.hostname, aud: resources.access.aud },
    lifecycle: { safeToUninstall: true, runs: { total: 0 } }, runs: [],
    prepare: null, authenticated: true, deleted: [], requests: [], probes: [], saves: [],
    loseDelete: null, failSave: null, commandCalls: 0,
  };
  let durable = clone(initial), saveCount = 0;
  const installer = {
    config: clone(config), names: clone(names), profile: clone(profile), state: clone(initial),
    async load() { this.state = clone(durable); return this.state; },
    async save() {
      saveCount++;
      if (remote.failSave?.(this.state, saveCount)) throw Error('durable checkpoint unavailable');
      durable = clone(this.state); remote.saves.push(clone(durable));
    },
    async run() { remote.commandCalls++; throw Error('Uninstall must not run a command, model, image or scanner'); },
    async probe(path, authenticated, request = {}) {
      assert.equal(authenticated, true, 'Every product probe is authenticated');
      remote.probes.push({ path, ...request });
      if (!remote.authenticated) return Response.json({}, { status: 403 });
      if (path === '/v1/lifecycle') return Response.json(remote.lifecycle);
      if (path === '/v1/runs?view=all') return Response.json(remote.runs);
      if (path === '/v1/lifecycle/prepare-uninstall') {
        assert.equal(request.method, 'POST');
        assert.deepEqual(JSON.parse(request.body), { deleteOnboarding: true });
        remote.lifecycle.quiesced = true;
        return Response.json(remote.prepare ?? { ...remote.lifecycle, safeToUninstall: true, quiesced: true });
      }
      throw Error('Unexpected product request: ' + path);
    },
    api: {
      async list(path, request = {}) {
        remote.requests.push({ path, method: 'GET', list: true, ...request });
        if (path === base + '/workers/scripts') return clone([...remote.workers.values()]);
        if (path === base + '/workers/domains') return clone([...remote.domains.values()]);
        if (path === base + '/workers/durable_objects/namespaces') return clone(remote.namespaces);
        if (path === base + '/artifacts/namespaces/' + names.namespace + '/repos') { assert.equal(request.cursor, true); return clone(remote.repos); }
        throw Error('Unexpected list endpoint: ' + path);
      },
      async request(path, request = {}) {
        const method = request.method ?? 'GET';
        remote.requests.push({ path, method, ...request });
        const relative = path.slice(base.length), clean = relative.split('?')[0];
        const components = clean.split('/').filter(Boolean);
        const result = value => {
          if (value == null && !request.missing) throw Error('404 at ' + path);
          return clone(value ?? null);
        };
        if (method === 'POST' && /^\/workers\/scripts\/[^/]+\/subdomain$/.test(relative)) {
          assert.deepEqual(request.body, { enabled: false, previews_enabled: false });
          assert(remote.workers.has(components[2]));
          remote.subdomains.set(components[2], clone(request.body));
          return clone(request.body);
        }
        if (method === 'GET') {
          if (/^\/workers\/scripts\/[^/]+\/settings$/.test(relative)) return result(remote.settings.get(components[2]));
          if (/^\/workers\/scripts\/[^/]+\/subdomain$/.test(relative)) return result(remote.subdomains.get(components[2]));
          if (/^\/workers\/domains\/[^/]+$/.test(relative)) return result(remote.domains.get(components[2]));
          if (/^\/workflows\/[^/]+$/.test(relative)) return result(remote.workflow);
          if (/^\/artifacts\/namespaces\/[^/]+$/.test(relative)) return result(remote.namespace);
          if (/^\/access\/apps\/[^/]+$/.test(relative)) return result(remote.access);
          if (/^\/containers\/applications\/[^/]+$/.test(relative)) return result(remote.containers.get(components[2]));
          if (/^\/containers\/applications\/[^/]+\/instances-v2\?/.test(relative)) {
            assert.equal(request.envelope, true);
            const query = new URL('https://fixture.example' + relative).searchParams;
            assert.equal(query.get('state'), 'active');
            assert.equal(query.get('per_page'), '1000');
            const pages = remote.instancePages.get(components[2]);
            return clone(pages?.[query.get('page_token') ?? 'first'] ?? { success: true, result: remote.active.get(components[2]) ?? [], result_info: {} });
          }
        }
        if (method === 'DELETE') {
          // These assertions make durable authorization a property of every
          // tested deletion, including the one whose response is lost.
          const journal = durable.packageUninstall ?? durable.packageRetain;
          assert.equal(journal?.authorized, true);
          const entry = Object.values(journal.resources).find(e => e.path === path);
          assert(entry, 'DELETE must target a receipted path');
          assert.equal(entry.intent, true); assert.equal(entry.status, 'delete-pending');
          assert.equal(request.missing, true);
          assert(!/force|kali|service_tokens|identity_providers|organizations|secrets_store|dns_records|email|billing|images/.test(path));
          if (/^\/workers\/domains\/[^/]+$/.test(relative)) remote.domains.delete(components[2]);
          else if (/^\/workers\/scripts\/[^/]+$/.test(relative)) {
            remote.workers.delete(components[2]); remote.settings.delete(components[2]); remote.subdomains.delete(components[2]);
            remote.namespaces = remote.namespaces.filter(n => n.script !== components[2]);
            if (remote.workflow && components[2] === names.app) remote.workflow.script_deleted = true;
          } else if (/^\/containers\/applications\/[^/]+$/.test(relative)) remote.containers.delete(components[2]);
          else if (/^\/workflows\/[^/]+$/.test(relative)) remote.workflow = null;
          else if (/^\/artifacts\/namespaces\/[^/]+$/.test(relative)) { assert.equal(remote.repos.length, 0); remote.namespace = null; }
          else if (/^\/access\/apps\/[^/]+$/.test(relative)) remote.access = null;
          else throw Error('Unexpected DELETE endpoint: ' + path);
          remote.deleted.push(path);
          if (remote.loseDelete === remote.deleted.length) { remote.loseDelete = null; throw Error('DELETE response was lost'); }
          return null;
        }
        throw Error('Unexpected API request: ' + method + ' ' + path);
      },
    },
  };
  return { installer, remote, durable: () => clone(durable), changeManifest(fn) { fn(durable); installer.state = clone(durable); },
    external(binding) { remote.workers.set('unrelated-worker', { id: 'unrelated-worker', tag: 'unrelated-tag', routes: [] }); remote.settings.set('unrelated-worker', { bindings: [binding] }); },
  };
}

const deleteCalls = remote => remote.requests.filter(r => r.method === 'DELETE');
const mutations = remote => remote.requests.filter(r => r.method !== 'GET');
async function refusesWithoutMutation(f, expression) {
  await assert.rejects(uninstallPackage(f.installer, options), expression);
  assert.equal(mutations(f.remote).length, 0);
  assert.equal(f.remote.probes.some(p => p.method === 'POST'), false);
}

test('uninstall requires explicit disposition and the exact installation name before loading', async () => {
  const f = fixture();
  f.installer.load = async () => { throw Error('must not load'); };
  await assert.rejects(uninstallPackage(f.installer), /retain.*delete/);
  await assert.rejects(uninstallPackage(f.installer, { data: 'delete', confirm: config.instance + '-other' }), /confirm/);
  assert.equal(f.remote.requests.length, 0);
});

test('empty package teardown deletes only the owned package resources in dependency order', async () => {
  const f = fixture();
  const result = await uninstallPackage(f.installer, options);
  assert.equal(result.status, 'removed'); assert.equal(result.imagesRetained, true); assert.equal(result.accountResourcesRetained, true);
  assert.equal(f.remote.deleted.length, 17);
  assert.deepEqual(f.remote.deleted.slice(0, 3), [base + '/workers/domains/owned-domain-id', base + '/workers/scripts/' + names.app, base + '/workflows/' + names.workflow]);
  assert(f.remote.deleted.slice(3, 14).every(p => p.includes('/containers/applications/')));
  assert.deepEqual(f.remote.deleted.slice(14), [base + '/workers/scripts/' + names.gateway, base + '/artifacts/namespaces/' + names.namespace, base + '/access/apps/owned-access-id']);
  assert.equal(f.remote.commandCalls, 0);
  assert.deepEqual(f.remote.probes.map(p => p.path), ['/v1/lifecycle', '/v1/runs?view=all', '/v1/lifecycle/prepare-uninstall']);
  assert.equal(f.durable().removed, true);
  assert(Object.values(f.durable().packageUninstall.resources).every(r => r.intent === true && r.status === 'deleted'));
  const repeat = await uninstallPackage(f.installer, options);
  assert.equal(repeat.alreadyRemoved, true);
  assert.equal(f.remote.deleted.length, 17);
});

for (const [field, value] of Object.entries({ id: 'foreign-id', service: 'foreign-worker', hostname: 'foreign.example.com', zone_id: 'foreign-zone' })) {
  test('foreign custom domain ' + field + ' blocks all mutation', async () => {
    const f = fixture(); Object.assign(f.remote.domains.get('owned-domain-id'), { [field]: value });
    await refusesWithoutMutation(f, /domain|Hostname/);
  });
}

test('a different custom domain occupying the hostname cannot be adopted', async () => {
  const f = fixture(); f.remote.domains.set('foreign-domain', { id: 'foreign-domain', hostname: domain.hostname, zone_id: domain.zoneId, service: names.app });
  await refusesWithoutMutation(f, /different custom domain/);
});

test('deleting Workers cannot implicitly remove unrecorded domains or public routes', async () => {
  for (const edit of [
    f => f.remote.domains.set('unrecorded-domain', { id: 'unrecorded-domain', hostname: 'other.example.com', zone_id: domain.zoneId, service: names.gateway }),
    f => f.remote.workers.get(names.app).routes.push({ id: 'unrecorded-route', pattern: 'other.example.com/*' }),
  ]) {
    const f = fixture(); edit(f); await refusesWithoutMutation(f, /unrecorded custom domain|Unrecorded public routes/);
  }
});

for (const key of ['app', 'gateway']) {
  test('changed ' + key + ' immutable Worker tag blocks all mutation', async () => {
    const f = fixture(); f.remote.workers.get(names[key]).tag = 'replacement-worker';
    await refusesWithoutMutation(f, /immutable tag changed/);
  });
  test('malformed recorded ' + key + ' tag cannot silently weaken ownership', async () => {
    const f = fixture(); f.changeManifest(s => { s.resources[key].tag = ''; });
    await refusesWithoutMutation(f, /Invalid recorded.*Worker tag/);
  });
}

for (const [field, value] of Object.entries({ id: 'foreign', name: 'foreign', aud: 'foreign', domain: 'foreign.example.com' })) {
  test('foreign Access ' + field + ' blocks all mutation', async () => {
    const f = fixture(); f.remote.access[field] = value;
    await refusesWithoutMutation(f, /Access application/);
  });
}

for (const [kind, edit] of [
  ['ID', f => { f.remote.containers.get('application-recon').id = 'replacement'; }],
  ['name', f => { f.remote.containers.get('application-recon').name = 'foreign'; }],
  ['DO association', f => { f.remote.containers.get('application-recon').durable_objects.namespace_id = 'foreign'; }],
  ['DO binding', f => { f.remote.settings.get(names.gateway).bindings[0].namespace_id = 'foreign'; }],
  ['DO namespace owner', f => { f.remote.namespaces.find(n => n.id === 'namespace-recon').script = 'foreign'; }],
]) {
  test('foreign Container ' + kind + ' blocks all mutation', async () => {
    const f = fixture(); edit(f); await refusesWithoutMutation(f, /Container|Durable Object|namespace owner/);
  });
}

for (const [label, edit] of [
  ['missing owned binding', f => { f.remote.settings.get(names.app).bindings = f.remote.settings.get(names.app).bindings.filter(b => b.name !== 'RESULTS'); }],
  ['changed binding target', f => { f.remote.settings.get(names.app).bindings.find(b => b.name === 'RESULTS').workflow_name = 'foreign'; }],
  ['different script', f => { f.remote.workflow.script_name = 'foreign-worker'; }],
  ['different class', f => { f.remote.workflow.class_name = 'ForeignClass'; }],
]) {
  test('Workflow ' + label + ' blocks all mutation', async () => {
    const f = fixture(); edit(f); await refusesWithoutMutation(f, /Workflow/);
  });
}

test('every lifecycle state must be empty and all-run listing must also be empty', async () => {
  for (const edit of [
    f => { f.remote.lifecycle.runs.total = 1; },
    f => { f.remote.runs = [{ id: 'archived-run' }]; },
    f => { f.remote.lifecycle.safeToUninstall = false; },
    f => { f.remote.runs = { unrecognized: [] }; },
    f => { f.remote.lifecycle.runs.active = 1; },
    f => { f.remote.lifecycle.activeAttempt = true; },
    f => { f.remote.lifecycle.pendingPublications = 1; },
    f => { f.remote.lifecycle.stagedUploads = 1; },
  ]) {
    const f = fixture(); edit(f);
    await assert.rejects(uninstallPackage(f.installer, options), /all runs|all-run/);
    assert.equal(mutations(f.remote).length, 0);
    assert.equal(f.remote.probes.some(p => p.method === 'POST'), false);
  }
});

test('lifecycle reads require owner authentication', async () => {
  const f = fixture(); f.remote.authenticated = false;
  await assert.rejects(uninstallPackage(f.installer, options), /Authenticated/);
  assert.equal(mutations(f.remote).length, 0);
});

test('quiescence must return atomic safe, quiesced and zero-run evidence', async () => {
  for (const receipt of [
    { safeToUninstall: true, runs: { total: 0 } },
    { safeToUninstall: false, quiesced: true, runs: { total: 0 } },
    { safeToUninstall: true, quiesced: true, runs: { total: 1 } },
    { safeToUninstall: true, quiesced: true },
  ]) {
    const f = fixture(); f.remote.prepare = receipt;
    await assert.rejects(uninstallPackage(f.installer, options), /quiescence receipt/);
    assert.equal(mutations(f.remote).length, 0); assert.equal(f.durable().packageUninstall, undefined);
  }
});

test('explicit delete can clear empty-instance onboarding through the product endpoint', async () => {
  const f = fixture(); f.remote.lifecycle.safeToUninstall = false; f.remote.lifecycle.canDeleteOnboarding = true;
  assert.equal((await uninstallPackage(f.installer, options)).status, 'removed');
  assert.equal(f.remote.probes.find(p => p.method === 'POST').body, JSON.stringify({ deleteOnboarding: true }));
});

test('a lost quiescence response can be safely retried before any deletion authority exists', async () => {
  const f = fixture(), probe = f.installer.probe; let first = true;
  f.installer.probe = async function (...args) { const result = await probe.apply(this, args); if (first && args[0].endsWith('prepare-uninstall')) { first = false; throw Error('quiescence response lost'); } return result; };
  await assert.rejects(uninstallPackage(f.installer, options), /quiescence response lost/);
  assert.equal(f.remote.lifecycle.quiesced, true); assert.equal(deleteCalls(f.remote).length, 0); assert.equal(f.durable().packageUninstall, undefined);
  assert.equal((await uninstallPackage(f.installer, options)).status, 'removed');
});

test('active Containers block before quiescence or any provider mutation', async () => {
  const f = fixture(); f.remote.active.set('application-reference', [{ id: 'running-container' }]);
  await refusesWithoutMutation(f, /Active Container/);
});

test('active Container checks use the instances-v2 next_page_token contract', async () => {
  const f = fixture(); f.remote.instancePages.set('application-recon', {
    first: { success: true, result: [], result_info: { next_page_token: 'next' } },
    next: { success: true, result: [{ id: 'provisioning-container' }], result_info: {} },
  });
  await refusesWithoutMutation(f, /Active Container/);
  assert(f.remote.requests.some(r => r.path.includes('instances-v2') && r.path.includes('page_token=next')));
});

for (const [label, binding] of [
  ['app service', { type: 'service', service: names.app }],
  ['gateway service', { type: 'service', service: names.gateway }],
  ['Workflow', { type: 'workflow', workflow_name: names.workflow }],
  ['Artifacts', { type: 'artifacts', namespace: names.namespace }],
  ['pack DO ID', { type: 'durable_object_namespace', namespace_id: 'namespace-recon' }],
  ['app DO ID', { type: 'durable_object_namespace', namespace_id: 'namespace-coordinator' }],
  ['DO script', { type: 'durable_object_namespace', script_name: names.gateway, class_name: 'ReconRunner' }],
]) {
  test('external ' + label + ' consumer prevents all destructive effects', async () => {
    const f = fixture(); f.external(binding); await refusesWithoutMutation(f, /external Worker consumes/);
  });
}

test('an unrelated external Worker and namespace remain untouched', async () => {
  const f = fixture(); f.external({ type: 'artifacts', namespace: 'unrelated-namespace' });
  await uninstallPackage(f.installer, options);
  assert(f.remote.workers.has('unrelated-worker'));
  assert.equal(f.remote.deleted.some(p => /unrelated/.test(p)), false);
});

test('any repository blocks namespace and installation deletion', async () => {
  const f = fixture(); f.remote.repos = [{ id: 'valuable-repository', name: 'customer-project' }];
  await refusesWithoutMutation(f, /contains repositories/);
  assert.equal(f.remote.repos.length, 1);
});

test('a repository arriving after quiescence is preserved and deletion remains unauthorized', async () => {
  const f = fixture(); const probe = f.installer.probe;
  f.installer.probe = async function (...args) { const result = await probe.apply(this, args); if (args[0].endsWith('prepare-uninstall')) f.remote.repos.push({ name: 'new-repository' }); return result; };
  await assert.rejects(uninstallPackage(f.installer, options), /contains repositories/);
  assert.equal(deleteCalls(f.remote).length, 0); assert.equal(f.durable().packageUninstall, undefined);
});

test('resource replacement during quiescence cannot become new deletion authority', async () => {
  const f = fixture(); f.changeManifest(s => { delete s.resources.app.tag; });
  const probe = f.installer.probe;
  f.installer.probe = async function (...args) { const result = await probe.apply(this, args); if (args[0].endsWith('prepare-uninstall')) f.remote.workers.get(names.app).tag = 'replacement-after-preflight'; return result; };
  await assert.rejects(uninstallPackage(f.installer, options), /identity changed while quiescing/);
  assert.equal(deleteCalls(f.remote).length, 0); assert.equal(f.durable().packageUninstall, undefined);
});

test('retain disables owned ingress while preserving all private resources and data', async () => {
  const f = fixture(); f.remote.repos = [{ name: 'customer-data' }]; f.remote.runs = [{ id: 'run' }];
  const result = await uninstallPackage(f.installer, { ...options, data: 'retain' });
  assert.equal(result.status, 'disabled'); assert.equal(result.data, 'retained'); assert.equal(result.publicIngressVerified, true);
  assert.deepEqual(f.remote.deleted, [base + '/workers/domains/owned-domain-id']);
  assert.equal(f.remote.workers.size, 2); assert.equal(f.remote.containers.size, 11);
  assert(f.remote.workflow && f.remote.namespace && f.remote.access); assert.equal(f.remote.repos.length, 1);
  assert.equal(f.remote.probes.length, 0); assert.equal(f.remote.commandCalls, 0);
  assert([...f.remote.subdomains.values()].every(s => s.enabled === false && s.previews_enabled === false));
  assert.equal(f.durable().removed, undefined);
});

test('retain does not claim disabled while any other custom domain or public route exists', async () => {
  for (const edit of [
    f => f.remote.domains.set('unowned', { id: 'unowned', hostname: 'other.example.com', zone_id: domain.zoneId, service: names.app }),
    f => f.remote.workers.get(names.gateway).routes.push({ id: 'unowned-route', pattern: 'other.example.com/*' }),
    f => { delete f.remote.workers.get(names.app).routes; },
  ]) {
    const f = fixture(); edit(f);
    const result = await uninstallPackage(f.installer, { ...options, data: 'retain' });
    assert.equal(result.status, 'ingress-detached'); assert.equal(result.publicIngressVerified, false); assert.equal(f.durable().disabled, false);
    assert.deepEqual(f.remote.deleted, [base + '/workers/domains/owned-domain-id']);
  }
});

test('retain also validates affected Worker and domain ownership before disabling endpoints', async () => {
  const f = fixture(); f.remote.domains.get('owned-domain-id').service = 'foreign-worker';
  await assert.rejects(uninstallPackage(f.installer, { ...options, data: 'retain' }), /domain.*service/);
  assert.equal(mutations(f.remote).length, 0);
});

test('lost retain-domain DELETE response resumes without touching private resources', async () => {
  const f = fixture(); f.remote.loseDelete = 1;
  await assert.rejects(uninstallPackage(f.installer, { ...options, data: 'retain' }), /response was lost/);
  const result = await uninstallPackage(f.installer, { ...options, data: 'retain' });
  assert.equal(result.status, 'disabled'); assert.equal(f.remote.deleted.length, 1); assert.equal(f.remote.containers.size, 11);
});

test('uncertain creates are never adopted or deleted by their names', async () => {
  for (const key of ['app', 'gateway', 'domain', 'access', 'namespace', 'pack-metasploit']) {
    const f = fixture(); f.changeManifest(s => { s.resources[key] = { status: 'pending' }; });
    await refusesWithoutMutation(f, /interrupted create/);
  }
});

test('a previously ready missing resource blocks before deletion authorization', async () => {
  for (const edit of [
    f => f.remote.workers.delete(names.app), f => f.remote.domains.clear(),
    f => { f.remote.namespace = null; }, f => { f.remote.access = null; },
    f => { f.remote.workflow = null; }, f => f.remote.containers.delete('application-sqlmap'),
  ]) {
    const f = fixture(); edit(f); await refusesWithoutMutation(f, /missing without an authorized delete intent/);
  }
});

test('failure to persist authorization or per-resource intent prevents DELETE', async () => {
  for (const trigger of [s => !!s.packageUninstall, s => s.packageUninstall?.resources.domain.intent === true]) {
    const f = fixture(); f.remote.failSave = trigger;
    await assert.rejects(uninstallPackage(f.installer, options), /checkpoint unavailable/);
    assert.equal(deleteCalls(f.remote).length, 0);
  }
});

test('every lost DELETE response resumes all remaining stages from the exact durable intent', async t => {
  for (let index = 1; index <= 17; index++) await t.test('DELETE stage ' + index, async () => {
    const f = fixture(); f.remote.loseDelete = index;
    await assert.rejects(uninstallPackage(f.installer, options), /response was lost/);
    const pending = Object.values(f.durable().packageUninstall.resources).filter(r => r.status === 'delete-pending');
    assert.equal(pending.length, 1); assert.equal(pending[0].intent, true);
    f.remote.authenticated = false;
    const result = await uninstallPackage(f.installer, options);
    assert.equal(result.status, 'removed'); assert.equal(f.remote.deleted.length, 17);
    assert.equal(new Set(f.remote.deleted).size, 17); assert.equal(f.remote.commandCalls, 0);
  });
});

test('every post-DELETE checkpoint interruption resumes from its saved pre-request intent', async t => {
  const keys = ['domain', 'app', 'workflow', ...Object.keys(packs).map(p => 'pack-' + p), 'gateway', 'namespace', 'access'];
  for (const key of keys) await t.test(key, async () => {
    const f = fixture();
    f.remote.failSave = s => s.packageUninstall?.resources[key]?.status === 'deleted';
    await assert.rejects(uninstallPackage(f.installer, options), /checkpoint unavailable/);
    assert.equal(f.durable().packageUninstall.resources[key].status, 'delete-pending');
    f.remote.failSave = null;
    assert.equal((await uninstallPackage(f.installer, options)).status, 'removed');
    assert.equal(f.remote.deleted.length, 17); assert.equal(new Set(f.remote.deleted).size, 17);
  });
});

test('authorization alone does not excuse a missing resource without its own delete intent', async () => {
  const f = fixture(); f.remote.loseDelete = 1;
  await assert.rejects(uninstallPackage(f.installer, options), /response was lost/);
  f.remote.containers.delete('application-http');
  const before = f.remote.deleted.length;
  await assert.rejects(uninstallPackage(f.installer, options), /missing without an authorized delete intent/);
  assert.equal(f.remote.deleted.length, before);
});

test('resume rejects replacement Worker tags and foreign Container associations', async () => {
  for (const edit of [
    f => { f.remote.workers.get(names.gateway).tag = 'foreign-replacement'; },
    f => { f.remote.containers.get('application-nuclei').durable_objects.namespace_id = 'foreign-namespace'; },
    f => { f.remote.workflow.id = 'foreign-workflow-id'; },
  ]) {
    const f = fixture(); f.remote.loseDelete = 1;
    await assert.rejects(uninstallPackage(f.installer, options), /response was lost/);
    edit(f); const before = f.remote.deleted.length;
    await assert.rejects(uninstallPackage(f.installer, options), /changed/);
    assert.equal(f.remote.deleted.length, before);
  }
});

test('resume rejects a journal copied to a different installation or altered paths', async () => {
  for (const edit of [
    s => { s.packageUninstall.identity.installationId = 'another-installation'; },
    s => { s.packageUninstall.resources.access.path = base + '/access/apps/foreign'; },
    s => { delete s.packageUninstall.quiesced; },
  ]) {
    const f = fixture(); f.remote.loseDelete = 1;
    await assert.rejects(uninstallPackage(f.installer, options), /response was lost/);
    f.changeManifest(edit);
    await assert.rejects(uninstallPackage(f.installer, options), /different installation|path changed|quiescence/);
    assert.equal(f.remote.deleted.length, 1);
  }
});

test('new external consumers and repositories still block a resumed teardown', async () => {
  for (const edit of [f => f.external({ type: 'artifacts', namespace: names.namespace }), f => f.remote.repos.push({ name: 'late-data' })]) {
    const f = fixture(); f.remote.loseDelete = 2;
    await assert.rejects(uninstallPackage(f.installer, options), /response was lost/);
    edit(f);
    await assert.rejects(uninstallPackage(f.installer, options), /external Worker|contains repositories/);
    assert.equal(f.remote.deleted.length, 2);
  }
});

test('legacy authorization or removed flags cannot bypass the package receipt', async () => {
  const f = fixture(); f.changeManifest(s => { s.steps.deleteAuthorized = true; s.removed = true; });
  await refusesWithoutMutation(f, /completed package teardown receipt/);
});
