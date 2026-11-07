import type {SessionControls} from "../../src/native/managed-session";
import {evidenceBytesHash} from "../../src/native/evidence";
import { CodeModeTool } from "@opencode/core/codemode/tool";
import { Tool } from "@opencode/schema/tool";
import { Effect } from "effect";
import { ToolboxMCP, GuardedWorkspace } from "../../src/native/tools";
import {
  contracts,
  supportedOptionalTools,
} from "../../src/native/tool-policy";
import { NativeAttempt } from "../../src/native/attempt";
import {renderLaunch,promptRendererMemory} from "../../src/native/prompts";
import primaryPrompt from "../../../../upstream/pentagi/prompts/primary_agent.tmpl?raw";
import { pinToolSkill } from "../../src/native/skills";
import {recordedWorkPage} from "../../src/native/recorded-work";
import {redact} from "../../src/native/tool-policy";
import {digest} from "../../src/native/domain";
import {type PinnedModel} from "../../src/native/opencode-models";
import {OpenCodeWorkerd} from "@opencode/sdk/workerd";
import {Plugin} from "@opencode/plugin";
import {OpenCodeConnectionTest} from "../../src/native/model-test";
import type { AttemptInput, NativeEnv } from "../../src/native/types";
import type {ToolboxReadiness, ToolboxActivity, ToolboxFailure} from "../../../../shared/toolbox-rpc";
import stockCatalog from "../fixtures/stock-kali-catalog.json";
export { WorkspaceServiceProxy } from "@cloudflare/computer";
export { NativeDynamicWorkerTail } from "../../src/native/dynamic-worker-tail";
export {TargetEgress} from "../../src/native/target-egress";

// Synthetic network response; production transport, injection and projection stay real.
const originalFetch=globalThis.fetch;
globalThis.fetch=async(input,init)=>{const url=typeof input==="string"||input instanceof URL?String(input):input.url,headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));return new URL(url).hostname==="example.com"&&headers.get("X-Researcher")==="private-header-marker"?new Response("private-header-marker"):originalFetch(input,init);};

async function fixtureReady(ctx: DurableObjectState, expected?: string): Promise<ToolboxReadiness | ToolboxFailure> {
  const generation = (await ctx.storage.get<string>("fixture:generation")) ?? "fixture-generation";
  await ctx.storage.put("fixture:readies", ((await ctx.storage.get<number>("fixture:readies")) ?? 0) + 1);
  if (expected !== undefined && expected !== generation) return {error: "generation_lost", generation};
  return {state: (await ctx.storage.get("fixture:readyBlocked")) ? "booting" : "ready", generation};
}
async function fixtureActivity(ctx: DurableObjectState, expected: string): Promise<ToolboxActivity | ToolboxFailure> {
  const generation = (await ctx.storage.get<string>("fixture:generation")) ?? "fixture-generation";
  await ctx.storage.put("fixture:activities", ((await ctx.storage.get<number>("fixture:activities")) ?? 0) + 1);
  return expected === generation ? {state: "running", generation} : {error: "generation_lost", generation};
}
async function sessionMCP(
  ctx: DurableObjectState,
  request: Request,
): Promise<Response> {
  const response = await sessionMCPResponse(ctx, request);
  response.headers.set("X-Pentcloud-Toolbox-Generation", (await ctx.storage.get<string>("fixture:generation")) ?? "fixture-generation");
  return response;
}
async function sessionMCPResponse(
  ctx: DurableObjectState,
  request: Request,
): Promise<Response> {
  const generation = (await ctx.storage.get<string>("fixture:generation")) ?? "fixture-generation";
  const pinned = request.headers.get("X-Pentcloud-Toolbox-Generation");
  if (pinned !== generation) return Response.json({state: "lost", generation}, {status: 409});
  if (request.method === "GET")
    return new Response("No standalone SSE", { status: 405 });
  const sid = request.headers.get("Mcp-Session-Id");
  const stateless = !!(await ctx.storage.get("fixture:stateless"));
  if (request.method === "DELETE") {
    await ctx.storage.put(
      "fixture:deleteAttempts",
      ((await ctx.storage.get<number>("fixture:deleteAttempts")) ?? 0) + 1,
    );
    const failure = await ctx.storage.get<boolean | number>(
      "fixture:failDelete",
    );
    if (failure)
      return new Response("Deletion unavailable", {
        status: typeof failure === "number" ? failure : 503,
      });
    if (!sid || !(await ctx.storage.get(`fixture:server:${sid}`)))
      return new Response("Session missing", { status: 404 });
    const receipt = await ctx.storage.get<{ state: string }>(
      "remote:session-lost",
    );
    await ctx.storage.put(
      "fixture:deleteAfterProof",
      !receipt ||
        receipt.state === "reconciled" ||
        receipt.state === "completed",
    );
    await ctx.storage.delete(`fixture:server:${sid}`);
    await ctx.storage.put(
      "fixture:deletes",
      ((await ctx.storage.get<number>("fixture:deletes")) ?? 0) + 1,
    );
    return new Response(null, { status: 204 });
  }
  const rpc = (await request.json()) as {
    id?: string | number;
    method: string;
    params?: {
      name?: string;
      arguments?: Record<string, unknown>;
      requestId?: string | number;
    };
  };
  if (rpc.method === "initialize") {
    await ctx.storage.put(
      "fixture:initializes",
      ((await ctx.storage.get<number>("fixture:initializes")) ?? 0) + 1,
    );
    const newSid = `probe-${crypto.randomUUID()}`;
    if (await ctx.storage.get("fixture:partialWarmup")) {
      await ctx.storage.put(`fixture:partial:${newSid}`, true);
      await ctx.storage.put("fixture:partialWarmup", false);
    }
    if (!stateless) {
      await ctx.storage.put(`fixture:server:${newSid}`, true);
      await ctx.storage.put("fixture:originalSid", newSid);
    }
    return Response.json(
      {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "stateful-stock-fixture", version: "1" },
        },
      },
      stateless ? {} : { headers: { "Mcp-Session-Id": newSid } },
    );
  }
  if (!stateless && (!sid || !(await ctx.storage.get(`fixture:server:${sid}`))))
    return new Response("Wrong session", { status: 404 });
  if (rpc.method === "notifications/initialized")
    return new Response(null, { status: 202 });
  if (rpc.method === "notifications/cancelled") {
    await ctx.storage.put("fixture:cancelledWireId", rpc.params?.requestId);
    return new Response(null, { status: 202 });
  }
  if (rpc.id !== undefined) {
    const seen =
      (await ctx.storage.get<Array<string | number>>("fixture:wireIds")) ?? [];
    seen.push(rpc.id);
    await ctx.storage.put("fixture:wireIds", seen);
    if (await ctx.storage.get(`fixture:pending:${rpc.id}`))
      await ctx.storage.put("fixture:idCollision", true);
  }

  let result: object;
  if (rpc.method === "tools/list") {
    if (sid && await ctx.storage.get(`fixture:partial:${sid}`)) {
      await ctx.storage.put("fixture:modelsAtPartialCatalog", (await ctx.storage.get("fixture:modelRequests")) ?? 0);
      await ctx.storage.put("fixture:partialCatalogWasPinned", !!(await ctx.storage.get("remoteCatalog")));
    }
    result = {
      tools: (sid && await ctx.storage.get(`fixture:partial:${sid}`)) ? stockCatalog.tools.slice(0, 100) : stockCatalog.tools,
    };
  } else if (rpc.method === "tools/call") {
    await ctx.storage.put("fixture:toolCalls", ((await ctx.storage.get<number>("fixture:toolCalls")) ?? 0) + 1);
    if (rpc.params?.name === "whatweb_whatweb_scan") await ctx.storage.put("fixture:whatwebArguments",rpc.params.arguments);
    if (rpc.params?.name === "nmap_port_scan") {
      const durable = await ctx.storage.get<{
        sessionId: string;
        protocolVersion?: string;
      }>("mcpSession");
      await ctx.storage.put(
        "fixture:persistedBeforeMutation",
        stateless ||
          (durable?.sessionId === sid &&
            durable.protocolVersion === "2025-03-26"),
      );
      await ctx.storage.put("fixture:scanSid", sid ?? "stateless");
      if (await ctx.storage.get("fixture:dropSessionReply")) {
        await ctx.storage.put("fixture:oldWireId", rpc.id);
        await ctx.storage.put(`fixture:pending:${rpc.id}`, true);
        await ctx.storage.put("fixture:dropSessionReply", false);
        throw new Error(
          "Injected domain response loss after persistent remote scan",
        );
      }
    }
    if (
      rpc.params?.name === "nmap_get_scan_results" &&
      rpc.params.arguments?.scan_id === "cancel-probe"
    ) {
      await ctx.storage.put("fixture:newHeldWireId", rpc.id);
      return new Promise<Response>((resolve) =>
        request.signal.addEventListener(
          "abort",
          () =>
            resolve(
              Response.json({
                jsonrpc: "2.0",
                id: rpc.id,
                error: { code: -32000, message: "Transport closed" },
              }),
            ),
          { once: true },
        ),
      );
    }
    const oldId = await ctx.storage.get<string | number>("fixture:oldWireId");
    if ((await ctx.storage.get("fixture:completeOld")) && oldId !== undefined)
      await ctx.storage.delete(`fixture:pending:${oldId}`);
    const operationStatus =
      oldId !== undefined && (await ctx.storage.get(`fixture:pending:${oldId}`))
        ? "running"
        : "completed";
    const original = await ctx.storage.get<string>("fixture:scanSid");
    if (
      rpc.params?.name === "nmap_get_scan_results" &&
      original !== (sid ?? "stateless")
    )
      result = {
        content: [{ type: "text", text: "Scan not found in this session" }],
      };
    else
      result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              scan_id: "session-scan",
              http_status: rpc.params?.name?.startsWith("whatweb_")?(await ctx.storage.get("fixture:whatwebEmpty")?null:200):undefined,
              target: (rpc.params?.name?.startsWith("whatweb_")?await ctx.storage.get("fixture:whatwebTarget"):undefined)??"127.0.0.1",
              scan_type: "port",
              status: (rpc.params?.name?.startsWith("whatweb_")&&await ctx.storage.get("fixture:whatwebFailed"))?"failed":operationStatus,
            }),
          },
        ],
        isError: false,
      };
  } else result = {};
  return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
}

