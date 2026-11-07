import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
const read=async path=>JSON.parse(await readFile(new URL('../'+path,import.meta.url),'utf8'));
test('deployment button has one complete account-independent Worker and all eleven native tool images',async()=>{
  const config=await read('wrangler.jsonc'),packs=await read('infra/tool-packs/wrangler.jsonc'),pkg=await read('package.json');
  assert.equal(config.main,'apps/control-plane/src/customer/worker.ts');assert.equal(config.account_id,undefined);assert.equal(config.services,undefined);assert.equal(config.workers_dev,true);assert.equal(config.preview_urls,false);
  assert.equal(config.containers.length,11);assert.deepEqual(config.containers.map(c=>c.class_name),packs.durable_objects.bindings.map(b=>b.class_name));
  const classes=new Set(config.migrations.flatMap(m=>m.new_sqlite_classes??[]));for(const c of config.containers){assert(classes.has(c.class_name));assert.equal(c.scheduling_policy,'durable_object');assert.equal(Object.keys(c.images).length,1);assert(!JSON.stringify(c).includes('Kali'));}
  assert.equal(config.vars.ACCESS_AUD,undefined);assert.equal(config.vars.ACCESS_TEAM_DOMAIN,undefined);assert.equal(config.secrets,undefined);assert.equal(pkg.scripts.build,'node scripts/build-customer.mjs');assert.match(pkg.scripts.deploy,/--config wrangler.jsonc$/);
});

test('selected Worker names isolate Artifacts, Workflow and wizard metadata for each installation',async()=>{
  const {customerConfig}=await import('./build-customer.mjs'),source=await read('wrangler.jsonc');
  const first=customerConfig(structuredClone(source),{worker:'customer-one',accountId:'a'.repeat(32)}),second=customerConfig(structuredClone(source),{worker:'customer-two',accountId:'b'.repeat(32)});
  for(const value of [first,second]){assert.equal(value.artifacts[0].namespace,value.name);assert.equal(value.workflows[0].name,value.name);assert.equal(value.vars.PENTCLOUD_WORKER_NAME,value.name);assert.equal(value.vars.ARTIFACTS_NAMESPACE,value.name);}
  assert.notEqual(first.artifacts[0].namespace,second.artifacts[0].namespace);assert.equal(second.vars.PENTCLOUD_ACCOUNT_ID,'b'.repeat(32));
});
