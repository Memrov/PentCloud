/// <reference types="@cloudflare/vitest-plugin/types" />
import {exports} from 'cloudflare:workers';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {saveSetupKey} from '../../src/native/setup';
import {accessKeys,accessHeaders} from './access-fixture';
const app=exports as unknown as {default:Fetcher};
beforeEach(()=>{accessKeys();});afterEach(()=>vi.restoreAllMocks());
it('requires native Access authentication for setup status and every setup mutation',async()=>{
  for(const [path,method]of [['','GET'],['/storage','POST'],['/model','POST']] as const)expect((await app.default.fetch('https://operator.test/v1/ui/setup'+path,{method,headers:{'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})})).status).toBe(401);
});
it('returns only bounded readiness and rejects cross-origin setup before any provider call',async()=>{
  const response=await app.default.fetch('https://operator.test/v1/ui/setup',{headers:await accessHeaders()});
  expect(response.status).toBe(200);expect(response.headers.get('Cache-Control')).toBe('no-store');expect(await response.json()).toMatchObject({schemaVersion:1,access:true,ready:false,storage:false,models:true});
  for(const action of ['storage','model'])expect((await app.default.fetch('https://operator.test/v1/ui/setup/'+action,{method:'POST',headers:await accessHeaders({Origin:'https://foreign.invalid','Content-Type':'application/json'}),body:'{}'})).status).toBe(403);
});
it('validates secret requests before calling Cloudflare and never echoes the submitted token',async()=>{
  const response=await app.default.fetch('https://operator.test/v1/ui/setup/model',{method:'POST',headers:await accessHeaders({'Content-Type':'application/json'}),body:JSON.stringify({apiToken:'PRIVATE_SENTINEL'})});
  expect(response.status).toBe(400);expect(await response.text()).not.toContain('PRIVATE_SENTINEL');
});

it('constructs secret API requests with Workers-supported redirect protection',async()=>{
  const requests:Request[]=[];
  await expect(saveSetupKey({CF_VERSION_METADATA:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}},{accountId:'a'.repeat(32),worker:'example-app',apiToken:'t'.repeat(40),key:'private-model-key',route:'go'},async(url,init)=>{requests.push(new Request(url,init));return Response.json({success:true});})).resolves.toBeUndefined();
  expect(requests).toHaveLength(2);expect(requests.every(request=>request.redirect==='manual')).toBe(true);
});

it('limits the public first-run route to scoped bootstrap input and this application origin',async()=>{
  const headers={'X-Fixture-Unconfigured':'1','Content-Type':'application/json'};
  const status=await app.default.fetch('https://operator.test/v1/ui/setup',{headers});expect(await status.json()).toMatchObject({access:false,ready:false});
  const invalid=await app.default.fetch('https://operator.test/v1/ui/setup/access',{method:'POST',headers,body:JSON.stringify({apiToken:'PRIVATE_SENTINEL'})});expect(invalid.status).toBe(400);expect(await invalid.text()).not.toContain('PRIVATE_SENTINEL');
  const foreign=await app.default.fetch('https://operator.test/v1/ui/setup/access',{method:'POST',headers:{...headers,Origin:'https://foreign.invalid'},body:'{}'});expect(foreign.status).toBe(403);
  const installed=await app.default.fetch('https://operator.test/v1/ui/setup/access',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});expect(installed.status).toBe(401);
});
