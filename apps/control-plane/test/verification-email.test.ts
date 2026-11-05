import {expect,it} from 'vitest';
import {readVerificationEmail} from '../src/native/verification-email';
const raw=(body:string)=>'From: Login <login@owned.example>\r\nTo: codes+abc@auth.example\r\nDate: Thu, 05 Nov 2026 12:00:00 +0000\r\nMessage-ID: <one@owned.example>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'+body;
const headers=new Headers({'Authentication-Results':'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass header.from=owned.example'});
it('extracts a bounded code without returning a whole email or its subject',async()=>{
 const result=await readVerificationEmail({to:'codes+abc@auth.example',headers,raw:raw('Your verification code is 384217. Copyright 2026.')});
 expect(result?.code).toBe('384217');expect(result?.from).toBe('login@owned.example');expect(result).not.toHaveProperty('body');
});
it('ignores spoofed authentication results and ambiguous or oversized messages',async()=>{
 for(const auth of ['attacker.test; dmarc=pass','mx.cloudflare.net; dmarc=fail, attacker.test; dmarc=pass'])expect(await readVerificationEmail({to:'codes+abc@auth.example',headers:new Headers({'Authentication-Results':auth}),raw:raw('Your code is 384217')})).toBeUndefined();
 expect(await readVerificationEmail({to:'codes+abc@auth.example',headers,raw:raw('Your code is 384217 or code 948235')})).toBeUndefined();
 expect(await readVerificationEmail({to:'codes+abc@auth.example',headers,raw:'x'.repeat(256*1024+1)})).toBeUndefined();
});
it('trusts only the first authentication header, ignoring comment and version spoofing',async()=>{
 for(const suffix of ['attacker.test 1; dmarc=pass','attacker.test ; dmarc=pass','mx.cloudflare.net; dmarc=pass']){
  const h=new Headers({'Authentication-Results':'mx.cloudflare.net; dmarc=fail'});h.append('Authentication-Results',suffix);
  expect(await readVerificationEmail({to:'codes+abc@auth.example',headers:h,raw:raw('Your code is 384217')})).toBeUndefined();
 }
 expect(await readVerificationEmail({to:'codes+abc@auth.example',headers:new Headers({'Authentication-Results':'mx.cloudflare.net; dkim=fail (ignored; dmarc=pass); dmarc=fail'}),raw:raw('Your code is 384217')})).toBeUndefined();
 expect((await readVerificationEmail({to:'codes+abc@auth.example',headers:new Headers({'Authentication-Results':'mx.cloudflare.net; dkim=pass (valid, signed); dmarc=pass header.from=owned.example, attacker.test 1; dmarc=fail'}),raw:raw('Your code is 384217')}))?.code).toBe('384217');
});
