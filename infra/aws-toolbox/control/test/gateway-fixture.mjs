import { WorkerEntrypoint } from "cloudflare:workers";
import { KaliToolbox } from "../dist/worker.js";
export { default, ToolboxGateway } from "../dist/worker.js";

export class FixtureKali extends KaliToolbox {
  fixtureState = {running:true,generation:"fixture-generation",starts:0,timeouts:[],failTimeout:false};
  async fixture(options) {Object.assign(this.fixtureState,options);return this.fixtureState;}
  get container() { const target=this.env.KALI, state=this.fixtureState; return {
    get running(){return state.running;}, images:{stock:"exact-stock-fixture"},
    inspect:async()=>state.running?{labels:{"pentcloud-gen":state.generation},image:"exact-stock-fixture"}:null,
    getTcpPort:port=>{if(port!==8081)throw Error("wrong port");return target;},
    start:options=>{state.starts++;state.running=true;state.generation=options.labels["pentcloud-gen"];},
    setInactivityTimeout:async ms=>{state.timeouts.push(ms);if(state.failTimeout)throw Error("fixture native timeout unavailable");},
  }; }
}
let waiting=false;
export class Upstream extends WorkerEntrypoint {
  async fetch(request) {
    if(new URL(request.url).pathname==="/fixture/state")return Response.json({waiting});
    if(request.headers.get("x-held")){waiting=true;await new Promise(resolve=>setTimeout(resolve,1000));waiting=false;}
    if (request.method === "GET") {let timer;return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        timer=setTimeout(() => { controller.enqueue(new TextEncoder().encode("data: second\n\n")); controller.close(); }, 150); },
      cancel(){clearTimeout(timer);}
    }), { headers: { "content-type": "text/event-stream", "mcp-session-id": "session-fixture" } });}
    if (request.headers.get("x-redirect")) return new Response(null, { status: 307, headers: { location: "https://unexpected.example/" } });
    return Response.json({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
  }
}
