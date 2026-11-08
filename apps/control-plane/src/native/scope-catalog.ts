import {
  compileProgramScope,
  type ScopeProgram,
  type ProgramScope
} from "../../../../shared/target-access";
import { boundedText } from "./target-check";
interface ProgramSummary {
  id: string;
  name: string;
  platform: string;
  url: string;
  path: string;
  scope_counts: { in_scope: number; out_of_scope: number };
}
interface Manifest {
  schema_version: number;
  published_at: string;
  source: { commit: string };
  files: Record<string, string>;
}
interface Catalog {
  commit: string;
  manifest: Manifest;
  programs: ProgramSummary[];
  fetchedAt: number;
}
const repository = "Memrov/PentCloud-scopes",
  platforms = ["hackerone", "bugcrowd", "intigriti", "yeswehack"];
class UpstreamError extends Error {
  constructor(
    readonly status: number,
    url: string
  ) {
    super(
      "503: Scope catalog unavailable (" +
        new URL(url).hostname +
        " HTTP " +
        status +
        "); retry later"
    );
  }
}
function advertisedCatalog(text: string) {
  let offset = 0;
  const packet = () => {
    const prefix = text.slice(offset, offset + 4);
    if (!/^[a-f0-9]{4}$/.test(prefix)) throw new Error();
    const size = parseInt(prefix, 16);
    offset += 4;
    if (size === 0) return null;
    if (size < 4 || offset + size - 4 > text.length) throw new Error();
    const value = text.slice(offset, offset + size - 4);
    offset += size - 4;
    return value;
  };
  if (packet() !== "# service=git-upload-pack\n" || packet() !== null)
    throw new Error();
  let commit: string | undefined,
    finished = false;
  for (let count = 0; count < 4096 && offset < text.length; count++) {
    const value = packet();
    if (value === null) {
      finished = true;
      break;
    }
    const ref = value
      .split("\0")[0]!
      .trimEnd()
      .match(/^([a-f0-9]{40}) (\S+)$/);
    if (!ref) throw new Error();
    if (ref[2] === "refs/heads/catalog") {
      if (commit) throw new Error();
      commit = ref[1];
    }
  }
  if (!finished || offset !== text.length || !commit) throw new Error();
  return commit;
}
const hash = async (text: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
    )
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
/** Fixed public source only; neither platform credentials nor target requests are involved. */
export class ScopeCatalog {
  constructor(
    private readonly io: {
      get<T>(key: string): T | undefined;
      put(key: string, value: unknown): void;
      fetcher?: typeof fetch;
    }
  ) {}
  private async read(url: string) {
    const response = await (this.io.fetcher ?? fetch)(url, {
      redirect: "manual",
      headers: {
        "User-Agent": "PentCloud scope catalog",
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new UpstreamError(response.status, url);
    }
    return boundedText(response, 4 * 1024 * 1024);
  }
  private async catalog(): Promise<Catalog> {
    const prior = this.io.get<Catalog>("scope-catalog:current");
    if (prior && Date.now() - prior.fetchedAt < 900000) return prior;
    try {
      let commit: string;
      try {
        const ref = JSON.parse(
          await this.read(
            "https://api.github.com/repos/" +
              repository +
              "/git/ref/heads/catalog"
          )
        );
        if (!/^[a-f0-9]{40}$/.test(ref.object?.sha)) throw new Error();
        commit = ref.object.sha;
      } catch (error) {
        if (
          !(error instanceof UpstreamError) ||
          ![403, 429, 502, 503].includes(error.status)
        )
          throw error;
        commit = advertisedCatalog(
          await this.read(
            "https://github.com/" +
              repository +
              ".git/info/refs?service=git-upload-pack"
          )
        );
      }
      const root =
        "https://raw.githubusercontent.com/" + repository + "/" + commit + "/";
      const manifest = JSON.parse(
        await this.read(root + "manifest.json")
      ) as Manifest;
      if (
        manifest.schema_version !== 1 ||
        !manifest.files ||
        !/^[a-f0-9]{40}$/.test(manifest.source?.commit) ||
        !Number.isFinite(Date.parse(manifest.published_at)) ||
        Date.now() - Date.parse(manifest.published_at) > 72 * 3600000
      )
        throw new Error(
          "503: Scope catalog is stale; verify its refresh before importing"
        );
      const raw = await this.read(root + "index.json");
      if ((await hash(raw)) !== manifest.files["index.json"])
        throw new Error("502: Scope catalog checksum mismatch");
      const index = JSON.parse(raw);
      if (
        index.schema_version !== 1 ||
        !Array.isArray(index.programs) ||
        index.programs.length > 10000
      )
        throw new Error();
      const programs: ProgramSummary[] = index.programs;
      if (
        programs.some(
          (p) =>
            typeof p.id !== "string" ||
            p.id.length > 512 ||
            typeof p.name !== "string" ||
            !platforms.includes(p.platform) ||
            !new RegExp(
              "^programs/" + p.platform + "/[a-f0-9]{64}\\.json$"
            ).test(p.path) ||
            !/^[a-f0-9]{64}$/.test(manifest.files[p.path] ?? "")
        )
      )
        throw new Error();
      const value = { commit, manifest, programs, fetchedAt: Date.now() };
      this.io.put("scope-catalog:current", value);
      return value;
    } catch (error) {
      if (error instanceof Error && /^50[23]:/.test(error.message)) throw error;
      throw new Error("502: Invalid public scope catalog");
    }
  }
  async search(
    query: string,
    platform?: string,
    allowedPlatforms?: readonly string[]
  ) {
    if (
      typeof query !== "string" ||
      query.length > 160 ||
      (platform && !platforms.includes(platform))
    )
      throw new Error("400: Invalid program search");
    const catalog = await this.catalog(),
      needle = query.trim().toLowerCase(),
      matches = catalog.programs.filter(
        (p) =>
          (!allowedPlatforms || allowedPlatforms.includes(p.platform)) &&
          (!platform || p.platform === platform) &&
          (!needle || (p.name + " " + p.id).toLowerCase().includes(needle))
      );
    return {
      catalogCommit: catalog.commit,
      publishedAt: catalog.manifest.published_at,
      total: matches.length,
      programs: matches.slice(0, 50).map(({ path: _path, ...p }) => p)
    };
  }
  async names() {
    const catalog = await this.catalog();
    return {
      programs: catalog.programs
        .map(({ id, name, platform }) => ({ id, name, platform }))
        .sort((a, b) => a.name.localeCompare(b.name))
    };
  }
  private async program(id: string) {
    const catalog = await this.catalog(),
      row = catalog.programs.find((p) => p.id === id);
    if (!row)
      throw new Error("404: Program not found; search the catalog first");
    const raw = await this.read(
        "https://raw.githubusercontent.com/" +
          repository +
          "/" +
          catalog.commit +
          "/" +
          row.path
      ),
      sha256 = await hash(raw);
    if (sha256 !== catalog.manifest.files[row.path])
      throw new Error("502: Program scope checksum mismatch");
    const program = JSON.parse(raw) as ScopeProgram & {
      schema_version: number;
      source_status?: { value: unknown };
    };
    if (
      program.schema_version !== 1 ||
      program.id !== row.id ||
      program.platform !== row.platform
    )
      throw new Error("502: Program identity mismatch");
    const status = String(program.source_status?.value ?? "").toLowerCase();
    if (["closed", "paused", "disabled", "inactive"].includes(status))
      throw new Error("409: Program is not accepting assessments");
    return {
      program,
      source: {
        catalogCommit: catalog.commit,
        sourceCommit: catalog.manifest.source.commit,
        sha256,
        publishedAt: catalog.manifest.published_at
      }
    };
  }
  async preview(id: string) {
    const { program, source } = await this.program(id);
    if (!Array.isArray(program.targets?.in_scope))
      throw new Error("502: Invalid program assets");
    const types = new Set([
      "url",
      "wildcard",
      "website",
      "web-application",
      "api",
      "domain"
    ]);
    return {
      program: {
        id: program.id,
        name: program.name,
        platform: program.platform,
        url: program.url
      },
      ...source,
      assets: program.targets.in_scope
        .filter(
          (asset) =>
            types.has(asset.type?.toLowerCase()) &&
            asset.eligible_for_submission !== false
        )
        .slice(0, 500)
        .map(({ value, type }) => ({ value, type })),
      assetCount: program.targets.in_scope.length,
      exclusionCount: program.targets.out_of_scope?.length ?? 0
    };
  }
  async import(id: string, targetURL: string): Promise<ProgramScope> {
    const { program, source } = await this.program(id);
    return compileProgramScope(program, source, targetURL);
  }
}
