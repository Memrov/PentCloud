import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NativeEnv } from "./types";
import type { AgentSettings } from "../settings/catalog";
import { LegacyHistory } from "./history";
import {knownRuntimeSecrets} from "../../../../shared/runtime-secrets";
import { normalizeUploadIds, MATERIAL_FILE_LIMIT } from "./materials";
import { confinedRelative } from "./tool-policy";
import { hostedUIResponse } from "./ui-response";
import {readVerificationEmail} from './verification-email';
import {configureSetupAccess,prepareSetupStorage,saveSetupKey,setupStatus} from './setup';

import { TOOLBOX_GENERATION_HEADER, toolboxOperatorReply } from "../../../../shared/toolbox-rpc";

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const browserViewHeaders = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"};
async function actor(request: Request, env: NativeEnv): Promise<string> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
    throw new Error("401: Cloudflare Access configuration is required");
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("401: Sign in through Cloudflare Access");
  const issuer = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
  let keys = jwks.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwks.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: env.ACCESS_AUD,
      requiredClaims: ["exp"],
    });
    return typeof payload.email === "string" ? payload.email : "access-service";
  } catch {
    throw new Error("403: Invalid Cloudflare Access identity");
  }
}
async function body(request: Request, limit=2300*1024): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("Content-Length") ?? 0) > limit)
    throw new Error("413: request too large");
  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let text = "",
    size = 0;
  if (reader) {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new Error("413: request too large");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("400: invalid JSON object");
  }
}
function errorResponse(error: unknown, env: NativeEnv) {
  let message = error instanceof Error ? error.message : String(error);
  const status = Number(
    message.match(/\b(400|401|403|404|409|410|413|429|503):/)?.[1] ?? 500,
  );
  for (const secret of [...knownRuntimeSecrets(env), env.OPENCODE_GO_API_KEY])
    if (secret) message = message.split(secret).join("[redacted]");
  return Response.json({ error: message.slice(0, 1500) }, { status });
}


