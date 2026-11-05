import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configs = {
  app: new URL('../apps/control-plane/wrangler.jsonc', import.meta.url),
  gateway: new URL('../infra/aws-toolbox/control/wrangler.jsonc', import.meta.url),
};

// Installation metadata belongs in Cloudflare Builds, not in the shared source.
// Runtime credentials remain bound Worker secrets and are never included here.
export function validateBuildConfig(kind, value, template, expectedName, installationTemplate) {
  if (!Object.hasOwn(configs, kind)) throw new Error('Choose app or gateway.');
  if (typeof value !== 'string' || !value || value.length > 5000) {
    throw new Error('Set PENTCLOUD_DEPLOY_CONFIG in Cloudflare Builds (maximum 5000 characters).');
  }
  let config;
  try { config = JSON.parse(value); } catch { throw new Error('PENTCLOUD_DEPLOY_CONFIG must be valid JSON.'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Expected one Worker configuration.');
  if (typeof config.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(config.name)) throw new Error('A valid Worker name is required.');
  if (expectedName && config.name !== expectedName) throw new Error('The configuration does not match this Builds Worker.');
  if (config.env || config.build) throw new Error('Supply a single Worker configuration without environment or build overrides.');
  const sourceRoot = kind === 'app' ? 'apps/control-plane' : 'infra/aws-toolbox/control';
  const sourcePath = (value, relative, suffix) => value === relative || (typeof value === 'string' && value.replaceAll('\\', '/').endsWith(`/${sourceRoot}/${suffix}`));
  if (!sourcePath(config.main, template.main, 'src/worker.ts')) throw new Error('Preserve the source Worker entrypoint.');
  config.main = template.main;
  if (kind === 'app') {
    if (!sourcePath(config.assets?.directory, template.assets.directory, 'dist/client')) throw new Error('Preserve the source assets directory.');
    config.assets.directory = template.assets.directory;
  }
  const contract = [template, installationTemplate].filter(Boolean).find(candidate => ['migrations', 'secrets'].every(key => JSON.stringify(config[key]) === JSON.stringify(candidate[key])));
  if (!contract) throw new Error('Preserve migration and secret declarations shipped with this source.');
  // Older installer configs predate required secret-name declarations. These
  // names keep generated Env types correct; no secret values are transferred.
  config.secrets = template.secrets;
  for (const key of ['main', 'compatibility_date', 'compatibility_flags', 'durable_objects', 'migrations', 'secrets', 'version_metadata', ...(kind === 'app' ? ['assets', 'rules', 'worker_loaders'] : [])]) {
    const expected = key === 'migrations' ? contract[key] : template[key];
    if (JSON.stringify(config[key]) !== JSON.stringify(expected)) throw new Error(`Preserve the source configuration's ${key}.`);
  }
  if (config.vars === undefined || (config.vars && typeof config.vars === 'object' && !Array.isArray(config.vars))) {
    for (const key of Object.keys(config.vars || {})) {
      if (/(?:key|token|secret|password|credential)/i.test(key)) throw new Error('Bind credentials as Worker secrets, not configuration variables.');
    }
  } else throw new Error('Configuration variables must be an object.');
  if (template.vars) config.vars = { ...template.vars, ...config.vars };
  if (kind === 'app') {
    for (const [key, binding, fixed] of [['artifacts', 'ARTIFACTS', {}], ['services', 'TOOLBOX', { entrypoint: 'ToolboxGateway' }], ['workflows', 'RESULTS', { class_name: 'ResultValidation' }]]) {
      const entries = config[key];
      if (!Array.isArray(entries) || entries.length !== 1 || entries[0].binding !== binding || Object.entries(fixed).some(([k, v]) => entries[0][k] !== v)) throw new Error(`Preserve the ${key} binding contract.`);
      const resource = entries[0][key === 'artifacts' ? 'namespace' : key === 'services' ? 'service' : 'name'];
      if (typeof resource !== 'string' || !resource) throw new Error(`Configure the ${key} resource.`);
    }
    for (const key of ['browser', 'ai']) if (config[key]?.binding !== template[key].binding) throw new Error(`Preserve the ${key} binding.`);
  } else {
    const container = config.containers?.[0];
    if (config.containers?.length !== 1 || container.class_name !== 'KaliToolbox' || container.scheduling_policy !== 'durable_object' || !container.name || !container.images?.stock?.image) throw new Error('Configure the prepared stock Kali container.');
  }
  return config;
}

async function main() {
  const kind = process.argv[2];
  if (!Object.hasOwn(configs, kind) || process.argv.length !== 3) throw new Error('Usage: node scripts/configure-cloudflare-build.mjs app|gateway');
  const template = JSON.parse(await readFile(configs[kind], 'utf8'));
  const installationTemplate = JSON.parse(await readFile(new URL(`../templates/private-install/${kind}.json`, import.meta.url), 'utf8'));
  const config = validateBuildConfig(kind, process.env.PENTCLOUD_DEPLOY_CONFIG, template, process.env.WRANGLER_CI_OVERRIDE_NAME, installationTemplate);
  await writeFile(configs[kind], `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log('Applied this installation’s Cloudflare Builds configuration.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
