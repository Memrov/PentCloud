import assert from 'node:assert/strict';

const PACKS = {
  recon: 'ReconRunner', http: 'HttpRunner', nuclei: 'NucleiRunner', sqlmap: 'SqlmapRunner',
  service: 'ServiceRunner', 'web-context': 'WebContextRunner', pcap: 'PcapRunner',
  'file-analysis': 'FileRunner', password: 'PasswordRunner', reference: 'ReferenceRunner', metasploit: 'MetasploitRunner',
};
const copy = value => structuredClone(value);
const segment = value => encodeURIComponent(value);
const check = (condition, message) => assert(condition, message + '; preserve the installation and review ownership');

// API schemas checked against Cloudflare's current OpenAPI and Artifacts REST docs:
// https://developers.cloudflare.com/api/resources/workers/subresources/domains/
// https://developers.cloudflare.com/api/resources/containers/subresources/applications/
// https://developers.cloudflare.com/api/resources/workflows/methods/delete/
// https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/delete/
// https://developers.cloudflare.com/artifacts/api/rest-api/
// In particular, instances-v2 uses page_token/next_page_token, not page or cursor.
async function noActiveContainers(installer, path) {
  const seen = new Set();
  let next;
  do {
    const query = new URLSearchParams({ state: 'active', per_page: '1000', ...(next ? { page_token: next } : {}) });
    const page = await installer.api.request(path + '/instances-v2?' + query, { envelope: true });
    check(page?.success === true && Array.isArray(page?.result), 'Container instance inventory unavailable');
    check(page.result.length === 0, 'Active Container instances must drain before uninstall');
    next = page.result_info?.next_page_token;
    if (next) {
      check(typeof next === 'string' && !seen.has(next), 'Invalid Container instance pagination');
      seen.add(next);
    }
  } while (next);
}

function identity(installer) {
  const { config, names, profile, state } = installer;
  check(typeof state.installationId === 'string' && state.installationId.length > 0, 'Missing installation ownership identity');
  return { installationId: state.installationId, accountId: config.accountId, instance: config.instance, names: copy(names), domain: copy(profile.domain) };
}

function claimIdentity(key, resource, installer) {
  check(resource && typeof resource.id === 'string' && resource.id.length > 0, 'Missing ' + key + ' ownership receipt');
  const { names, config } = installer;
  if (key === 'app' || key === 'gateway') {
    check(resource.id === names[key], key + ' Worker name changed');
    check(resource.tag === undefined || typeof resource.tag === 'string' && resource.tag.length > 0, 'Invalid recorded ' + key + ' Worker tag');
    return { id: resource.id, ...(resource.tag ? { tag: resource.tag } : {}) };
  }
  if (key === 'namespace') {
    check(resource.id === names.namespace, 'Artifacts namespace identity changed');
    return { id: resource.id };
  }
  if (key === 'domain') return { id: resource.id, ...copy(installer.profile.domain), service: names.app };
  if (key === 'access') {
    check(typeof resource.aud === 'string' && resource.aud.length > 0, 'Missing Access audience receipt');
    return { id: resource.id, name: names.access, aud: resource.aud, domain: installer.profile.domain.hostname };
  }
  const pack = key.slice(5);
  check(Object.hasOwn(PACKS, pack) && resource.name === config.instance + '-' + pack && typeof resource.namespaceId === 'string' && resource.namespaceId.length > 0,
    'Tool-pack Container ownership receipt changed');
  return { id: resource.id, name: resource.name, namespaceId: resource.namespaceId, className: PACKS[pack] };
}

function paths(installer) {
  const base = '/accounts/' + segment(installer.config.accountId);
  const r = installer.state.resources, names = installer.names;
  return {
    app: base + '/workers/scripts/' + segment(names.app), gateway: base + '/workers/scripts/' + segment(names.gateway),
    domain: base + '/workers/domains/' + segment(r.domain?.id),
    workflow: base + '/workflows/' + segment(names.workflow),
    namespace: base + '/artifacts/namespaces/' + segment(names.namespace),
    access: base + '/access/apps/' + segment(r.access?.id),
    ...Object.fromEntries(Object.keys(PACKS).map(pack => ['pack-' + pack, base + '/containers/applications/' + segment(r['pack-' + pack]?.id)])),
  };
}

