import { WorkerEntrypoint } from "cloudflare:workers";
import { readTargetSecret } from "../../../../shared/target-access";
import type { NativeEnv } from "./types";

/** Keeps existing target secrets on the edge Worker during the DO transfer. */
export class TargetSecretBroker extends WorkerEntrypoint<NativeEnv> {
  async read(name: string): Promise<string> {
    return readTargetSecret(this.env, name);
  }
}
