import { it, expect } from "vite-plus/test";
import {
  modelSecretMetadata,
  readModelSecret
} from "../src/native/model-secrets";
it("reads native Worker and Secrets Store bindings without persisting values", async () => {
  let reads = 0;
  const env = {
    OPENCODE_GO_API_KEY: "worker-secret",
    OPENCODE_API_KEY: {
      get: async () => {
        reads++;
        return "store-secret";
      }
    }
  };
  const metadata = modelSecretMetadata(env);
  expect(reads).toBe(0);
  expect(JSON.stringify(metadata)).not.toMatch(/worker-secret|store-secret/);
  expect(metadata.map((m) => m.id)).toEqual(["bound-go", "bound-console"]);
  expect(await readModelSecret(env, "bound-go")).toBe("worker-secret");
  expect(await readModelSecret(env, "bound-console")).toBe("store-secret");
  expect(reads).toBe(1);
  await expect(readModelSecret(env, "other")).rejects.toThrow(/Cloudflare/);
  await expect(
    readModelSecret(
      {
        OPENCODE_API_KEY: {
          get: async () => {
            throw new Error("private-body");
          }
        }
      },
      "bound-console"
    )
  ).rejects.toThrow("Cloudflare OpenCode secret binding unavailable");
});
