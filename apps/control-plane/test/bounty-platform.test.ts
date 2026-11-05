import {expect,it} from 'vitest';
import {checkProgramAccess} from '../src/native/bounty-platform';
it('accepts the native HackerOne single-resource response without a data envelope',async()=>{
 const result=await checkProgramAccess('hackerone:example',{token:'platform-only',username:'researcher'},async()=>Response.json({id:'15966',type:'program',attributes:{handle:'example',name:'Example',submission_state:'open',policy:'Own test accounts only.'}}));
 expect(result.name).toBe('Example');expect(result.policy).toBe('Own test accounts only.');
});
it('checks the selected HackerOne program with its own credential, not a target request',async()=>{
 let request:Request|undefined;
 const result=await checkProgramAccess('hackerone:example',{token:'platform-only',username:'researcher'},async(input,init)=>{request=new Request(input,init);return Response.json({data:{attributes:{handle:'example',name:'Example',submission_state:'open',policy:'Only owned test accounts.'}}});});
 expect(request?.url).toBe('https://api.hackerone.com/v1/hackers/programs/example');expect(result.policy).toBe('Only owned test accounts.');expect(JSON.stringify(result)).not.toContain('platform-only');
});
it('reads Intigriti program rules and testing requirements from the live program record',async()=>{
 const id='152bc833-04a4-40d2-bdaa-0b31f6161449';
 const result=await checkProgramAccess('intigriti:'+id,{token:'platform-only'},async()=>Response.json({id,name:'Example',status:{value:'open'},rulesOfEngagement:{content:{description:'Use owned accounts.',testingRequirements:{intigritiMe:true,requestHeader:'X-Researcher: yourname'}}}}));
 expect(result.policy).toContain('X-Researcher');expect(result.policy).toContain('Use owned accounts.');
});
it('fails safely for invalid keys, unavailable programs and rate limits without exposing provider bodies',async()=>{
 for(const status of [401,403,404,429,503])await expect(checkProgramAccess('hackerone:example',{token:'platform-only',username:'researcher'},async()=>new Response('private-provider-body',{status}))).rejects.not.toThrow(/private-provider-body|platform-only/);
 await expect(checkProgramAccess('hackerone:example',{token:'platform-only',username:'researcher'},async()=>Response.json({data:{attributes:{handle:'other',submission_state:'open',policy:'wrong'}}}))).rejects.toThrow(/identity/i);
});
