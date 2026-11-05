import { describe, expect, it } from "vitest";
import { performAPIRequest, validateAPIRequest } from "../src/native/api-access";
describe("target-bound native API access",()=>{
  const access={targetURL:"https://api.example/v1/",header:"Authorization",value:"Bearer test-secret"};
  it("injects the credential server-side and leaves redirects un-followed",async()=>{
    let observed:RequestInit|undefined;
    const result=await performAPIRequest(access,{path:"items",method:"GET"},async(_url,init)=>{observed=init;return Response.json({ok:true});});
    expect(new Headers(observed?.headers).get("Authorization")).toBe("Bearer test-secret");
    expect(observed?.redirect).toBe("manual");expect(result).toMatchObject({url:"https://api.example/v1/items",authenticated:true,status:200});
    expect(JSON.stringify(result)).not.toContain("test-secret");
  });
  it("rejects cross-origin and outside-root requests before sending credentials",()=>{
    for(const path of ["https://other.example/","/admin","../admin","https://user:password@api.example/v1/","%2e%2e%2fadmin","%252e%252e%252fadmin","items%5c..%5c..%5cadmin"])
      expect(()=>validateAPIRequest(access,{path,method:"POST"})).toThrow();
  });
  it("caps bodies and does not accept GET bodies or arbitrary HTTP methods",()=>{
    expect(()=>validateAPIRequest(access,{path:"items",method:"GET",body:"x"})).toThrow();
    expect(()=>validateAPIRequest(access,{path:"items",method:"CONNECT"})).toThrow();
    expect(()=>validateAPIRequest(access,{path:"items",method:"POST",body:"x".repeat(65537)})).toThrow();
  });
});
