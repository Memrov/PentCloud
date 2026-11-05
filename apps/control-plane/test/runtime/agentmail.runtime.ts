import {expect,it} from 'vitest';
import {readAgentMail} from '../../src/native/agentmail-verification';
it('constructs provider requests in workerd without following redirects',async()=>{
 const now=Date.now();let calls=0;
 const fetcher:typeof fetch=async(url,options)=>{const request=new Request(url,options);calls++;expect(request.redirect).toBe('manual');expect(request.headers.get('Authorization')).toBe('Bearer fixture-provider-key');return Response.json({messages:[]});};
 await expect(readAgentMail({PENTCLOUD_AGENTMAIL_INBOX:'owned@agentmail.to',AGENTMAIL_API_KEY:'fixture-provider-key'},{createdAt:now,expiresAt:now+60000,sender:''},{fetcher})).resolves.toEqual([]);
 expect(calls).toBe(1);
});
