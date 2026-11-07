import assert from 'node:assert/strict';
import {test} from 'node:test';
import {customerConfiguration,packageBaseConfiguration,customerPlan,installationBackend} from './lib/customer-config.mjs';

const input={schemaVersion:2,accountId:'a'.repeat(32),instance:'my-pentcloud',accessTeamDomain:'https://customer.cloudflareaccess.com',allowedEmails:['owner@example.com'],domain:{zoneId:'b'.repeat(32),hostname:'app.customer.example'}};
test('customer configuration selects packages in any explicit account and custom domain',()=>{
  const config=customerConfiguration(input);
  assert.deepEqual(config,input);
  assert.equal(packageBaseConfiguration(config).schemaVersion,1);
  assert(!('domain' in packageBaseConfiguration(config)));
  const plan=customerPlan(config);
  assert.equal(plan.backend,'tool-packages');assert.equal(plan.toolPacks,11);
  assert(!JSON.stringify(plan).includes(input.accountId));assert(!JSON.stringify(plan).includes(input.allowedEmails[0]));
  assert(!JSON.stringify(plan).toLowerCase().includes('kali'));
});
test('customer configuration rejects credentials, domain overrides and unapproved bootstrap fields',()=>{
  for(const patch of [{apiToken:'sensitive'},{domain:{...input.domain,image:'override'}},{accessBootstrap:{organizationName:'Team',onetimepin:false}},{schemaVersion:1},{allowedEmails:[]}])assert.throws(()=>customerConfiguration({...input,...patch}));
  assert(customerConfiguration({...input,accessBootstrap:{organizationName:'My Team',onetimepin:true}}).accessBootstrap.onetimepin);
});
test('new installations cannot select the legacy backend or silently convert existing state',()=>{
  assert.equal(installationBackend(input,null,'install'),'packages');
  assert.throws(()=>installationBackend({...input,schemaVersion:1},null,'install'));
  const legacy={config:{schemaVersion:1},resources:{app:{status:'ready'}}};
  assert.equal(installationBackend({schemaVersion:1},legacy,'doctor'),'legacy');
  assert.throws(()=>installationBackend(input,legacy,'upgrade'));
  assert.equal(installationBackend(input,{packageProfile:{domain:input.domain}},'upgrade'),'packages');
});
