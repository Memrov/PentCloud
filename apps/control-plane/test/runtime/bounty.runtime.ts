import {expect,it} from 'vitest';
import {BountyConnections} from '../../src/native/bounty-platform';
it('checks a native secret binding in workerd and gates rotated credentials without returning them',async()=>{
 const records=new Map<string,unknown>();let token='fixture-only';
 const connections=new BountyConnections({PENTCLOUD_INTIGRITI_API_TOKEN:{get:async()=>token}},{get:k=>records.get(k) as never,put:(k,v)=>records.set(k,v),remove:k=>records.delete(k),fetcher:async(url,options)=>{expect(String(url)).toContain('api.intigriti.com/external/researcher/v1/programs?');expect(new Headers(options?.headers).get('Authorization')).toBe('Bearer fixture-only');return Response.json({records:[],maxCount:0});}});
 await expect(connections.require('intigriti')).rejects.toThrow(/Bug bounty/);await connections.check('intigriti');await expect(connections.require('intigriti')).resolves.toBeUndefined();
 expect(JSON.stringify(await connections.list())).not.toContain(token);token='rotated';await expect(connections.require('intigriti')).rejects.toThrow(/Bug bounty/);
});