export default {
  async email(message:ForwardableEmailMessage,env:NativeEnv){
    if(!env.PENTCLOUD_VERIFICATION_EMAIL||message.rawSize>256*1024){message.setReject('Verification email is unavailable');return;}
    const delivery=await readVerificationEmail({to:message.to,headers:message.headers,raw:message.raw});
    if(delivery)await env.COORDINATOR.getByName('global').receiveVerificationEmail(delivery);
  },
  async fetch(request: Request, env: NativeEnv): Promise<Response> {
    const url = new URL(request.url);
    if(url.pathname==='/v1/ui/setup/access'&&request.method==='POST'&&!env.ACCESS_TEAM_DOMAIN&&!env.ACCESS_AUD){
      try{const origin=request.headers.get('Origin');if((origin&&origin!==url.origin)||request.headers.get('Sec-Fetch-Site')==='cross-site')throw Error('403: Use this application’s origin.');await configureSetupAccess(env,await body(request,16384),request.url);return Response.json({configured:true},{headers:browserViewHeaders});}catch(error){return errorResponse(error,env);}
    }
    if(url.pathname==='/v1/ui/setup'&&request.method==='GET'&&(!env.ACCESS_TEAM_DOMAIN||!env.ACCESS_AUD))
      return Response.json({schemaVersion:1,access:false,accountId:Reflect.get(env,'PENTCLOUD_ACCOUNT_ID'),worker:Reflect.get(env,'PENTCLOUD_WORKER_NAME'),missing:['Cloudflare Access'],storage:false,models:false,ready:false},{headers:browserViewHeaders});
    if (url.pathname === "/health")
      return Response.json({
        application: "PentCloud",
        runtime: "Cloudflare OpenCode V2",
        concurrency: 1,
        maxOutstanding: 3,
        timeoutSeconds: null,
        goConfigured: !!env.OPENCODE_GO_API_KEY,
        storage: "DO SQLite and Artifacts",
      });
    try {
      if (
        !url.pathname.startsWith("/v1/") &&
        !url.pathname.startsWith("/agents/")
      )
        return env.ASSETS
          ? hostedUIResponse(await env.ASSETS.fetch(request), request.url)
          : new Response("PentCloud", { status: 200 });
      const identity = await actor(request, env);
      // Access authenticates cookies at the edge. Do not let a foreign page
      // spend that identity on mutations or an authenticated WebSocket.
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
        const origin=request.headers.get("Origin");
        if ((origin && origin !== url.origin) || request.headers.get("Sec-Fetch-Site") === "cross-site")
          throw new Error("403: Use this application's origin for browser actions");
      }
      if(url.pathname==='/v1/ui/setup'&&request.method==='GET')return Response.json(await setupStatus(env),{headers:browserViewHeaders});
      if(url.pathname==='/v1/ui/setup/storage'&&request.method==='POST'){
        await body(request,64);await prepareSetupStorage(env);return Response.json({prepared:true},{headers:browserViewHeaders});
      }
      if(url.pathname==='/v1/ui/setup/model'&&request.method==='POST'){
        await saveSetupKey(env,await body(request,16384));return Response.json({saved:true},{headers:browserViewHeaders});
      }
      const coordinator = env.COORDINATOR.getByName("global");
      const history = new LegacyHistory(env);
      if (url.pathname.startsWith("/agents/")) {
        if (url.pathname !== "/agents/coordinator/global")
          return new Response("Not found", { status: 404 });
        return await coordinator.fetch(request);
      }
      const path = url.pathname.replace(/^\/v1(?:\/ui)?/, "");
      if (!url.search && ((path === "/toolbox/status" && ["GET","POST"].includes(request.method)) || (path === "/toolbox/start" && request.method === "POST"))) {
        if(!env.TOOLBOX)return Response.json({state:"not-installed",...(env.TOOL_PACKS?{runtime:"Cloudflare tool packs"}:{})},{status:404,headers:{"Cache-Control":"no-store"}});
        const reply=path.endsWith("status")?await env.TOOLBOX.status():await env.TOOLBOX.ready(request.headers.get(TOOLBOX_GENERATION_HEADER)??undefined);
        return toolboxOperatorReply(reply);
      }
      const definition=path.match(/^\/targets\/([A-Za-z0-9._-]+)\/definition$/);
      if(definition){
        if(request.method==="GET")return coordinator.targetDefinition(definition[1]!,url.searchParams.has("version")?Number(url.searchParams.get("version")):undefined);
        if(request.method==="POST"){
          const name=url.searchParams.get("name")??"",sha256=request.headers.get("X-Content-SHA256")??"",revision=request.headers.get("If-Match")??"0";
          if(!request.body||!/^[a-f0-9]{64}$/.test(sha256)||!/^\d+$/.test(revision))throw new Error("400: File body, SHA-256 and expected definition version are required");
          return Response.json(await coordinator.saveTargetDefinition(definition[1]!,Number(revision),{name,sha256,body:request.body,uploadedBy:identity}),{status:201,headers:{"Cache-Control":"no-store"}});
        }
      }
      const pendingCreation=path.match(/^\/onboarding\/pending\/([A-Za-z0-9._-]+)$/);
      if(pendingCreation&&request.method==="GET")return Response.json(await coordinator.creationSnapshot(pendingCreation[1]!),{headers:{"Cache-Control":"no-store"}});
      if(path==="/onboarding" && request.method==="GET")return Response.json(await coordinator.onboardingSnapshot(url.searchParams.get("run")??undefined),{headers:{"Cache-Control":"no-store"}});
      if(path==="/onboarding/export" && request.method==="GET")return Response.json(await coordinator.onboardingExport(),{headers:{"Cache-Control":"no-store"}});
      const onboardingAction=path.match(/^\/onboarding\/([a-z]+(?:\.[a-z]+){1,2})$/);
      if(onboardingAction && request.method==="POST"){
        const input=await body(request,onboardingAction[1]==="metadata.import"?16*1024*1024:2300*1024);
        if(onboardingAction[1]==="credential.save"&&input.purpose==="model")throw new Error("400: Manage OpenCode keys through Cloudflare secret bindings");
        return Response.json(await coordinator.onboardingAction(onboardingAction[1]!,input,identity),{headers:{"Cache-Control":"no-store"}});
      }
      const activation=path.match(/^\/runs\/([A-Za-z0-9._-]+)\/analysis$/);
      if(activation && request.method==="POST"){
        const value=await body(request);
        if(typeof value.revision!=="number" || typeof value.requestId!=="string")throw new Error("400: Setup revision and request ID are required");
        return Response.json(await coordinator.activateAnalysis(activation[1]!,value.revision,value.requestId,value.acknowledgeFailure===true,typeof value.definitionVersion==="number"?value.definitionVersion:0),{status:202});
      }
      if(path==="/lifecycle" && request.method==="GET")return Response.json(await coordinator.lifecycleStatus(),{headers:{"Cache-Control":"no-store"}});
      if(path==="/lifecycle/prepare-uninstall" && request.method==="POST")return Response.json(await coordinator.prepareUninstall(request.body?(await body(request)).deleteOnboarding===true:false));
      const lifecycleRoute=path.match(/^\/runs\/([A-Za-z0-9._-]+)(?:\/(archive|trash|restore|report|findings))?$/);
      if(lifecycleRoute){
        const id=lifecycleRoute[1]!,action=lifecycleRoute[2];
        if(request.method==="DELETE" && !action){const value=await body(request);return Response.json(await coordinator.purgeRun(id,String(value.confirm ?? "")));}
        if(request.method==="POST" && action==="archive")return Response.json(await coordinator.archiveRun(id));
        if(request.method==="POST" && action==="trash")return Response.json(await coordinator.trashRun(id));
        if(request.method==="POST" && action==="restore")return Response.json(await coordinator.restoreRun(id));
        if(request.method==="GET" && action==="findings")return Response.json(await coordinator.findings(id,url.searchParams.get("job")??""),{headers:{"Cache-Control":"private, no-store"}});
        if(request.method==="GET" && action==="report")return coordinator.report(id,url.searchParams.get("job") ?? undefined);
      }
      const jobAccess=path.match(/^\/jobs\/([A-Za-z0-9._-]+)\//);
      if(jobAccess){
        // Remote receipt reconciliation remains available in Trash until drain;
        // all execution/content routes reject purged jobs before opening a session.
        const safety=/\/(?:remote-receipts|remote-control|remote-inspect|api-receipts)(?:\/|$)/.test(path);
        try{
          const access=await coordinator.assertJobAvailable(jobAccess[1]!,request.method!=="GET" && !safety && !path.endsWith("/interrupt"));
          if(access.executionKind==="discovery"&&/\/(events|inspect|steer|revisions|session-controls|browser-live-view|forms|permissions)(?:\/|$)/.test(path))throw new Error("409: Discovery has no model session; use run progress and accepted files");
        }
        catch(error){if(!String(error).includes("404:") || !path.endsWith("/events"))throw error;}
      }
      const upload = path.match(/^\/runs\/([A-Za-z0-9._-]+)\/uploads\/([A-Za-z0-9._-]+)$/);
      if (upload && request.method === "POST") {
        const name = url.searchParams.get("name") ?? "";
        const sha256 = request.headers.get("X-Content-SHA256") ?? "";
        if (!name.trim() || name.length > 180 || /[\/\\\x00-\x1f\x7f]/.test(name) || !/^[a-f0-9]{64}$/.test(sha256) || !request.body)
          throw new Error("400: valid filename, SHA-256 and file body are required");
        const length = request.headers.get("Content-Length");
        if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))))
          throw new Error("400: invalid upload length");
        if (length !== null && Number(length) > MATERIAL_FILE_LIMIT) throw new Error("413: file exceeds 2 MiB");
        return Response.json(await coordinator.stageUpload({
          runId: upload[1]!, id: upload[2]!, name, sha256, body: request.body, uploadedBy: identity,
        }), {status: 201, headers: {"Cache-Control": "no-store"}});
      }
      const fileRoute = path.match(/^\/runs\/([A-Za-z0-9._-]+)\/(files|file)$/);
      if (fileRoute && request.method === "GET") {
        const runId = fileRoute[1]!;
        if (fileRoute[2] === "files")
          return Response.json(await coordinator.files(runId, url.searchParams.get("job") ?? undefined), {headers: {"Cache-Control": "no-store"}});
        const commit = url.searchParams.get("commit") ?? "";
        const requested = url.searchParams.get("path") ?? "";
        if (!/^[a-f0-9]{40}$/.test(commit) || !requested || requested.split("/").includes(".git")) throw new Error("400: immutable commit and file path are required");
        let filePath: string;
        try { filePath = confinedRelative(requested); } catch { throw new Error("400: invalid file path"); }
        const response = await coordinator.file(runId, commit, filePath, url.searchParams.get("preview") === "1");
        const headers = new Headers(response.headers);
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
        headers.set("Cache-Control", "private, no-store");
        headers.set("Referrer-Policy", "no-referrer");
        return new Response(response.body, {status: response.status, headers});
      }
      if (path === "/runtime-diagnostics" && request.method === "GET")
        return Response.json(await coordinator.diagnostics(), {headers: {"Cache-Control": "no-store"}});
      if (path === "/runtime-recovery" && request.method === "POST") {
        const value = await body(request);
        if (!Object.keys(value).every(key => ["scope", "observedAt", "attemptId"].includes(key)) ||
            !["coordinator", "attempt"].includes(String(value.scope)) ||
            typeof value.observedAt !== "number" || !Number.isSafeInteger(value.observedAt) || value.observedAt < 0 ||
            (value.attemptId !== undefined && (typeof value.attemptId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value.attemptId))) ||
            (value.scope === "attempt" && !value.attemptId))
          throw new Error("400: invalid runtime recovery identity");
        return Response.json(await coordinator.rearmPlatformRecovery(value as {scope: "coordinator" | "attempt"; observedAt: number; attemptId?: string}));
      }
      if (path === "/runs" && request.method === "GET") {
        const view=url.searchParams.get("view") ?? "active";
        if(!["active","archived","trash","all"].includes(view))throw new Error("400: invalid run view");
        const current = view==="active" ? await coordinator.listRuns() : await coordinator.listRuns(view as "archived"|"trash"|"all");
        const previous = view==="active" || view==="all" ? await history.listRuns() : {runs:[]};
        const ids = new Set(current.runs.map((r) => r.id));
        return Response.json({
          runs: [
            ...current.runs,
            ...previous.runs.filter((r) => !ids.has(r.id)),
          ],
        });
      }
      if (path === "/runs" && request.method === "POST") {
        const value = await body(request);
        if (value.upload_ids !== undefined) value.upload_ids = normalizeUploadIds(value.upload_ids);
        return Response.json(
          await coordinator.createRun(
            {...value,actor:identity} as unknown as import("./types").NewRunInput,
          ),
          { status: 202 },
        );
      }
      if (path === "/queue" && request.method === "GET")
        return Response.json(await coordinator.queueSnapshot());
      if (path === "/settings" && request.method === "GET")
        return Response.json(await coordinator.settings());
      if (path === "/settings" && request.method === "PUT") {
        const value = await body(request);
        const rawRevision = request.headers.get("If-Match");
        const revision = Number(rawRevision);
        if (
          rawRevision === null ||
          !/^\d+$/.test(rawRevision) ||
          !Number.isSafeInteger(revision) ||
          revision < 0
        )
          throw new Error("400: If-Match settings revision is required");
        return Response.json(
          await coordinator.saveSettings(
            value.roles as AgentSettings["roles"],
            revision,
            identity,
          ),
        );
      }
      if (path === "/settings/models" && request.method === "GET")
        return Response.json(await coordinator.modelCatalog((url.searchParams.get("route")??"go") as "go"|"console",url.searchParams.get("refresh")==="1"),{headers:{"Cache-Control":"no-store"}});
      const run = path.match(
        /^\/runs\/([A-Za-z0-9._-]+)\/(jobs|workflow-events|cancel)$/,
      );
      if (run) {
        const id = run[1]!,
          action = run[2]!;
        if (request.method === "GET") {
          try {
            if (action === "jobs")
              return Response.json(await coordinator.getRun(id));
            if (action === "workflow-events")
              return await coordinator.stream(id, request);
          } catch (error) {
            if (!String(error).includes("404:")) throw error;
            const archived = await history.getRun(id);
            if (action === "jobs") return Response.json(archived);
            return new Response(
              url.searchParams.get("protocol") === "2" ? "event: done\ndata: {}\n\n" : "event: end\ndata: {}\n\n",
              {
                headers: {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-store",
                },
              },
            );
          }
        }
        if (action === "cancel" && request.method === "POST")
          return Response.json(await coordinator.cancelRun(id));
      }
      const remoteReceipt = path.match(
        /^\/jobs\/([A-Za-z0-9._-]+)\/remote-receipts(?:\/([^/]+)\/(reconcile))?$/,
      );
      const apiReceipt=path.match(/^\/jobs\/([A-Za-z0-9._-]+)\/api-receipts\/([^/]+)\/reconcile$/);
      if(apiReceipt&&request.method==="POST"){
        const attempt=env.ATTEMPTS.getByName(apiReceipt[1]!);
        const result=await attempt.reconcileAPIReceipt(decodeURIComponent(apiReceipt[2]!),await body(request) as {reference:string;outcome:"completed"|"not-executed";confirm:string});
        await coordinator.reconcileToolOutcome(apiReceipt[1]!);return Response.json(result);
      }
      if (remoteReceipt) {
        const id = remoteReceipt[1]!,
          attempt = env.ATTEMPTS.getByName(id);
        if (!remoteReceipt[2] && request.method === "GET")
          return Response.json(await attempt.remoteReceipts());
        if (remoteReceipt[2] && request.method === "POST") {
          let receiptId: string;
          try {
            receiptId = decodeURIComponent(remoteReceipt[2]);
          } catch {
            throw new Error("400: invalid remote receipt identifier");
          }
          if (!/^[A-Za-z0-9._~-]{1,300}$/.test(receiptId))
            throw new Error("400: invalid remote receipt identifier");
          const value = await body(request);
          if (
            typeof value.inspectionTool !== "string" ||
            typeof value.scanId !== "string"
          )
            throw new Error("400: inspectionTool and scanId must be strings");
          const proof = {
            inspectionTool: value.inspectionTool,
            scanId: value.scanId,
            ...(value.identityEvidence === undefined
              ? {}
              : { identityEvidence: value.identityEvidence }),
          } as Parameters<typeof attempt.reconcileRemote>[1];
          const result: unknown = await attempt.reconcileRemote(
            receiptId,
            proof,
          );
          if (
            !result ||
            typeof result !== "object" ||
            !("reconciled" in result) ||
            result.reconciled !== true
          )
            throw new Error("409: remote outcome remains unresolved");
          await coordinator.reconcileToolOutcome(id);
          return Response.json(result);
        }
      }
      const remoteControl = path.match(
        /^\/jobs\/([A-Za-z0-9._-]+)\/remote-control$/,
      );
      if (remoteControl && request.method === "POST") {
        const value = await body(request);
        if (
          typeof value.tool !== "string" ||
          !value.tool.trim() ||
          !value.args ||
          typeof value.args !== "object" ||
          Array.isArray(value.args) ||
          typeof value.request_id !== "string" ||
          !value.request_id.trim()
        )
          throw new Error(
            "400: tool, args object, and request_id are required",
          );
        const id = remoteControl[1]!;
        const result: unknown = await env.ATTEMPTS.getByName(id).controlRemote(
          value.tool,
          value.args as Record<string, unknown>,
          value.request_id,
        );
        if (
          !result ||
          typeof result !== "object" ||
          !("controlled" in result) ||
          result.controlled !== true ||
          !("verified" in result) ||
          typeof result.verified !== "boolean"
        )
          throw new Error("409: remote control outcome remains unresolved");
        if (result.verified) await coordinator.reconcileToolOutcome(id);
        return Response.json(result, { status: result.verified ? 200 : 202 });
      }
      const remoteInspect = path.match(
        /^\/jobs\/([A-Za-z0-9._-]+)\/remote-inspect$/,
      );
      if (remoteInspect && request.method === "POST") {
        const value = await body(request);
        if (
          typeof value.tool !== "string" ||
          !value.args ||
          typeof value.args !== "object" ||
          Array.isArray(value.args)
        )
          throw new Error("400: tool and args object are required");
        return Response.json(
          await env.ATTEMPTS.getByName(remoteInspect[1]!).inspectRemote(
            value.tool,
            value.args as Record<string, unknown>,
          ),
        );
      }
      const browserView = path.match(/^\/jobs\/([A-Za-z0-9._-]+)\/browser-live-view$/);
      if (browserView) {
        if (request.method !== "POST") return new Response("Not found", {status: 404, headers: browserViewHeaders});
        return Response.json(await env.ATTEMPTS.getByName(browserView[1]!).browserLiveView(), {headers: browserViewHeaders});
      }
      const controls = path.match(/^\/jobs\/([A-Za-z0-9._-]+)\/session-controls$/);
      if (controls && request.method === "GET")
        return Response.json(await env.ATTEMPTS.getByName(controls[1]!).sessionControls(), {headers: {"Cache-Control": "no-store"}});
      const nativeReply = path.match(/^\/jobs\/([A-Za-z0-9._-]+)\/(forms|permissions)\/([A-Za-z0-9._~-]{1,255})\/(reply|cancel)$/);
      if (nativeReply && request.method === "POST" && !(nativeReply[2] === "permissions" && nativeReply[4] === "cancel")) {
        const input = await body(request);
        return Response.json(await env.ATTEMPTS.getByName(nativeReply[1]!).replyNative(
          nativeReply[2] === "forms" ? "form" : "permission",
          nativeReply[3]!, input, nativeReply[4] === "cancel",
        ), {headers: {"Cache-Control": "no-store"}});
      }
      const job = path.match(
        /^\/jobs\/([A-Za-z0-9._-]+)\/(events|inspect|steer|revisions|interrupt)$/,
      );
      if (job) {
        const id = job[1]!,
          action = job[2]!;
        if (action === "events" && request.method === "GET") {
          let response: Response;
          try {
            response = await env.ATTEMPTS.getByName(id).events(request);
          } catch (error) {
            if (
              !/not initialized|not found|404|uninitialized/i.test(
                String(error),
              )
            )
              throw error;
            return await history.events(id);
          }
          if (response.status === 404) {
            await response.body?.cancel();
            return await history.events(id);
          }
          return response;
        }
        if (action === "inspect" && request.method === "GET")
          return Response.json(await env.ATTEMPTS.getByName(id).inspect());
        if (request.method === "POST") {
          if (action === "interrupt")
            return Response.json(await coordinator.interrupt(id));
          if (action === "steer" || action === "revisions") {
            const value = await body(request);
            if (action === "steer") {
              if (typeof value.message !== "string")
                throw new Error("400: steering message must be a string");
              return Response.json(await coordinator.steer(id, value.message));
            }
            if (
              typeof value.instructions !== "string" ||
              typeof value.request_id !== "string"
            )
              throw new Error(
                "400: revision instructions and request identity must be strings",
              );
            return Response.json(
              value.upload_ids === undefined
                ? await coordinator.revise(id, value.instructions, value.request_id)
                : await coordinator.revise(id, value.instructions, value.request_id, undefined, normalizeUploadIds(value.upload_ids)),
              { status: 202 },
            );
          }
        }
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      const response = errorResponse(error, env);
      if (/^\/v1(?:\/ui)?\/jobs\/[A-Za-z0-9._-]+\/browser-live-view$/.test(url.pathname))
        for (const [name, value] of Object.entries(browserViewHeaders)) response.headers.set(name, value);
      return response;
    }
  },
} satisfies ExportedHandler<NativeEnv>;

/** A native Artifacts event is a reconciliation hint, never result authorization. */
export class ResultValidation extends WorkflowEntrypoint<NativeEnv> {
  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const record = (value: unknown): value is Record<string, unknown> =>
      value !== null && typeof value === "object" && !Array.isArray(value);
    const data = event.payload;
    if (!record(data) || !record(data.source) || !record(data.payload))
      return { ignored: true };
    const source = data.source,
      payload = data.payload;
    if (
      data.type !== "cf.artifacts.repo.pushed" ||
      (source.type !== undefined && source.type !== "artifacts.repo") ||
      source.namespace !== this.env.ARTIFACTS_NAMESPACE ||
      typeof source.repoName !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(source.repoName) ||
      typeof payload.ref !== "string" ||
      !/^refs\/heads\/attempts\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(
        payload.ref,
      ) ||
      typeof payload.after !== "string" ||
      !/^[a-f0-9]{40}$/.test(payload.after)
    )
      return { ignored: true };
    const repoName = source.repoName,
      ref = payload.ref,
      after = payload.after;
    const coordinator = this.env.COORDINATOR.getByName("global");
    return step.do("validate committed result", async () => ({
      result: JSON.stringify(await coordinator.reconcile(repoName, ref, after)),
    }));
  }
}
