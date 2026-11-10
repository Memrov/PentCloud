import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import {
  ContainerBackend,
  withWorkspaceContainer
} from "@cloudflare/computer/backends/container";

export { WorkspaceProxy } from "@cloudflare/computer";

interface SmokeEnv {
  COMPUTER: DurableObjectNamespace<ComputerSmoke>;
}

class ContainerBase extends DurableObject<SmokeEnv> {}

export class ComputerSmoke extends withWorkspaceContainer(ContainerBase) {
  private readonly backend = new ContainerBackend({
    container: () => this,
    workspace: { binding: "COMPUTER", id: this.ctx.id.toString() },
    id: "native-container",
    name: "computer",
    instance: "standard-2",
    egress: { mode: "direct" }
  });
  private readonly workspace = new Workspace({
    storage: this.ctx.storage,
    backends: [this.backend]
  });

  async smoke(): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    returned: string | null;
  }> {
    const path = "/workspace/fixture/marker.txt";
    await this.workspace.fs.mkdir("/workspace/fixture", { recursive: true });
    await this.workspace.fs.writeFile(path, "pentcloud-container-marker\n");
    const run = await this.workspace.runtime.exec(
      "pwd && node --version && rg pentcloud-container-marker marker.txt && printf from-container > returned.txt && test -d /tmp",
      {
        backend: "native-container",
        cwd: "/workspace/fixture",
        encoding: "utf8"
      }
    );
    try {
      const result = await run.result();
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        returned:
          result.exitCode === 0
            ? await this.workspace.fs.readFile(
                "/workspace/fixture/returned.txt",
                {
                  encoding: "utf8"
                }
              )
            : null
      };
    } finally {
      run[Symbol.dispose]();
    }
  }

  override fetch(request: Request) {
    return this.backend.handleFetch(request);
  }
}

export default {
  async fetch(_request: Request, env: SmokeEnv) {
    const result = await env.COMPUTER.getByName("owned-fixture").smoke();
    return Response.json(result, { status: result.exitCode === 0 ? 200 : 500 });
  }
};
