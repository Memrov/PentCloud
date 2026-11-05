#!/usr/bin/env node
import assert from 'node:assert/strict';
import { privateProcess } from './lib/private-process.mjs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudflareApi, Installer, configuration, plan, privateJson, readJson, withStateLock } from './lib/private-install.mjs';
import { accountAuthorization } from './lib/native-auth.mjs';
import { importStockImage } from './lib/private-image.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `PentCloud installer
Usage: node scripts/pentcloud.mjs COMMAND --config FILE --state DIRECTORY [OPTIONS]
Commands: plan, install, doctor, upgrade, export, import-targets, uninstall
Options: --apply (required for mutations), --output FILE (new path outside state for metadata and Git export),
         --data retain|delete --confirm INSTANCE (uninstall)
Auth: cf auth login for account setup; cloudflared access login --quiet APP_URL
for app access. CI may supply a selected-account CLOUDFLARE_API_TOKEN. OPENCODE_GO_API_KEY
is optional for bootstrap; otherwise add the key through Cloudflare Worker Secrets.
Never place credentials in config or args.
Plan needs no credentials. No command invokes a model or scanner.
State contains private ownership metadata, not recovery credentials. Keep it
out of Git. Official Cloudflare clients manage their own login sessions.`;

function parse(args) {
  if (!args.length || args.includes('--help')) return null;
  const [command, ...rest] = args;
  assert(['plan', 'install', 'doctor', 'upgrade', 'export', 'import-targets', 'uninstall'].includes(command), 'Unknown command');
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    assert(['--config', '--state', '--apply', '--output', '--input', '--data', '--confirm'].includes(name), 'Unknown option');
    assert(!(name in options), 'Duplicate option');
    if (name === '--apply') options[name] = true;
    else { assert(rest[index + 1] && !rest[index + 1].startsWith('--'), 'Option needs a value'); options[name] = rest[++index]; }
  }
  assert(options['--config'], 'Provide --config explicitly; no personal profile is loaded');
  if (command !== 'plan') assert(options['--state'], 'Provide --state explicitly');
  if (['install', 'upgrade', 'import-targets', 'uninstall'].includes(command)) assert(options['--apply'], 'Review plan, then pass --apply to authorize the listed mutations');
  if (command === 'export') assert(options['--output'], 'Provide --output for the private metadata export');
  if(command==='import-targets')assert(options['--input'],'Provide --input for the target/profile export');
  return { command, options };
}
const execute=(command,args,options={})=>privateProcess(command,args,{cwd:root,...options});
async function run(kind, args, options) {
  if (kind === 'wrangler') return execute(process.execPath, [join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], options);
  if (kind === 'node') return execute(process.execPath, args, options);
  if (kind === 'build') {
    const [major, minor, patch] = process.versions.node.split('.').map(Number);
    assert(major === 26 && (minor > 12 || minor === 12 && patch >= 1), 'Use pinned Node 26.12.1 or later 26.x');
    await execute('bash', [join(root, 'scripts/build-prompt-renderer.sh')]);
    return execute(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: join(root, 'apps/control-plane') });
  }
  return execute(kind, args, options);
}

try {
  const parsed = parse(process.argv.slice(2));
  if (!parsed) console.log(help);
  else {
    const { command, options } = parsed;
    const config = configuration(await readJson(resolve(options['--config'])));
    if (command === 'plan') console.log(JSON.stringify(plan(config), null, 2));
    else {
      const directory = resolve(options['--state']);
      assert(directory !== dirname(directory) && directory !== root && !directory.startsWith(root + '/') && !root.startsWith(directory + '/'), 'State must be outside the source checkout and its ancestors');
      const prior=await readJson(join(directory,'manifest.json'),null);
      const authorization=await accountAuthorization({accountId:config.accountId,run,legacy:Boolean(prior?.resources?.store||prior?.resources?.serviceToken)});
      const deploymentRun=(kind,args,settings={})=>run(kind,args,{...settings,env:settings.env??{...process.env,CLOUDFLARE_API_TOKEN:authorization.token}});
      try {
      const installer = new Installer({ config, stateDirectory: directory, root, api: new CloudflareApi(authorization.token), run:deploymentRun, importImage: importStockImage,
        log: (record) => console.log(JSON.stringify(record)) });
      const result = await withStateLock(directory, async () => {
        if (command === 'install' || command === 'upgrade') return installer.install({ upgrade: command === 'upgrade' });
        if (command === 'doctor') return installer.doctor();
        if (command === 'import-targets') return installer.importTargets(resolve(options['--input']));
        if (command === 'uninstall') return installer.uninstall({ data: options['--data'], confirm: options['--confirm'] });
        return installer.exportInstallation(resolve(options['--output']));
      });
      console.log(JSON.stringify(result, null, 2));
      } finally {await authorization.close();}
    }
  }
} catch (error) {
  // All network/subprocess adapters intentionally use fixed messages, without
  // raw provider bodies, arguments or error causes that could expose secrets.
  console.error(`PentCloud: ${error.message}`);
  process.exitCode = 1;
}