function assertJournal(installer, journal, mode) {
  check(journal?.schemaVersion === 1 && journal.mode === mode && journal.authorized === true, 'Invalid package uninstall authorization');
  assert.deepEqual(journal.identity, identity(installer), 'Package uninstall authorization belongs to a different installation');
  if (mode === 'delete') check(journal.quiesced?.safeToUninstall === true && journal.quiesced?.quiesced === true && journal.quiesced?.runsTotal === 0,
    'Missing durable empty-instance quiescence receipt');
}

function expectedKeys(mode) {
  return mode === 'delete' ? ['domain', 'app', 'workflow', ...Object.keys(PACKS).map(p => 'pack-' + p), 'gateway', 'namespace', 'access'] : ['domain', 'app', 'gateway'];
}

function validateClaims(installer, journal, mode) {
  const resources = installer.state.resources;
  for (const resource of Object.values(resources)) check(resource?.status !== 'pending', 'An interrupted create has uncertain ownership');
  for (const key of expectedKeys(mode).filter(k => k !== 'workflow')) {
    const claim = resources[key];
    check(claim, 'Missing ready ' + key + ' ownership receipt');
    const recorded = claimIdentity(key, claim, installer);
    const entry = journal?.resources?.[key];
    if (entry) {
      // A live Worker tag learned during the first preflight strengthens an old
      // manifest that recorded only its name. Never weaken a recorded tag.
      assert.deepEqual({ ...recorded, ...(entry.identity.tag && !recorded.tag ? { tag: entry.identity.tag } : {}) }, entry.identity,
        key + ' ownership changed since uninstall authorization');
      check(['ready', 'delete-pending', 'deleted'].includes(entry.status), 'Invalid ' + key + ' deletion receipt');
      check(entry.deleteAcknowledged === undefined || typeof entry.deleteAcknowledged === 'boolean', 'Invalid ' + key + ' deletion acknowledgement');
      check(claim.status === entry.status, key + ' deletion checkpoint disagrees with its ownership receipt');
      if (claim.status !== 'ready') check(entry.intent === true && ['delete-pending', 'deleted'].includes(claim.status), 'Missing exact ' + key + ' deletion intent');
    } else if (key === 'domain' && claim.status === 'deleted' && installer.state.packageRetain) {
      assertJournal(installer, installer.state.packageRetain, 'retain');
      const retained = installer.state.packageRetain.resources?.domain;
      check(retained?.intent === true && retained.status === 'deleted', 'Missing retained-domain deletion receipt');
      assert.deepEqual(recorded, retained.identity, 'Retained domain ownership changed');
    } else check(claim.status === 'ready', 'Uncertain ' + key + ' ownership');
  }
  if (journal) {
    assert.deepEqual(Object.keys(journal.resources).sort(), expectedKeys(mode).sort(), 'Incomplete package uninstall authorization');
    const currentPaths = paths(installer);
    for (const key of expectedKeys(mode)) assert.equal(journal.resources[key].path, currentPaths[key], 'Uninstall resource path changed');
  }
}

function mayBeMissing(installer, key, journal) {
  const entry = journal?.resources?.[key];
  if (entry) return entry.intent === true && ['delete-pending', 'deleted'].includes(entry.status);
  return key === 'domain' && installer.state.packageRetain?.resources?.domain?.intent === true && installer.state.packageRetain.resources.domain.status === 'deleted';
}

function present(installer, key, remote, journal) {
  check(remote || mayBeMissing(installer, key, journal), 'Previously ready ' + key + ' is missing without an authorized delete intent');
  check(!remote || journal?.resources?.[key]?.status !== 'deleted', 'Deleted ' + key + ' has reappeared');
  return !!remote;
}

function verifyObject(key, current, owned) {
  check(current && typeof current === 'object' && !Array.isArray(current), 'Invalid ' + key + ' ownership response');
  if (key === 'domain') {
    check(current.id === owned.id && current.hostname === owned.hostname && current.zone_id === owned.zoneId && current.service === owned.service,
      'Custom domain ID, hostname, zone or service changed');
  } else if (key === 'access') {
    check(current.id === owned.id && current.name === owned.name && current.aud === owned.aud && current.domain === owned.domain, 'Access application identity, name, domain or audience changed');
  } else if (key.startsWith('pack-')) {
    check(current.id === owned.id && current.name === owned.name && current.durable_objects?.namespace_id === owned.namespaceId,
      'Tool-pack Container ID, name or Durable Object association changed');
  } else if (key === 'workflow') {
    check(current.id === owned.id && current.name === owned.name && current.script_name === owned.scriptName && current.class_name === owned.className,
      'Result Workflow ownership changed');
  } else if (key === 'namespace') {
    check((current.namespace === undefined || current.namespace === owned.id) && (current.name === undefined || current.name === owned.id), 'Artifacts namespace identity changed');
  }
}

