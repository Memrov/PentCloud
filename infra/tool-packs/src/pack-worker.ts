import { WorkerEntrypoint } from "cloudflare:workers";
import { prepareFiles } from "@memrov2/pentcloud-tool-runtime";
import {
  assertPackAccess,
  packFileNames,
  type ToolPack,
  type ToolPackRequest,
  type ToolPackScope
} from "../../../shared/tool-packs";

export interface PackWorkerService {
  ready(scope: ToolPackScope): Promise<unknown>;
  stop(scope: ToolPackScope): Promise<{ stopped: boolean }>;
  run(
    scope: ToolPackScope,
    input: ToolPackRequest,
    files: Record<string, Uint8Array>
  ): Promise<unknown>;
}

export interface PackRunner {
  ready(): Promise<unknown>;
  retire(): Promise<{ stopped: boolean }>;
}

type PackEnv = { RUNNER: DurableObjectNamespace };

export function packWorker<R extends PackRunner>(
  pack: ToolPack,
  validate: (request: Record<string, unknown>) => unknown,
  execute: (
    runner: R,
    request: Record<string, unknown>,
    files: Record<string, Uint8Array>
  ) => Promise<unknown>
) {
  return class extends WorkerEntrypoint<PackEnv> implements PackWorkerService {
    private runner(scope: ToolPackScope): R {
      assertPackAccess(scope, pack);
      return this.env.RUNNER.getByName(
        `${scope.runId}:${scope.attemptId}`
      ) as unknown as R;
    }

    async ready(scope: ToolPackScope) {
      return this.runner(scope).ready();
    }

    async stop(scope: ToolPackScope) {
      return this.runner(scope).retire();
    }

    async run(
      scope: ToolPackScope,
      input: ToolPackRequest,
      files: Record<string, Uint8Array>
    ) {
      assertPackAccess(scope, pack, input?.request);
      if (input.pack !== pack) throw Error("Tool pack binding mismatch");
      try {
        const required = packFileNames(input);
        await prepareFiles(required, files);
        validate(input.request);
      } catch (error) {
        return {
          rejected: true,
          notExecuted: true,
          error: error instanceof Error ? error.message : "Invalid tool input"
        };
      }
      return execute(this.runner(scope), input.request, files);
    }
  };
}
