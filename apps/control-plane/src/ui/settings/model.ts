export const SETTINGS_ROLES = [
  { id: "primary", label: "Primary", glyph: "P", description: "Plans the run and delegates specialist work." },
  { id: "adviser", label: "Adviser", glyph: "A", description: "Provides strategic guidance and technical review." },
  { id: "coder", label: "Coder", glyph: "C", description: "Builds and changes code in an isolated workspace." },
  { id: "maintenance", label: "Maintenance", glyph: "T", description: "Installs tools and prepares specialist environments." },
  { id: "memorist", label: "Memorist", glyph: "M", description: "Retrieves prior findings and durable context." },
  { id: "pentester", label: "Pentester", glyph: "X", description: "Performs authorized security testing." },
  { id: "searcher", label: "Searcher", glyph: "S", description: "Researches targets, code, and technical sources." },
] as const;

export type SettingsRoleId = typeof SETTINGS_ROLES[number]["id"];
export type UIReasoningEffort = "default" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export const UI_REASONING_EFFORTS: UIReasoningEffort[] = ["default", "low", "medium", "high", "xhigh", "max", "ultra"];

export interface SettingsRoleValue {
  promptFormat?: "markdown" | "pentagi-template";
  promptTemplate: string;
  upstreamPromptDigest: string;
  model: string;
  reasoningEffort: UIReasoningEffort;
}

export type SettingsRoles = Record<SettingsRoleId, SettingsRoleValue>;

export interface UpstreamRoleValue {
  promptFormat?: "markdown" | "pentagi-template";
  promptTemplate: string;
  upstreamPromptDigest: string;
}

export type UpstreamRoles = Record<SettingsRoleId, UpstreamRoleValue>;

export interface UIAgentSettings {
  schemaVersion: 1;
  revision: string;
  upstreamManifestDigest: string;
  savedAt: string;
  savedBy: string;
  roles: SettingsRoles;
}

export interface UISettingsResponse {
  settings: UIAgentSettings;
  casRevision: number;
  locked: boolean;
  blockingRunIds: string[];
  upstreamRoles: UpstreamRoles;
}

export interface UISettingsModel {
  id: string;
  name: string;
  provider: string;
  description?: string;
  contextLength?: number;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  reasoningEfforts: UIReasoningEffort[];
}

export interface UISettingsModelCatalog {
  models: UISettingsModel[];
  fetchedAt: string;
  stale: boolean;
}

export function cloneRoles(roles: SettingsRoles): SettingsRoles {
  return Object.fromEntries(SETTINGS_ROLES.map(({ id }) => [id, { ...roles[id] }])) as SettingsRoles;
}

export function isRoleDirty(draft: SettingsRoles, saved: SettingsRoles, role: SettingsRoleId): boolean {
  return JSON.stringify(draft[role]) !== JSON.stringify(saved[role]);
}

export function isDraftDirty(draft: SettingsRoles, saved: SettingsRoles): boolean {
  return SETTINGS_ROLES.some(({ id }) => isRoleDirty(draft, saved, id));
}

export function resetRole(roles: SettingsRoles, role: SettingsRoleId, upstream: UpstreamRoleValue): SettingsRoles {
  return { ...roles, [role]: { ...roles[role], ...upstream } };
}

export function applyModelToAll(roles: SettingsRoles, model: string): SettingsRoles {
  return Object.fromEntries(SETTINGS_ROLES.map(({ id }) => [id, { ...roles[id], model, ...(model.startsWith("opencode-go:") ? { reasoningEffort: "default" } : {}) }])) as SettingsRoles;
}

export function filterModels(models: UISettingsModel[], query: string): UISettingsModel[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return models;
  return models.filter((model) => [model.id, model.name, model.provider]
    .some((value) => value.toLocaleLowerCase().includes(needle)));
}

export function savedModelsCatalog(roles: SettingsRoles, fetchedAt: string): UISettingsModelCatalog {
  const models = new Map<string, UISettingsModel>();
  for (const { id: role } of SETTINGS_ROLES) {
    const value = roles[role];
    const existing = models.get(value.model);
    if (existing) {
      if (!existing.reasoningEfforts.includes(value.reasoningEffort)) existing.reasoningEfforts.push(value.reasoningEffort);
      continue;
    }
    models.set(value.model, {
      id: value.model,
      name: value.model,
      provider: value.model.includes("/") ? value.model.split("/", 1)[0]! : "gateway",
      inputModalities: [],
      outputModalities: [],
      supportedParameters: [],
      reasoningEfforts: [value.reasoningEffort],
    });
  }
  return { models: [...models.values()].sort((left, right) => left.id.localeCompare(right.id)), fetchedAt, stale: true };
}

export function settingsPath(): string {
  return "/settings";
}