async function inventory(installer, journal, mode) {
  const base = '/accounts/' + segment(installer.config.accountId), api = installer.api;
  const workers = await api.list(base + '/workers/scripts');
  const domains = await api.list(base + '/workers/domains');
  check(Array.isArray(workers) && Array.isArray(domains), 'Worker or custom-domain inventory unavailable');
  const resources = {}, settings = {};
  for (const key of ['app', 'gateway']) {
    const owned = journal?.resources[key]?.identity ?? claimIdentity(key, installer.state.resources[key], installer);
    const current = workers.find(w => w.id === owned.id);
    if (present(installer, key, current, journal)) {
      check(!owned.tag || current.tag === owned.tag, key + ' Worker immutable tag changed');
      settings[key] = await api.request(base + '/workers/scripts/' + segment(owned.id) + '/settings');
      check(Array.isArray(settings[key]?.bindings), key + ' Worker binding inventory unavailable');
    }
    resources[key] = { identity: { ...owned, ...(current?.tag ? { tag: current.tag } : {}) }, path: base + '/workers/scripts/' + segment(owned.id), current };
  }
  const allPaths = paths(installer);
  for (const key of expectedKeys(mode).filter(k => !['app', 'gateway', 'workflow'].includes(k))) {
    const owned = journal?.resources[key]?.identity ?? claimIdentity(key, installer.state.resources[key], installer);
    const current = await api.request(allPaths[key], { missing: true });
    if (present(installer, key, current, journal)) verifyObject(key, current, owned);
    if (key === 'domain') {
      check(!domains.some(d => d.hostname === owned.hostname && d.id !== owned.id), 'Hostname now belongs to a different custom domain');
      check(!domains.some(d => d.id === owned.id && (d.hostname !== owned.hostname || d.zone_id !== owned.zoneId || d.service !== owned.service)), 'Custom-domain inventory disagrees with ownership');
    }
    resources[key] = { identity: owned, path: allPaths[key], current };
  }
  if (mode === 'retain') return { resources, workers, domains, settings };

  check(!domains.some(d => [installer.names.app, installer.names.gateway].includes(d.service) && d.id !== resources.domain.identity.id),
    'An unrecorded custom domain uses a package Worker');
  check(!workers.some(w => [installer.names.app, installer.names.gateway].includes(w.id) && w.routes?.length > 0),
    'Unrecorded public routes use a package Worker');

  const appBindings = settings.app?.bindings;
  if (appBindings) {
    check(appBindings.some(b => b.name === 'TOOL_PACKS' && b.service === installer.names.gateway && b.entrypoint === 'ToolPackGateway'), 'Package gateway binding changed');
    check(appBindings.some(b => b.name === 'ARTIFACTS' && b.namespace === installer.names.namespace), 'Package Artifacts binding changed');
    check(appBindings.some(b => b.name === 'RESULTS' && b.workflow_name === installer.names.workflow && b.class_name === 'ResultValidation' && (!b.script_name || b.script_name === installer.names.app)), 'Owned app Result Workflow binding changed');
  } else check(journal?.resources.workflow?.identity, 'Cannot prove Workflow ownership after the app disappeared');
  const workflow = await api.request(allPaths.workflow, { missing: true });
  const workflowOwned = journal?.resources.workflow?.identity ?? { id: workflow?.id, name: installer.names.workflow, scriptName: installer.names.app, className: 'ResultValidation' };
  if (present(installer, 'workflow', workflow, journal)) {
    check(typeof workflowOwned.id === 'string' && workflowOwned.id.length > 0, 'Missing Workflow provider identity');
    verifyObject('workflow', workflow, workflowOwned);
  }
  resources.workflow = { identity: workflowOwned, path: allPaths.workflow, current: workflow };

  const namespaces = await api.list(base + '/workers/durable_objects/namespaces');
  check(Array.isArray(namespaces), 'Durable Object namespace inventory unavailable');
  const ownedDoNamespaces = new Set(journal?.ownedDoNamespaces ?? []);
  for (const n of namespaces) if ([installer.names.app, installer.names.gateway].includes(n.script)) {
    check(typeof n.id === 'string' && n.id.length > 0, 'Missing Durable Object provider identity');
    ownedDoNamespaces.add(n.id);
  }
  for (const [key, data] of Object.entries(settings)) for (const b of data.bindings) {
    if (b.namespace_id && (!b.script_name || b.script_name === installer.names[key])) {
      check(namespaces.some(n => n.id === b.namespace_id && n.script === installer.names[key] && n.class === b.class_name), 'Local Durable Object association changed');
      ownedDoNamespaces.add(b.namespace_id);
    }
  }
  for (const pack of Object.keys(PACKS)) {
    const key = 'pack-' + pack, resource = resources[key];
    if (!resource.current) continue;
    const owned = resource.identity;
    check(settings.gateway?.bindings.some(b => b.class_name === owned.className && b.namespace_id === owned.namespaceId && (!b.script_name || b.script_name === installer.names.gateway)),
      'Tool-pack gateway Durable Object binding changed');
    check(namespaces.some(n => n.id === owned.namespaceId && n.script === installer.names.gateway && n.class === owned.className), 'Tool-pack namespace owner changed');
    ownedDoNamespaces.add(owned.namespaceId);
    await noActiveContainers(installer, resource.path);
  }
  for (const worker of workers.filter(w => ![installer.names.app, installer.names.gateway].includes(w.id))) {
    check(typeof worker.id === 'string' && worker.id.length > 0, 'External Worker identity unavailable');
    const external = await api.request(base + '/workers/scripts/' + segment(worker.id) + '/settings');
    check(Array.isArray(external?.bindings), 'External Worker binding inventory unavailable');
    check(!external.bindings.some(b => [installer.names.app, installer.names.gateway].includes(b.service) ||
      [installer.names.app, installer.names.gateway].includes(b.script_name) || b.workflow_name === installer.names.workflow ||
      (b.namespace === installer.names.namespace && (!b.type || b.type === 'artifacts')) || ownedDoNamespaces.has(b.namespace_id)),
    'An external Worker consumes package resources');
  }
  if (resources.namespace.current) {
    const repos = await api.list(allPaths.namespace + '/repos', { cursor: true });
    check(Array.isArray(repos) && repos.length === 0, 'Artifacts namespace contains repositories; purge them through the product lifecycle first');
  }
  return { resources, workers, domains, settings, ownedDoNamespaces: [...ownedDoNamespaces].sort() };
}

