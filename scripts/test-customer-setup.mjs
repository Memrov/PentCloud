import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectCustomerSetup as collect } from './lib/customer-setup.mjs';

const accountId = 'a'.repeat(32);
const otherAccountId = 'b'.repeat(32);
const zoneId = 'c'.repeat(32);
const secondZoneId = 'd'.repeat(32);
const json = value => Buffer.from(JSON.stringify(value));
const commands = {
  session: ['auth', 'whoami'],
  accounts: ['accounts', 'list', '--page', '1', '--per-page', '50'],
  zones: ['zones', 'list', '--account-id', accountId, '--status', 'active', '--page', '1', '--per-page', '50'],
  organization: ['zero-trust', 'organization', 'get'],
  providers: ['zero-trust', 'identity-providers', 'list', '--page', '1', '--per-page', '50'],
  dns: ['dns', 'records', 'list', '--zone', zoneId, '--name', 'pentcloud.example.com', '--page', '1', '--per-page', '50'],
};
const prefixes = {
  session: ['auth', 'whoami'], accounts: ['accounts', 'list'], zones: ['zones', 'list'],
  organization: ['zero-trust', 'organization', 'get'],
  providers: ['zero-trust', 'identity-providers', 'list'], dns: ['dns', 'records', 'list'],
};

function fixture({ accounts, zones, organization, providers, responses = {}, answers = {}, selections = {} } = {}) {
  const calls = [], prompts = [], choices = [];
  const values = {
    session: { authenticated: true, tokenValid: true, authSource: 'OAuth token', accounts: [] },
    accounts: accounts ?? [{ id: accountId, name: 'Customer account' }],
    zones: zones ?? [{ id: zoneId, name: 'example.com', status: 'active', account: { id: accountId, name: 'Customer account' } }],
    organization: organization === undefined ? { auth_domain: 'established-team.cloudflareaccess.com', name: 'Established team' } : organization,
    providers: providers ?? [{ id: 'existing-idp', name: 'Company SSO', type: 'oidc', config: {} }],
    dns: [],
    ...responses,
  };
  const run = async (kind, args, settings) => {
    calls.push({ kind, args, settings });
    assert.equal(kind, 'cf');
    const key = Object.keys(prefixes).find(key => args.slice(0, prefixes[key].length).join(' ') === prefixes[key].join(' '));
    assert(key, 'Only verified discovery commands are allowed');
    const value = typeof values[key] === 'function' ? await values[key](args, settings) : values[key];
    if (value instanceof Error) throw value;
    return Buffer.isBuffer(value) ? value : json(value);
  };
  const ask = async (label, defaultValue) => {
    prompts.push({ label, defaultValue });
    if (Object.hasOwn(answers, label)) return answers[label];
    if (label === 'Owner email') return 'owner@example.net';
    if (defaultValue !== undefined) return defaultValue;
    assert.fail(`Unexpected prompt: ${label}`);
  };
  const choose = async (label, options) => {
    choices.push({ label, options });
    return selections[label] ?? options[0].value;
  };
  return { run, ask, choose, environment: {}, calls, prompts, choices };
}

test('discovery selects the customer account and zone and preserves the actual Access team', async () => {
  const options = fixture({
    accounts: [{ id: otherAccountId, name: 'Other account' }, { id: accountId, name: 'Customer account' }],
    zones: [
      { id: zoneId, name: 'example.com', status: 'active', account: { id: accountId, name: 'Customer account' } },
      { id: secondZoneId, name: 'example.org', status: 'active', account: { id: accountId, name: 'Customer account' } },
    ],
    selections: { 'Cloudflare account': accountId, 'Domain zone': zoneId },
  });
  const config = await collect(options);
  assert.deepEqual(config, {
    schemaVersion: 2, accountId, instance: 'my-pentcloud',
    accessTeamDomain: 'https://established-team.cloudflareaccess.com',
    allowedEmails: ['owner@example.net'], domain: { zoneId, hostname: 'pentcloud.example.com' },
  });
  assert.deepEqual(options.choices.map(({ label, options }) => ({ label, options })), [
    { label: 'Cloudflare account', options: [{ label: 'Other account', value: otherAccountId }, { label: 'Customer account', value: accountId }] },
    { label: 'Domain zone', options: [{ label: 'example.com', value: zoneId }, { label: 'example.org', value: secondZoneId }] },
  ]);
  assert.deepEqual(options.calls.map(({ args }) => args), Object.values(commands));
  for (const call of options.calls.slice(2)) {
    assert.equal(call.settings.env.CLOUDFLARE_ACCOUNT_ID, accountId);
    assert.equal(call.settings.accountAuthorization, true);
  }
  assert(!options.prompts.some(({ label }) => label.includes('team') || label.includes('organization')));
});

