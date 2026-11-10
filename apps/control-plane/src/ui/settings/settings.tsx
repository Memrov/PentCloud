import {
  Badge,
  Banner,
  Button,
  Collapsible,
  Empty,
  Link,
  LinkButton,
  Select
} from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  ChatCircleDotsIcon,
  CheckCircleIcon,
  FloppyDiskIcon,
  GearSixIcon,
  LockKeyIcon,
  PulseIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import {
  DEFAULT_SEARCH_PROVIDER,
  SEARCH_PROVIDERS
} from "../../../../../shared/search-providers";

import {
  APIError,
  getSettings,
  listRuns,
  listSettingsModels,
  saveSettings,
  type UIRun
} from "../api";
import { runLabel } from "../run-label";
import { chatPath, dashboardPath } from "../dashboard/model";
import { ModelPicker } from "./model-picker";
import {
  SETTINGS_ROLES,
  UI_REASONING_EFFORTS,
  applyModelToAll,
  cloneRoles,
  isDraftDirty,
  isRoleDirty,
  resetRole,
  savedModelsCatalog,
  settingsPath,
  type SettingsRoleId,
  type SettingsRoles,
  type UISettingsModelCatalog,
  type UISettingsResponse
} from "./model";
import { PromptEditor } from "./prompt-editor";
import { RuntimeRecoveryPanel } from "../components/runtime-recovery";
import { ThemeControl } from "../components/theme-control";
import { AgentConnection } from "./agent-connection";

