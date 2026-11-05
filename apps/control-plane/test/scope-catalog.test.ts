import {it,expect} from "vitest";
import {ScopeCatalog} from "../src/native/scope-catalog";
it("reports safe upstream status without returning error bodies",async()=>{
 const catalog=new ScopeCatalog({get:()=>undefined,put:()=>{},fetcher:async()=>new Response('upstream private text',{status:403})});
 await expect(catalog.names()).rejects.toThrow(/HTTP 403/);
 await expect(catalog.names()).rejects.not.toThrow(/upstream private/);
});
const sha="a".repeat(40),path="programs/hackerone/"+"b".repeat(64)+".json";
const program={schema_version:1,id:"hackerone:example",name:"Example",platform:"hackerone",url:"https://hackerone.com/example",source_status:{field:"submission_state",value:"open"},targets:{in_scope:[{type:"URL",value:"example.com"}],out_of_scope:[]}};
async function fixture(corrupt=false,gitRefs?:string){
 const encode=(v:unknown)=>JSON.stringify(v),hash=async(s:string)=>[...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,"0")).join("");
 const file=encode(program),index=encode({schema_version:1,programs:[{id:program.id,name:program.name,platform:program.platform,url:program.url,path,scope_counts:{in_scope:1,out_of_scope:0}}]});
 const manifest=encode({schema_version:1,published_at:new Date().toISOString(),source:{commit:"c".repeat(40)},files:{"index.json":await hash(index),[path]:await hash(file)}});
 const requests:string[]=[],cache=new Map<string,unknown>();
 const fetcher:typeof fetch=async(input,init)=>{
  const url=String(input);requests.push(url);expect(init?.redirect).toBe("manual");
  if(url.endsWith("/git/ref/heads/catalog"))return gitRefs===undefined?Response.json({object:{sha}}):new Response('rate limit',{status:403});
  if(url.endsWith(".git/info/refs?service=git-upload-pack"))return new Response(gitRefs,{headers:{'Content-Type':'application/x-git-upload-pack-advertisement'}});
  if(url.endsWith("/manifest.json"))return new Response(manifest);
  if(url.endsWith("/index.json"))return new Response(index);
  if(url.endsWith("/"+path))return new Response(corrupt?file+" ":file);
  return new Response(null,{status:404});
 };
 return {catalog:new ScopeCatalog({get:<T>(k:string)=>cache.get(k) as T,put:(k,v)=>{cache.set(k,v);},fetcher}),requests};
}
const advertised="001e# service=git-upload-pack\n00000040"+"a".repeat(40)+" refs/heads/catalog\n0000";
it("imports the same immutable scope through public Git when the shared REST limit is exhausted",async()=>{
 const {catalog}=await fixture(false,advertised);
 expect((await catalog.import(program.id,"https://example.com/")).catalogCommit).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});
it("rejects missing, malformed and conflicting public Git branch advertisements",async()=>{
 for(const refs of [advertised.replace('catalog','missing'),advertised.slice(0,-3),advertised.replace('0040','zzzz'),advertised+advertised]){
  const {catalog}=await fixture(false,refs);await expect(catalog.names()).rejects.toThrow(/Invalid public scope catalog/);
 }
});
it("pins index and selected scope reads to the same catalog commit and imports only the chosen program",async()=>{
 const {catalog,requests}=await fixture();expect((await catalog.search("exam","hackerone")).programs).toHaveLength(1);
 const scope=await catalog.import("hackerone:example","https://example.com/");expect(scope.catalogCommit).toBe(sha);
 expect(requests).toEqual([
  "https://api.github.com/repos/Memrov/PentCloud-scopes/git/ref/heads/catalog",
  ...["manifest.json","index.json",path].map(file=>"https://raw.githubusercontent.com/Memrov/PentCloud-scopes/"+sha+"/"+file),
 ]);
 expect(requests.filter(url=>url.includes("/programs/"))).toHaveLength(1);
});
it("rejects a selected program whose downloaded bytes do not match the manifest",async()=>{
 const {catalog}=await fixture(true);await expect(catalog.import("hackerone:example","https://example.com/")).rejects.toThrow(/checksum/i);
});
it("never accepts arbitrary program paths or URLs as an import destination",async()=>{
 const {catalog,requests}=await fixture();await expect(catalog.import("https://attacker.test/program.json","https://example.com/")).rejects.toThrow(/program/i);
 expect(requests.some(url=>new URL(url).hostname==="attacker.test")).toBe(false);
});
it("offers only eligible web assets from the selected program for target setup",async()=>{
 const {catalog}=await fixture();const result=await catalog.preview("hackerone:example");expect(result.assets).toEqual([{value:"example.com",type:"URL"}]);expect(result.program.name).toBe("Example");
});
it("loads all lightweight program names without downloading scope documents",async()=>{
 const {catalog,requests}=await fixture();const result=await catalog.names();
 expect(result.programs).toEqual([{id:program.id,name:"Example",platform:"hackerone"}]);
 expect(JSON.stringify(result)).not.toContain("scope_counts");
 expect(requests.some(url=>url.includes("/programs/"))).toBe(false);
});
it("does not hide programs after the first50 when browsing names",async()=>{
 const programs=Array.from({length:100},(_,i)=>({id:'hackerone:'+i,name:'Program '+i,platform:'hackerone',path:'unused'}));
 const catalog=new ScopeCatalog({get:<T>()=>({programs,manifest:{},commit:sha,fetchedAt:Date.now()}) as T,put:()=>{},fetcher:async()=>{throw Error('unexpected download');}});
 expect((await catalog.names()).programs).toHaveLength(100);
});