/** Local fixture: Workspace, Git, shell, JS and guarded RPC are real; only external authorities are substitutes. */
export class ProbeAttempt extends NativeAttempt {
  private readonly published: Array<{ ref?: string; remoteRef?: string }> = [];
  constructor(ctx: DurableObjectState, bindings: { LOADER: WorkerLoader }) {
    const fakeArtifacts = {
      get: async () => ({
        createToken: async (scope: "read" | "write") => ({ plaintext: `local-probe-token-${scope}` }),
        readFile: async ({ ref, path }: { ref: string; path: string }) => {
          if (
            ref !==
            (await this.workspace.git.revParse({
              dir: this.directory,
              ref: "HEAD",
            }))
          )
            throw new Error("Wrong candidate commit");
          return new Blob([
            await this.workspace.fs.readFile(
              `${this.directory}/${path}`,
              "utf8",
            ),
          ]);
        },
        [Symbol.dispose]() {},
      }),
    };
    super(ctx, {
      ...bindings,
      ARTIFACTS: fakeArtifacts,
      CONTROL_TOKEN: "local-probe-control",
      OPENCODE_GO_API_KEY: "local-probe-go",
      PENTCLOUD_TARGET_HEADERS:{get:async()=>JSON.stringify({"X-Researcher":"private-header-marker"})},
      CF_VERSION_METADATA: { id: "probe-terminal", tag: "fixture" },
      COORDINATOR: {
        getByName: () => ({
          assertActive: async () => {},
          apiCredential:async()=>({targetURL:"https://example.com/"}),
          assertConversation: async () => {},
          assertEvidenceOwner: async () => {},
          recordEvidence: async (_id:string,receipt:unknown) => {
            const values=await ctx.storage.get<unknown[]>("fixture:evidenceReceipts")??[];
            if(!values.some(x=>JSON.stringify(x)===JSON.stringify(receipt)))await ctx.storage.put("fixture:evidenceReceipts",[...values,receipt]);
          },
          getContext: async () => await ctx.storage.get<Record<string,unknown>>("fixture:liveContext")??{},
          readRunWork:async(_requester:string,_job?:string,offset=0)=>recordedWorkPage(redact({messages:[{text:"TOKEN=private-assignment\n"+"recorded source evidence 🧪 ".repeat(3000)}]},[]),offset),
        }),
      },
      TOOLBOX: {
        putFile:async (scope:{attemptId:string},file:{path:string;size:number;sha256:string},body:ReadableStream<Uint8Array>)=>{
          const bytes=new Uint8Array(await new Response(body).arrayBuffer());if(bytes.length!==file.size||await evidenceBytesHash(bytes)!==file.sha256)throw new Error("fixture byte mismatch");
          const path=`/fixture-kali/${ctx.id}/${file.path}`;await this.workspace.fs.mkdir(path.slice(0,path.lastIndexOf('/')),{recursive:true});await this.workspace.fs.writeFile(path,bytes);
          return {...file,path:`/work/pentcloud/local-run/${scope.attemptId}/${file.path}`};
        },
        getFile:async (_scope:unknown,path:string)=>{const bytes=await this.workspace.fs.readFile(`/fixture-kali/${ctx.id}/${path}`);const value=new Uint8Array(await new Response(bytes).arrayBuffer());return new Response(value,{headers:{"X-Content-SHA256":await evidenceBytesHash(value)}});},
        listFiles:async()=>({root:"/fixture-kali",files:[],unavailable:[],truncated:false}),
        ready: (expected?: string) => fixtureReady(ctx, expected),
        activity: (expected: string) => fixtureActivity(ctx, expected),
        status: async () => ({state: "running", generation: (await ctx.storage.get<string>("fixture:generation")) ?? "fixture-generation", inactivityTimeoutMs: 1800000}),
        fetch: async (request: Request) => sessionMCP(ctx, request),
      },
    } as unknown as NativeEnv);
    this.workspace.git.push = async (options) => {
      if (options?.headers?.Authorization !== `Basic ${btoa("x:local-probe-token-write")}`)
        throw new Error("Candidate push must receive a write repository token");
      this.published.push({
        ...(options?.ref ? { ref: options.ref } : {}),
        ...(options?.remoteRef ? { remoteRef: options.remoteRef } : {}),
      });
      return { ok: true, error: null, refs: {} };
    };
    // No model is run by this fixture. Cancellation still exercises the durable runtime fence.
    this.harness.abort = async () => true;
    const setup = this.plugin.setup;
    (this.plugin as {setup:typeof setup}).setup = async context => {
      await setup(context);
      if (await this.ctx.storage.get("fixture:holdModel")) await context.session.hook("model.request", async event => {
        await this.ctx.storage.put("fixture:modelKinds", [...((await this.ctx.storage.get<string[]>("fixture:modelKinds")) ?? []), event.kind]);
        // OpenCode prepares a title request too. Only primary execution is the
        // operation being evicted; auxiliary preparation must never reach HTTP.
        if (event.kind !== "primary") throw new Error("LOCAL_AUXILIARY_PROBE_NO_MODEL_HTTP");
        await this.ctx.storage.put("fixture:modelRequests", ((await this.ctx.storage.get<number>("fixture:modelRequests")) ?? 0) + 1);
        await this.ctx.storage.put("fixture:modelHeld", true);
        await new Promise(resolve => setTimeout(resolve, 120000));
        throw new Error("LOCAL_EVICTION_PROBE_NO_MODEL_HTTP");
      });
      if (await this.ctx.storage.get("fixture:stopBeforeModel")) await context.session.hook("model.request", async event => {
        await this.ctx.storage.put("fixture:modelKinds", [...((await this.ctx.storage.get<string[]>("fixture:modelKinds")) ?? []), event.kind]);
        if (event.kind === "primary") await this.ctx.storage.put("fixture:modelRequests", ((await this.ctx.storage.get<number>("fixture:modelRequests")) ?? 0) + 1);
        throw new Error("LOCAL_STARTUP_PROBE_NO_MODEL_HTTP");
      });
      if (await this.ctx.storage.get("fixture:inspectProviderTools")) await context.session.hook("http.request", async event => {
        const body = await event.request.clone().json() as {tools?:Array<{type:string;function?:{name:string;parameters:unknown};name?:string}>};
        const tools = body.tools ?? [];
        await this.ctx.storage.put("fixture:providerTools",{names:tools.map(tool=>tool.function?.name??tool.name),browser:tools.find(tool=>tool.function?.name === "browser")?.function?.parameters ?? null});
        const origin=await this.ctx.storage.get<string>("fixture:scriptedOrigin");
        if(origin && (await this.ctx.storage.get<{preparation?:true}>("attempt"))?.preparation){event.request=new Request(origin+"/fake-provider"+(await this.ctx.storage.get("fixture:question")?"?question=1":""),event.request);return;}
        throw new Error("LOCAL_TOOL_ASSEMBLY_PROBE_NO_MODEL_HTTP");
      });
    };
  }
  async configurePreparation(origin:string,question=false,failure:string|null=null){await this.ctx.storage.put("fixture:scriptedOrigin",origin);await this.ctx.storage.put("fixture:question",question);if(failure)await this.ctx.storage.put("fixture:promotionFailure",failure);}
  async probe(kind: string, origin?: string) {
    const id = "local-attempt";
    await this.workspace.fs.mkdir(this.directory, { recursive: true });
    await this.workspace.fs.mkdir("/workspace/scratch", { recursive: true });
    await this.workspace.git.init({
      dir: this.directory,
      defaultBranch: "main",
    });
    await this.workspace.fs.writeFile(
      `${this.directory}/README.md`,
      "accepted baseline\n",
    );
    await this.workspace.git.add({ dir: this.directory, paths: ["README.md"] });
    const base = await this.workspace.git.commit({
      dir: this.directory,
      message: "probe baseline",
    });
    if(!kind.startsWith("preparation-"))await this.workspace.git.branch({
      dir: this.directory,
      name: `attempts/${id}`,
      checkout: true,
    });
    const input: AttemptInput = {
      id,
      runId: "local-run",
      role:
        kind.startsWith("package-only")?"coder":
        kind==="finding-contract"?"reporter":
        kind.startsWith("native-discovery")?"pentester":
        kind.startsWith("evidence")?"coder":
        (kind === "sdk-toolbox-cold" || kind === "toolbox-eviction") ? "coder" : kind === "toolbox-generation-loss" ? "pentester" :
        kind.startsWith("sdk-role-") ? kind.slice(9) as AttemptInput["role"] :
        kind === "sdk-searcher-tools" ? "searcher" : kind === "sdk-memorist-tools" ? "memorist" : kind === "sdk-pentester-tools" ? "pentester" : kind === "sdk-managed-specialist" ? "coder" : kind === "sdk-managed-specialist-primary" ? "primary" :
        kind.startsWith("metasploit") ||
        kind.startsWith("session") ||
        kind === "unknown" ||
        kind === "known-running"
          ? "pentester"
          : (kind.startsWith("memory") || kind === "computer-coder")
            ? "coder"
            : kind === "research-policy"
              ? "searcher"
              : "primary",
      tool: "primary",
      args: { task: "probe" },
      task: "probe",
      inputCommit: base.oid,
      repo: "local-probe",
      remote: "https://example.invalid/repo.git",
      settingsRevision: "a".repeat(64),
      settings: {
        ...(kind.startsWith("sdk-managed-specialist")||kind==="package-only" ? { promptFormat: "markdown" as const } : {}),
        promptTemplate: "Probe",
        upstreamPromptDigest: "b".repeat(64),
        model: "opencode-go:deepseek-v4-pro",
        reasoningEffort: "default",
      },
      depth: 0,
      attempt: 1,
      logicalThreadId: id,
      context: {},
      createdAt: Date.now(),
    };
    input.context = {
      enabledTools: supportedOptionalTools(input.role),
      browserAllowedURLs: ["https://example.com/"],
    };
    if(kind==="preparation-chat"||kind==="preparation-stop"){
      input.role="primary";input.context.enabledTools=supportedOptionalTools("primary");
      await this.ctx.storage.put("fixture:inspectProviderTools",true);
      await this.ctx.storage.put("fixture:readyBlocked",true);
      const backup=this.directory+"-remote";
      await this.workspace.fs.rename(this.directory,backup);
      this.workspace.git.clone=async options=>{if(options.headers?.Authorization!=="Basic "+btoa("x:local-probe-token-read"))throw new Error("Clone requires read-only source access");if((await this.ctx.storage.get<{preparation?:true}>("attempt"))?.preparation!==true && await this.ctx.storage.get("fixture:promotionFailure")==="clone" && !await this.ctx.storage.get("fixture:promotionFailed")){await this.ctx.storage.put("fixture:promotionFailed",true);throw new Error("Injected one-shot promotion clone failure");}await this.workspace.fs.rename(backup,options.dir!);return undefined as never;};
      await this.prepareConversation(input);await this.prepareConversation(input);
      let form:SessionControls["forms"][number]|undefined;
      if(kind==="preparation-chat"){
        for(let n=0;n<200&&!form;n++){form=(await this.sessionControls()).forms[0];if(!form)await new Promise(resolve=>setTimeout(resolve,10));}
        if(!form)throw new Error("Preparation question did not become answerable");
      }else await this.harness.wait("prepare-"+input.id);
      const before={tools:await this.ctx.storage.get("fixture:providerTools"),users:(await this.harness.session().history()).filter(message=>message.type==="user").length,session:this.harness.session().id,readies:(await this.ctx.storage.get("fixture:readies"))??0};
      const internals=this as unknown as {cloudflareTools():Promise<Array<{name:string}>>;callCloudflareTool(tool:unknown,args:unknown,id:string,signal:AbortSignal):Promise<unknown>;callTool(name:string,args:unknown,id:string,signal:AbortSignal):Promise<unknown>};
      const tools=await internals.cloudflareTools();
      const read=await internals.callCloudflareTool(tools.find(tool=>tool.name==="computer_read"),{path:"README.md"},"prepare-read",new AbortController().signal);
      let writeDenied=false,resultDenied=false;
      try{await internals.callCloudflareTool(tools.find(tool=>tool.name==="computer_write"),{path:"README.md",content:"changed"},"prepare-write",new AbortController().signal);}catch{writeDenied=true;}
      try{await internals.callTool("done",{},"prepare-result",new AbortController().signal);}catch{resultDenied=true;}
      if(kind==="preparation-stop"){
        await this.cancel();let steerDenied=false;try{await this.steer("late");}catch{steerDenied=true;}
        return {before,writeDenied,resultDenied,steerDenied,readiness:await this.purgeReadiness(input.runId)};
      }
      await this.workspace.fs.writeFile(this.directory+"/discovery.txt","validated discovery");await this.workspace.git.add({dir:this.directory,paths:["discovery.txt"]});
      const advanced=await this.workspace.git.commit({dir:this.directory,message:"discovery accepted"});
      await this.workspace.fs.rm(this.directory+"/.git/refs/heads/attempts/local-attempt");
      await this.workspace.fs.rename(this.directory,backup);
      await this.ctx.storage.put("fixture:liveContext",{discovery_result:"validated discovery"});
      const admission={...input,inputCommit:advanced.oid,context:{...input.context,discovery_result:"validated discovery"}};
      if(await this.ctx.storage.get("fixture:promotionFailure")==="reload"){
        const actor=this as unknown as {reloadConversation:()=>Promise<void>},reload=actor.reloadConversation;
        actor.reloadConversation=async()=>{if(!await this.ctx.storage.get("fixture:promotionFailed")){await this.ctx.storage.put("fixture:promotionFailed",true);throw new Error("Injected one-shot promotion reload failure");}await reload();};
      }
      const promoted=this.run(admission).then(result=>({result}),error=>({error:String(error)}));
      for(let n=0;n<200&&!(this as unknown as {admittingConversation?:Promise<void>}).admittingConversation;n++)await new Promise(resolve=>setTimeout(resolve,10));
      await this.replyNative("form",form!.id,{session:this.harness.session().id,answer:{q0:"Focused"}});
      const first=await promoted;
      const pendingAfterFailure=!!(await this.ctx.storage.get<{promotionPending?:true}>("attempt"))?.promotionPending;
      const result="result" in first?first.result:await this.run(admission);
      let changedReplayDenied=false;try{await this.run({...input,inputCommit:"f".repeat(40)});}catch{changedReplayDenied=true;}
      const history=await this.harness.session().history();
      const after={tools:await this.ctx.storage.get("fixture:providerTools"),session:this.harness.session().id,source:(await this.ctx.storage.get<{input:AttemptInput}>("attempt"))?.input.inputCommit,
        retained:!!await this.ctx.storage.get("preparation:snapshot"),discoveryDelivered:JSON.stringify(history).includes("validated discovery"),users:history.filter(message=>message.type==="user").length};
      await this.harness.dispose();return {before,after,read,writeDenied,resultDenied,changedReplayDenied,pendingAfterFailure,firstFailure:"error" in first,formAnswered:JSON.stringify(history).includes("Focused"),result:result.status,expected:advanced.oid};
    }
    if(kind.startsWith("native-discovery")){
      input.execution={kind:"discovery",url:"http://127.0.0.1/",profile:kind==="native-discovery-legacy"?"whatweb-polite-v1":"whatweb-stealthy-v2"};
      input.context.target={id:"owned-target",kind:"website",url:input.execution.url};
      input.tool="native_discovery";
      Object.assign(this.env,{OPENCODE_GO_API_KEY:""});
      await this.ctx.storage.put("fixture:whatwebTarget",input.execution.url);
      if(kind==="native-discovery-failed")await this.ctx.storage.put("fixture:whatwebFailed",true);
      if(kind==="native-discovery-empty")await this.ctx.storage.put("fixture:whatwebEmpty",true);
    }
    if(kind==="native-pinned-model"||kind==="sdk-terminal-cold"){
      input.modelConfig={id:"opencode:fixture-console",modelId:"fixture-console",provider:"opencode",route:"console",adapter:"chat-completions",name:"Fixture Console",
        package:"@opencode/ai/providers/openai-compatible",baseURL:"https://opencode.ai/inference/openai/v1",contextLength:128000,outputLimit:8192,
        compatibility:{reasoning_field:"reasoning_content"},reasoningEfforts:["default"],inputModalities:["text"],outputModalities:["text"],supportedParameters:[],
        credentialId:"fixture-key",credentialVersion:1,catalogDigest:"a".repeat(64),testedAt:Date.now()};
      input.settings.model=input.modelConfig.id;
      Object.assign(this.env.COORDINATOR,{getByName:()=>({assertActive:async()=>{},getContext:async()=>({}),modelCredential:async()=>{await this.ctx.storage.put("fixture:credentialReads",((await this.ctx.storage.get<number>("fixture:credentialReads"))??0)+1);if(await this.ctx.storage.get("fixture:credentialDenied"))throw new Error("409: Conversation is not available for this queued primary");return "fixture-model-key";}})});
      await this.ctx.storage.put("fixture:stopBeforeModel",true);
    }
    if(kind==="finding-contract")input.findingsVersion=1;
    if(kind==="header-redaction")input.targetConfig={id:"echo-site",url:"https://example.com/",name:"Echo",kind:"website",revision:1,archived:false,createdAt:0,updatedAt:0,updatedBy:"fixture",objective:"",exclusions:"",access:{headers:[],headerBinding:"PENTCLOUD_TARGET_HEADERS"}};

    await this.ctx.storage.put("attempt", {
      input,
      fingerprint: kind === "toolbox-eviction" || kind.startsWith("native-discovery") || kind==="native-pinned-model" ? await digest(input) : "local-probe",
      prompt: "Probe",
      promptDigest: "c".repeat(64),
      ...(kind.startsWith("sdk-managed-specialist") ? { toolSkill: await pinToolSkill() } : {}),
      status: "running",
      prepared: true,
      startedAt: Date.now(),
      runtimeVersion: { id: "probe-initialized", tag: "fixture" },
    });
    type Internals = {
      initialize(input:AttemptInput):Promise<unknown>;
      preflightToolbox(state:object):Promise<void>;
      packCall(input:import("../../../../shared/tool-packs").ToolPackRequest,id:string):Promise<unknown>;
      safe(value:unknown):unknown;
      apiRequest(input:unknown,id:string):Promise<unknown>;
      cloudflareTools(): Promise<import("../../src/native/cloudflare-tools").CloudflareTool[]>;
      callCloudflareTool(tool: import("../../src/native/cloudflare-tools").CloudflareTool, args: unknown, id: string, signal: AbortSignal): Promise<unknown>;
      terminal(args: Record<string, unknown>): Promise<unknown>;
      javascript(source: string): Promise<unknown>;
      publish(proposal: object): Promise<unknown>;
      callTool(name: string, args: object, callId: string): Promise<unknown>;
      captureToolEvidence(tool:string,args:Record<string,unknown>,id:string,result:unknown):Promise<void>;
      checkpointEvidence():Promise<import("../../src/native/evidence").EvidenceCheckpoint|undefined>;
    };
    const internal = this as unknown as Internals;
    if(kind.startsWith("package-only")){
      const checks:Record<string,unknown>={};
      delete this.env.TOOLBOX;
      let runs=0,stops=0;
      this.env.TOOL_PACKS={ready:async()=>({}),run:async()=>{runs++;return {exitCode:0,stdout:"owned package result",stderr:""};},stop:async()=>{stops++;return {stopped:true};}};
      await this.ctx.storage.delete("attempt");await internal.initialize(input);
      const state=(await this.ctx.storage.get<Record<string,unknown>>("attempt"))!;
      await this.ctx.storage.put("attempt",{...state,prepared:true});
      await internal.preflightToolbox(state);
      checks.prompt=state.prompt;checks.skill=(state.toolSkill as {content:string}|undefined)?.content??"";
      checks.tools=(await internal.cloudflareTools()).map(tool=>tool.name);
      const request={pack:"http" as const,request:{tool:"curl",target:"https://owned.example/"}};
      checks.result=await internal.packCall(request,"once");await internal.packCall(request,"once");
      checks.shell=await internal.terminal({input:"echo owned",cwd:this.directory});
      await this.cancel();checks.execution=await this.execution();checks.runs=runs;checks.stops=stops;
      checks.readies=(await this.ctx.storage.get("fixture:readies"))??0;
      checks.initializes=(await this.ctx.storage.get("fixture:initializes"))??0;
      return checks;
    }else if(kind==="finding-contract"){
      const emptyState=await this.ctx.storage.get<Record<string,unknown>>("attempt");
      await this.ctx.storage.put("attempt",{...emptyState,status:"settled"});
      const emptyWork=JSON.parse((await this.recordedWork(input.runId)).text);
      if(emptyWork.historyAvailable||emptyWork.messages.length)throw new Error("Missing history was replaced with a synthetic session");
      // Exercise the real input projection. Seeding storage directly hid the
      // dropped findingsVersion and skipped the agent's format instructions.
      await this.ctx.storage.delete("attempt");
      await internal.initialize(input);
      const reviewTool=(await internal.cloudflareTools()).find(t=>t.name==="pentcloud_run_work")!;
      let reviewText="",reviewOffset=0,reviewPages=0;
      for(;;){const response=await internal.callCloudflareTool(reviewTool,{job_id:"source-job",offset:reviewOffset},"review-"+reviewPages,new AbortController().signal) as {content:string};const page=JSON.parse(response.content).value;reviewText+=page.text;reviewPages++;if(page.nextOffset===undefined)break;reviewOffset=page.nextOffset;}
      const review=JSON.parse(reviewText);
      if(!review.messages[0].text.startsWith("TOKEN=[redacted]\n")||reviewText.includes("private-assignment")||reviewPages<2)throw new Error("Recorded-work delivery changed or exposed secret content");
      const proposal={tool:"report_result",arguments:{report:"Reviewed existing evidence"},status:"completed",finishedAt:Date.now()};
      let missing:string|undefined;try{await internal.publish(proposal);}catch(error){missing=String(error);}
      const after=await this.ctx.storage.get<{proposal?:unknown}>("attempt");
      if(!missing?.includes("Required")||after?.proposal)throw new Error(`Missing index guard: ${missing}; proposal=${!!after?.proposal}`);
      const root=`.pentagi/evidence/${id}`;await this.workspace.fs.mkdir(`${this.directory}/${root}`,{recursive:true});
      const doc={version:1,coverage:"partial",summary:"Owned fixture; incomplete coverage",reportPath:root+"/report.md",findings:[]};
      await this.workspace.fs.writeFile(`${this.directory}/${root}/findings.json`,JSON.stringify(doc));
      await this.workspace.fs.writeFile(`${this.directory}/${root}/report.md`,"# Owned partial assessment");
      const result=await internal.publish(proposal) as import("../../src/native/types").AttemptResult;
      const committed=JSON.parse(await this.workspace.fs.readFile(`${this.directory}/.pentagi/jobs/${id}/result.json`,"utf8"));
      return {missing,proposalAfterMissing:!!after?.proposal,outputCommit:result.outputCommit,version:committed.findings_version,modelRequests:await this.ctx.storage.get("fixture:modelRequests")??0};
    }

    const shell = async (command: string) =>
      internal.terminal({
        input: command,
        cwd: this.directory,
        detach: false,
        timeout: 30,
        message: "local probe",
      });
    const checks: Record<string, unknown> = {};
    if(kind==="sdk-live-transport"){
      await this.lifecycle.start();
      Object.assign(this.env,{OPENCODE_GO_API_KEY:"fixture-sensitive-key"});
      const image="data:image/png;base64,aGVsbG8=";
      const tool={type:"tool",id:"browser-call",name:"cloudflare_browser",state:{status:"completed",input:{action:"screenshot"},content:[{type:"text",text:"Captured evidence"}],metadata:{cloudflareImages:[image]}}};
      let emit:(events:unknown[])=>void=()=>{},stops=0;
      const fake={id:"ses_root",busy:async()=>true,history:async()=>[{id:"answer",type:"assistant",content:[tool]}],events:async()=>({snapshot:{messages:[{id:"past-span",type:"assistant",time:{created:0},content:[{type:"text",text:"Proof"}]},{id:"recover",type:"assistant",time:{created:0},content:[{type:"text",text:""}]},{id:"overlap",type:"assistant",time:{created:0},content:[{type:"text",text:"Hello"}]}],pending:[],permissions:[],busy:true},start:(listener:(events:unknown[])=>void)=>{emit=listener;},stop:async()=>{stops++;}}),log:async function*(){throw new Error("LOCAL_DURABLE_ONLY_TRANSPORT");}};
      this.harness.session=()=>fake as unknown as ReturnType<typeof this.harness.session>;
      const abort=new AbortController();
      const response=await this.events(new Request("https://probe.invalid/events",{signal:abort.signal}));
      const reader=response.body!.getReader(),decoder=new TextDecoder();let text="";
      const until=async(marker:string)=>{while(!text.includes(marker)){const chunk=await reader.read();if(chunk.done)throw new Error("Live stream ended before "+marker);text+=decoder.decode(chunk.value);}};
      await until("event: snapshot");
      checks.completedSnapshotRetained=text.includes('"text":"Proof"');
      emit([{type:"message_start",messageId:"answer",agent:"primary",model:{providerID:"opencode",id:"fixture"}},{type:"text_delta",messageId:"answer",ordinal:0,delta:"Partial live answer"}]);
      await until("Partial live answer");checks.partialBeforeEnd=!text.includes("text_end");
      emit([{type:"text_delta",messageId:"answer",ordinal:1,delta:"fixture-sensi"},{type:"text_delta",messageId:"answer",ordinal:1,delta:"tive-key"},{type:"text_end",messageId:"answer",ordinal:1,text:"fixture-sensitive-key"},
        {type:"text_delta",messageId:"answer",ordinal:2,delta:'{"api_key": "live-'},{type:"text_delta",messageId:"answer",ordinal:2,delta:'private-value"}'},{type:"text_end",messageId:"answer",ordinal:2,text:'{"api_key": "live-private-value"}'},
        {type:"text_delta",messageId:"answer",ordinal:3,delta:'PASSWORD="first '},{type:"text_delta",messageId:"answer",ordinal:3,delta:'private tail'},{type:"text_end",messageId:"answer",ordinal:3,text:'PASSWORD="first private tail'},
        {type:"text_delta",messageId:"answer",ordinal:4,delta:"API_TOKEN='first "},{type:"text_delta",messageId:"answer",ordinal:4,delta:"single tail"},{type:"text_delta",messageId:"answer",ordinal:4,delta:"' permitted summary"},{type:"text_end",messageId:"answer",ordinal:4,text:"API_TOKEN='first single tail' permitted summary"},
        {type:"text_delta",messageId:"recover",ordinal:0,delta:"tive-key"},{type:"text_end",messageId:"recover",ordinal:0,text:"fixture-sensitive-key"},
        {type:"text_delta",messageId:"overlap",ordinal:0,delta:"Hello"},{type:"text_end",messageId:"overlap",ordinal:0,text:"Hello"}]);
      emit([{type:"tool_start",messageId:"answer",toolCallId:"browser-call",name:"cloudflare_browser",input:{action:"screenshot"}},{type:"tool_end",messageId:"answer",toolCallId:"browser-call",name:"cloudflare_browser",error:false,output:"Captured evidence"}]);
      await until(image);checks.evidenceRetained=text.includes("nativeTool");
      abort.abort();await reader.cancel();
      checks.secretLeak=text.includes("fixture-sensi")||text.includes("tive-key")||text.includes("live-")||text.includes("private-value");
      checks.quotedSecretLeak=text.includes("private tail")||text.includes("single tail");checks.overlapDuplicated=text.includes("HelloHello");checks.permittedSummary=text.includes("permitted summary");
      checks.stops=stops;checks.frames=text;checks.remainingStreams=(this as unknown as {sessionStreams:Set<unknown>}).sessionStreams.size;
      checks.modelRequests=(await this.ctx.storage.get("fixture:modelRequests"))??0;checks.kaliReadies=(await this.ctx.storage.get("fixture:readies"))??0;
      await this.harness.dispose();return checks;
    }else if(kind==="sdk-terminal-cold"){
      await this.lifecycle.start();
      const receipt=await this.harness.submit("Retained terminal conversation",{operationId:"cold-history-no-model-http"});
      await this.harness.wait(receipt.operationId,{session:receipt.session});
      const before=(await this.harness.session().history()).length;
      try{await this.recordedWork("local-run");checks.activeWorkDenied=false;}catch{checks.activeWorkDenied=true;}
      await this.cancel();
      const settled=(await this.ctx.storage.get<{result:Record<string,unknown>}&Record<string,unknown>>("attempt"))!;
      await this.ctx.storage.put("attempt",{...settled,result:{...settled.result,status:"completed"}});
      await this.harness.dispose();
      await this.ctx.storage.put("fixture:credentialDenied",true);
      const credentials=await this.ctx.storage.get<number>("fixture:credentialReads")??0,models=await this.ctx.storage.get<number>("fixture:modelRequests")??0;
      checks.before=before;
      checks.after=(await this.inspect() as {messages:unknown[]}).messages.length;
      checks.events=await (await this.events(new Request("https://probe.invalid/events"))).text();
      checks.canReply=(await this.sessionControls()).canReply;
      await this.harness.dispose();
      await this.ctx.storage.put("remote:recorded-proof",{name:"ffuf",state:"unknown",remoteId:"520de8b8",result:{output:"recorded 🧪 ".repeat(10000)}});
      let offset=0,recorded="",pages=0;
      for(;;){const page=await this.recordedWork("local-run",offset);recorded+=page.text;pages++;if(page.nextOffset===undefined)break;offset=page.nextOffset;}
      const work=JSON.parse(recorded);
      checks.recorded={messages:work.messages.length,historyAvailable:work.historyAvailable,pages,remote:work.remoteCalls[0].state,outputLength:work.remoteCalls[0].result.output.length};
      try{await this.recordedWork("another-run");checks.crossRunWorkDenied=false;}catch{checks.crossRunWorkDenied=true;}
      checks.credentialReads=(await this.ctx.storage.get<number>("fixture:credentialReads")??0)-credentials;
      checks.modelRequests=(await this.ctx.storage.get<number>("fixture:modelRequests")??0)-models;
      checks.kaliReadies=await this.ctx.storage.get<number>("fixture:readies")??0;
      try{await this.steer("Must remain stopped");checks.steerDenied=false;}catch{checks.steerDenied=true;}
      await this.harness.dispose();await this.ctx.storage.deleteAlarm();
      return checks;
    }else if(kind==="evidence-finalization"){
      const operations:string[]=[];
      const harness=this.harness as unknown as {session:()=>{setModel:()=>Promise<void>};submit:(text:string,options:{operationId:string})=>Promise<{operationId:string;session:object}>;wait:(id:string)=>Promise<{status:string}>};
      harness.session=()=>({setModel:async()=>{}});
      harness.submit=async(_text,options)=>{operations.push(options.operationId);return {operationId:options.operationId,session:{}};};
      harness.wait=async operation=>{
        if(operation.startsWith("finalize-")){
          try{await internal.callTool("terminal",{input:"echo forbidden",message:"must not run"},"forbidden");}catch{checks.mutationFenced=true;}
          const tools=await internal.cloudflareTools(),tool=tools.find(t=>t.name==="pentcloud_kali_import")!;
          try{await internal.callCloudflareTool(tool,{path:"README.md"},"forbidden-file",new AbortController().signal);}catch{checks.fileMutationFenced=true;}
          try{await internal.javascript("export default function(){return 'forbidden'}");}catch{checks.javascriptFenced=true;}
          await internal.callTool("code_result",{result:"Existing work finalized",message:"done"},"final-result");
        }
        return {status:"done"};
      };
      checks.result=await (this as unknown as {execute():Promise<unknown>}).execute();
      checks.operations=operations;checks.initialId=id;checks.starts=(await this.ctx.storage.get("fixture:modelRequests"))??0;return checks;
    }else if(kind==="evidence-gateway-compat"){
      (this.env.TOOLBOX as unknown as {putFile:()=>Promise<never>}).putFile=async()=>{throw new Error('RPC receiver does not implement method putFile');};
      const tool=(await internal.cloudflareTools()).find(t=>t.name==="pentcloud_kali_import")!;
      try{await tool.execute({path:"README.md"},"compat-proof",new AbortController().signal);}catch(error){checks.pending=error instanceof Error&&error.name==="ToolboxPendingError";}
      checks.starts=(await this.ctx.storage.get("fixture:modelRequests"))??0;return checks;
    }else if(kind==="evidence-cancel-commit"||kind==="evidence-failed-push"){
      const commit=this.workspace.git.commit.bind(this.workspace.git),push=this.workspace.git.push.bind(this.workspace.git);let pushes=0,cancelled=false;
      this.workspace.git.commit=async options=>{const value=await commit(options);if(kind==="evidence-cancel-commit"&&!cancelled){cancelled=true;await this.cancel();}return value;};
      this.workspace.git.push=async options=>{pushes++;if(kind==="evidence-failed-push"&&pushes===1)throw new Error("Injected failed push");return push(options);};
      await internal.captureToolEvidence("fixture-command",{},"call-one",{status:"completed",output:"retained existing bytes"});
      if(kind==="evidence-failed-push"){
        const state=(await this.ctx.storage.get<Record<string,unknown>>("attempt"))!;
        await this.ctx.storage.put("attempt",{...state,status:"settled",result:{id,runId:"local-run",status:"failed",error:"Model stopped",inputCommit:base.oid}});
      }
      const execution=await this.execution();checks.execution=execution;checks.pushes=pushes;checks.registrations=await this.ctx.storage.get("fixture:evidenceReceipts");checks.starts=(await this.ctx.storage.get("fixture:modelRequests"))??0;return checks;
    }else if(kind==="evidence-cancel-push"){
      let pushes=0;const push=this.workspace.git.push.bind(this.workspace.git);
      this.workspace.git.push=async options=>{pushes++;const result=await push(options);await this.cancel();return result;};
      await internal.captureToolEvidence("fixture-command",{},"call-one",{status:"completed",output:"pushed before cancellation"});
      const execution=await this.execution();checks.evidence=execution.evidence;
      await internal.checkpointEvidence();
      try{await internal.callTool("terminal",{input:"echo forbidden",message:"stop"},"after-cancel");}catch{checks.cancelFenced=true;}
      checks.pushes=pushes;checks.registrations=(await this.ctx.storage.get("fixture:evidenceReceipts"))??[];return checks;
    }else if(kind==="evidence-transfer"){
      const bytes=new TextEncoder().encode("config = ß\n\u0000binary-boundary");
      await this.workspace.fs.writeFile(`${this.directory}/input.bin`,bytes);
      const tools=await internal.cloudflareTools(),tool=(name:string)=>{const found=tools.find(t=>t.name===name);if(!found)throw new Error("missing native transfer tool "+name);return found;};
      const imported=await tool("pentcloud_kali_import").execute({path:"input.bin"},"import-proof",new AbortController().signal);
      checks.imported=imported;
      const parsed=JSON.parse(imported.content);const value=(parsed.value??parsed) as {path:string};
      const exported=await tool("pentcloud_kali_export").execute({path:value.path},"export-proof",new AbortController().signal);
      const parsedFile=JSON.parse(exported.content);const file=(parsedFile.value??parsedFile) as {path:string;sha256:string};checks.file=file;
      checks.expectedHash=await evidenceBytesHash(bytes);checks.actualHash=await evidenceBytesHash(new Uint8Array(await new Response(await this.workspace.fs.readFile(`${this.directory}/${file.path}`)).arrayBuffer()));
      const guarded=new GuardedWorkspace(this.workspace,{role:input.role,id,root:this.directory,active:async()=>{}});
      try{await guarded.fs.rename(`${this.directory}/.pentagi/evidence/${id}`,`${this.directory}/moved-evidence`);}catch{checks.renameFenced=true;}
      checks.checkpoint=await this.ctx.storage.get("fixture:evidenceReceipts");
      checks.starts=(await this.ctx.storage.get("fixture:modelRequests"))??0;return checks;
    }else if(kind==="evidence-pack-scratch"){
      const bytes=new Uint8Array([0,128,192,255,10]),state=(await this.ctx.storage.get<Record<string,unknown>>("attempt"))!;
      await this.ctx.storage.put("attempt",{...state,toolPacks:true});await this.workspace.fs.mkdir("/workspace/scratch",{recursive:true});await this.workspace.fs.writeFile("/workspace/scratch/fixture.bin",bytes);let calls=0;
      this.env.TOOL_PACKS={ready:async()=>({}),stop:async()=>({stopped:true}),run:async(_scope,_input,files)=>{calls++;checks.checkpointBeforeDispatch=((await this.ctx.storage.get<unknown[]>("fixture:evidenceReceipts"))??[]).length>0;checks.inputHash=await evidenceBytesHash(files.input!);return {exitCode:0,stdout:"exact binary input",stderr:""};}};
      const request={pack:"pcap" as const,request:{tool:"tshark"},files:{input:"/workspace/scratch/fixture.bin"}};
      await internal.packCall(request,"scratch");await this.workspace.fs.rm("/workspace/scratch/fixture.bin");await internal.packCall(request,"scratch");
      checks.calls=calls;checks.expectedHash=await evidenceBytesHash(bytes);const files=await this.ctx.storage.get<Array<{path:string;source:string;sha256:string}>>("evidenceFiles");checks.captured=files!.find(f=>f.source==="tool-input");
      try{await internal.packCall({...request,files:{input:"/workspace/scratch/../private"}},"escape");}catch{checks.escapeDenied=true;}
      await this.workspace.fs.symlink("/private","/workspace/scratch/link");try{await internal.packCall({...request,files:{input:"/workspace/scratch/link"}},"symlink");}catch{checks.symlinkDenied=true;}
      return checks;
    }else if(kind==="evidence-pack-large"){
      const output="🧪".repeat(600000),record={stdout:output,stderr:"retained complete stderr",exitCode:0};
      await internal.captureToolEvidence("pentcloud_tool",{},"large-result",record);
      const files=await this.ctx.storage.get<Array<{path:string;size:number}>>("evidenceFiles");
      const index=files!.find(f=>f.path.endsWith("-result.json"))!;
      const manifest=JSON.parse(await this.workspace.fs.readFile(this.directory+"/"+index.path,"utf8"));
      const chunks:Uint8Array[]=[];for(const path of manifest.parts)chunks.push(new Uint8Array(await new Response(await this.workspace.fs.readFile(this.directory+"/"+path)).arrayBuffer()));
      const bytes=new Uint8Array(chunks.reduce((n,b)=>n+b.length,0));let offset=0;for(const b of chunks){bytes.set(b,offset);offset+=b.length;}
      const restored=JSON.parse(new TextDecoder().decode(bytes));checks.restored=restored.result.stdout===output&&restored.result.stderr===record.stderr;checks.files=files;checks.parts=manifest.parts;checks.checkpoint=await this.ctx.storage.get("fixture:evidenceReceipts");return checks;
    }else if(kind==="evidence-checkpoints"){
      const commits:string[]=[],push=this.workspace.git.push.bind(this.workspace.git);let lose=true;
      this.workspace.git.push=async options=>{const result=await push(options);commits.push(await this.workspace.git.revParse({dir:this.directory,ref:"HEAD"}));if(lose){lose=false;throw new Error("Injected lost push reply");}return result;};
      await internal.captureToolEvidence("fixture-command",{},"call-one",{status:"completed",output:"retained evidence",private:this.env.OPENCODE_GO_API_KEY});
      const first=await this.workspace.git.revParse({dir:this.directory,ref:"HEAD"});
      checks.before=(await this.ctx.storage.get<{result?:unknown}>("attempt"))?.result??null;
      const recovered=await internal.checkpointEvidence();
      checks.unavailable=JSON.parse(await this.workspace.fs.readFile(`${this.directory}/${recovered!.manifestPath}`,"utf8")).unavailable??[];
      checks.sameCommitRetried=commits[0]===commits[1]&&commits[0]===first;
      checks.recovered=recovered;
      const evidenceFiles=await this.ctx.storage.get<Array<{path:string;sha256:string}>>("evidenceFiles");
      checks.evidenceFiles=evidenceFiles;checks.raw=await this.workspace.fs.readFile(this.directory+"/"+evidenceFiles![0]!.path,"utf8");
      await this.workspace.fs.writeFile(`${this.directory}/output.txt`,"ordinary source output");
      checks.terminal=await internal.publish({tool:"code_result",arguments:{result:"Finished existing work",message:"done"},status:"completed",finishedAt:Date.now()});
      const head=await this.workspace.git.revParse({dir:this.directory,ref:"HEAD"}),commit=await this.workspace.git.show({dir:this.directory,ref:head});
      checks.terminalParent=commit.parent[0];checks.registrations=await this.ctx.storage.get("fixture:evidenceReceipts");
      await this.cancel();const before=commits.length;await internal.captureToolEvidence("late-tool",{},"late-call",{late:true});checks.noLatePublication=commits.length===before;
      checks.starts=(await this.ctx.storage.get("fixture:modelRequests"))??0;return checks;
    }else if(kind==="evidence-incomplete-image"){
      await internal.captureToolEvidence("fixture-image",{},"incomplete",{content:[{type:"image",mimeType:"image/png",data:"invalid base64!"}]});
      const recovered=await internal.checkpointEvidence();
      checks.unavailable=JSON.parse(await this.workspace.fs.readFile(`${this.directory}/${recovered!.manifestPath}`,"utf8")).unavailable??[];
      return checks;
    }else if(kind==="native-pinned-model"){
      const result=await this.run(input);
      await this.harness.dispose();
      return {model:result.model,modelRequests:(await this.ctx.storage.get("fixture:modelRequests"))??0};
    }else if(kind.startsWith("native-discovery")){
      // Exercise production admission too: bypassing run() hid stripped execution metadata.
      checks.result=await this.run(input);
      checks.record=JSON.parse(await this.workspace.fs.readFile(this.directory+"/.pentagi/jobs/"+id+"/result.json","utf8"));
      checks.modelRequests=(await this.ctx.storage.get("fixture:modelRequests"))??0;
      checks.modelKeyConfigured=!!this.env.OPENCODE_GO_API_KEY;
      checks.scannerArguments=await this.ctx.storage.get("fixture:whatwebArguments");
      return checks;
    }
    if (kind === "purge-failure") {
      const state = (await this.ctx.storage.get<Record<string, unknown>>("attempt"))!;
      await this.ctx.storage.put("attempt", {...state, status: "settled"});
      await this.ctx.storage.put("cancelled", true);
      this.harness.dispose = async () => {throw new Error("LOCAL_PURGE_CLEANUP_INTERRUPTED");};
      return await this.purge(input.runId);
    } else if (kind === "purge") {
      const native = this as unknown as {purge(runId: string): Promise<unknown>; inFlightTools: number; running: Promise<unknown> | undefined; publishing: Promise<unknown> | undefined};
      const rejection = async (runId = input.runId) => {try {await native.purge(runId); return "allowed";} catch (error) {return String(error);}};
      checks.wrongRun = await rejection("another-run");
      checks.running = await rejection();
      const state = (await this.ctx.storage.get<Record<string, unknown>>("attempt"))!;
      await this.ctx.storage.put("attempt", {...state, status: "publishing"});
      checks.persistedPublishing = await rejection();
      await this.ctx.storage.put("attempt", {...state, status: "settled"});
      await this.ctx.storage.put("cancelled", true);
      await this.ctx.storage.put("remote:held", {state: "unknown", name: "nmap_port_scan", fingerprint: "held"});
      checks.unknown = await rejection();
      await this.ctx.storage.delete("remote:held");
      native.inFlightTools = 1; checks.inflight = await rejection(); native.inFlightTools = 0;
      native.running = Promise.resolve(); checks.localRunning = await rejection(); native.running = undefined;
      native.publishing = Promise.resolve(); checks.publishing = await rejection(); native.publishing = undefined;
      await this.ctx.storage.put("mcpSession", {sessionId: "held"});
      checks.session = await rejection(); await this.ctx.storage.delete("mcpSession");
      this.ctx.storage.sql.exec("CREATE TABLE purge_probe (payload TEXT)");
      this.ctx.storage.sql.exec("INSERT INTO purge_probe VALUES ('private session history')");
      await this.ctx.storage.put("fixture:privateTranscript", "private session history");
      await this.ctx.storage.setAlarm(Date.now() + 60000);
      checks.purged = await native.purge(input.runId);
      checks.keys = [...await this.ctx.storage.list()];
      checks.tables = [...this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")].map(row => row.name);
      checks.alarm = await this.ctx.storage.getAlarm();
      checks.repeat = await native.purge(input.runId);
      checks.reused = await rejection("another-run");
      try {await this.run(input); checks.replay = "allowed";} catch (error) {checks.replay = String(error);}
      try {await this.sessionControls(); checks.controls = "allowed";} catch (error) {checks.controls = String(error);}
      try {await this.events(new Request("https://local.invalid/events")); checks.events = "allowed";} catch (error) {checks.events = String(error);}
      checks.execution = await this.execution();
      checks.finalKeys = [...await this.ctx.storage.list()];
      return checks;
    } else if (kind === "browser-live-view") {
      const snapshot = async () => JSON.stringify([...await this.ctx.storage.list()]);
      const before = await snapshot();
      checks.absent = await this.browserLiveView();
      checks.absentNoWrites = before === await snapshot();
      const state = (await this.ctx.storage.get<object>("attempt"))!;
      let browserReads = 0;
      let providerCalls = 0;
      const credential = "https://live.browser.run/ui/view?wss=fixture-readonly-bearer";
      Object.defineProperty(this.cloudBrowser, "liveView", {value: async () => {
        browserReads++;
        return {sessionId: "existing-browser", targets: [{targetId: "existing-page", type: "page"}]};
      }});
      Object.assign(this.env, {BROWSER: {getLiveView: async (_session: string, options: object) => {
        providerCalls++;
        checks.options = options;
        return {devtoolsFrontendUrl: credential, options: {mode: "tab", guardrails: {mode: "readonly"}}};
      }}});
      const activeView = await this.browserLiveView();
      checks.created = activeView.available && activeView.readOnly && activeView.url === credential;
      checks.activeNoWrites = before === await snapshot();
      for (const value of [undefined, {...state, status: "settled"}, {...state, proposal: {tool: "done"}}]) {
        if (value) await this.ctx.storage.put("attempt", value);
        else await this.ctx.storage.delete("attempt");
        const prior = await snapshot();
        if ((await this.browserLiveView()).available || prior !== await snapshot()) throw new Error("Historical view changed runtime state");
      }
      await this.ctx.storage.put("attempt", state);
      await this.ctx.storage.put("cancelled", true);
      checks.cancelled = !(await this.browserLiveView()).available;
      await this.ctx.storage.delete("cancelled");
      Object.assign(this.env, {BROWSER: {getLiveView: async () => {
        providerCalls++;
        await this.ctx.storage.put("cancelled", true);
        return {devtoolsFrontendUrl: credential, options: {mode: "tab", guardrails: {mode: "readonly"}}};
      }}});
      checks.cancellationRace = !(await this.browserLiveView()).available;
      checks.credentialsNotStored = !(await snapshot()).includes("fixture-readonly-bearer");
      checks.lifecycleNotStarted = !(await this.ctx.storage.get("startup"));
      checks.browserReads = browserReads;
      checks.providerCalls = providerCalls;
    } else if (kind === "toolbox-eviction") {
      await this.ctx.storage.put("fixture:holdModel", true);
      await this.ctx.storage.put("fixture:replayInput", input);
      // Finish SDK startup before observing its background model hook, so this
      // fixture's storage polling does not contend with startup's concurrency gate.
      await (this as unknown as {preflightToolbox(state: object): Promise<void>}).preflightToolbox((await this.ctx.storage.get<object>("attempt"))!);
      await this.lifecycle.start();
      this.ctx.waitUntil((this as unknown as {execute(): Promise<unknown>}).execute().catch(() => undefined));
      for (let i = 0; i < 400 && !(await this.ctx.storage.get("fixture:modelHeld")); i++) await new Promise(resolve => setTimeout(resolve, 10));
      if (!(await this.ctx.storage.get("fixture:modelHeld"))) throw new Error("Model hold did not start");
      checks.users = (await this.harness.session().history()).filter(message => message.type === "user").length;
      checks.models = await this.ctx.storage.get("fixture:modelRequests");
      checks.modelKinds = await this.ctx.storage.get("fixture:modelKinds");
      checks.pending = await this.harness.pending();
    } else if (kind === "sdk-toolbox-cold") {
      await this.ctx.storage.put("fixture:readyBlocked", true);
      await this.ctx.storage.put("fixture:partialWarmup", true);
      await this.ctx.storage.put("fixture:stopBeforeModel", true);
      const started = (this as unknown as {execute(): Promise<unknown>}).execute();
      await new Promise(resolve => setTimeout(resolve, 100));
      checks.before = {readies: (await this.ctx.storage.get("fixture:readies")) ?? 0, initializes: (await this.ctx.storage.get("fixture:initializes")) ?? 0, modelRequests: (await this.ctx.storage.get("fixture:modelRequests")) ?? 0};
      await this.ctx.storage.put("fixture:readyBlocked", false);
      checks.answer = await started;
      checks.modelKinds = await this.ctx.storage.get("fixture:modelKinds");
      checks.after = {generation: await this.ctx.storage.get("toolboxGeneration"), session: await this.ctx.storage.get("mcpSession"), catalog: await this.ctx.storage.get("remoteCatalog"), modelRequests: await this.ctx.storage.get("fixture:modelRequests"), initializes: await this.ctx.storage.get("fixture:initializes"), deletes: await this.ctx.storage.get("fixture:deletes"), modelsAtPartial: await this.ctx.storage.get("fixture:modelsAtPartialCatalog"), partialCatalogWasPinned: await this.ctx.storage.get("fixture:partialCatalogWasPinned")};
      await this.cancel();
      await this.harness.dispose();
      await this.ctx.storage.deleteAlarm();
    } else if (kind === "toolbox-activity") {
      await this.execution();
      checks.withoutOwnership = (await this.ctx.storage.get("fixture:activities")) ?? 0;
      await this.ctx.storage.put("toolboxGeneration", "fixture-generation");
      await this.execution();
      checks.active = (await this.ctx.storage.get("fixture:activities")) ?? 0;
      await this.cancel();
      await this.execution();
      checks.drained = (await this.ctx.storage.get("fixture:activities")) ?? 0;
      await this.ctx.storage.put("remote:held", {state: "unknown", name: "nmap_port_scan", fingerprint: "held"});
      await this.execution();
      checks.held = (await this.ctx.storage.get("fixture:activities")) ?? 0;
      checks.readies = (await this.ctx.storage.get("fixture:readies")) ?? 0;
    } else if (kind === "toolbox-generation-loss") {
      const native = this as unknown as {remote(): Promise<ToolboxMCP>; executeRemoteTool(name: string, args: object, id: string): Promise<unknown>};
      await (await native.remote()).list();
      await this.ctx.storage.put("fixture:dropSessionReply", true);
      try { await native.executeRemoteTool("nmap_port_scan", {target: "127.0.0.1"}, "generation-lost"); } catch {}
      checks.firstInitializes = await this.ctx.storage.get("fixture:initializes");
      await this.ctx.storage.put("fixture:generation", "replacement-generation");
      let blocked = 0;
      try { await (await native.remote()).list(); } catch { blocked++; }
      try { await native.executeRemoteTool("nmap_port_scan", {target: "127.0.0.1"}, "generation-lost"); } catch { blocked++; }
      try { await this.harness.opencode(); } catch { blocked++; }
      checks.blocked = blocked;
      checks.initializes = await this.ctx.storage.get("fixture:initializes");
      checks.receipts = await this.remoteReceipts();
      checks.execution = await this.execution();
      checks.session = await this.ctx.storage.get("mcpSession");
      await this.cancel();
      checks.cancelled = await this.execution();
      const receipt = (await this.ctx.storage.get<Record<string, unknown>>("remote:generation-lost"))!;
      await this.ctx.storage.put("remote:generation-lost", {...receipt, state: "reconciled"});
      checks.reconciled = await this.execution();
      checks.sessionAfterReconciled = !!(await this.ctx.storage.get("mcpSession"));
    } else if (kind === "toolbox-cleanup-lost" || kind === "toolbox-upstream-conflict" || kind === "toolbox-legacy-session") {
      const native = this as unknown as {remote(): Promise<ToolboxMCP>};
      if (kind === "toolbox-legacy-session") await this.ctx.storage.put("mcpSession", {sessionId: "unversioned-legacy"});
      else await (await native.remote()).list();
      if (kind === "toolbox-cleanup-lost") await this.ctx.storage.put("fixture:generation", "replacement-generation");
      if (kind === "toolbox-upstream-conflict") await this.ctx.storage.put("fixture:failDelete", 409);
      await this.cancel();
      checks.after = await this.execution();
      checks.sessionHeld = !!(await this.ctx.storage.get("mcpSession"));
      checks.initializes = (await this.ctx.storage.get("fixture:initializes")) ?? 0;
      checks.readies = (await this.ctx.storage.get("fixture:readies")) ?? 0;
      checks.deletes = (await this.ctx.storage.get("fixture:deleteAttempts")) ?? 0;
      if (kind === "toolbox-upstream-conflict") {
        await this.ctx.storage.put("fixture:failDelete", false);
        checks.recovered = await this.execution();
        checks.sessionAfterRecovery = !!(await this.ctx.storage.get("mcpSession"));
      }
    } else if (kind === "platform-backoff") {
      await this.onAlarmMemoryLimit({ sealed: false, nextTime: Date.now() + 60000 });
      try { await this.sessionControls(); checks.controlsFenced = false; }
      catch (error) { checks.controlsFenced = String(error).includes("409:"); }
      await this.lifecycle.start();
      await this.lifecycle.alarm();
      checks.lifecycleStartupSkipped = !(await this.ctx.storage.get("startup"));
      const recovery = (await this.execution()).recovery!;
      await this.ctx.storage.put("platform:recovery", { ...recovery, nextTime: Date.now() - 1 });
      checks.after = await this.sessionControls();
    } else if (kind === "platform-recovery" || kind === "platform-recovery-held") {
      await this.ctx.storage.put("remote:platform-unknown", { state: "unknown", name: "nmap_port_scan", fingerprint: "held" });
      await this.onAlarmMemoryLimit({ sealed: true, purgedRecoveryLoopJobs: [] });
      const before = await this.execution();
      checks.before = before;
      try { await this.rearmPlatformRecovery(before.recovery!.observedAt - 1); checks.staleRejected = false; }
      catch (error) { checks.staleRejected = String(error).includes("409:"); }
      try { await this.rearmPlatformRecovery(before.recovery!.observedAt); checks.unknownRejected = false; }
      catch (error) { checks.unknownRejected = String(error).includes("409:"); }
      try { await this.sessionControls(); checks.controlsFenced = false; }
      catch (error) { checks.controlsFenced = String(error).includes("409:"); }
      await this.lifecycle.start();
      await this.lifecycle.alarm();
      checks.lifecycleStartupSkipped = !(await this.ctx.storage.get("startup"));
      try { await internal.callTool("terminal", {input:"printf unsafe", cwd:this.directory,detach:false,timeout:30,message:"probe"}, "sealed-call"); checks.callFenced = false; }
      catch { checks.callFenced = true; }
      if (kind === "platform-recovery-held") return checks;
      await this.ctx.storage.put("remote:platform-unknown", { state: "reconciled", name: "nmap_port_scan", fingerprint: "held" });
      checks.rearmed = await this.rearmPlatformRecovery(before.recovery!.observedAt);
      checks.after = await this.execution();
    } else if (kind.startsWith("sdk-managed-specialist")) {
      await this.ctx.storage.put("fixture:inspectProviderTools", true);
      await this.lifecycle.start();
      const native = await this.harness.opencode();
      const sessionID = this.harness.session().id;
      const created = await native.sessions.create({ id: sessionID });
      const location = { directory: created.location.directory };
      // agent.list awaits native plugin activation; agent.get does not in 2.2.5.
      await native.agent.list({ location });
      checks.profile = (await native.agent.get({ agentID: `pentcloud-${input.role}`, location })).data;
      checks.skills = (await native.skill.list({ location })).data;
      await native.experimental.session.skill({ sessionID, id: "pentcloud-tools", resume: false });
      checks.skillLoaded = JSON.stringify(await this.harness.session().history()).includes("PentCloud");
      const receipt = await this.harness.submit("Inspect actual native skill tool; stop before model HTTP", { operationId: "skill-tool-proof" });
      checks.answer = await this.harness.wait(receipt.operationId, { session: receipt.session });
      checks.providerTools = await this.ctx.storage.get("fixture:providerTools");
      await this.harness.dispose();
      await this.ctx.storage.deleteAlarm();
    } else if (kind === "sdk-managed-session") {
      await this.lifecycle.start();
      const native = await this.harness.opencode();
      const sessionID = this.harness.session().id;
      // No prompt, inference, scanner or provider request is needed to exercise
      // native form storage, permissions and the embedded usage APIs.
      await native.sessions.create({id: sessionID, permissions: [{action: "operator-probe", resource: "*", effect: "ask"}]});
      await native.sessions.update({sessionID, permissions: [{action: "operator-probe", resource: "*", effect: "ask"}]});
      const form = await native.sessions.form.create({sessionID, title: "Native operator question", fields: [{key: "continue", type: "boolean", required: true}]});
      checks.pending = await this.sessionControls();
      try { await this.replyNative("form", form.id, {session: "ses_other", answer: {continue: true}}); checks.wrongSessionRejected = false; }
      catch (error) { checks.wrongSessionRejected = String(error).includes("409:"); }
      try { await this.replyNative("form", form.id, {session: sessionID, answer: {continue: "not boolean"}}); checks.invalidAnswerRejected = false; }
      catch (error) { checks.invalidAnswerRejected = String(error).includes("400:"); }
      await this.replyNative("form", form.id, {session: sessionID, answer: {continue: true}});
      checks.answered = await native.sessions.form.get({sessionID, formID: form.id});
      try { await this.replyNative("form", form.id, {session: sessionID, answer: {continue: false}}); checks.duplicateRejected = false; }
      catch (error) { checks.duplicateRejected = String(error).includes("409:"); }
      const cancelled = await native.sessions.form.create({sessionID, title: "Cancel native question", fields: [{key: "text", type: "string"}]});
      await this.replyNative("form", cancelled.id, {session: sessionID, message: "Operator declined"}, true);
      checks.cancelled = await native.sessions.form.get({sessionID, formID: cancelled.id});
      const permission = native.permission.create({sessionID, id: "per_managed_probe", action: "operator-probe", resources: ["exact-resource"]});
      let pendingPermission = false;
      for (let i = 0; i < 100; i++) {
        if ((await native.permission.list({sessionID})).some(request => request.id === "per_managed_probe")) { pendingPermission = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      if (!pendingPermission) throw new Error(`Native permission fixture did not become pending: ${JSON.stringify(await permission)}`);
      checks.permissionPending = await this.sessionControls();
      await this.replyNative("permission", "per_managed_probe", {session: sessionID, decision: "once"});
      checks.permission = await permission;
      try { await this.replyNative("permission", "per_managed_probe", {session: sessionID, decision: "once"}); checks.permissionDuplicateRejected = false; }
      catch (error) { checks.permissionDuplicateRejected = String(error).includes("409:"); }
      const fenced = await native.sessions.form.create({sessionID, title: "Cancellation fence", fields: [{key: "text", type: "string"}]});
      await this.cancel();
      try { await this.replyNative("form", fenced.id, {session: sessionID, answer: {text: "late"}}); checks.lateRejected = false; }
      catch (error) { checks.lateRejected = String(error).includes("409:"); }
      checks.fenced = await native.sessions.form.get({sessionID, formID: fenced.id});
      checks.nativePermissionList = await native.permission.list({sessionID});
      await this.harness.dispose();
      await this.ctx.storage.deleteAlarm();
    } else if (kind.startsWith("sdk-role-") || kind === "sdk-startup" || kind === "sdk-searcher-tools" || kind === "sdk-memorist-tools" || kind === "sdk-pentester-tools") {
      const launch = await renderLaunch("primary",{task:"Local harmless startup probe"},primaryPrompt,{cwd:this.directory,now:new Date(0)});
      const state = (await this.ctx.storage.get<Record<string,unknown>>("attempt"))!;
      await this.ctx.storage.put("attempt",{...state,prompt:launch.prompt,promptDigest:launch.promptDigest});
      await this.ctx.storage.put(kind === "sdk-startup" ? "fixture:stopBeforeModel" : "fixture:inspectProviderTools",true);
      await this.lifecycle.start();
      const receipt = await this.harness.submit("Stop before inference HTTP",{operationId:"local-startup-no-model"});
      checks.answer = await this.harness.wait(receipt.operationId,{session:receipt.session});
      checks.renderer = await promptRendererMemory();
      checks.startup = await this.ctx.storage.get("startup");
      checks.messages = (await this.harness.session().history()).length;
      if(kind==="sdk-startup"){
        checks.storedModelSecret=false;
        const tables=this.ctx.storage.sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf*' AND name NOT GLOB '__cf*'").toArray();
        for(const table of tables){
          const rows=this.ctx.storage.sql.exec('SELECT * FROM "'+table.name.replaceAll('"','""')+'" LIMIT 1000').toArray();
          for(const row of rows)for(const value of Object.values(row)){
            const text=value instanceof ArrayBuffer?new TextDecoder().decode(value):typeof value==="string"?value:JSON.stringify(value);
            if(text?.includes("local-probe-go"))checks.storedModelSecret=true;
          }
        }
      }

      checks.providerTools = await this.ctx.storage.get("fixture:providerTools") ?? null;
      checks.toolboxReadies = (await this.ctx.storage.get("fixture:readies")) ?? 0;
      await this.cancel();
      checks.terminalEvents = (await this.events(new Request("https://probe.invalid/events"))).text();
      checks.terminalEvents = await checks.terminalEvents;
      await this.harness.dispose();
      await this.ctx.storage.deleteAlarm();
    } else if (kind === "header-redaction") {
      const tools=await internal.cloudflareTools();
      checks.curl=await internal.callCloudflareTool(tools.find(t=>t.name==="computer_exec")!,{backend:"native-shell",command:"curl --silent https://example.com/"},"echo-curl",new AbortController().signal);
      checks.api=await internal.apiRequest({path:"/",method:"GET"},"echo-api");
      checks.retrieval=internal.safe(await(await this.targetFetch(new Request("https://example.com/"))).text());
    } else if (kind === "computer-coder") {
      const tools = await internal.cloudflareTools();
      const call = async (name: string, args: unknown) => internal.callCloudflareTool(tools.find(t => t.name === name)!,args,crypto.randomUUID(),new AbortController().signal);
      const path = `${this.directory}/native-computer.txt`;
      checks.write = await call("computer_write",{path,content:"native marker"});
      checks.read = await call("computer_read",{path});
      checks.edit = await call("computer_edit",{path,edits:[{oldText:"native marker",newText:"edited marker"}]});
      checks.exec = await call("computer_exec",{backend:"native-shell",command:"cat native-computer.txt"});
      checks.delete = await call("computer_delete",{path});
      try { await this.workspace.fs.stat(path); checks.deleted = false; }
      catch { checks.deleted = true; }
    } else if (kind === "computer") {
      const tools = await internal.cloudflareTools();
      const call = async (name: string, args: unknown) => {
        try { return await internal.callCloudflareTool(tools.find(t => t.name === name)!, args, crypto.randomUUID(), new AbortController().signal) as {content:string}; }
        catch (error) { return {content:JSON.stringify({error:String(error)})}; }
      };
      checks.read = await call("computer_read", {path:"README.md"});
      checks.write = await call("computer_write", {path:`.pentagi/evidence/${id}/computer.txt`,content:"computer native marker"});
      checks.exec = await call("computer_exec", {backend:"native-shell",command:`cat .pentagi/evidence/${id}/computer.txt`});
      checks.javascript = await call("computer_exec", {backend:"native-javascript",command:'export default async function() { return 42; }'});
      checks.source = await call("computer_write", {path:"README.md",content:"forbidden"});
      checks.escape = await call("computer_read", {path:"../outside"});
      checks.git = await call("computer_read", {path:".git/config"});
      checks.cwdBlocked = (await call("computer_exec", {backend:"native-shell",command:"pwd",cwd:"/"})).content.includes('"error"');
      checks.baseline = await this.workspace.fs.readFile(`${this.directory}/README.md`, "utf8");
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const blocked = new Promise<void>(resolve => { release = resolve; });
      const pending = internal.callCloudflareTool({ ...tools[0]!, execute:async () => {
        entered(); await blocked; return {content:"late browser response"};
      } }, {}, "native-drain", new AbortController().signal).then(() => false, () => true);
      await started;
      await this.cancel();
      checks.drainedDuring = (await this.execution()).drained;
      release();
      checks.rejectedAfterCancel = await pending;
      checks.drainedAfter = (await this.execution()).drained;
      checks.lateBlocked = (await call("computer_read", {path:"README.md"})).content.includes("cancelled");
    } else if (kind === "shell") {
      checks.read = await shell("cat README.md");
      checks.git = await shell("git status --short");
      checks.blockGit = await shell("cat .git/config");
      checks.blockSource = await shell("echo changed > README.md");
      checks.baseline = await this.workspace.fs.readFile(
        `${this.directory}/README.md`,
        "utf8",
      );
      checks.evidence = await shell(
        `mkdir -p .pentagi/evidence/${id}; echo native-shell > .pentagi/evidence/${id}/shell.txt; cat .pentagi/evidence/${id}/shell.txt`,
      );
      checks.unsupported = await shell("nmap 127.0.0.1");
      // Exercise the production backend: optional curl modules, real HTTP
      // egress, request options, and guarded Workspace output files.
      checks.curl = await shell(`curl --include --fail --silent --show-error --max-time 5 -X POST -H 'X-Curl-Fixture: native' --data 'curl fixture body' '${origin}/curl-fixture' > .pentagi/evidence/${id}/curl-response.txt; cat .pentagi/evidence/${id}/curl-response.txt`);
      checks.curlFile = await this.workspace.fs.readFile(`${this.directory}/.pentagi/evidence/${id}/curl-response.txt`, "utf8").catch(() => "");
    } else if (kind === "javascript") {
      checks.scratch = await internal.javascript(
        'import fs from "node:fs/promises"; export default async function() { await fs.writeFile("hello.txt", "isolated scratch"); console.log(await fs.readFile("hello.txt", "utf8")); }',
      );
      checks.blockEscape = await internal.javascript(
        'import fs from "node:fs/promises"; export default async function() { console.log(await fs.readFile("/workspace/repo/.git/config", "utf8")); }',
      );
      checks.fileRead = await internal.javascript(
        'import {call} from "ws:attempt"; export default async function() { console.log(await call("file", {action:"read_file",path:"README.md",message:"probe"})); }',
      );
      checks.fileWrite = await internal.javascript(
        'import {call} from "ws:attempt"; export default async function() { console.log(await call("file", {action:"write_file",path:"README.md",content:"changed",message:"probe"})); }',
      );
    } else if (kind === "publish" || kind === "replay") {
      checks.terminal = await internal.publish({
        tool: "yield",
        arguments: { message: "local probe", plan: "done" },
        status: "waiting",
        finishedAt: Date.now(),
      });
      checks.published = this.published;
      checks.main = await this.workspace.git.revParse({
        dir: this.directory,
        ref: "main",
      });
      checks.base = base.oid;
      checks.head = await this.workspace.git.revParse({
        dir: this.directory,
        ref: "HEAD",
      });
      checks.result = JSON.parse(
        await this.workspace.fs.readFile(
          `${this.directory}/.pentagi/jobs/${id}/result.json`,
          "utf8",
        ),
      );
      if (kind === "replay") {
        const state =
          await this.ctx.storage.get<Record<string, unknown>>("attempt");
        if (!state) throw new Error("Fixture state missing");
        const proposal = state.proposal;
        Object.assign(this.env.CF_VERSION_METADATA, { id: "probe-redeployed" });
        delete state.result;
        delete state.outputCommit;
        state.status = "publishing";
        await this.ctx.storage.put("attempt", state);
        checks.replayed = await internal.publish(proposal as object);
        checks.replayedHead = await this.workspace.git.revParse({
          dir: this.directory,
          ref: "HEAD",
        });
      }
    } else if (kind === "codemode") {
      const original = contracts.get("file")!;
      const inventory: CodeModeTool.Inventory = {
        tools: new Map([
          [
            "file",
            {
              name: "file",
              description: original.description,
              input: original.input_schema,
              options: { codemode: true },
              execute: () =>
                Effect.succeed({ content: [{ type: "text", text: "unused" }] }),
            },
          ],
        ]),
      };
      const execute = (code: string) =>
        Effect.runPromise(
          CodeModeTool.check(
            inventory,
            code,
            {},
            { maxToolCalls: 8 },
            (name, _tool, args) =>
              Effect.tryPromise({
                try: async () => ({
                  content: [
                    {
                      type: "text" as const,
                      text: JSON.stringify(
                        await internal.callTool(
                          name,
                          args as object,
                          "native-codemode-probe",
                        ),
                      ),
                    },
                  ],
                }),
                catch: (error) =>
                  new Tool.Error({
                    message:
                      error instanceof Error ? error.message : String(error),
                  }),
              }),
          ),
        );
      checks.read = await execute(
        'return await tools.file({action:"read_file",path:"README.md",message:"probe"});',
      );
      checks.denied = await execute(
        'return await tools.file({action:"write_file",path:"README.md",content:"changed",message:"probe"});',
      );
      checks.terminalUnavailable = await execute(
        'return await tools.yield({message:"probe",plan:"stop"});',
      );
      checks.invalidSchema = await execute(
        'return await tools.file({action:"read_file",path:"README.md",message:"probe",extra:true});',
      );
      checks.baseline = await this.workspace.fs.readFile(
        `${this.directory}/README.md`,
        "utf8",
      );
    } else if (
      kind === "session" ||
      kind === "session-cleanup-failure" ||
      kind === "session-stateless"
    ) {
      if (kind === "session-stateless") {
        await this.ctx.storage.put("fixture:stateless", true);
        const hooks = {
          load: () =>
            this.ctx.storage.get<{
              sessionId: string;
              protocolVersion?: string;
            }>("mcpSession"),
          save: (value: object) => this.ctx.storage.put("mcpSession", value),
          clear: async () => {
            await this.ctx.storage.delete("mcpSession");
          },
        };
        const binding = {
          fetch: (request: Request) => sessionMCP(this.ctx, request),
        } as unknown as Fetcher;
        const first = new ToolboxMCP(binding, hooks, "fixture-generation");
        await first.list();
        await first.detach();
        const second = new ToolboxMCP(binding, hooks, "fixture-generation");
        await second.list();
        await second.close();
        checks.initializes = await this.ctx.storage.get("fixture:initializes");
        checks.deletes = (await this.ctx.storage.get("fixture:deletes")) ?? 0;
        checks.saved = !!(await this.ctx.storage.get("mcpSession"));
      } else {
        const native = this as unknown as {
          remote(): Promise<ToolboxMCP>;
          remoteTools(remote: ToolboxMCP): Promise<object[]>;
          executeRemoteTool(
            name: string,
            args: object,
            id: string,
          ): Promise<unknown>;
        };
        const remote = await native.remote();
        await Promise.all([remote.list(), remote.list()]);
        await native.remoteTools(remote);
        if (kind === "session")
          await this.ctx.storage.put("fixture:dropSessionReply", true);
        else await this.ctx.storage.put("fixture:failDelete", true);
        try {
          await native.executeRemoteTool(
            "nmap_port_scan",
            { target: "127.0.0.1" },
            "session-lost",
          );
        } catch {
          checks.lost = true;
        }
        await this.cancel();
        checks.before = await this.execution();
        checks.savedBeforeMutation = await this.ctx.storage.get(
          "fixture:persistedBeforeMutation",
        );
        checks.initializes = await this.ctx.storage.get("fixture:initializes");
        checks.deletesBefore =
          (await this.ctx.storage.get("fixture:deletes")) ?? 0;
        if (kind === "session-cleanup-failure") {
          checks.refused = [];
          for (const status of [404, 405]) {
            await this.ctx.storage.put("fixture:failDelete", status);
            (checks.refused as object[]).push({
              status,
              execution: await this.execution(),
              saved: !!(await this.ctx.storage.get("mcpSession")),
            });
          }
          await this.ctx.storage.put("fixture:failDelete", false);
          checks.after = await this.execution();
          checks.savedAfter = !!(await this.ctx.storage.get("mcpSession"));
          checks.deletes = await this.ctx.storage.get("fixture:deletes");
        }
      }
    } else if (kind.startsWith("metasploit-")) {
      const tools = [
        "metasploit_start_listener",
        "metasploit_stop_job",
        "metasploit_terminate_session",
        "metasploit_list_listeners",
        "metasploit_list_active_sessions",
      ];
      await this.ctx.storage.put("remoteCatalog", {
        tools: tools.map((name) => ({
          name,
          inputSchema: { type: "object", properties: {} },
        })),
      });
      let job = true,
        session = kind !== "metasploit-stale-inventory",
        stops = 0,
        launches = 0,
        closed = false,
        closes = 0,
        opensAfterClose = 0;
      let holdOldInventory = false,
        oldInventoryEntered!: () => void,
        releaseOldInventory!: () => void;
      const inventoryEntered = new Promise<void>((resolve) => {
        oldInventoryEntered = resolve;
      });
      const inventoryRelease = new Promise<void>((resolve) => {
        releaseOldInventory = resolve;
      });
      const inspectOrder: string[] = [];
      const backend = {
        close: async () => {
          closed = true;
          closes++;
          await this.ctx.storage.delete("mcpSession");
        },
        detach: async () => {},
        call: async (name: string, args: Record<string, unknown>) => {
          let data: object;
          if (name === "metasploit_start_listener") {
            launches++;
            data =
              kind === "metasploit-unknown"
                ? { status: "unknown", result: { uuid: "owned-execution" } }
                : {
                    status: "success",
                    job_id: 0,
                    uuid: "owned-execution",
                    session_id: null,
                  };
          } else if (name === "metasploit_stop_job") {
            stops++;
            job = false;
            data = { status: "success", job_id: args.job_id };
          } else if (name === "metasploit_terminate_session") {
            stops++;
            session = false;
            data = { status: "success" };
          } else if (name === "metasploit_list_listeners") {
            inspectOrder.push("jobs");
            data = {
              status: "success",
              handlers: job ? { "0": { name: "owned" } } : {},
              other_jobs: {},
              handler_count: job ? 1 : 0,
              other_job_count: 0,
              total_job_count: job ? 1 : 0,
            };
          } else if (name === "metasploit_list_active_sessions") {
            inspectOrder.push("sessions");
            data = {
              status: "success",
              sessions: session
                ? {
                    "7": { exploit_uuid: "owned-execution" },
                    "8": { exploit_uuid: "other-execution" },
                  }
                : { "8": { exploit_uuid: "other-execution" } },
              count: session ? 2 : 1,
            };
          } else throw new Error("Unexpected fixture tool");
          if (name === "metasploit_list_active_sessions" && holdOldInventory) {
            holdOldInventory = false;
            oldInventoryEntered();
            await inventoryRelease;
          }
          return {
            content: [{ type: "text", text: JSON.stringify(data) }],
            isError: false,
          };
        },
      };
      (this as unknown as { remote(): Promise<object> }).remote = async () => {
        if (closed) opensAfterClose++;
        return backend;
      };
      const native = this as unknown as {
        executeRemoteTool(
          name: string,
          args: object,
          id: string,
        ): Promise<unknown>;
      };
      await native.executeRemoteTool(
        "metasploit_start_listener",
        {},
        "listener",
      );
      checks.before = await this.execution();
      try {
        await native.executeRemoteTool(
          "metasploit_start_listener",
          {},
          "new-launch",
        );
        checks.newCallFenced = false;
      } catch {
        checks.newCallFenced = true;
      }
      try {
        await this.controlRemote(
          "metasploit_terminate_session",
          { session_id: 8 },
          "unowned",
        );
        checks.unownedRejected = false;
      } catch {
        checks.unownedRejected = true;
      }
      await this.cancel();
      if (kind === "metasploit-stale-inventory") {
        holdOldInventory = true;
        const oldSessions = this.inspectRemote(
          "metasploit_list_active_sessions",
          {},
        );
        await inventoryEntered;
        job = false;
        session = true;
        await this.inspectRemote("metasploit_list_listeners", {});
        releaseOldInventory();
        await oldSessions;
        checks.afterStale = await this.remoteReceipts();
        checks.after = await this.execution();
        checks.terminate = await this.controlRemote(
          "metasploit_terminate_session",
          { session_id: 7 },
          "fresh-session-terminate",
        );
      } else if (kind.endsWith("race")) {
        await this.ctx.storage.put("mcpSession", {
          sessionId: "owned-backend",
        });
        const storage = this.ctx.storage as unknown as {
          get: (...args: unknown[]) => Promise<unknown>;
        };
        const get = storage.get.bind(this.ctx.storage);
        let release!: () => void,
          entered!: () => void,
          hold = true;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        const admitted = new Promise<void>((resolve) => {
          entered = resolve;
        });
        storage.get = async (...args: unknown[]) => {
          if (hold && args[0] === "remoteCatalog") {
            hold = false;
            entered();
            await held;
          }
          return get(...args);
        };
        const request =
          kind === "metasploit-control-race"
            ? this.controlRemote(
                "metasploit_stop_job",
                { job_id: 0 },
                "racing-stop",
              )
            : this.inspectRemote("metasploit_list_listeners", {});
        const outcome = request.then(
          () => "fulfilled",
          (error) => (error instanceof Error ? error.message : String(error)),
        );
        await admitted;
        job = false;
        session = false;
        checks.during = await this.execution();
        checks.closesDuring = closes;
        release();
        checks.requestOutcome = await outcome;
        storage.get = get;
        checks.after = await this.execution();
        checks.closes = closes;
        checks.opensAfterClose = opensAfterClose;
        try {
          await this.controlRemote(
            "metasploit_stop_job",
            { job_id: 0 },
            "retired-stop",
          );
          checks.retiredControlRejected = false;
        } catch {
          checks.retiredControlRejected = true;
        }
        try {
          await this.inspectRemote("metasploit_list_listeners", {});
          checks.retiredInspectionRejected = false;
        } catch {
          checks.retiredInspectionRejected = true;
        }
      } else if (kind === "metasploit-owned") {
        checks.stop = await this.controlRemote(
          "metasploit_stop_job",
          { job_id: 0 },
          "stop-job",
        );
        checks.afterJob = await this.execution();
        checks.stopDuplicate = await this.controlRemote(
          "metasploit_stop_job",
          { job_id: 0 },
          "stop-job",
        );
        checks.terminate = await this.controlRemote(
          "metasploit_terminate_session",
          { session_id: 7 },
          "terminate-session",
        );
        checks.after = await this.execution();
      } else {
        job = false;
        session = false;
        checks.after = await this.execution();
        try {
          await this.controlRemote(
            "metasploit_stop_job",
            { job_id: 0 },
            "unknown-stop",
          );
          checks.unknownControlRejected = false;
        } catch {
          checks.unknownControlRejected = true;
        }
      }
      checks.receipts = await this.remoteReceipts();
      checks.launches = launches;
      checks.stops = stops;
      checks.inspectOrder = inspectOrder;
    } else if (kind === "mcp-schema") {
      let initialized = false;
      const binding = {
        fetch: async (request: Request) => {
          if (request.method !== "POST")
            return new Response("Method not allowed", { status: 405, headers: {"X-Pentcloud-Toolbox-Generation": "fixture-generation"} });
          const rpc = (await request.json()) as { id?: number; method: string };
          if (rpc.method === "notifications/initialized") {
            initialized = true;
            return new Response(null, { status: 202, headers: {"X-Pentcloud-Toolbox-Generation": "fixture-generation"} });
          }
          const result =
            rpc.method === "initialize"
              ? {
                  protocolVersion: "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "schema-canary", version: "1" },
                }
              : rpc.method === "tools/list"
                ? {
                    tools: [
                      {
                        name: "schema_canary",
                        inputSchema: { type: "object", properties: {} },
                        outputSchema: {
                          type: "object",
                          properties: { ok: { type: "boolean" } },
                          required: ["ok"],
                          additionalProperties: false,
                        },
                      },
                    ],
                  }
                : {
                    content: [{ type: "text", text: "Validated without eval" }],
                    structuredContent: { ok: true },
                    isError: false,
                  };
          return Response.json({ jsonrpc: "2.0", id: rpc.id, result }, {headers: {"X-Pentcloud-Toolbox-Generation": "fixture-generation"}});
        },
      };
      const client = new ToolboxMCP(binding as unknown as Fetcher, undefined, "fixture-generation");
      try {
        checks.catalog = await client.list();
        checks.result = await client.call("schema_canary", {});
        checks.initialized = initialized;
      } finally {
        await client.close();
      }
    } else if (kind === "memory-contract") {
      let call = 0;
      const role = async (name: AttemptInput["role"], scope: Record<string, unknown> = {}) => {
        const state = (await this.ctx.storage.get<{input: AttemptInput}>("attempt"))!;
        await this.ctx.storage.put("attempt", {...state, input: {...state.input, role: name,
          context: {enabledTools: supportedOptionalTools(name), ...scope}}});
      };
      const invoke = (name: string, args: object) => internal.callTool(name, {...args, message: "Memory contract regression"}, `memory-${++call}`);
      const code = (lang: string, marker: string) => ({code: marker, question: marker, lang,
        explanation: "Memory contract", description: "Memory contract"});
      await role("coder");
      const fresh = await invoke("store_code", code("python", "same-attempt-needle"));
      checks.sameAttempt = await invoke("search_code", {questions: ["same-attempt-needle"], lang: "python"});
      checks.wrongLanguage = await invoke("search_code", {questions: ["same-attempt-needle"], lang: "javascript"});
      // Populate different original document kinds with the same literal query.
      await invoke("store_code", code("javascript", "shared-kind-needle"));
      await role("maintenance");
      const install = await invoke("store_guide", {guide: "shared-kind-needle", question: "install question", type: "install"});
      await invoke("store_guide", {guide: "shared-kind-needle", question: "configure question", type: "configure"});
      checks.guides = await invoke("search_guide", {questions: ["shared-kind-needle"], type: "install"});
      await role("searcher");
      const answer = await invoke("store_answer", {answer: "shared-kind-needle", question: "answer question", type: "vulnerability"});
      checks.answers = await invoke("search_answer", {questions: ["shared-kind-needle"], type: "vulnerability"});
      checks.wrongAnswerType = await invoke("search_answer", {questions: ["shared-kind-needle"], type: "tool"});
      await role("coder", {task_id: 41, subtask_id: 7});
      const scoped = await invoke("store_code", code("python", "scoped-needle"));
      await role("coder", {task_id: 41, subtask_id: 8});
      await invoke("store_code", code("python", "scoped-needle"));
      await role("coder", {task_id: 42, subtask_id: 7});
      await invoke("store_code", code("python", "scoped-needle"));
      await role("coder");
      const argumentState = (await this.ctx.storage.get<{input: AttemptInput}>("attempt"))!;
      await this.ctx.storage.put("attempt", {...argumentState, input: {...argumentState.input, args: {task_id: 43, subtask_id: 9}}});
      const argumentScoped = await invoke("store_code", code("python", "argument-scope-needle"));
      await role("memorist");
      checks.scoped = await invoke("search_in_memory", {questions: ["scoped-needle"], task_id: 41, subtask_id: 7});
      checks.argumentScoped = await invoke("search_in_memory", {questions: ["argument-scope-needle"], task_id: 43, subtask_id: 9});
      checks.mappedButNoMatch = await invoke("search_in_memory", {questions: ["absent-needle"], task_id: 41});
      try { await invoke("search_in_memory", {questions: ["scoped-needle"], task_id: 999}); }
      catch (error) { checks.unmapped = String(error); }
      try { await invoke("search_in_memory", {questions: ["scoped-needle"], task_id: 41, subtask_id: 999}); }
      catch (error) { checks.unmappedSubtask = String(error); }
      // Legacy accepted Markdown must remain searchable with its original metadata headings.
      const legacy = ".pentagi/memory/code/legacy.md";
      await this.workspace.fs.writeFile(`${this.directory}/${legacy}`, "---\nkind: code\ntool: store_code\njob_id: old\ndigest: legacy\n---\n\n## code\n\nlegacy-needle\n\n## lang\n\npython\n\n## question\n\nOld accepted code\n");
      await this.workspace.git.add({dir: this.directory, paths: [legacy]});
      await role("coder");
      checks.legacy = await invoke("search_code", {questions: ["legacy-needle"], lang: "python"});
      checks.paths = {fresh, install, answer, scoped, argumentScoped};
      checks.noModel = (await this.ctx.storage.get("fixture:modelRequests")) ?? 0;
      checks.noScanner = (await this.ctx.storage.get("fixture:toolCalls")) ?? 0;
    } else if (kind === "memory") {
      checks.stored = await internal.callTool(
        "store_code",
        {
          code: "native-memory-marker",
          question: "native-memory-marker",
          lang: "text",
          explanation: "Durable memory regression",
          description: "Native memory",
          message: "Store evidence",
        },
        "store-code",
      );
      const terminal = (await internal.publish({
        tool: "code_result",
        arguments: { result: "Stored native-memory-marker", message: "Done" },
        status: "completed",
        finishedAt: Date.now(),
      })) as { outputCommit: string };
      checks.acceptedHead = terminal.outputCommit;
      checks.committedFiles = await this.workspace.git.lsFiles({
        dir: this.directory,
        ref: terminal.outputCommit,
      });
      const next = {
        ...input,
        id: "next-memory-attempt",
        role: "memorist" as const,
        inputCommit: terminal.outputCommit,
        context: { enabledTools: supportedOptionalTools("memorist") },
      };
      await this.ctx.storage.put("attempt", {
        input: next,
        fingerprint: "next-memory",
        prompt: "Probe",
        promptDigest: "c".repeat(64),
        status: "running",
        prepared: true,
        startedAt: Date.now(),
      });
      checks.found = await internal.callTool(
        "search_in_memory",
        {
          questions: ["native-memory-marker"],
          message: "Find accepted memory",
        },
        "search-memory",
      );
    } else if (kind === "research-policy") {
      let scopeRejected = false;
      let mutationRejected = false;
      try {
        await internal.callTool(
          "browser",
          {
            url: "https://outside.example.invalid/",
            action: "html",
            message: "Scope regression",
          },
          "browser-outside",
        );
      } catch {
        scopeRejected = true;
      }
      try {
        await (
          this as unknown as {
            executeRemoteTool(
              name: string,
              args: object,
              id: string,
            ): Promise<unknown>;
          }
        ).executeRemoteTool(
          "nmap_port_scan",
          { target: "127.0.0.1" },
          "research-mutation",
        );
      } catch {
        mutationRejected = true;
      }
      checks.scopeRejected = scopeRejected;
      checks.mutationRejected = mutationRejected;
      checks.enabledTools = input.context.enabledTools;
    } else if (
      kind.startsWith("metasploit") ||
      kind.startsWith("session") ||
      kind === "unknown" ||
      kind === "known-running"
    ) {
      await this.installRemoteFixture();
      const remote = this as unknown as {
        executeRemoteTool(
          name: string,
          args: object,
          id: string,
        ): Promise<unknown>;
      };
      if (kind === "known-running")
        await this.ctx.storage.put("fakeKnownRunning", true);
      try {
        checks.first = await remote.executeRemoteTool(
          "nmap_port_scan",
          { target: "127.0.0.1", ports: "8081" },
          "lost-first",
        );
      } catch {
        checks.firstLost = true;
      }
      try {
        await remote.executeRemoteTool(
          "nmap_port_scan",
          { target: "127.0.0.1", ports: "8081" },
          "new-second",
        );
        checks.newCallFenced = false;
      } catch {
        checks.newCallFenced = true;
      }
      checks.starts = await this.ctx.storage.get("fakeRemoteStarts");
      checks.before = await this.execution();
      if (kind === "known-running") {
        await this.ctx.storage.put("fakeKnownFinished", true);
        checks.after = await this.execution();
      } else {
        await this.cancel();
        checks.cancelled = await this.execution();
        checks.receipts = await this.remoteReceipts();
      }
    } else if (kind === "drain") {
      const pending = shell("sleep 30");
      await new Promise((resolve) => setTimeout(resolve, 25));
      checks.before = await this.execution();
      await this.cancel();
      checks.cancelled = await this.execution();
      try {
        await pending;
        checks.lateRejected = false;
      } catch {
        checks.lateRejected = true;
      }
      checks.after = await this.execution();
      checks.published = this.published;
    } else if (kind === "cancel") {
      await this.cancel();
      try {
        await internal.publish({
          tool: "yield",
          arguments: { message: "late", plan: "late" },
          status: "waiting",
          finishedAt: Date.now(),
        });
        checks.lateRejected = false;
      } catch {
        checks.lateRejected = true;
      }
      checks.published = this.published;
      checks.state = await this.ctx.storage.get("attempt");
    } else throw new Error("Unknown probe");
    return checks;
  }
  private async installRemoteFixture() {
    await this.ctx.storage.put("remoteCatalog", {
      tools: [
        {
          name: "nmap_get_scan_results",
          inputSchema: {
            type: "object",
            properties: { scan_id: { type: "string" } },
            required: ["scan_id"],
          },
        },
        {
          name: "nmap_list_active_scans",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    (this as unknown as { remote(): Promise<object> }).remote = async () => ({
      call: async (name: string, _args: object) => {
        if (name === "nmap_port_scan") {
          await this.ctx.storage.put(
            "fakeRemoteStarts",
            ((await this.ctx.storage.get<number>("fakeRemoteStarts")) ?? 0) + 1,
          );
          if (!(await this.ctx.storage.get("fakeKnownRunning")))
            throw new Error("Injected response lost after remote mutation");
        }
        const status =
          (await this.ctx.storage.get("fakeKnownRunning")) &&
          !(await this.ctx.storage.get("fakeKnownFinished"))
            ? "running"
            : "completed";
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                scan_id: "probe-scan",
                target: "127.0.0.1",
                scan_type: "port",
                status,
              }),
            },
          ],
          isError: false,
        };
      },
    });
  }
  async afterSessionEviction() {
    const before = await this.execution();
    const sid = await this.ctx.storage.get<{ sessionId: string }>("mcpSession");
    const original = await this.ctx.storage.get<string>("fixture:originalSid");
    const native = this as unknown as { remote(): Promise<ToolboxMCP> };
    const remote = await native.remote();
    for (let index = 0; index < 6; index++)
      await this.inspectRemote("nmap_get_scan_results", {
        scan_id: "session-scan",
      });
    await this.ctx.storage.delete("fixture:cancelledWireId");
    const cancellation = new AbortController();
    const waiting = remote.call(
      "nmap_get_scan_results",
      { scan_id: "cancel-probe" },
      cancellation.signal,
      5000,
    );
    for (
      let tick = 0;
      tick < 100 && !(await this.ctx.storage.get("fixture:newHeldWireId"));
      tick++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    cancellation.abort("Only the new inspection is cancelled");
    await waiting.catch(() => undefined);
    for (
      let tick = 0;
      tick < 100 && !(await this.ctx.storage.get("fixture:cancelledWireId"));
      tick++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const oldId = await this.ctx.storage.get<string | number>(
      "fixture:oldWireId",
    );
    const oldPendingRetained =
      oldId !== undefined &&
      !!(await this.ctx.storage.get(`fixture:pending:${oldId}`));
    const newId = await this.ctx.storage.get("fixture:newHeldWireId");
    const cancelledId = await this.ctx.storage.get("fixture:cancelledWireId");
    const ids =
      (await this.ctx.storage.get<Array<string | number>>("fixture:wireIds")) ??
      [];
    const wireIdsUnique =
      new Set(ids).size === ids.length &&
      ids.every((id) => typeof id === "string");
    const collision = !!(await this.ctx.storage.get("fixture:idCollision"));
    await this.ctx.storage.put("fixture:completeOld", true);
    const resolution = await this.reconcileRemote("session-lost", {
      inspectionTool: "nmap_get_scan_results",
      scanId: "session-scan",
      identityEvidence: {
        source: "captured-response",
        reference: "Fixture exact lost session-scan original response",
        confirmedExactOperation: true,
      },
    });
    return {
      wireIdsUnique,
      collision,
      oldPendingRetained,
      cancelOnlyNew: cancelledId === newId && cancelledId !== oldId,
      before,
      resolution,
      reusedSid: sid?.sessionId === original,
      after: await this.execution(),
      initializes: await this.ctx.storage.get("fixture:initializes"),
      deletes: await this.ctx.storage.get("fixture:deletes"),
      deleteAfterProof: await this.ctx.storage.get("fixture:deleteAfterProof"),
      saved: !!(await this.ctx.storage.get("mcpSession")),
    };
  }
  async purgedSnapshot() {
    const checks: Record<string, unknown> = {keys: [...await this.ctx.storage.list()], alarm: await this.ctx.storage.getAlarm(), readiness: await this.purgeReadiness("local-run")};
    try {await this.run({} as AttemptInput); checks.replay = "allowed";} catch (error) {checks.replay = String(error);}
    try {await this.inspect(); checks.inspect = "allowed";} catch (error) {checks.inspect = String(error);}
    checks.browser = await this.browserLiveView();
    checks.execution = await this.execution();
    return checks;
  }
  async evict(): Promise<void> {
    await this.ctx.storage.sync();
    this.ctx.abort("Unknown receipt eviction regression");
  }
  async afterPlatformEviction() {
    const before = await this.execution();
    let controlsFenced = false;
    try { await this.sessionControls(); } catch (error) { controlsFenced = String(error).includes("409:"); }
    await this.lifecycle.start();
    await this.lifecycle.alarm();
    const lifecycleStartupSkipped = !(await this.ctx.storage.get("startup"));
    await this.cancel();
    return { before, controlsFenced, lifecycleStartupSkipped, cancelled: await this.execution() };
  }
  async afterToolboxEviction(): Promise<object> {
    const input = (await this.ctx.storage.get<AttemptInput>("fixture:replayInput"))!;
    await this.ctx.storage.put("fixture:holdModel", false);
    await this.ctx.storage.put("fixture:stopBeforeModel", true);
    const modelsBefore = await this.ctx.storage.get("fixture:modelRequests");
    const readiesBefore = await this.ctx.storage.get("fixture:readies");
    await this.lifecycle.start();
    const queued = this.ctx.storage.sql.exec<{count: number}>("SELECT count(*) AS count FROM cf_agents_jobs WHERE id LIKE 'opencode-wake:%'").one().count;
    // Accelerate the existing SDK wake; there is no additional recovery job.
    this.ctx.storage.sql.exec("UPDATE cf_agents_jobs SET time=0, running=0, execution_started_at=NULL WHERE id LIKE 'opencode-wake:%'");
    await this.lifecycle.alarm();
    const afterAlarm = {models: await this.ctx.storage.get("fixture:modelRequests"), readies: await this.ctx.storage.get("fixture:readies"), wakes: this.ctx.storage.sql.exec<{count: number}>("SELECT count(*) AS count FROM cf_agents_jobs WHERE id LIKE 'opencode-wake:%'").one().count};
    const result = await this.run(input);
    const users = (await this.harness.session().history()).filter(message => message.type === "user").length;
    const modelsAfter = await this.ctx.storage.get("fixture:modelRequests");
    const calls = (await this.ctx.storage.get("fixture:toolCalls")) ?? 0;
    await this.harness.dispose();
    await this.ctx.storage.deleteAlarm();
    return {queued, modelsBefore, readiesBefore, afterAlarm, result, users, modelsAfter, calls};
  }
  async afterEviction() {
    await this.installRemoteFixture();
    const before = await this.execution();
    const remote = this as unknown as {
      executeRemoteTool(
        name: string,
        args: object,
        id: string,
      ): Promise<unknown>;
    };
    let newCallFenced = false;
    try {
      await remote.executeRemoteTool(
        "nmap_port_scan",
        { target: "127.0.0.1", ports: "8081" },
        "after-eviction-new",
      );
    } catch {
      newCallFenced = true;
    }
    const identityEvidence = {
      source: "captured-response" as const,
      reference:
        "Fixture captured response for exactly lost-first with probe-scan",
      confirmedExactOperation: true as const,
    };
    let missingAttestationRejected = false;
    try {
      await this.reconcileRemote("lost-first", {
        inspectionTool: "nmap_get_scan_results",
        scanId: "probe-scan",
      });
    } catch {
      missingAttestationRejected = true;
    }
    let wrongProofRejected = false;
    try {
      await this.reconcileRemote("lost-first", {
        inspectionTool: "nmap_get_scan_results",
        scanId: "different-scan",
        identityEvidence,
      });
    } catch {
      wrongProofRejected = true;
    }
    const resolution = await this.reconcileRemote("lost-first", {
      inspectionTool: "nmap_get_scan_results",
      scanId: "probe-scan",
      identityEvidence,
    });
    return {
      missingAttestationRejected,
      before,
      newCallFenced,
      wrongProofRejected,
      resolution,
      after: await this.execution(),
      starts: await this.ctx.storage.get("fakeRemoteStarts"),
    };
  }
}
export class ProbeModelTest extends OpenCodeConnectionTest {
  private requests:Array<{native:boolean;authenticated:boolean;model:string;tools:number}>=[];
  private origin="";
  protected override create(options:OpenCodeWorkerd.CreateOptions){
    const owner=this;
    return OpenCodeWorkerd.create({...options,plugins:[...options.plugins??[],Plugin.define({id:"fixture.http",async setup(ctx){
      await ctx.session.hook("http.request",async event=>{
        const request=event.request,body=await request.clone().json() as {model:string;tools?:unknown[]};
        owner.requests.push({native:!!request.headers.get("x-opencode-client")&&!!request.headers.get("x-opencode-session-id"),authenticated:request.headers.get("authorization")==="Bearer fixture-model-key",model:body.model,tools:body.tools?.length??0});
        event.request=new Request(owner.origin+"/fake-provider",request);
      });
    }})]});
  }
  async check(origin:string){
    this.origin=origin;
    const model:PinnedModel={id:"opencode:fixture-console",modelId:"fixture-console",provider:"opencode",route:"console",adapter:"chat-completions",name:"Fixture Console",
      package:"@opencode/ai/providers/openai-compatible",baseURL:"https://opencode.ai/inference/openai/v1",contextLength:128000,outputLimit:8192,
      compatibility:{reasoning_field:"reasoning_content"},reasoningEfforts:["default"],inputModalities:["text"],outputModalities:["text"],supportedParameters:[],
      credentialId:"fixture-key",credentialVersion:1,catalogDigest:"a".repeat(64),testedAt:Date.now()};
    try {await this.probeModel(model,"fixture-model-key");}catch(error){return {error:String(error),requests:this.requests};}
    return {requests:this.requests,empty:(await this.ctx.storage.list()).size===0};
  }
}
export default {
  async fetch(
    request: Request,
    env: { ATTEMPTS: DurableObjectNamespace<ProbeAttempt>; MODEL_TESTS:DurableObjectNamespace<ProbeModelTest> },
  ) {
    const url = new URL(request.url);
    const kind = url.pathname.slice(1);
    if(kind==="curl-fixture")return Response.json({method:request.method,header:request.headers.get("X-Curl-Fixture"),body:await request.text()},{status:207});
    if(kind==="fake-provider"){
      if(url.searchParams.has("question")){
        const body=await request.json() as {messages:Array<{role:string;content:unknown}>};
        const ask=!body.messages.some(message=>message.role==="tool");
        const delta=ask?{role:"assistant",tool_calls:[{index:0,id:"call_preparation_question",type:"function",function:{name:"question",arguments:JSON.stringify({questions:[{header:"Approach",question:"What should we prepare?",options:[{label:"Focused",description:"Review the selected project"},{label:"Broader",description:"Discuss the wider project"}]}]})}}]}:{role:"assistant",content:"Ready to prepare Focused"};
        const frame=(delta:unknown,finish:string|null)=>"data: "+JSON.stringify({id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta,finish_reason:finish}]})+"\n\n";
        return new Response(frame(delta,null)+frame({},ask?"tool_calls":"stop")+"data: [DONE]\n\n",{headers:{"Content-Type":"text/event-stream"}});
      }
      const chunks=[{id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta:{role:"assistant",content:"OK"},finish_reason:null}]},
        {id:"fixture",object:"chat.completion.chunk",choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:10,completion_tokens:1,total_tokens:11}}];
      return new Response(chunks.map(x=>"data: "+JSON.stringify(x)+"\n\n").join("")+"data: [DONE]\n\n",{headers:{"Content-Type":"text/event-stream"}});
    }
    if(kind==="native-model-probe")return Response.json(await env.MODEL_TESTS.getByName(crypto.randomUUID()).check(url.origin));
    const attempt = env.ATTEMPTS.getByName(
      url.searchParams.get("name") ?? `${kind}-${crypto.randomUUID()}`,
    );
    try {
      if(kind.startsWith("preparation-"))await attempt.configurePreparation(url.origin,kind==="preparation-chat",url.searchParams.get("failure"));
      if (kind === "after-purge") return Response.json(await attempt.purgedSnapshot());
      if (kind === "purge-absent") return Response.json(await attempt.purge("local-run"));
      if (kind === "evict") {
        await attempt.evict();
        return Response.json({ evicted: true });
      }
      if (kind === "after-session-eviction")
        return Response.json(await attempt.afterSessionEviction());
      if (kind === "after-platform-eviction") return Response.json(await attempt.afterPlatformEviction());
      if (kind === "after-toolbox-eviction") return Response.json(await attempt.afterToolboxEviction());
      if (kind === "after-eviction")
        return Response.json(await attempt.afterEviction());
      return Response.json(await attempt.probe(kind, url.origin));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.stack : String(error) },
        { status: 500 },
      );
    }
  },
};
