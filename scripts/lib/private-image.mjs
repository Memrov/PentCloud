// Uses the verified stock-image transfer recipe, without personal identities or
// a Docker daemon. regctl is upstream tooling, not a new OCI implementation.
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { STOCK_DIGEST, STOCK_SOURCE, hash, privateJson } from './private-install.mjs';

export const REGCTL_VERSION = 'v0.9.0';
// Checksums pin upstream regctl v0.9.0 binaries for each supported platform.
export const REGCTL_HASHES = {
  'darwin-amd64': 'fe9f4c84d87e6c9f7c7634a4730d1149df04548b66834092f269b70fcc573b27',
  'darwin-arm64': '4bb4d22fc546322394593a8a702b2990b22bf57ceb83a103117d81a4ab7bbd16',
  'linux-amd64': '17e45fc20aacdde01634ab1a38fd33de040891821acbb62f222331ef1fb02d0d',
  'linux-arm64': '2cc45379b3b21d3d2eb4cc84f32c5812a792803878d61aff85c7c6402225481a',
};
export function regctlPlatform(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch === 'x64' ? 'amd64' : arch}`;
  assert(REGCTL_HASHES[key], 'Image import supports macOS/Linux on x64/arm64; use a supported host');
  return key;
}
export async function importStockImage(installer, { fetcher = fetch, platform, arch } = {}) {
  const { directory, config, names, run, environment, log } = installer;
  const privateDirectory = await mkdtemp(join(directory, 'registry-transfer-'));
  await chmod(privateDirectory, 0o700);
  try {
    const key = regctlPlatform(platform, arch);
    const response = await fetcher(`https://github.com/regclient/regclient/releases/download/${REGCTL_VERSION}/regctl-${key}`, { signal: AbortSignal.timeout(120_000) });
    assert(response.ok, 'Could not download the pinned upstream regctl release');
    const binary = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(binary), REGCTL_HASHES[key], 'Pinned upstream regctl binary checksum mismatch');
    const regctl = join(privateDirectory, 'regctl');
    await writeFile(regctl, binary, { mode: 0o700, flag: 'wx' });
    const selector = join(privateDirectory, 'account.wrangler.json');
    await privateJson(selector, { name: `${config.instance}-image-import`, account_id: config.accountId, compatibility_date: '2026-10-30' });
    const credential = JSON.parse((await run('wrangler', ['containers', 'registries', 'credentials', 'registry.cloudflare.com', '--push', '--pull', '--expiration-minutes', '60', '--json', '--config', selector])).toString());
    assert.equal(credential.registry_host, 'registry.cloudflare.com', 'Unexpected registry credential host');
    assert(credential.username && credential.password, 'Registry credential response is incomplete');
    await privateJson(join(privateDirectory, 'config.json'), { auths: { 'registry.cloudflare.com': { auth: Buffer.from(`${credential.username}:${credential.password}`).toString('base64') } } });
    // The OCI client receives temporary registry auth and network trust only.
    // It never inherits Cloudflare operator/model/scanner credentials.
    const passthrough = ['PATH', 'HOME', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'LANG', 'LC_ALL', 'TMPDIR'];
    const env = Object.fromEntries(passthrough.filter((key) => environment[key]).map((key) => [key, environment[key]]));
    Object.assign(env, { DOCKER_CONFIG: privateDirectory, REGCTL_CONFIG: join(privateDirectory, 'regctl.json') });
    const registry = (args, timeout = 120_000) => run(regctl, args, { env, timeout });
    await registry(['registry', 'set', 'registry.cloudflare.com', '--blob-chunk', '134217728', '--blob-max', '134217728', '--req-concurrent', '1']);
    const source = await registry(['manifest', 'get', STOCK_SOURCE, '--format', 'raw-body']);
    assert.equal(`sha256:${hash(source)}`, STOCK_DIGEST, 'Source image manifest does not match the immutable stock pin');
    const repository = `registry.cloudflare.com/${config.accountId}/${names.imageRepository}`;
    const destination = `${repository}:stock`;
    // A prior interrupted transfer is safely resumed by regctl's content-addressed
    // blob copy. Never choose a replacement image or mutate its contents.
    log({ stage: 'image-copy', source: STOCK_SOURCE, destination, status: 'copying' });
    await registry(['image', 'copy', '--force-recursive', STOCK_SOURCE, destination], 3_600_000);
    const target = await registry(['manifest', 'get', destination, '--format', 'raw-body']);
    assert(source.equals(target), 'Imported manifest differs from the pinned stock manifest');
    const descriptor = JSON.parse(source.toString());
    const configBlob = await registry(['blob', 'get', repository, descriptor.config.digest]);
    assert.equal(`sha256:${hash(configBlob)}`, descriptor.config.digest, 'Imported stock config blob digest mismatch');
    const proof = { source: STOCK_SOURCE, image: `${repository}@${STOCK_DIGEST}`, regctlVersion: REGCTL_VERSION,
      regctlPlatform: key, regctlBinarySha256: REGCTL_HASHES[key], manifestDigest: STOCK_DIGEST,
      exactManifestBytes: true, exactConfigDescriptor: true, exactLayerDescriptors: true, configBlobDigestVerified: true,
      layerCount: descriptor.layers.length, compressedLayerBytes: descriptor.layers.reduce((sum, item) => sum + item.size, 0),
      localLayerExtraction: false, layerRecompression: false, importedAt: new Date().toISOString() };
    await privateJson(join(directory, 'image-copy-proof.json'), proof);
    return proof;
  } finally { await rm(privateDirectory, { recursive: true, force: true }); }
}