test('zones from another account and inactive zones cannot become the selected domain', async () => {
  const options = fixture({ zones: [
    { id: secondZoneId, name: 'foreign.example', status: 'active', account: { id: otherAccountId, name: 'Other account' } },
    { id: 'e'.repeat(32), name: 'pending.example', status: 'pending', account: { id: accountId, name: 'Customer account' } },
    { id: zoneId, name: 'example.com', status: 'active', account: { id: accountId, name: 'Customer account' } },
  ] });
  const config = await collect(options);
  assert.deepEqual(config.domain, { zoneId, hostname: 'pentcloud.example.com' });
  assert.equal(options.choices.length, 0, 'The sole eligible account and zone need no choice prompt');
});

test('a missing official session invokes login once and retries the session check', async () => {
  let loggedIn = false, logins = 0;
  const options = fixture({ responses: { session: () => loggedIn
    ? { authenticated: true, tokenValid: true }
    : { authenticated: false, error: 'Not logged in' } } });
  options.login = async () => { logins++; loggedIn = true; };
  const config = await collect(options);
  assert.equal(config.accountId, accountId);
  assert.equal(logins, 1);
  assert.deepEqual(options.calls.slice(0, 3).map(({ args }) => args), [commands.session, commands.session, commands.accounts]);
});

test('a failed login retry stops after one browser callback without collecting private answers', async () => {
  let logins = 0;
  const options = fixture({ responses: { session: { authenticated: false, error: 'Not logged in' } } });
  options.login = async () => { logins++; };
  await assert.rejects(collect(options), /session|sign.in/i);
  assert.equal(logins, 1);
  assert.equal(options.calls.length, 2);
  assert.equal(options.prompts.length, 0);
});

test('an explicitly supplied invalid API token never starts an interactive login', async () => {
  const options = fixture({ responses: { session: { authenticated: true, tokenValid: false } } });
  options.environment = { CLOUDFLARE_API_TOKEN: 'fixture-private-token' };
  options.login = () => assert.fail('An environment credential must be corrected explicitly');
  await assert.rejects(collect(options), /session|token|sign.in/i);
  assert.equal(options.prompts.length, 0);
});

test('CI and GitHub Actions calls fail before discovery, login or prompting', async () => {
  for (const environment of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true', CI: '' }]) {
    const options = fixture();
    options.environment = environment;
    options.login = () => assert.fail('CI cannot open a browser');
    await assert.rejects(collect(options), /interactive|private configuration/i);
    assert.equal(options.calls.length, 0);
    assert.equal(options.prompts.length, 0);
    assert.equal(options.choices.length, 0);
  }
});

test('an existing Access organization with no providers requests only missing one-time PIN bootstrap', async () => {
  const options = fixture({ providers: [] });
  const config = await collect(options);
  assert.equal(config.accessTeamDomain, 'https://established-team.cloudflareaccess.com');
  assert.deepEqual(config.accessBootstrap, { organizationName: 'Established team', onetimepin: true });
  assert(!options.prompts.some(({ label }) => label.includes('team') || label.includes('organization')));
  assert(options.calls.every(({ args }) => !args.includes('create') && !args.includes('update')));
});

test('a missing Access organization collects a new team and organization without creating either', async () => {
  const options = fixture({ organization: null, answers: {
    'New Zero Trust team label': 'new-customer-team', 'Zero Trust organization name': 'New customer team',
  } });
  const config = await collect(options);
  assert.equal(config.accessTeamDomain, 'https://new-customer-team.cloudflareaccess.com');
  assert.deepEqual(config.accessBootstrap, { organizationName: 'New customer team', onetimepin: true });
  assert(!options.calls.some(({ args }) => args.includes('create') || args.includes('update') || args.includes('identity-providers')));
});

test('only an explicit missing-organization status permits a new team bootstrap', async () => {
  const options = fixture({ responses: { organization: Object.assign(new Error('private response body'), { statusCode: 404 }) } });
  const config = await collect(options);
  assert.equal(config.accessTeamDomain, 'https://my-pentcloud.cloudflareaccess.com');
  assert.deepEqual(config.accessBootstrap, { organizationName: 'my-pentcloud', onetimepin: true });
});

test('successful empty organization stdout represents the official CLI null-result output', async () => {
  const options = fixture({ responses: { organization: Buffer.alloc(0) } });
  const config = await collect(options);
  assert.equal(config.accessTeamDomain, 'https://my-pentcloud.cloudflareaccess.com');
  assert.deepEqual(config.accessBootstrap, { organizationName: 'my-pentcloud', onetimepin: true });
});

