import { specialistSources } from "../native/specialist-sources";
import { DEFAULT_SEARCH_PROVIDER, isSearchProvider, type SearchProvider } from "../../../../shared/search-providers";

export const ACTIVE_ROLES = ["primary", "adviser", "coder", "maintenance", "memorist", "pentester", "searcher"] as const;
export type ActiveRole = typeof ACTIVE_ROLES[number];

export const REASONING_EFFORTS = ["default", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export interface RoleSettings {
  /** Historical settings without a selection use TinyFish. */
  searchProvider?: SearchProvider;
  /** Missing on historical settings: retain the original format when reading; new saves require Markdown. */
  promptFormat?: "markdown" | "pentagi-template";
  promptTemplate: string;
  upstreamPromptDigest: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

export interface AgentSettings {
  schemaVersion: 1;
  revision: string;
  upstreamManifestDigest: string;
  savedAt: string;
  savedBy: string;
  roles: Record<ActiveRole, RoleSettings>;
}

const UPSTREAM_MANIFEST_DIGEST = "fe64d11a7a9ad76f9c9664ad7066b059dbfa51e4950999688470680d3801720a";

const sources: Record<ActiveRole, { upstreamPromptDigest: string }> = {
  primary: { upstreamPromptDigest: "f000f4706042efb07663c07cc5ff8943eed498c62b012911277d9a5a5521e2dc" },
  adviser: { upstreamPromptDigest: "d36cfb5193e0667e9a3dfc71d77534047fdc190e58f7bfd7218c55e67de35c3f" },
  coder: { upstreamPromptDigest: "20d2920d8b860b723d58da160bf9b63bf317d59dfa5b6a7d3453dc22c6a48807" },
  maintenance: { upstreamPromptDigest: "73f2e540b3f12eb0b13983203bf5fdd154ca6be3d37250e57200bff05f59c161" },
  memorist: { upstreamPromptDigest: "ed21374f2bee7858803a718f7e3540765eda085340d79e34aff54c1b625e0517" },
  pentester: { upstreamPromptDigest: "5f053b282ac24fc57f27b184c66838ce754426df2af93e0bae3826c29d2ae087" },
  searcher: { upstreamPromptDigest: "97186f2cc8e0f1e18c5e4e95076e21441308243337e2bbb0852018027fcfb762" },
};

export async function defaultAgentSettings(model: string, reasoningEffort: ReasoningEffort): Promise<AgentSettings> {
  const roles = Object.fromEntries(ACTIVE_ROLES.map((role) => [role, {
    ...managedRoleSettings(role),
    model,
    reasoningEffort,
    searchProvider: DEFAULT_SEARCH_PROVIDER,
  }])) as Record<ActiveRole, RoleSettings>;
  return createAgentSettings(roles, "system", new Date(0));
}

export function managedRoleSettings(role: ActiveRole): Pick<RoleSettings, "promptTemplate" | "upstreamPromptDigest" | "promptFormat"> {
  return { promptTemplate: specialistSources[role], upstreamPromptDigest: sources[role].upstreamPromptDigest, promptFormat: "markdown" };
}

export async function createAgentSettings(
  input: Record<ActiveRole, RoleSettings>,
  savedBy: string,
  savedAt: Date,
): Promise<AgentSettings> {
  const roles = validateAndNormalizeRoles(input);
  const revision = await sha256(stableStringify({ schemaVersion: 1, upstreamManifestDigest: UPSTREAM_MANIFEST_DIGEST, roles }));
  return {
    schemaVersion: 1,
    revision,
    upstreamManifestDigest: UPSTREAM_MANIFEST_DIGEST,
    savedAt: savedAt.toISOString(),
    savedBy,
    roles,
  };
}

function validateAndNormalizeRoles(input: Record<ActiveRole, RoleSettings>): Record<ActiveRole, RoleSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("roles must be an object");
  const keys = Object.keys(input).sort();
  const expected = [...ACTIVE_ROLES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`roles must contain exactly ${ACTIVE_ROLES.join(", ")}`);
  }
  let totalBytes = 0;
  const entries = ACTIVE_ROLES.map((role): [ActiveRole, RoleSettings] => {
    const value = input[role];
    if (!value || typeof value !== "object") throw new Error(`${role} settings are invalid`);
    if (value.promptFormat !== "markdown") throw new Error(`${role} prompt template execution is retired; reset this role to Markdown instructions before saving`);
    const promptBytes = new TextEncoder().encode(value.promptTemplate ?? "").byteLength;
    totalBytes += promptBytes;
    if (promptBytes === 0 || (value.promptFormat === "markdown" && !value.promptTemplate.trim())) throw new Error(`${role} prompt template is empty`);
    if (promptBytes > 256 * 1024) throw new Error(`${role} prompt template is too large`);
    if (value.promptTemplate.includes("\0")) throw new Error(`${role} prompt template contains NUL`);
    if (typeof value.upstreamPromptDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.upstreamPromptDigest)) {
      throw new Error(`${role} upstream prompt digest is invalid`);
    }
    if (typeof value.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~:/-]{0,199}$/.test(value.model)) {
      throw new Error(`${role} model is invalid`);
    }
    if (!REASONING_EFFORTS.includes(value.reasoningEffort)) throw new Error(`${role} reasoning effort is invalid`);
    if (value.searchProvider !== undefined && !isSearchProvider(value.searchProvider)) throw new Error(`${role} search provider is invalid`);
    if (value.model.startsWith("opencode-go:") && value.reasoningEffort !== "default") throw new Error(`${role} OpenCode Go requires default reasoning`);
    return [role, { ...value, searchProvider: value.searchProvider ?? DEFAULT_SEARCH_PROVIDER }];
  });
  if (totalBytes > 2 * 1024 * 1024) throw new Error("settings document is too large");
  return Object.fromEntries(entries) as Record<ActiveRole, RoleSettings>;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
