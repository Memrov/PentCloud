import {describe,expect,it} from "vitest";
import {materialHash,materialSelection,selectionManifest,type MaterialFile} from "../src/native/materials";
import {verifyMaterialInput} from "../src/native/material-input";
import {assertRoleWrite} from "../src/native/tool-policy";

describe("pinned native material input",()=>{
  const setup=async()=>{
    const bytes=new TextEncoder().encode("const config = 'audited';\n"),sha256=await materialHash(bytes);
    const file:MaterialFile={id:"upload-1",name:"config.ts",sha256,size:bytes.length,mediaType:"text/plain",kind:"text",sourcePath:`.pentagi/materials/${sha256}/source`,textPath:`.pentagi/materials/${sha256}/source`,textSha256:sha256,textSize:bytes.length,uploadedBy:"operator",createdAt:1};
    const selection=await materialSelection(undefined,[file]);
    const map=new Map([["/repo/"+file.sourcePath,bytes],["/repo/"+selection.manifestPath,new TextEncoder().encode(selectionManifest(selection))]]);
    const fs={readFile:async(path:string)=>{const value=map.get(path);if(!value)throw new Error("missing");return new Blob([value]).stream();}};
    return {selection,file,map,fs};
  };
  it("verifies admitted bytes and exact manifest before model/tool use",async()=>{
    const {selection,fs}=await setup();
    expect(await verifyMaterialInput(fs,"/repo",{materials:selection})).toEqual(selection);
    expect(await verifyMaterialInput(fs,"/repo",{})).toBeUndefined();
  });
  it("rejects a changed manifest, raw file or content digest",async()=>{
    const {selection,file,map,fs}=await setup();
    await expect(verifyMaterialInput(fs,"/repo",{materials:{...selection,digest:"f".repeat(64)}})).rejects.toThrow(/manifest|digest/i);
    map.set("/repo/"+file.sourcePath,new TextEncoder().encode("changed source"));
    await expect(verifyMaterialInput(fs,"/repo",{materials:selection})).rejects.toThrow(/bytes|hash|size/i);
    map.set("/repo/"+selection.manifestPath,new TextEncoder().encode("{}"));
    await expect(verifyMaterialInput(fs,"/repo",{materials:selection})).rejects.toThrow(/manifest/i);
  });
  it("keeps uploaded originals protected across every active role",()=>{
    for(const role of ["primary","adviser","coder","maintenance","memorist","pentester","searcher","reporter"] as const)
      expect(()=>assertRoleWrite(role,"job-1",".pentagi/materials/a/source")).toThrow();
  });
});
