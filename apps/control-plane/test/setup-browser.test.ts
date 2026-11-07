import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {chromium,type Browser} from 'playwright';
import {expect as check} from 'playwright/test';
import {createServer,type ViteDevServer} from 'vite';
import {fileURLToPath} from 'node:url';
describe.skipIf(process.env.PENTCLOUD_SETUP_BROWSER!=='1')('small setup wizard in a real browser',()=>{
  let server:ViteDevServer,browser:Browser,origin:string;
  beforeAll(async()=>{server=await createServer({root:fileURLToPath(new URL('../',import.meta.url)),server:{host:'127.0.0.1',port:0}});await server.listen();origin=server.resolvedUrls!.local[0]!.replace(/\/$/,'');browser=await chromium.launch({channel:'chrome',headless:true});},30000);
  afterAll(async()=>{await browser?.close();await server?.close();});
  for(const width of [1440,390])it('prepares storage, saves a secret and opens the app at '+width+'px',async()=>{
    const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors:string[]=[],writes:string[]=[];
    page.on('pageerror',e=>errors.push(e.message));let storage=false,models=false;
    await context.routeWebSocket('**/agents/coordinator/global*',socket=>{socket.send(JSON.stringify({type:'cf_agent_identity',name:'global',agent:'coordinator',stateFollows:true}));socket.send(JSON.stringify({type:'cf_agent_state',state:{revision:1,runs:[],jobs:[]}}));});
    await page.route('**/v1/ui/**',async route=>{
      const path=new URL(route.request().url()).pathname,json=(value:unknown)=>route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
      if(route.request().method()==='POST')writes.push(path);
      if(path==='/v1/ui/setup')return json({schemaVersion:1,access:true,missing:[],storage,models,ready:storage&&models});
      if(path==='/v1/ui/setup/storage'){storage=true;return json({prepared:true});}
      if(path==='/v1/ui/setup/model'){expect(route.request().postDataJSON()).toMatchObject({accountId:'a'.repeat(32),worker:'customer-app',apiToken:'private-setup-token',key:'private-model-key',route:'go'});models=true;return json({saved:true});}
      if(path==='/v1/ui/runs')return json({runs:[]});if(path==='/v1/ui/onboarding')return json({targets:[],credentials:[],defaults:[]});return json({});
    });
    try{
      await page.goto(origin+'/setup');expect(new URL(page.url()).pathname).toBe('/setup');await check(page.getByRole('heading',{name:'Set up PentCloud',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByRole('button',{name:'Prepare workspace',exact:true}).click();await check(page.getByText('Your Artifacts workspace is connected.',{exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByLabel('OpenCode key',{exact:true}).fill('private-model-key');await page.getByText('Allow this one-time secret save',{exact:true}).click();
      if(width===390){const main=page.getByRole('main');await main.hover();await page.mouse.wheel(0,700);await check.poll(()=>main.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);}
      await page.getByLabel('Cloudflare account ID').fill('a'.repeat(32));await page.getByLabel('App Worker name').fill('customer-app');await page.getByLabel('Setup API token').fill('private-setup-token');await page.getByRole('button',{name:'Save key in Cloudflare',exact:true}).click();
      await check(page.getByText('Your OpenCode key is configured in Cloudflare.',{exact:true})).toBeVisible();expect(writes).toEqual(['/v1/ui/setup/storage','/v1/ui/setup/model']);
      await check(page.getByLabel('Setup API token')).toHaveCount(0);expect(await page.evaluate(()=>Object.keys(localStorage).length)).toBe(0);
      await page.screenshot({path:'/tmp/pentcloud-setup-'+width+'.png'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.getByRole('button',{name:'Open PentCloud',exact:true}).click();await check(page.getByRole('button',{name:'Save target',exact:true})).toBeVisible();expect(errors).toEqual([]);
    }finally{await context.close();}
  },30000);
  it('blocks later steps until the owner and base bindings are configured',async()=>{
    const page=await browser.newPage();await page.route('**/v1/ui/setup',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({schemaVersion:1,access:false,missing:['Cloudflare Access'],storage:false,models:false,ready:false})}));
    try{await page.goto(origin);await check(page.getByRole('link',{name:'Access setup'})).toBeVisible();await check(page.getByRole('button',{name:'2. Workspace',exact:true})).toBeDisabled();await check(page.getByRole('button',{name:'Continue',exact:true})).toBeDisabled();}finally{await page.close();}
  });
  it('bootstraps hostname Access with one temporary credential and clears it before sign-in',async()=>{
    const page=await browser.newPage();let configured=false;
    await page.route('**/v1/ui/setup**',async route=>{
      if(route.request().method()==='POST'){const input=route.request().postDataJSON();expect(new URL(route.request().url()).pathname).toBe('/v1/ui/setup/access');expect(input).toMatchObject({accountId:'a'.repeat(32),worker:'customer-app',email:'owner@example.com',apiToken:'temporary-setup-token',key:'private-model-key'});configured=true;return route.fulfill({contentType:'application/json',body:JSON.stringify({configured:true})});}
      return route.fulfill({contentType:'application/json',body:JSON.stringify({schemaVersion:1,accountId:'a'.repeat(32),worker:'customer-app',access:configured,missing:configured?[]:['Cloudflare Access'],storage:false,models:configured,ready:false})});
    });
    try{await page.goto(origin+'/setup');await page.getByLabel('Owner email',{exact:true}).fill('owner@example.com');await check(page.getByLabel('Cloudflare account ID')).toHaveValue('a'.repeat(32));await page.getByLabel('Setup API token').fill('temporary-setup-token');await page.getByLabel('OpenCode key (optional)').fill('private-model-key');await page.getByRole('button',{name:'Protect this installation',exact:true}).click();await check(page.getByRole('button',{name:'Sign in to continue',exact:true})).toBeVisible();await check(page.getByLabel('Setup API token')).toHaveCount(0);await page.getByRole('button',{name:'Sign in to continue',exact:true}).click();await check(page.getByText('Your deployment has the required service bindings.',{exact:true})).toBeVisible();expect(await page.evaluate(()=>Object.keys(localStorage).length)).toBe(0);}finally{await page.close();}
  });

});
