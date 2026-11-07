import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateBuildConfig } from './configure-cloudflare-build.mjs';

for (const [kind, path] of [['app', '../apps/control-plane/wrangler.jsonc'], ['gateway', '../infra/aws-toolbox/control/wrangler.jsonc']]) {
  const template = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  const installationTemplate = JSON.parse(await readFile(new URL(`../templates/private-install/${kind}.json`, import.meta.url), 'utf8'));
  const container = { name: 'example-kali', class_name: 'KaliToolbox', scheduling_policy: 'durable_object', images: { stock: { image: 'registry.example.invalid/stock-kali:prepared' } } };
  const config = { ...template, name: `example-${kind}`, vars: { ACCESS_AUD: 'example-audience' }, ...(kind === 'gateway' ? { containers: [container] } : {}) };
  test(`${kind}: installation bindings are preserved and credentials are rejected`, () => {
    assert.deepEqual(validateBuildConfig(kind, JSON.stringify(config), template, config.name), { ...config, vars: { ...template.vars, ...config.vars } });
    assert.throws(() => validateBuildConfig(kind, undefined, template), /Set PENTCLOUD/);
    assert.throws(() => validateBuildConfig(kind, '{"private-value":', template), /^Error: PENTCLOUD_DEPLOY_CONFIG must be valid JSON\.$/);
    assert.throws(() => validateBuildConfig(kind, JSON.stringify(config), template, 'another-worker'), /does not match/);
    for (const patch of [{ migrations: [] }, { durable_objects: {} }, { main: 'other.js' }, { env: {} }, { build: {} }, { vars: [] }, { vars: { OPENCODE_GO_API_KEY: 'example' } }, ...(kind === 'app' ? [{ services: [] }, { workflows: [] }, { artifacts: [] }, { browser: {} }, { ai: {} }, { services: [{ binding: 'TOOLBOX', service: 'example-toolbox', entrypoint: 'OtherGateway' }] }] : [{ containers: [] }])]) {
      assert.throws(() => validateBuildConfig(kind, JSON.stringify({ ...config, ...patch }), template));
    }
  });
  test(`${kind}: installer paths are rebased without changing its migration history`, () => {
    const generated = { ...config, ...installationTemplate, name: `example-${kind}`, main: `/operator/checkout/${kind === 'app' ? 'apps/control-plane' : 'infra/aws-toolbox/control'}/src/worker.ts`, ...(kind === 'app' ? { assets: { ...template.assets, directory: '/operator/checkout/apps/control-plane/dist/client' }, vars: { CONTROL_BASE_URL: 'https://example.invalid', ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com', ACCESS_AUD: 'example-audience', ARTIFACTS_NAMESPACE: 'example' } } : {}) };
    if (!installationTemplate.secrets) delete generated.secrets;
    const result = validateBuildConfig(kind, JSON.stringify(generated), template, generated.name, installationTemplate);
    assert.deepEqual(result.migrations, installationTemplate.migrations);
    assert.deepEqual(result.durable_objects, installationTemplate.durable_objects);
    assert.deepEqual(result.secrets, template.secrets);
    if (kind === 'app') assert.equal(result.vars.AI_GATEWAY_ID, '');
    assert.equal(result.main, template.main);
    if (kind === 'app') assert.deepEqual(result.assets, template.assets);
  });
}

test('app: first-run Builds accept smaller tool packages without requiring a model key', async()=>{
  const template=JSON.parse(await readFile(new URL('../apps/control-plane/wrangler.jsonc',import.meta.url),'utf8'));
  const config={...template,services:[{binding:'TOOL_PACKS',service:'example-tools',entrypoint:'ToolPackGateway'}],secrets:{required:['OPENCODE_GO_API_KEY']}};
  const result=validateBuildConfig('app',JSON.stringify(config),template,config.name);
  assert.equal(result.secrets,undefined);assert.equal(result.services[0].binding,'TOOL_PACKS');
});
