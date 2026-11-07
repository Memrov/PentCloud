import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHTTPServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { expect as browserExpect } from "playwright/test";
import { createServer, type ViteDevServer } from "vite";
import { hostedUIResponse } from "../src/native/ui-response";

// Real local React UI, mocked HTTP/SSE only. No model, scanner, Git or production traffic.
// Opt in locally; the portable native Builds unit gate does not install a browser.
describe.skipIf(process.env.PENTCLOUD_MATERIALS_BROWSER !== "1")("chat files in the browser", () => {
let server: ViteDevServer;
let browser: Browser;
let origin: string;
const COMMIT = "a".repeat(40);
const run = {id: "run-ui-files", status: "running", baselineRepo: "run-run-ui-files", inputCommit: COMMIT, maxDepth: 4, maxJobs: 48};
const active = {id: "job-ui-files", runId: run.id, role: "primary", status: "running", revision: 1, nativeSession: true, inputCommit: COMMIT, attempt: 1};
const ready = (id: string, runId: string, name: string, body: Buffer) => {
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {id, runId, name, sha256, size: body.length, mediaType: "text/plain", kind: "text", status: "ready", sourcePath: `.pentagi/materials/${sha256}/source`, textPath: `.pentagi/materials/${sha256}/source`};
};
beforeAll(async () => {
  server = await createServer({root: fileURLToPath(new URL("../", import.meta.url)), mode: "browser-fixture", server: {host: "127.0.0.1", port: 0}});
  await server.listen();
  origin = server.resolvedUrls!.local[0]!;
  browser = await chromium.launch({channel: "chrome", headless: true});
}, 30000);
afterAll(async () => { await browser?.close(); await server?.close(); });
async function fixture(existing: boolean, viewport = {width: 1440, height: 1000}, legacy = false, firstFailure: "network" | number = "network", inputError?: string, session?: {messages: unknown[]; settled?: boolean}) {
  const initialJob = inputError ? {...active, nativeSession: false, status: "invalid_result", inputError} : legacy ? {...active, nativeSession: false, status: "completed"} : session?.settled ? {...active, status: "completed", outputCommit: COMMIT} : active;
  const context = await browser.newContext({viewport, reducedMotion: "reduce"});
  let publishCoordinator: (revision: number) => void = (_revision: number) => { throw new Error("Coordinator is not connected"); };
  await context.routeWebSocket("**/agents/coordinator/global*", socket => {
    socket.send(JSON.stringify({type: "cf_agent_identity", name: "global", agent: "coordinator", stateFollows: true}));
    socket.send(JSON.stringify({type: "cf_agent_state", state: {revision: 1, runs: existing ? [run] : [], jobs: existing ? [initialJob] : []}}));
    publishCoordinator = revision => socket.send(JSON.stringify({type: "cf_agent_state", state: {revision, runs: [run, {...run, id: `run-refresh-${revision}`}], jobs: [initialJob]}}));
  });
  const page = await context.newPage();
  const calls: Array<{path: string; body: string | null; bytes: Buffer | null; headers: Record<string, string>}> = [];
  let failSubmission = true;
  let currentRun = {...run};
  let currentJob = {...initialJob};
  await page.route("**/v1/ui/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    calls.push({path, body: request.postData(), bytes: request.postDataBuffer(), headers: request.headers()});
    const json = (value: unknown) => route.fulfill({status: 200, contentType: "application/json", body: JSON.stringify(value)});
    if(path==='/v1/ui/setup')return json({schemaVersion:1,access:true,missing:[],storage:true,models:true,ready:true});
    if (path.includes("/uploads/")) {
      const id = path.split("/").at(-1)!, runId = path.split("/")[4]!;
      return json(ready(id, runId, url.searchParams.get("name")!, request.postDataBuffer()!));
    }
    if(path==="/v1/ui/onboarding")return json({targets:[{id:"target-files",kind:"website",name:"Owned target",url:"https://owned.example/",revision:1,archived:false,objective:"",exclusions:""}],credentials:[],defaults:[]});
    if(path.includes("/onboarding/pending/"))return json({});
    if(path.endsWith("/target.check"))return json({classification:"reachable",status:200});
    if (path === "/v1/ui/runs" && request.method() === "GET") return json({runs: existing ? [run] : []});
    if ((path === "/v1/ui/runs" && request.method() === "POST") || path.endsWith("/revisions")) {
      if (failSubmission) {
        failSubmission = false;
        return firstFailure === "network" ? route.abort("failed") : route.fulfill({status: firstFailure, contentType: "application/json", body: JSON.stringify({error: "Selected material set exceeds the allowed files"})});
      }
      const body = request.postDataJSON();
      if (path.endsWith("/revisions")) return json({job: {...active, id: "job-next", status: "created", revision: 1, attempt: 2, revisionOf: active.id}});
      currentRun = {...run, id: body.run_id}; currentJob = {...active, runId: body.run_id};
      return json({run: currentRun, rootJob: currentJob});
    }
    if (path.endsWith("/jobs")) return json({run: currentRun, jobs: [currentJob]});
    if (path.endsWith("/events")) return route.fulfill({status: 200, contentType: "text/event-stream", body: `event: snapshot\ndata: ${JSON.stringify({messages: session?.messages ?? [], busy: true, pending: [], job: currentJob, cursor: 1})}\n\nevent: end\ndata: {}\n\n`});
    if (path.endsWith("/session-controls")) return json({session: "ses_ui", canReply: true, forms: [], permissions: [], usage: {stats: {steps: 0, tokens: {input: 0, output: 0}, cost: 0, tools: {mode: "summary", totals: {calls: 0, failed: 0}}}, limits: null, limitsStatus: "not-connected"}});
    if (path.endsWith("/files")) return json({runId: run.id, commit: COMMIT, files: [{path: "evidence/source.html", name: "source.html", size: 40, mediaType: "text/html", kind: "output", commit: COMMIT, previewable: true}]});
    if (path.endsWith("/file") && url.searchParams.get("preview") === "1") return route.fulfill({status: 200, contentType: "text/plain; charset=utf-8", headers: {"X-Content-Truncated": "1"}, body: "<script>window.fileExecuted = true</script>"});
    return route.fulfill({status: 404, contentType: "application/json", body: JSON.stringify({error: `Unhandled UI fixture ${path}`})});
  });
  return {context, page, calls, publishCoordinator: (revision: number) => publishCoordinator(revision)};
}

it.each([1440,390])("keeps production chat private at %i px while retaining screenshots, live projections and explicit external navigation", async (width) => {
  // Serve the actual production browser bundle with the same policy as the Worker.
  const production = createHTTPServer(async (request, response) => {
    try {
      const path = new URL(request.url!, "http://127.0.0.1").pathname;
      const file = path.startsWith("/assets/") || path === "/theme.js" ? path : "/index.html";
      const bytes = await readFile(new URL(`../dist/client${file}`, import.meta.url));
      const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html";
      const reply = hostedUIResponse(new Response(new Uint8Array(bytes), {headers:{"Content-Type":type}}), `http://${request.headers.host}${request.url}`);
      const headers:Record<string,string>={};reply.headers.forEach((v,k)=>{headers[k]=v;});
      response.writeHead(reply.status,headers);response.end(Buffer.from(await reply.arrayBuffer()));
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise<void>(resolve=>production.listen(0,"127.0.0.1",resolve));
  const address=production.address(); if(!address||typeof address==="string")throw Error("No production fixture port");
  const site=`http://127.0.0.1:${address.port}`;
  const pixel="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==";
  const markdown='**Finding**\n\n![tracking](https://target.invalid/pixel)\n\n<img src="https://target.invalid/html">\n<iframe src="https://target.invalid/frame"></iframe>\n\n[Inspect target](https://target.invalid/page)';
  const messages=[{id:"privacy",type:"assistant",content:[{type:"text",text:markdown},{type:"reasoning",text:"![reasoning tracker](https://target.invalid/reasoning)"},{id:"shot",type:"tool",name:"cloudflare_browser",state:{status:"completed",input:{},content:[],metadata:{cloudflareImages:[pixel]}}}]}];
  const {context,page,publishCoordinator}=await fixture(true,{width,height:1000},false,"network",undefined,{messages});
  const foreign:string[]=[];
  await context.route("**/*",route=>{if(new URL(route.request().url()).origin!==site){foreign.push(route.request().url());return route.abort();}return route.continue();});
  await page.addInitScript(()=>{(window as any).privacyViolations=[];document.addEventListener("securitypolicyviolation",event=>(window as any).privacyViolations.push(event.effectiveDirective));});
  try {
    const reply=await page.goto(`${site}?run=${run.id}&job=${active.id}`);
    expect(reply?.headers()["content-security-policy"]).toContain(`connect-src 'self' ws://127.0.0.1:${address.port}`);
    await browserExpect(page.getByRole("heading",{name:"Primary",exact:true})).toBeVisible();
    await browserExpect(page.getByText("Finding",{exact:true})).toBeVisible();
    await page.getByRole("button",{name:/Activity/}).click();
    await page.getByRole("button",{name:/cloudflare browser/}).click();
    await page.getByRole("button",{name:/Reasoning/}).click();
    await browserExpect(page.getByAltText("Cloudflare browser screenshot")).toBeVisible();
    await browserExpect.poll(()=>page.getByAltText("Cloudflare browser screenshot").evaluate((img:HTMLImageElement)=>img.naturalWidth)).toBe(1);
    expect(await page.locator("iframe,video,object,embed,link[rel=preload]").count()).toBe(0);
    expect(foreign).toEqual([]);
    expect(await page.evaluate(()=>(window as any).privacyViolations)).toEqual([]);
    publishCoordinator(2);await browserExpect(page.locator('.run-row').filter({hasText:"refresh-"})).toBeVisible();
    await page.getByRole("button",{name:"Inspect target",exact:true}).click();
    await browserExpect(page.getByRole("dialog")).toContainText("website can see your IP address");
    expect(foreign).toEqual([]);
    await page.getByRole("button",{name:"Stay in PentCloud"}).click();
    await page.evaluate(()=>{const img=document.createElement("img");img.src="https://target.invalid/csp-probe";document.body.appendChild(img);});
    await browserExpect.poll(()=>page.evaluate(()=>(window as any).privacyViolations)).toContain("img-src");
    expect(foreign).toEqual([]);
  } finally {await context.close();await new Promise<void>((resolve,reject)=>production.close(error=>error?reject(error):resolve()));}
},30000);

it("keeps file/history inspection in place across repeated projections and follows new messages only at the bottom", async () => {
  const history = Array.from({length: 35}, (_, index) => ({id: `history-${index}`, type: "user", text: `Historical investigation detail ${index}.\n\n${"Evidence and scope details. ".repeat(12)}`}));
  // Settled inference fences are reconciled against each identical Coordinator job projection.
  const messages = [...history, {id: "settled-fence", type: "idle", outcome: "failed", error: "Attempt has settled"}];
  const {context, page, publishCoordinator} = await fixture(true, {width: 1440, height: 900}, false, "network", undefined, {messages, settled: true});
  try {
    await page.addInitScript(() => {
      const NativeEventSource = window.EventSource;
      (window as any).sessionSources = [];
      window.EventSource = class extends NativeEventSource {
        constructor(url: string | URL, options?: EventSourceInit) { super(url, options); (window as any).sessionSources.push(this); }
      };
    });
    await page.goto(`${origin}?run=${run.id}&job=${active.id}`);
    const scroll = page.locator(".message-scroll");
    const bottomGap = () => scroll.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop);
    await browserExpect(page.locator(".message-row")).toHaveCount(35);
    await browserExpect.poll(bottomGap).toBeLessThan(2);
    await page.getByRole("button", {name: "Files", exact: true}).click();
    await page.getByRole("button", {name: "Preview", exact: true}).click();
    const preview = page.locator(".material-preview pre");
    await browserExpect(preview).toBeInViewport();
    const inspectionTop = await scroll.evaluate(element => element.scrollTop);
    publishCoordinator(2);
    await browserExpect(page.locator('.run-row').filter({hasText:"refresh-"})).toBeVisible();
    await browserExpect(preview).toBeInViewport();
    expect(Math.abs(await scroll.evaluate(element => element.scrollTop) - inspectionTop)).toBeLessThan(2);

    const append = async (text: string, cursor: number) => page.evaluate(({messages, text, cursor}) => {
      (window as any).sessionSources.at(-1).dispatchEvent(new MessageEvent("snapshot", {data: JSON.stringify({messages: [...messages, {id: `new-${cursor}`, type: "user", text}], pending: [], busy: false, cursor})}));
    }, {messages, text, cursor});
    await append("New message while inspecting history", 2);
    await browserExpect(page.getByText("New message while inspecting history", {exact: true})).toHaveCount(1);
    await browserExpect(preview).toBeInViewport();
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event("scroll")); });
    await append(`Latest message while following the conversation.\n\n${"Additional live investigation detail. ".repeat(120)}`, 3);
    await browserExpect(page.locator(".message-row").last()).toContainText("Latest message while following the conversation");
    await browserExpect.poll(bottomGap).toBeLessThan(2);
  } finally { await context.close(); }
}, 30000);

