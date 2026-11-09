import { body, browserViewHeaders, type RouteContext } from "./routes/context";
import { routeToolbox } from "./routes/toolbox";
import { routeOnboarding } from "./routes/onboarding";
import { routeLifecycle } from "./routes/lifecycle";
import { routeMaterials } from "./routes/materials";
import { routeRecovery } from "./routes/recovery";
import { routeAdministration } from "./routes/administration";
import {
  routeRunEvents,
  routeSessionControls,
  routeConversation
} from "./routes/conversations";
import {
  routeRemoteReceipts,
  routeRemoteControl,
  routeRemoteInspection
} from "./routes/remote";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { NativeEnv } from "./types";

import { LegacyHistory } from "./history";
import { knownRuntimeSecrets } from "../../../../shared/runtime-secrets";

import { hostedUIResponse } from "./ui-response";
import { readVerificationEmail } from "./verification-email";
import { agentMcp } from "./agent-mcp";
import {
  configureSetupAccess,
  prepareSetupStorage,
  saveSetupKey,
  setupStatus
} from "./setup";

const jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export async function actor(request: Request, env: NativeEnv): Promise<string> {
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
      requiredClaims: ["exp"]
    });
    return typeof payload.email === "string" ? payload.email : "access-service";
  } catch {
    throw new Error("403: Invalid Cloudflare Access identity");
  }
}

function errorResponse(error: unknown, env: NativeEnv) {
  let message = error instanceof Error ? error.message : String(error);
  const status = Number(
    message.match(/\b(400|401|403|404|409|410|413|429|503):/)?.[1] ?? 500
  );
  for (const secret of [...knownRuntimeSecrets(env), env.OPENCODE_GO_API_KEY])
    if (secret) message = message.split(secret).join("[redacted]");
  return Response.json({ error: message.slice(0, 1500) }, { status });
}

