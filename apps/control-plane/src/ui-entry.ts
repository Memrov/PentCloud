import { DurableObject } from "cloudflare:workers";
export { default } from "./native/worker";
export { OpenCodeConnectionTest } from "./native/model-test";
export { AgentBrowser } from "./native/agent-browser";
export { TargetSecretBroker } from "./native/target-secret-broker";

// Historical proof storage remains readable after the active objects move.
export class ProofQueue extends DurableObject {
  override async alarm() {
    await this.ctx.storage.deleteAlarm();
  }
}
export class ProofAttempt extends DurableObject {
  override async alarm() {
    await this.ctx.storage.deleteAlarm();
  }
}
