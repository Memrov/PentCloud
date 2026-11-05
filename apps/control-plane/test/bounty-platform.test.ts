import {expect,it} from 'vitest';
import {checkProgramAccess,platformBinding} from '../src/native/bounty-platform';
const engagementId='813b58b9-1d64-4f76-9fd7-aec55d247962';
const bugcrowdRecord={id:engagementId,type:'engagement',attributes:{code:'example-mbb-og',name:'Example',state:'in_progress'},links:{scope:'https://untrusted.example/scope'}};
const bugcrowdScope={engagement_id:engagementId,in_scope:[{value:'https://example.test',description:'Use an owned account.'}],out_of_scope:[{value:'https://example.test/admin',reason:'No admin testing.'}],vrt_exclusions:[{exclusion_type:'conditional',vrt_ids:[{id:'sensitive_data_exposure'}],all_targets:true,notes:'Stop at proof of access.'}]};
const ywhJWT='eyJhbGciOiJIUzI1NiJ9.'+btoa(JSON.stringify({exp:4102444800})).replace(/=/g,'')+'.fixture-signature';
it('resolves a Bugcrowd catalog URL to the exact live engagement UUID using only fixed Hacker API URLs',async()=>{
 const requests:Request[]=[];
 const result=await checkProgramAccess('bugcrowd:https://bugcrowd.com/engagements/example-mbb-og',{token:'fixture-id:fixture-secret'},async(input,init)=>{requests.push(new Request(input,init));return Response.json(requests.length===1?{data:[bugcrowdRecord],pagination:{has_more:false}}:bugcrowdScope);});
 expect(requests.map(r=>r.url)).toEqual(['https://hacker-api.bugcrowd.com/v1/engagements','https://hacker-api.bugcrowd.com/v1/engagements/'+engagementId+'/scope']);
 expect(requests.every(r=>r.method==='GET'&&r.headers.get('Authorization')==='Token fixture-id:fixture-secret')).toBe(true);
 expect(result.policy).toContain('not the complete brief');expect(result.policy).toContain('Use an owned account.');expect(result.policy).toContain('Stop at proof of access.');
 expect(JSON.stringify(result)).not.toContain('fixture-secret');
 for(const id of ['bugcrowd:https://other.example/engagements/example','bugcrowd:https://bugcrowd.com/engagements/example?other=1','bugcrowd:https://bugcrowd.com/engagements/a/b'])expect(platformBinding(id)).toBeUndefined();
});
it('rejects inaccessible, paused, incomplete or mismatched Bugcrowd scope instead of selecting another engagement',async()=>{
 for(const data of [[],[{...bugcrowdRecord,attributes:{...bugcrowdRecord.attributes,code:'other'}}],[{...bugcrowdRecord,attributes:{...bugcrowdRecord.attributes,state:'in_progress_paused'}}]]){
  let requests=0;await expect(checkProgramAccess('bugcrowd:example-mbb-og',{token:'id:secret'},async()=>{requests++;return Response.json({data,pagination:{has_more:false}});})).rejects.toThrow(/access|paused/);expect(requests).toBe(1);
 }
 await expect(checkProgramAccess('bugcrowd:example-mbb-og',{token:'id:secret'},async()=>Response.json({data:[bugcrowdRecord],pagination:{has_more:true}}))).rejects.toThrow(/incomplete/);
 for(const scope of [{...bugcrowdScope,engagement_id:'other'},{...bugcrowdScope,in_scope:[{value:'REDACTED'}]}]){
  let requests=0;await expect(checkProgramAccess('bugcrowd:example-mbb-og',{token:'id:secret'},async()=>Response.json(++requests===1?{data:[bugcrowdRecord],pagination:{has_more:false}}:scope))).rejects.toThrow(/identity|paused/);
 }
});
it('loads only the selected YesWeHack program with researcher authentication and preserves testing requirements',async()=>{
 let request:Request|undefined;const result=await checkProgramAccess('yeswehack:example',{token:ywhJWT},async(input,init)=>{request=new Request(input,init);return Response.json({slug:'example',title:'Example',disabled:false,archived:false,rules:'Use owned accounts.',user_agent:'X-Researcher',account_access:'Register an account.',out_of_scope:['DoS'],vpn_active:true});});
 expect(request?.url).toBe('https://api.yeswehack.com/programs/example');expect(request?.headers.get('Authorization')).toBe('Bearer '+ywhJWT);
 expect(result.policy).toContain('Register an account.');expect(result.policy).toContain('X-Researcher');expect(result.policy).toContain('DoS');expect(result.policy).toContain('"vpnRequired":true');
});
it('rejects YesWeHack identity mismatches, archived/disabled programs and missing rules',async()=>{
 const program={slug:'example',title:'Example',disabled:false,archived:false,rules:'Owned accounts only.'};
 for(const change of [{slug:'other'},{archived:true},{disabled:true},{rules:''}])await expect(checkProgramAccess('yeswehack:example',{token:ywhJWT},async()=>Response.json({...program,...change}))).rejects.toThrow(/identity|accepting|rules/);
});
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