const worker = {
  async email(message: ForwardableEmailMessage, env: NativeEnv) {
    if (!env.PENTCLOUD_VERIFICATION_EMAIL || message.rawSize > 256 * 1024) {
      message.setReject("Verification email is unavailable");
      return;
    }
    const delivery = await readVerificationEmail({
      to: message.to,
      headers: message.headers,
      raw: message.raw
    });
    if (delivery)
      await env.COORDINATOR.getByName("global").receiveVerificationEmail(
        delivery
      );
  },
  async fetch(request: Request, env: NativeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname === "/v1/ui/setup/access" &&
      request.method === "POST" &&
      !env.ACCESS_TEAM_DOMAIN &&
      !env.ACCESS_AUD
    ) {
      try {
        const origin = request.headers.get("Origin");
        if (
          (origin && origin !== url.origin) ||
          request.headers.get("Sec-Fetch-Site") === "cross-site"
        )
          throw Error("403: Use this application’s origin.");
        await configureSetupAccess(
          env,
          await body(request, 16384),
          request.url
        );
        return Response.json(
          { configured: true },
          { headers: browserViewHeaders }
        );
      } catch (error) {
        return errorResponse(error, env);
      }
    }
    if (
      url.pathname === "/v1/ui/setup" &&
      request.method === "GET" &&
      (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD)
    )
      return Response.json(
        {
          schemaVersion: 1,
          access: false,
          accountId: Reflect.get(env, "PENTCLOUD_ACCOUNT_ID"),
          worker: Reflect.get(env, "PENTCLOUD_WORKER_NAME"),
          missing: ["Cloudflare Access"],
          storage: false,
          models: false,
          ready: false
        },
        { headers: browserViewHeaders }
      );
    if (url.pathname === "/health")
      return Response.json({
        application: "PentCloud",
        runtime: "Cloudflare OpenCode V2",
        concurrency: 1,
        maxOutstanding: 3,
        timeoutSeconds: null,
        goConfigured: !!env.OPENCODE_GO_API_KEY,
        storage: "DO SQLite and Artifacts"
      });
    try {
      if (
        !url.pathname.startsWith("/v1/") &&
        !url.pathname.startsWith("/agents/") &&
        url.pathname !== "/mcp"
      )
        return env.ASSETS
          ? hostedUIResponse(await env.ASSETS.fetch(request), request.url)
          : new Response("PentCloud", { status: 200 });
      const identity = await actor(request, env);
      // Access authenticates cookies at the edge. Do not let a foreign page
      // spend that identity on mutations or an authenticated WebSocket.
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method) ||
        request.headers.get("Upgrade")?.toLowerCase() === "websocket"
      ) {
        const origin = request.headers.get("Origin");
        if (
          (origin && origin !== url.origin) ||
          request.headers.get("Sec-Fetch-Site") === "cross-site"
        )
          throw new Error(
            "403: Use this application's origin for browser actions"
          );
      }
      if (url.pathname === "/mcp")
        return await agentMcp(request, env, identity, (next, bindings) =>
          worker.fetch(next, bindings)
        );
      if (
        url.pathname === "/v1/ui/agent-connection" &&
        request.method === "GET"
      )
        return Response.json(
          {
            endpoint: url.origin + "/mcp",
            browser: !!env.AGENT_BROWSERS,
            authentication: "cloudflare-access-managed-oauth"
          },
          { headers: browserViewHeaders }
        );
      if (url.pathname === "/v1/ui/setup" && request.method === "GET")
        return Response.json(await setupStatus(env), {
          headers: browserViewHeaders
        });
      if (
        url.pathname === "/v1/ui/setup/storage" &&
        request.method === "POST"
      ) {
        await body(request, 64);
        await prepareSetupStorage(env);
        return Response.json(
          { prepared: true },
          { headers: browserViewHeaders }
        );
      }
      if (url.pathname === "/v1/ui/setup/model" && request.method === "POST") {
        await saveSetupKey(env, await body(request, 16384));
        return Response.json({ saved: true }, { headers: browserViewHeaders });
      }
      const coordinator = env.COORDINATOR.getByName("global");
      const history = new LegacyHistory(env);
      if (url.pathname.startsWith("/agents/")) {
        if (url.pathname !== "/agents/coordinator/global")
          return new Response("Not found", { status: 404 });
        return await coordinator.fetch(request);
      }
      const path = url.pathname.replace(/^\/v1(?:\/ui)?/, "");
      const context: RouteContext = {
        request,
        url,
        path,
        env,
        coordinator,
        history,
        identity
      };
      for (const route of [routeToolbox, routeOnboarding, routeLifecycle]) {
        const response = await route(context);
        if (response) return response;
      }
      const jobAccess = path.match(/^\/jobs\/([A-Za-z0-9._-]+)\//);
      if (jobAccess) {
        // Remote receipt reconciliation remains available in Trash until drain;
        // all execution/content routes reject purged jobs before opening a session.
        const safety =
          /\/(?:remote-receipts|remote-control|remote-inspect|api-receipts)(?:\/|$)/.test(
            path
          );
        try {
          const access = await coordinator.assertJobAvailable(
            jobAccess[1]!,
            request.method !== "GET" && !safety && !path.endsWith("/interrupt")
          );
          if (
            access.executionKind === "discovery" &&
            /\/(events|inspect|steer|revisions|session-controls|browser-live-view|forms|permissions)(?:\/|$)/.test(
              path
            )
          )
            throw new Error(
              "409: Discovery has no model session; use run progress and accepted files"
            );
        } catch (error) {
          if (!String(error).includes("404:") || !path.endsWith("/events"))
            throw error;
        }
      }
      for (const route of [
        routeMaterials,
        routeRecovery,
        routeAdministration,
        routeRunEvents,
        routeRemoteReceipts,
        routeRemoteControl,
        routeRemoteInspection,
        routeSessionControls,
        routeConversation
      ]) {
        const response = await route(context);
        if (response) return response;
      }
      return new Response("Not found", { status: 404 });
    } catch (error) {
      const response = errorResponse(error, env);
      if (
        /^\/v1(?:\/ui)?\/jobs\/[A-Za-z0-9._-]+\/browser-live-view$/.test(
          url.pathname
        )
      )
        for (const [name, value] of Object.entries(browserViewHeaders))
          response.headers.set(name, value);
      return response;
    }
  }
} satisfies ExportedHandler<NativeEnv>;
export default worker;
