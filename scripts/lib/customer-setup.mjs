// Read-only discovery and private prompts. Official cf owns its authentication
// session; callers own review, configuration persistence and provisioning.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const name = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !controls.test(value);
const dnsName = value => typeof value === 'string' && value.length <= 253 && value.includes('.')
  && value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
const teamLabel = value => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
const enabled = value => Boolean(value) && !['false', '0'].includes(String(value).toLowerCase());
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export async function collectCustomerSetup({ run, ask, choose, login, environment = process.env }) {
  requireValue(!enabled(environment.CI) && !enabled(environment.GITHUB_ACTIONS),
    'Guided setup requires an interactive session; provide a private configuration in CI');
  requireValue(typeof run === 'function' && typeof ask === 'function' && typeof choose === 'function',
    'Guided setup requires discovery and interactive prompt callbacks');
  let env = { ...environment, CI: 'true', CF_SEND_TELEMETRY: 'false' };
  const read = async (args, { missing = false } = {}) => {
    let output;
    try { output = await run('cf', args, { env, accountAuthorization: true, ...(missing ? { missing: true } : {}) }); }
    catch (error) {
      // Only typed absence can authorize a proposed new organization. Generic
      // CLI failures can also mean missing permissions or a failed connection.
      if (missing && (error?.statusCode === 404 || error?.status === 404)) return null;
      throw new Error('Cloudflare setup discovery failed; check your session and account permissions');
    }
    // cf prints no stdout when a successful API command returns null/undefined.
    // This is meaningful only for the organization get, never for a listing.
    if (missing && Buffer.isBuffer(output) && output.toString().trim() === '') return null;
    let value;
    try {
      requireValue(Buffer.isBuffer(output), 'Invalid output');
      value = JSON.parse(output.toString());
    } catch { throw new Error('Cloudflare setup discovery returned invalid JSON'); }
    requireValue(!object(value) || value.success !== false, 'Cloudflare setup discovery failed; check your session and account permissions');
    return object(value) && Object.hasOwn(value, 'result') ? value.result : value;
  };
  const list = async args => {
    const items = [];
    let previous;
    for (let page = 1; page <= 1000; page++) {
      const result = await read([...args, '--page', String(page), '--per-page', '50']);
      requireValue(Array.isArray(result), 'Cloudflare setup listing returned an unexpected shape');
      const fingerprint = JSON.stringify(result);
      requireValue(fingerprint !== previous, 'Cloudflare setup listing returned a repeated page');
      items.push(...result);
      if (result.length < 50) return items;
      previous = fingerprint;
    }
    throw new Error('Cloudflare setup listing exceeded the discovery page limit');
  };
  const select = async (label, items, emptyMessage, labelFor) => {
    requireValue(items.length > 0, emptyMessage);
    if (items.length === 1) return items[0].id;
    let selected;
    try { selected = await choose(label, items.map(item => ({ label: labelFor(item), value: item.id }))); }
    catch { throw new Error('Cloudflare setup selection did not complete'); }
    requireValue(items.some(item => item.id === selected), 'Cloudflare setup selection must match an available account or zone');
    return selected;
  };
  const prompt = async (label, defaultValue, valid, message) => {
    let value;
    try { value = await ask(label, defaultValue); }
    catch { throw new Error('Private setup prompt did not complete'); }
    requireValue(typeof value === 'string' && !controls.test(value), message);
    value = value.trim() || defaultValue || '';
    requireValue(valid(value), message);
    return value;
  };
  const sessionAvailable = async () => {
    const session = await read(['auth', 'whoami']);
    requireValue(object(session) && typeof session.authenticated === 'boolean'
      && (session.tokenValid == null || typeof session.tokenValid === 'boolean'), 'Cloudflare session discovery returned an unexpected shape');
    return session.authenticated && session.tokenValid !== false;
  };

  if (!await sessionAvailable()) {
    requireValue(!environment.CLOUDFLARE_API_TOKEN && typeof login === 'function',
      'Cloudflare session unavailable; run cf auth login or correct the supplied API token');
    try { await login(); }
    catch { throw new Error('Cloudflare sign-in did not complete; run cf auth login and retry'); }
    requireValue(await sessionAvailable(), 'Cloudflare session unavailable after sign-in; run cf auth login and retry');
  }
  const accounts = await list(['accounts', 'list']);
  requireValue(accounts.every(item => object(item) && identifier(item.id) && name(item.name)),
    'Cloudflare account discovery returned an unexpected shape');
  const accountId = await select('Cloudflare account', accounts, 'No Cloudflare accounts are available', item => item.name);
  env = { ...env, CLOUDFLARE_ACCOUNT_ID: accountId };
  const discoveredZones = await list(['zones', 'list', '--account-id', accountId, '--status', 'active']);
  requireValue(discoveredZones.every(zone => object(zone) && identifier(zone.id) && dnsName(zone.name)
    && identifier(zone.account?.id) && typeof zone.status === 'string'), 'Cloudflare zone discovery returned an unexpected shape');
  // Validate the CLI filter locally as well; never trust a default account or
  // adopt a pending, inactive or foreign zone from a broader token's results.
  const zones = discoveredZones.filter(zone => zone.account.id === accountId && zone.status === 'active');
  const zoneId = await select('Domain zone', zones, 'No active domain zone is available for the selected Cloudflare account', item => item.name);
  const zone = zones.find(item => item.id === zoneId);
  const instance = await prompt('Instance name', 'my-pentcloud', value => /^[a-z][a-z0-9-]{2,37}$/.test(value),
    'Instance name must use 3–38 lowercase letters, digits or hyphens and start with a letter');
  const adminEmail = await prompt('Owner email', undefined, value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), 'Provide a valid owner email');
  const hostname = await prompt('Unused app hostname', `pentcloud.${zone.name}`,
    value => dnsName(value) && value.endsWith(`.${zone.name}`), 'App hostname must be an unused subdomain of the selected zone');
  const organization = await read(['zero-trust', 'organization', 'get'], { missing: true });
  let accessTeamDomain, accessBootstrap;
  if (organization === null) {
    const label = await prompt('New Zero Trust team label', instance, teamLabel, 'New Zero Trust team label must be a lowercase DNS label');
    const organizationName = await prompt('Zero Trust organization name', instance, name, 'Provide a valid Zero Trust organization name');
    accessTeamDomain = `https://${label}.cloudflareaccess.com`;
    accessBootstrap = { organizationName, onetimepin: true };
  } else {
    requireValue(object(organization) && typeof organization.auth_domain === 'string'
      && organization.auth_domain.endsWith('.cloudflareaccess.com')
      && teamLabel(organization.auth_domain.slice(0, -'.cloudflareaccess.com'.length)),
    'Cloudflare Access organization returned an unexpected team domain');
    requireValue(organization.name === undefined || name(organization.name), 'Cloudflare Access organization returned an unexpected name');
    accessTeamDomain = `https://${organization.auth_domain}`;
    const providers = await list(['zero-trust', 'identity-providers', 'list']);
    requireValue(providers.every(provider => object(provider) && name(provider.id) && name(provider.type)),
      'Cloudflare identity provider discovery returned an unexpected shape');
    if (providers.length === 0) accessBootstrap = { organizationName: organization.name ?? instance, onetimepin: true };
  }
  const records = await list(['dns', 'records', 'list', '--zone', zoneId, '--name', hostname]);
  requireValue(records.length === 0, 'App hostname is already in use; choose an unused subdomain');
  return { schemaVersion: 2, accountId, instance, accessTeamDomain, allowedEmails: [adminEmail],
    domain: { zoneId, hostname }, ...(accessBootstrap ? { accessBootstrap } : {}) };
}
