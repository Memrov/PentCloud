import {expect,it} from 'vitest';
import {BountyConnections} from '../../src/native/bounty-platform';
it('checks a native secret binding in workerd and gates rotated credentials without returning them',async()=>{
 const records=new Map<string,unknown>();let token='fixture-only';
 const connections=new BountyConnections({PENTCLOUD_INTIGRITI_API_TOKEN:{get:async()=>token}},{get:k=>records.get(k) as never,put:(k,v)=>records.set(k,v),remove:k=>records.delete(k),fetcher:async(url,options)=>{expect(String(url)).toContain('api.intigriti.com/external/researcher/v1/programs?');expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-only');return Response.json({records:[],maxCount:0});}});
 await expect(connections.require('intigriti')).rejects.toThrow(/Bug bounty/);await connections.check('intigriti');await expect(connections.require('intigriti')).resolves.toBeUndefined();
 expect(JSON.stringify(await connections.list())).not.toContain(token);token='rotated';await expect(connections.require('intigriti')).rejects.toThrow(/Bug bounty/);
});
it('uses native Bugcrowd authentication and bounds YesWeHack readiness to JWT expiry in workerd',async()=>{
 const records=new Map<string,unknown>();let now=1000;const jwt='eyJhbGciOiJIUzI1NiJ9.'+btoa(JSON.stringify({exp:61})).replace(/=/g,'')+'.fixture-signature';
 const connections=new BountyConnections({PENTCLOUD_BUGCROWD_API_TOKEN:{get:async()=>'fixture-id:fixture-secret'},PENTCLOUD_YESWEHACK_API_TOKEN:{get:async()=>jwt}},{get:k=>records.get(k) as never,put:(k,v)=>records.set(k,v),remove:k=>records.delete(k),now:()=>now,fetcher:async(url,options)=>{
  const request=new Request(url,options);if(request.url.endsWith('/user')){expect(request.headers.get('Authorization')).toBe('Bearer '+jwt);return Response.json({username:'fixture-researcher'});}
  expect(request.url).toBe('https://hacker-api.bugcrowd.com/v1/engagements?limit=1');expect(request.headers.get('Authorization')).toBe('Token fixture-id:fixture-secret');return Response.json({data:[]});
 }});
 await connections.check('bugcrowd');await connections.check('yeswehack');await expect(connections.require('yeswehack')).resolves.toBeUndefined();
 now=61000;await expect(connections.require('yeswehack')).rejects.toThrow(/Bug bounty/);await expect(connections.require('bugcrowd')).resolves.toBeUndefined();expect(JSON.stringify(await connections.list())).not.toContain('fixture-secret');
});