it("keeps the new-run/upload identity and selections after a lost create reply on mobile", async () => {
  const {context, page, calls} = await fixture(false, {width: 390, height: 844});
  try {
    await page.goto(origin);
    await page.getByRole("button",{name:/Owned target/}).click();
    await page.getByRole("checkbox",{name:/I own this project/}).check();
    await browserExpect(page.getByRole("button", {name: "Attach files"})).toBeVisible({timeout: 3000});
    await page.getByLabel("Run objective").fill("Review the attached source",{timeout:5000});
    await page.getByLabel("Choose chat files").setInputFiles({name: "source.ts", mimeType: "text/plain", buffer: Buffer.from("hello\n")});
    await browserExpect(page.getByText("Staged for next input", {exact: false})).toBeVisible().catch(async error => { throw new Error(`${error.message}\n${await page.locator(".material-attachments").textContent()}\n${JSON.stringify(calls.filter(call => call.path.includes("/uploads/")))}`); });
    await page.getByRole("button", {name: "Verify address & start discovery", exact: true}).click();
    await browserExpect(page.getByRole("alert")).toBeVisible();
    await browserExpect(page.getByText("source.ts", {exact: true})).toBeVisible();
    await page.getByRole("button", {name: "Retry the same run", exact: true}).click();
    await browserExpect(page.getByRole("heading", {name: "Primary", exact: true})).toBeVisible();
    const submits = calls.filter(call => call.path === "/v1/ui/runs" && call.body);
    expect(submits).toHaveLength(2);
    expect(submits[1]?.body).toBe(submits[0]?.body);
    const input = JSON.parse(submits[0]!.body!);
    const upload = calls.find(call => call.path.includes("/uploads/"))!;
    expect(upload.path).toContain(`/runs/${input.run_id}/uploads/${input.upload_ids[0]}`);
    expect(upload.bytes?.toString()).toBe("hello\n");
    expect(upload.headers["x-content-sha256"]).toBe("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally { await context.close(); }
}, 30000);

it("queues active-chat files through a stable revision and keeps immutable previews inert", async () => {
  const {context, page, calls} = await fixture(true);
  try {
    await page.goto(`${origin}?run=${run.id}&job=${active.id}`);
    await browserExpect(page.getByRole("button", {name: "Attach files"})).toBeVisible({timeout: 3000});
    await page.getByRole("textbox", {name: /^Message /}).fill("Review this file next");
    await page.getByLabel("Choose chat files").setInputFiles({name: "review.txt", mimeType: "text/plain", buffer: Buffer.from("hello\n")});
    await browserExpect(page.getByText("Staged for next input", {exact: false})).toBeVisible().catch(async error => { throw new Error(`${error.message}\n${await page.locator(".material-attachments").textContent()}\n${JSON.stringify(calls.filter(call => call.path.includes("/uploads/")))}`); });
    await browserExpect(page.getByText("Files will queue a fresh revision", {exact: false})).toBeVisible();
    await page.getByLabel("Send message").click();
    await browserExpect(page.locator(".composer-error")).toBeVisible();
    await page.getByLabel("Send message").click();
    const revisions = calls.filter(call => call.path.endsWith("/revisions"));
    expect(revisions).toHaveLength(2);
    expect(revisions[1]?.body).toBe(revisions[0]?.body);
    expect(JSON.parse(revisions[0]!.body!).upload_ids).toHaveLength(1);
    expect(calls.some(call => call.path.endsWith("/steer") || call.path.endsWith("/interrupt") || call.path.endsWith("/cancel"))).toBe(false);
    await page.goto(`${origin}?run=${run.id}&job=${active.id}`);
    await page.getByRole("button", {name: "Files", exact: true}).click();
    await page.getByRole("button", {name: "Preview", exact: true}).click();
    await browserExpect(page.locator(".material-preview pre")).toHaveText("<script>window.fileExecuted = true</script>");
    expect(await page.evaluate(() => (window as any).fileExecuted)).toBeUndefined();
    await browserExpect(page.getByText("Preview limited to 64 KiB.", {exact: false})).toBeVisible();
    const href = await page.getByLabel("Download source.html").getAttribute("href");
    expect(new URL(href!, origin).searchParams.get("commit")).toBe(COMMIT);
    expect(new URL(href!, origin).searchParams.get("path")).toBe("evidence/source.html");
  } finally { await context.close(); }
}, 30000);


it("keeps archived chats readable without querying native file or session controls", async () => {
  const {context, page, calls} = await fixture(true, {width: 390, height: 844}, true);
  try {
    await page.goto(`${origin}?run=${run.id}&job=${active.id}`);
    await browserExpect(page.getByRole("heading", {name: "Primary", exact: true})).toBeVisible();
    expect(await page.getByRole("button", {name: "Attach files"}).count()).toBe(0);
    expect(await page.getByRole("button", {name: "Files", exact: true}).count()).toBe(0);
    expect(calls.some(call => /\/(files|session-controls)$/.test(call.path))).toBe(false);
  } finally { await context.close(); }
}, 30000);

it("adds each dropped/pasted file once, keeps ordinary text paste, and removes only the selected file", async () => {
  const {context, page, calls} = await fixture(false);
  try {
    await page.goto(origin);
    await page.getByRole("button",{name:/Owned target/}).click();
    await page.getByRole("checkbox",{name:/I own this project/}).check();
    await browserExpect(page.getByRole("button", {name: "Attach files"})).toBeVisible();
    await page.locator(".material-attachments").evaluate(element => {
      const transfer = new DataTransfer(); transfer.items.add(new File(["hello\n"], "dropped.txt", {type: "text/plain"}));
      element.dispatchEvent(new DragEvent("drop", {dataTransfer: transfer, bubbles: true, cancelable: true}));
    });
    await browserExpect(page.getByText("dropped.txt", {exact: true})).toBeVisible();
    await browserExpect(page.getByText("Staged for next input", {exact: false})).toBeVisible();
    await page.getByLabel("Run objective").evaluate(element => {
      const clipboardData = new DataTransfer(); clipboardData.items.add(new File(["hello\n"], "pasted.txt", {type: "text/plain"}));
      element.dispatchEvent(new ClipboardEvent("paste", {clipboardData, bubbles: true, cancelable: true}));
    });
    await browserExpect(page.getByText("pasted.txt", {exact: true})).toBeVisible();
    await browserExpect(page.getByText("Staged for next input", {exact: false})).toHaveCount(2);
    expect(calls.filter(call => call.path.includes("/uploads/"))).toHaveLength(2);
    const ordinaryPasteWasAllowed = await page.getByLabel("Run objective").evaluate(element => {
      const clipboardData = new DataTransfer(); clipboardData.setData("text/plain", "ordinary text");
      return element.dispatchEvent(new ClipboardEvent("paste", {clipboardData, bubbles: true, cancelable: true}));
    });
    expect(ordinaryPasteWasAllowed).toBe(true);
    await page.getByLabel("Remove dropped.txt").click();
    await browserExpect(page.getByText("dropped.txt", {exact: true})).toHaveCount(0);
    await browserExpect(page.getByText("pasted.txt", {exact: true})).toBeVisible();
  } finally { await context.close(); }
}, 30000);

it.each([{existing: false, label: "new run"}, {existing: true, label: "active revision"}])("allows correcting a $label draft after a definitive 400 rejection", async ({existing}) => {
  const {context, page, calls} = await fixture(existing, {width: 1440, height: 1000}, false, 400);
  try {
    await page.goto(existing ? `${origin}?run=${run.id}&job=${active.id}` : origin);
    if(!existing){await page.getByRole("button",{name:/Owned target/}).click();await page.getByRole("checkbox",{name:/I own this project/}).check();}
    await browserExpect(page.getByRole("button", {name: "Attach files"})).toBeVisible();
    const text = page.getByRole("textbox", {name: existing ? /^Message / : "Run objective"});
    const send = existing ? page.getByLabel("Send message") : page.getByRole("button", {name: "Verify address & start discovery", exact: true});
    await text.fill("Review original selection");
    await page.getByLabel("Choose chat files").setInputFiles([
      {name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("hello\n")},
      {name: "remove.txt", mimeType: "text/plain", buffer: Buffer.from("hello\n")},
    ]);
    await browserExpect(page.getByText("Staged for next input", {exact: false})).toHaveCount(2);
    await send.click();
    await browserExpect(page.getByText("Selected material set exceeds", {exact: false})).toBeVisible();
    await browserExpect(text).toBeEnabled();
    await browserExpect(page.getByLabel("Remove remove.txt")).toBeEnabled();
    await page.getByLabel("Remove remove.txt").click();
    await text.fill("Review corrected selection");
    await send.click();
    const submissions = calls.filter(call => existing ? call.path.endsWith("/revisions") : call.path === "/v1/ui/runs" && !!call.body);
    await browserExpect.poll(()=>calls.filter(call=>existing?call.path.endsWith("/revisions"):call.path==="/v1/ui/runs"&&!!call.body).length).toBe(2);
    const completedSubmissions=calls.filter(call=>existing?call.path.endsWith("/revisions"):call.path==="/v1/ui/runs"&&!!call.body);
    const rejected = JSON.parse(completedSubmissions[0]!.body!), corrected = JSON.parse(completedSubmissions[1]!.body!);
    expect(corrected[existing ? "instructions" : "task"]).toBe("Review corrected selection");
    expect(corrected.upload_ids).toEqual([rejected.upload_ids[0]]);
    if (existing) expect(corrected.request_id).not.toBe(rejected.request_id);
    else expect(corrected.run_id).toBe(rejected.run_id); // Existing uploaded receipts stay scoped to their stable run.
  } finally { await context.close(); }
}, 30000);

it("lets the operator explicitly edit a capacity-rejected revision without recycling its request identity", async () => {
  const {context, page, calls} = await fixture(true, {width: 1440, height: 1000}, false, 429);
  try {
    await page.goto(`${origin}?run=${run.id}&job=${active.id}`);
    await browserExpect(page.getByRole("button", {name: "Attach files"})).toBeVisible();
    await page.getByRole("textbox", {name: /^Message /}).fill("Original capacity request");
    await page.getByLabel("Choose chat files").setInputFiles({name: "review.txt", mimeType: "text/plain", buffer: Buffer.from("hello\n")});
    await browserExpect(page.getByText("Staged for next input", {exact: false})).toBeVisible();
    await page.getByLabel("Send message").click();
    await browserExpect(page.getByRole("textbox", {name: /^Message /})).toBeDisabled();
    await browserExpect(page.getByRole("button", {name: "Edit rejected draft", exact: true})).toBeVisible({timeout: 3000});
    await page.getByRole("button", {name: "Edit rejected draft", exact: true}).click();
    await page.getByRole("textbox", {name: /^Message /}).fill("Corrected capacity request");
    await page.getByLabel("Send message").click();
    const requests = calls.filter(call => call.path.endsWith("/revisions")).map(call => JSON.parse(call.body!));
    expect(requests).toHaveLength(2);
    expect(requests[1].request_id).not.toBe(requests[0].request_id);
    expect(requests[1].upload_ids).toEqual(requests[0].upload_ids);
  } finally { await context.close(); }
}, 30000);

it("shows a pre-session input rejection with a correctable composer and no native session requests", async () => {
  const {context, page, calls} = await fixture(true, {width: 390, height: 844}, false, "network", "The selected material set exceeds its admission limit");
  try {
    await page.goto(`${origin}?run=${run.id}&job=${active.id}`);
    await browserExpect(page.getByText("The selected material set exceeds its admission limit", {exact: true})).toBeVisible({timeout: 3000});
    await browserExpect(page.getByText("Input rejected before session start", {exact: true})).toBeVisible();
    await browserExpect(page.getByRole("button", {name: "Attach files", exact: true})).toBeVisible();
    await browserExpect(page.getByRole("textbox", {name: /^Message /})).toBeEnabled();
    expect(await page.getByRole("button", {name: "Files", exact: true}).count()).toBe(0);
    expect(calls.some(call => /\/(events|files|session-controls)$/.test(call.path))).toBe(false);
    expect(await page.getByText("Reconnecting", {exact: true}).count()).toBe(0);
  } finally { await context.close(); }
}, 30000);

});