function journalResources(snapshot, prior) {
  return Object.fromEntries(Object.entries(snapshot.resources).map(([key, r]) => [key, {
    identity: copy(r.identity), path: r.path, status: prior?.resources[key]?.status ?? (r.current ? 'ready' : 'deleted'),
    ...(prior?.resources[key]?.intent || !r.current ? { intent: true } : {}),
  }]));
}

async function readDeletionTarget(installer, entry, key) {
  if (key !== 'app' && key !== 'gateway') return installer.api.request(entry.path, { missing: true });
  // Worker DELETE returns no object receipt. The script list exposes its immutable tag.
  const workers = await installer.api.list('/accounts/' + segment(installer.config.accountId) + '/workers/scripts');
  check(Array.isArray(workers), 'Worker deletion inventory unavailable');
  const matching = workers.filter(worker => worker.id === entry.identity.id);
  check(matching.length <= 1, key + ' Worker deletion identity is ambiguous');
  return matching[0] ?? null;
}

function verifyDeletionTarget(key, current, entry) {
  if (key === 'app' || key === 'gateway') check(!entry.identity.tag || current.tag === entry.identity.tag, key + ' Worker immutable tag changed');
  else verifyObject(key, current, entry.identity);
}

async function confirmDeletion(installer, entry, key, { now, sleep, timeoutMs, pollIntervalMs }) {
  const deadline = now() + timeoutMs;
  const pending = () => new Error(key + ' deletion is still pending; retry uninstall to confirm absence; preserve the installation and review ownership');
  let expired = false, timer;
  const open = () => { if (expired || now() >= deadline) throw pending(); };
  const poll = async () => {
    for (;;) {
      open();
      let current, transition = false;
      try { current = await readDeletionTarget(installer, entry, key); }
      catch (error) {
        // A structured 409 read is inconclusive, never proof of absence. In
        // particular, Artifacts uses 409 while activation/deletion is in progress.
        if (error?.code !== 'PC_CLOUDFLARE_API' || error.httpStatus !== 409) throw error;
        transition = true;
      }
      open();
      if (!transition) {
        if (current === null) return;
        verifyDeletionTarget(key, current, entry);
      }
      await sleep(Math.min(pollIntervalMs, deadline - now()));
    }
  };
  try {
    // The wall-clock deadline also bounds a read that never resolves. Once it
    // expires, a late read cannot schedule another poll or update the journal.
    await Promise.race([poll(), new Promise((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(pending()); }, timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function remove(installer, journal, key, verification) {
  const entry = journal.resources[key];
  if (entry.status === 'deleted') return;
  // Save before every DELETE, including retries after a lost response. An absent
  // resource without this exact intent is never interpreted as our deletion.
  entry.intent = true; entry.status = 'delete-pending';
  if (installer.state.resources[key]) installer.state.resources[key].status = 'delete-pending';
  await installer.save();
  if (!entry.deleteAcknowledged) {
    const current = await readDeletionTarget(installer, entry, key);
    if (current !== null) {
      verifyDeletionTarget(key, current, entry);
      if (key.startsWith('pack-')) await noActiveContainers(installer, entry.path);
      if (key === 'namespace') {
        const repos = await installer.api.list(entry.path + '/repos', { cursor: true });
        check(Array.isArray(repos) && repos.length === 0, 'Artifacts namespace contains repositories');
      }
      await installer.api.request(entry.path, { method: 'DELETE', missing: true });
      entry.deleteAcknowledged = true;
      // A successful response acknowledges the request, not resource absence.
      // Persist it so a resumed asynchronous deletion only reads, never resends.
      await installer.save();
    }
  }
  if (entry.deleteAcknowledged) await confirmDeletion(installer, entry, key, verification);
  entry.status = 'deleted';
  if (installer.state.resources[key]) installer.state.resources[key].status = 'deleted';
  await installer.save();
}

async function disableWorkerIngress(installer, snapshot) {
  for (const key of ['app', 'gateway']) if (snapshot.resources[key].current) {
    const path = snapshot.resources[key].path + '/subdomain';
    await installer.api.request(path, { method: 'POST', body: { enabled: false, previews_enabled: false } });
    const current = await installer.api.request(path);
    check(current?.enabled === false && current?.previews_enabled === false, key + ' workers.dev or preview endpoint remains enabled');
  }
}

function emptyLifecycle(status, allowOnboarding = false) {
  return status?.runs?.total === 0 && ['active', 'archived', 'trashed', 'purging'].every(k => status.runs[k] === undefined || status.runs[k] === 0) &&
    ['activeAttempt', 'preparingInput'].every(k => status[k] === undefined || status[k] === false) &&
    ['pendingPublications', 'pendingPurges', 'ownedProjects'].every(k => status[k] === undefined || status[k] === 0) &&
    (allowOnboarding && status.canDeleteOnboarding === true || status.stagedUploads === undefined || status.stagedUploads === 0);
}

/**
 * Package-only teardown. installer supplies config/accountId+instance, names,
 * profile.domain, load()/save(), api.request()/list(), and authenticated
 * probe(path, true, fetchOptions). No Wrangler, image, model or scanner command
 * is run. save() must durably checkpoint before resolving; callers serialize
 * operations with the installation lock. All provider API responses are already
 * unwrapped by api.request except explicit {envelope:true} instance inventories.
 */
export async function uninstallPackage(installer, { data, confirm } = {}, verificationOptions = {}) {
  assert(['retain', 'delete'].includes(data), 'Choose --data retain or --data delete explicitly');
  assert.equal(confirm, installer.config.instance, '--confirm must match the installation name');
  const verification = { now: () => performance.now(), sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs: 60_000, pollIntervalMs: 1000, ...verificationOptions };
  assert(typeof verification.now === 'function' && typeof verification.sleep === 'function' &&
    Number.isFinite(verification.timeoutMs) && verification.timeoutMs > 0 && verification.timeoutMs <= 60_000 &&
    Number.isFinite(verification.pollIntervalMs) && verification.pollIntervalMs > 0, 'Invalid deletion verification budget');
  await installer.load();
  check(installer.state.resources && installer.state.packageProfile, 'A package installation manifest is required');
  const mode = data, journalKey = mode === 'delete' ? 'packageUninstall' : 'packageRetain';
  let journal = installer.state[journalKey];
  if (journal) assertJournal(installer, journal, mode);
  check(!installer.state.packageUninstall || mode === 'delete', 'Destructive package teardown has already started');
  validateClaims(installer, journal, mode);
  if (installer.state.removed) {
    check(journal && expectedKeys(mode).every(k => journal.resources[k]?.status === 'deleted'), 'Missing completed package teardown receipt');
    return { status: 'removed', data: 'deleted', alreadyRemoved: true, manifestRetained: true, imagesRetained: true, accountResourcesRetained: true };
  }
  let snapshot = await inventory(installer, journal, mode);
  if (mode === 'delete' && !journal) {
    const lifecycle = await installer.probe('/v1/lifecycle', true);
    const runs = await installer.probe('/v1/runs?view=all', true);
    check(lifecycle.status === 200 && runs.status === 200, 'Authenticated lifecycle and all-run reads are required');
    const status = await lifecycle.json(), payload = await runs.json();
    const all = Array.isArray(payload) ? payload : payload.runs;
    check((status.safeToUninstall === true || status.canDeleteOnboarding === true) && emptyLifecycle(status, true) && Array.isArray(all) && all.length === 0,
      'Purge all runs and drain owned work before uninstall');
    const response = await installer.probe('/v1/lifecycle/prepare-uninstall', true, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deleteOnboarding: true }),
    });
    check(response.status === 200, 'Cannot atomically quiesce admissions');
    const receipt = await response.json();
    check(receipt.safeToUninstall === true && receipt.quiesced === true && emptyLifecycle(receipt), 'Missing atomic empty-instance quiescence receipt');
    // Check ownership, external consumers, active instances and repositories
    // again after admissions are closed, before granting deletion authority.
    const after = await inventory(installer, null, mode);
    assert.deepEqual(Object.fromEntries(Object.entries(after.resources).map(([k, r]) => [k, r.identity])),
      Object.fromEntries(Object.entries(snapshot.resources).map(([k, r]) => [k, r.identity])), 'Resource identity changed while quiescing');
    assert.deepEqual(after.ownedDoNamespaces, snapshot.ownedDoNamespaces, 'Durable Object identity changed while quiescing');
    snapshot = after;
    journal = { schemaVersion: 1, mode, authorized: true, identity: identity(installer),
      quiesced: { safeToUninstall: true, quiesced: true, runsTotal: 0 },
      ownedDoNamespaces: snapshot.ownedDoNamespaces, resources: journalResources(snapshot),
    };
    installer.state[journalKey] = journal;
    await installer.save();
  } else if (!journal) {
    journal = { schemaVersion: 1, mode, authorized: true, identity: identity(installer), resources: journalResources(snapshot) };
    installer.state[journalKey] = journal;
    await installer.save();
  }
  await disableWorkerIngress(installer, snapshot);
  if (mode === 'retain') {
    await remove(installer, journal, 'domain', verification);
    const workers = await installer.api.list('/accounts/' + segment(installer.config.accountId) + '/workers/scripts');
    const domains = await installer.api.list('/accounts/' + segment(installer.config.accountId) + '/workers/domains');
    const ownedWorkers = workers.filter(w => [installer.names.app, installer.names.gateway].includes(w.id));
    const otherDomains = domains.filter(d => [installer.names.app, installer.names.gateway].includes(d.service));
    const routesKnown = ownedWorkers.length === 2 && ownedWorkers.every(w => Array.isArray(w.routes));
    const remainingRoutes = ownedWorkers.some(w => w.routes?.length > 0);
    const disabled = routesKnown && !remainingRoutes && otherDomains.length === 0;
    installer.state.disabled = disabled;
    await installer.save();
    return { status: disabled ? 'disabled' : 'ingress-detached', data: 'retained', publicIngressVerified: disabled,
      manifestRetained: true, imagesRetained: true, accountResourcesRetained: true,
      warning: disabled ? 'Private Workers, Containers, Durable Object data, events and Artifacts remain installed' :
        'The owned domain and workers.dev/previews were disabled; other public routes exist or route inventory is incomplete. Private resources and data remain installed' };
  }
  for (const key of expectedKeys(mode)) await remove(installer, journal, key, verification);
  installer.state.removed = true;
  await installer.save();
  return { status: 'removed', data: 'deleted', manifestRetained: true, imagesRetained: true, accountResourcesRetained: true,
    warning: 'Shared image repositories and account resources are retained; provider logs and backups follow provider retention' };
}