export default function Settings({
  embedded = false
}: { embedded?: boolean } = {}) {
  const [snapshot, setSnapshot] = useState<UISettingsResponse>();
  const [runs, setRuns] = useState<UIRun[]>([]);
  const [draft, setDraft] = useState<SettingsRoles>();
  const [catalog, setCatalog] = useState<UISettingsModelCatalog>();
  const [selectedRole, setSelectedRole] = useState<SettingsRoleId>("primary");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => {
    let live = true;
    void listRuns(globalThis.fetch, "all")
      .then((value) => {
        if (live) setRuns(value);
      })
      .catch(() => {});
    void Promise.allSettled([getSettings(), listSettingsModels()])
      .then(([settingsResult, modelsResult]) => {
        if (!live) return;
        if (settingsResult.status === "rejected") {
          setError(
            messageFrom(settingsResult.reason, "Could not load agent settings")
          );
          return;
        }
        const settings = settingsResult.value;
        setSnapshot(settings);
        setDraft(cloneRoles(settings.settings.roles));
        if (modelsResult.status === "fulfilled") {
          setCatalog(modelsResult.value);
          setError(undefined);
        } else {
          setCatalog(
            savedModelsCatalog(
              settings.settings.roles,
              settings.settings.savedAt
            )
          );
          const detail = messageFrom(
            modelsResult.reason,
            "OpenCode Go model discovery failed"
          );
          setError(
            `Could not load connected OpenCode Go models. Showing saved selections. ${detail}`
          );
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const dirty = Boolean(
    snapshot && draft && isDraftDirty(draft, snapshot.settings.roles)
  );
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const selected = draft?.[selectedRole];
  const roleMeta = SETTINGS_ROLES.find((role) => role.id === selectedRole)!;
  const selectedModel = catalog?.models.find(
    (model) => model.id === selected?.model
  );
  const disabled = Boolean(snapshot?.locked || saving);
  const reasoningOptions = selectedModel?.reasoningEfforts.length
    ? selectedModel.reasoningEfforts
    : UI_REASONING_EFFORTS;

  const updateSelected = (patch: Partial<SettingsRoles[SettingsRoleId]>) => {
    setDraft((current) =>
      current
        ? { ...current, [selectedRole]: { ...current[selectedRole], ...patch } }
        : current
    );
    setNotice(undefined);
  };

  const refreshModels = async () => {
    setRefreshing(true);
    setError(undefined);
    try {
      setCatalog(await listSettingsModels(true));
    } catch (caught) {
      setError(messageFrom(caught, "Could not refresh OpenCode Go models"));
    } finally {
      setRefreshing(false);
    }
  };

  const save = async () => {
    if (!snapshot || !draft || disabled || !dirty) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const saved = await saveSettings(draft, snapshot.casRevision);
      setSnapshot(saved);
      setDraft(cloneRoles(saved.settings.roles));
      setNotice(`Saved revision ${saved.settings.revision.slice(0, 12)}.`);
    } catch (caught) {
      setError(
        caught instanceof APIError && caught.status === 409
          ? "Settings changed or a run started. Reload before saving again."
          : messageFrom(caught, "Could not validate and save settings")
      );
    } finally {
      setSaving(false);
    }
  };

  if (loading)
    return (
      <SettingsShell embedded={embedded}>
        <SettingsNotice title="Loading agent settings…" />
      </SettingsShell>
    );
  if (!snapshot || !draft || !catalog || !selected) {
    return (
      <SettingsShell embedded={embedded}>
        <SettingsNotice
          title="Settings unavailable"
          {...(error ? { detail: error } : {})}
        />
      </SettingsShell>
    );
  }

  return (
    <SettingsShell embedded={embedded}>
      <main className="settings-scroll">
        <div className="settings-page">
          <header className="settings-page-heading">
            <div>
              {!embedded && (
                <span className="settings-kicker">
                  <GearSixIcon size={14} /> Agent configuration
                </span>
              )}
              {embedded ? (
                <h2>Agent configuration</h2>
              ) : (
                <h1>Prompts and models</h1>
              )}
              <p>
                These versioned defaults apply to future runs. Active and
                historical runs keep their pinned revision.
              </p>
            </div>
            <div className="settings-heading-actions">
              <Button
                variant="secondary"
                icon={<ArrowCounterClockwiseIcon size={15} />}
                disabled={refreshing}
                onClick={() => void refreshModels()}
              >
                {refreshing ? "Refreshing…" : "Refresh models"}
              </Button>
              <Button
                variant="primary"
                icon={<FloppyDiskIcon size={15} />}
                disabled={disabled || !dirty}
                onClick={() => void save()}
              >
                {saving ? "Validating…" : "Validate and save"}
              </Button>
            </div>
          </header>

          <SettingsStatus
            snapshot={snapshot}
            runs={runs}
            dirty={dirty}
            stale={catalog.stale}
          />
          <AgentConnection />
          {error && (
            <Banner
              className="settings-banner"
              variant="error"
              role="alert"
              icon={<WarningCircleIcon size={17} />}
              title={error}
            />
          )}
          {notice && (
            <Banner
              className="settings-banner"
              variant="secondary"
              role="status"
              icon={<CheckCircleIcon size={17} />}
              title={notice}
            />
          )}

          <div className="settings-mobile-role">
            <Select
              label="Agent"
              items={SETTINGS_ROLES.map((role) => ({
                value: role.id,
                label: role.label
              }))}
              value={selectedRole}
              onValueChange={(value) => {
                if (value) setSelectedRole(value as SettingsRoleId);
              }}
            />
          </div>
          <div className="settings-workspace">
            <aside className="settings-role-rail" aria-label="Agent roles">
              <div className="settings-role-rail-heading">
                <span>Specialists</span>
                <small>{SETTINGS_ROLES.length} roles</small>
              </div>
              {SETTINGS_ROLES.map((role) => {
                const roleDirty = isRoleDirty(
                  draft,
                  snapshot.settings.roles,
                  role.id
                );
                return (
                  <Button
                    key={role.id}
                    className="justify-start"
                    variant={role.id === selectedRole ? "secondary" : "ghost"}
                    aria-current={role.id === selectedRole ? "page" : undefined}
                    onClick={() => setSelectedRole(role.id)}
                  >
                    {role.label}
                    {roleDirty && <Badge variant="secondary">Edited</Badge>}
                  </Button>
                );
              })}
            </aside>

            <section className="settings-detail">
              <header className="settings-detail-heading">
                <div className="settings-role-title">
                  <span>{roleMeta.glyph}</span>
                  <div>
                    <h2>{roleMeta.label}</h2>
                    <p>{roleMeta.description}</p>
                  </div>
                </div>
                <div className="settings-revision-copy">
                  <span>Current revision</span>
                  <code title={snapshot.settings.revision}>
                    {snapshot.settings.revision.slice(0, 12)}
                  </code>
                </div>
              </header>

              <div className="settings-control-grid">
                <div className="settings-model-column">
                  <div className="settings-field-heading">
                    <div>
                      <strong>OpenCode Go model</strong>
                      <small>Runs in a fresh OpenCode session</small>
                    </div>
                    <Button
                      variant="ghost"
                      disabled={disabled}
                      onClick={() =>
                        setDraft(
                          applyModelToAll(
                            draft,
                            selected.model,
                            selectedModel?.reasoningEfforts ?? []
                          )
                        )
                      }
                    >
                      Apply to all roles
                    </Button>
                  </div>
                  <ModelPicker
                    key={selectedRole}
                    models={catalog.models}
                    selectedId={selected.model}
                    stale={catalog.stale}
                    disabled={disabled}
                    onSelect={(model) => {
                      const effort =
                        model.reasoningEfforts.includes(
                          selected.reasoningEffort
                        ) || model.reasoningEfforts.length === 0
                          ? selected.reasoningEffort
                          : model.reasoningEfforts[0]!;
                      updateSelected({
                        model: model.id,
                        reasoningEffort: effort
                      });
                    }}
                  />
                </div>
                <div className="settings-reasoning-field grid gap-4">
                  <Select<SettingsRoles[SettingsRoleId]["reasoningEffort"]>
                    label="Reasoning effort"
                    description="Default uses the strongest supported effort for new analysis"
                    items={reasoningOptions.map((effort) => ({
                      value: effort,
                      label: effort
                    }))}
                    value={selected.reasoningEffort}
                    disabled={disabled}
                    onValueChange={(reasoningEffort) => {
                      if (reasoningEffort) updateSelected({ reasoningEffort });
                    }}
                  />
                  <Select
                    label="Web search provider"
                    description="Used by this role in future runs"
                    items={SEARCH_PROVIDERS.map((provider) => ({
                      value: provider.id,
                      label: provider.label
                    }))}
                    value={selected.searchProvider ?? DEFAULT_SEARCH_PROVIDER}
                    disabled={disabled}
                    onValueChange={(searchProvider) => {
                      if (searchProvider) updateSelected({ searchProvider });
                    }}
                  />
                </div>
              </div>

              <div className="settings-prompt-heading">
                <div>
                  <strong>Specialist instructions</strong>
                  <small>
                    {selected.promptFormat === "markdown"
                      ? "Specialist guidance adapted for the current tools"
                      : "Legacy Go template"}
                  </small>
                </div>
              </div>
              {selected.promptFormat !== "markdown" && (
                <p role="status">
                  Go template execution is retired. Reset this role to the
                  current Markdown instructions before saving or starting new
                  work. The saved template remains available here for reference.
                </p>
              )}
              <PromptEditor
                roleLabel={roleMeta.label}
                value={selected.promptTemplate}
                upstreamDigest={
                  snapshot.upstreamRoles[selectedRole].upstreamPromptDigest
                }
                revision={snapshot.settings.revision}
                disabled={disabled}
                canReset={
                  selected.promptFormat !== "markdown" ||
                  selected.promptTemplate !==
                    snapshot.upstreamRoles[selectedRole].promptTemplate
                }
                onChange={(promptTemplate) =>
                  updateSelected({ promptTemplate })
                }
                onReset={() =>
                  setDraft(
                    resetRole(
                      draft,
                      selectedRole,
                      snapshot.upstreamRoles[selectedRole]
                    )
                  )
                }
              />

              <footer className="settings-detail-footer">
                <div>
                  <strong>
                    {dirty ? "Unsaved draft" : "All changes saved"}
                  </strong>
                  <small>
                    Last saved {formatSavedAt(snapshot.settings.savedAt)}
                  </small>
                </div>
                <div>
                  <Button
                    variant="secondary"
                    disabled={saving || !dirty}
                    onClick={() => {
                      setDraft(cloneRoles(snapshot.settings.roles));
                      setNotice(undefined);
                    }}
                  >
                    Discard draft
                  </Button>
                  <Button
                    variant="primary"
                    disabled={disabled || !dirty}
                    onClick={() => void save()}
                  >
                    {saving ? "Validating…" : "Validate and save"}
                  </Button>
                </div>
              </footer>
            </section>
          </div>
          <Collapsible className="settings-diagnostics">
            <Collapsible.DefaultTrigger>
              Runtime diagnostics and recovery
            </Collapsible.DefaultTrigger>
            <Collapsible.DefaultPanel>
              <RuntimeRecoveryPanel />
            </Collapsible.DefaultPanel>
          </Collapsible>
        </div>
      </main>
    </SettingsShell>
  );
}

export function SettingsStatus({
  snapshot,
  runs = [],
  dirty,
  stale
}: {
  snapshot: UISettingsResponse;
  runs?: UIRun[];
  dirty: boolean;
  stale: boolean;
}) {
  if (snapshot.locked) {
    return (
      <Banner
        className="settings-banner"
        variant="alert"
        icon={<LockKeyIcon size={19} />}
        title="Defaults locked by unfinished runs"
        description={
          <div className="grid gap-2 text-base">
            <p>
              {snapshot.blockingRunIds.length} unfinished runs keep defaults
              locked, including discovery and setup, even when no specialist is
              executing.
            </p>
            <Collapsible>
              <Collapsible.DefaultTrigger>
                View unfinished runs
              </Collapsible.DefaultTrigger>
              <Collapsible.DefaultPanel className="grid gap-2">
                {snapshot.blockingRunIds.map((id) => {
                  const run = runs.find((r) => r.id === id);
                  return (
                    <Link key={id} href={chatPath(id)}>
                      {run
                        ? runLabel(run)
                        : "Run " + id.replace(/^run-/, "").slice(0, 8)}
                      {run?.phase ? ` · ${run.phase}` : ""}
                    </Link>
                  );
                })}
                <p>Open a run to continue or stop it.</p>
              </Collapsible.DefaultPanel>
            </Collapsible>
          </div>
        }
      />
    );
  }
  return (
    <Banner
      className="settings-banner"
      variant="secondary"
      icon={<CheckCircleIcon size={19} />}
      title={dirty ? "Draft ready to validate" : "Ready to edit"}
      description="Saving validates all specialist instructions before updating the settings."
      action={
        <small>
          {stale ? "Cached model catalog" : "OpenCode Go catalog live"}
        </small>
      }
    />
  );
}

function SettingsShell({
  children,
  embedded = false
}: {
  children: React.ReactNode;
  embedded?: boolean;
}) {
  return (
    <div
      className={
        embedded ? "settings-shell settings-embedded" : "settings-shell"
      }
    >
      {!embedded && <SettingsHeader />}
      {children}
    </div>
  );
}

function SettingsHeader() {
  return (
    <header className="dashboard-topbar settings-topbar">
      <Link variant="plain" className="dashboard-brand" href={settingsPath()}>
        PentCloud
      </Link>
      <nav aria-label="Product navigation">
        <LinkButton variant="ghost" aria-label="Chats" href={chatPath()}>
          <ChatCircleDotsIcon size={16} />{" "}
          <span className="hidden min-[721px]:inline">Chats</span>
        </LinkButton>
        <LinkButton
          variant="ghost"
          aria-label="Dashboard"
          href={dashboardPath()}
        >
          <PulseIcon size={16} />{" "}
          <span className="hidden min-[721px]:inline">Dashboard</span>
        </LinkButton>
        <LinkButton
          variant="secondary"
          aria-label="Settings"
          href={settingsPath()}
        >
          <GearSixIcon size={16} />{" "}
          <span className="hidden min-[721px]:inline">Settings</span>
        </LinkButton>
        <ThemeControl className="dashboard-icon-button" />
      </nav>
    </header>
  );
}

function SettingsNotice({ title, detail }: { title: string; detail?: string }) {
  return (
    <main className="settings-scroll">
      <Empty title={title} {...(detail ? { description: detail } : {})} />
    </main>
  );
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatSavedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}