test('only the organization lookup requests the private missing-result adapter hint', async () => {
  const options = fixture();
  await collect(options);
  assert.equal(options.calls.find(({ args }) => args.join(' ') === 'zero-trust organization get').settings.missing, true);
  assert(options.calls.filter(({ args }) => args.join(' ') !== 'zero-trust organization get').every(({ settings }) => settings.missing === undefined));
});

test('an occupied hostname fails without returning a configuration or modifying DNS', async () => {
  const options = fixture({ responses: { dns: [{ id: 'existing-record', name: 'pentcloud.example.com', type: 'CNAME', content: 'existing.example.net' }] } });
  await assert.rejects(collect(options), /hostname.*in use|unused.*subdomain/i);
  assert(options.calls.every(({ args }) => !args.includes('create') && !args.includes('delete') && !args.includes('update')));
});

test('an invalid selection cannot escape the discovered account or zone list', async () => {
  const options = fixture({
    accounts: [{ id: otherAccountId, name: 'Other account' }, { id: accountId, name: 'Customer account' }],
    selections: { 'Cloudflare account': 'f'.repeat(32) },
  });
  await assert.rejects(collect(options), /selection|account/i);
  assert.equal(options.calls.length, 2);
});

test('an account without an active owned zone stops before prompting for private values', async () => {
  const options = fixture({ zones: [{ id: zoneId, name: 'foreign.example', status: 'active', account: { id: otherAccountId } }] });
  await assert.rejects(collect(options), /active.*zone|zone.*available/i);
  assert.equal(options.prompts.length, 0);
  assert.equal(options.choices.length, 0);
});

test('malformed discovery responses and provider failures never expose private response content', async t => {
  for (const [key, value] of [
    ['session', { email: 'private-person@example.net' }],
    ['accounts', { accounts: 'private-person@example.net' }],
    ['accounts', [{ id: accountId, name: 'private-person@example.net' }, { id: 'bad', name: 'bad account' }]],
    ['zones', [{ id: zoneId, name: 'example.com', status: 'active' }]],
    ['organization', { auth_domain: 'private-person@example.net' }],
    ['providers', { providers: 'private-person@example.net' }],
    ['providers', [{ name: 'private-person@example.net' }]],
    ['dns', Buffer.from('{"private-person@example.net":')],
    ['organization', new Error('private-person@example.net fixture-private-token')],
    ['accounts', new Error('private-person@example.net fixture-private-token')],
  ]) {
    await t.test(key, async () => {
      const options = fixture({ responses: { [key]: value } });
      options.login = () => assert.fail('Malformed data and provider failures do not indicate a missing session');
      await assert.rejects(collect(options), error => {
        assert(!error.message.includes('private-person'));
        assert(!error.message.includes('fixture-private-token'));
        assert.equal(error.cause, undefined);
        assert.match(error.message, /Cloudflare|zone|account|session|provider/i);
        return true;
      });
    });
  }
});

test('invalid private answers fail with fixed validation messages', async t => {
  for (const [label, value, message] of [
    ['Instance name', 'private-person@example.net', /instance/i],
    ['Owner email', 'fixture-private-token', /email/i],
    ['Unused app hostname', 'other.example.net', /hostname/i],
    ['Unused app hostname', 'example.com', /hostname/i],
    ['Unused app hostname', 'https://pentcloud.example.com', /hostname/i],
    ['Unused app hostname', '-bad.example.com', /hostname/i],
    ['New Zero Trust team label', 'fixture-private-token\n', /team label/i],
    ['Zero Trust organization name', 'private-person@example.net\n', /organization name/i],
  ]) {
    await t.test(label, async () => {
      const options = fixture({ organization: null, answers: { [label]: value } });
      await assert.rejects(collect(options), error => {
        assert(!error.message.includes('private-person'));
        assert(!error.message.includes('fixture-private-token'));
        assert.match(error.message, message);
        return true;
      });
    });
  }
});

test('full discovery pages are followed so account selection never silently omits later accounts', async () => {
  const firstPage = Array.from({ length: 50 }, (_, index) => ({ id: (index + 1).toString(16).padStart(32, '0'), name: `Fixture account ${index + 1}` }));
  const options = fixture({ responses: { accounts: args => args[args.indexOf('--page') + 1] === '1'
    ? firstPage : [{ id: accountId, name: 'Customer account' }] }, selections: { 'Cloudflare account': accountId } });
  const config = await collect(options);
  assert.equal(config.accountId, accountId);
  assert.equal(options.choices[0].options.length, 51);
  assert.deepEqual(options.calls.filter(({ args }) => args[0] === 'accounts').map(({ args }) => args), [
    ['accounts', 'list', '--page', '1', '--per-page', '50'],
    ['accounts', 'list', '--page', '2', '--per-page', '50'],
  ]);
});
