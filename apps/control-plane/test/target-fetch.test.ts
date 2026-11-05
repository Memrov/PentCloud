import {it,expect} from "vitest";
import {performTargetFetch} from "../src/native/target-fetch";
const target={url:"https://example.com/",access:{headers:[{name:"X-Researcher",value:"required"}]}};
it("rejects an off-target request without dispatching and keeps redirects visible for the next policy check",async()=>{
 let dispatched=0;const fetcher:typeof fetch=async(input,init)=>{dispatched++;expect(String(input)).toBe("https://example.com/login");expect(init?.redirect).toBe("manual");return new Response(null,{status:302,headers:{Location:"https://outside.example/"}});};
 await expect(performTargetFetch(target,new Request("https://outside.example/"),fetcher)).rejects.toThrow(/target/i);expect(dispatched).toBe(0);
 const response=await performTargetFetch(target,new Request("https://example.com/login"),fetcher);expect(response.status).toBe(302);expect(dispatched).toBe(1);
});
it("injects required headers into anonymous requests and only accepts an explicit target credential",async()=>{
 const calls:Headers[]=[];const fetcher:typeof fetch=async(_input,init)=>{calls.push(new Headers(init?.headers));return new Response("ok");};
 await performTargetFetch(target,new Request("https://example.com/",{headers:{"CF-Access-Jwt-Assertion":"operator","X-Researcher":"override"}}),fetcher);
 expect(calls[0]!.get("X-Researcher")).toBe("required");expect(calls[0]!.has("CF-Access-Jwt-Assertion")).toBe(false);expect(calls[0]!.has("Authorization")).toBe(false);
 await performTargetFetch(target,new Request("https://example.com/"),fetcher,{header:"Authorization",value:"Bearer target-key"});expect(calls[1]!.get("Authorization")).toBe("Bearer target-key");
});
it("bounds streamed bodies even without a Content-Length header",async()=>{
 let dispatched=false;const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(2*1024*1024));controller.enqueue(new Uint8Array(1));controller.close();}});
 const request=new Request("https://example.com/",{method:"POST",body,duplex:"half"} as RequestInit);
 await expect(performTargetFetch(target,request,async()=>{dispatched=true;return new Response();})).rejects.toThrow(/too large/);
 expect(dispatched).toBe(false);
});
