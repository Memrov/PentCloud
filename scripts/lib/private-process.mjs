import {spawn} from 'node:child_process';
export function privateProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const environment = {...(options.env ?? { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'log', CI: 'true' })};
    // Builds/account overrides must never redirect a generic explicit instance.
    for (const name of ['WRANGLER_CI_OVERRIDE_NAME', 'WRANGLER_CI_MATCH_TAG', 'CF_ACCOUNT_ID', 'WRANGLER_API_BASE_URL', 'CLOUDFLARE_API_BASE_URL']) delete environment[name];
    if(!options.accountAuthorization)delete environment.CLOUDFLARE_ACCOUNT_ID;
    const child = spawn(command, args, { cwd: options.cwd ?? process.cwd(), env: environment, stdio: [options.input===undefined?'ignore':'pipe', 'pipe', 'pipe'] });
    if(options.input!==undefined){child.stdin.on('error',()=>{});child.stdin.end(options.input);}
    const output = []; let length = 0;
    child.stdout.on('data', (chunk) => { length += chunk.length; if (length < 64 * 1024 * 1024) output.push(chunk); });
    child.stderr.resume(); // Never stream provider/registry error bodies or secrets.
    const timer = setTimeout(() => child.kill('SIGTERM'), options.timeout ?? 600_000);
    child.on('error', () => { clearTimeout(timer); reject(new Error('Required subprocess could not start; check installed prerequisites')); });
    child.on('close', (status) => { clearTimeout(timer); status === 0 ? resolvePromise(Buffer.concat(output)) : reject(new Error(`Installer subprocess failed (exit ${status}); private state is retained for reconciliation`)); });
  });
}
