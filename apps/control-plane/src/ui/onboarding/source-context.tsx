import {
  Badge,
  Button,
  Collapsible,
  Input,
  Select,
  Text
} from "@cloudflare/kumo";
import { useRef, useState } from "react";
import type { SavedTarget } from "../../native/onboarding";
import { APIError } from "../api";
import { action, type OnboardingSnapshot } from "./api";

export function SourceContextEditor({
  target,
  pending = [],
  disabled,
  perform,
  onChanged
}: {
  target: SavedTarget;
  pending?: NonNullable<OnboardingSnapshot["sourceImports"]>;
  disabled: boolean;
  perform: (fn: () => Promise<void>) => Promise<void>;
  onChanged: (target?: SavedTarget) => Promise<void>;
}) {
  const [mode, setMode] = useState("artifacts"),
    [repos, setRepos] = useState<{ name: string; defaultBranch: string }[]>(),
    [cursor, setCursor] = useState<string>();
  const [repo, setRepo] = useState(""),
    [url, setURL] = useState(""),
    [branch, setBranch] = useState("");
  const request = useRef<
    | { requestId: string; url: string; branch: string; revision: number }
    | undefined
  >(undefined);
  const latestRequests = useRef<
    Record<string, NonNullable<OnboardingSnapshot["sourceImports"]>[number]>
  >({});
  const load = () =>
    perform(async () => {
      const page = await action<{
        repos: { name: string; defaultBranch: string }[];
        cursor?: string;
      }>("source.list", { ...(cursor ? { cursor } : {}) });
      setRepos((prior) =>
        cursor ? [...(prior ?? []), ...page.repos] : page.repos
      );
      setCursor(page.cursor);
    });
  const update = (verb: string, extra: object) =>
    perform(async () => {
      const saved = await action<SavedTarget>("source." + verb, {
        id: target.id,
        revision: target.revision,
        ...extra
      });
      await onChanged(saved);
    });
  const importRepo = (
    input?: NonNullable<OnboardingSnapshot["sourceImports"]>[number]
  ) =>
    perform(async () => {
      if (
        !input &&
        (!request.current ||
          request.current.url !== url ||
          request.current.branch !== branch ||
          request.current.revision !== target.revision)
      )
        request.current = {
          requestId: "import-" + crypto.randomUUID(),
          url,
          branch,
          revision: target.revision
        };
      const value = input ?? request.current!;
      try {
        const result = await action<{
          status: "pending" | "ready";
          target?: SavedTarget;
        }>("source.import", {
          id: target.id,
          revision: value.revision,
          url: value.url,
          branch: value.branch ?? "",
          requestId: value.requestId,
          ...(input?.replaceId ? { replaceId: input.replaceId } : {})
        });
        if (result.status === "ready") {
          request.current = undefined;
          if (input?.replaceId) delete latestRequests.current[input.replaceId];
          setURL("");
          setBranch("");
        }
        await onChanged(result.target);
      } catch (error) {
        if (error instanceof APIError && error.status === 400) {
          request.current = undefined;
          if (input?.replaceId) delete latestRequests.current[input.replaceId];
        }
        throw error;
      }
    });
  return (
    <section aria-label="Source context" className="source-context">
      <Collapsible>
        <Collapsible.DefaultTrigger>
          Source context (optional)
          {!!target.sources?.length && (
            <Badge variant="secondary">{target.sources.length}</Badge>
          )}
        </Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <div className="onboarding-form">
            <Text variant="secondary">
              Let agents refer to your code. Source stays separate and read
              only. Every run keeps the exact commit selected here.
            </Text>
            {target.sources?.map((source) => (
              <div className="source-context-item" key={source.id}>
                <strong>{source.origin ?? source.repo}</strong>
                <Text variant="secondary">
                  {source.branch} ·{" "}
                  <code title={source.commit}>
                    {source.commit.slice(0, 12)}
                  </code>
                </Text>
                <div className="onboarding-row">
                  <Button
                    variant="ghost"
                    disabled={
                      disabled ||
                      pending.some(
                        (p) =>
                          p.targetId === target.id &&
                          p.replaceId === source.id &&
                          p.revision === target.revision
                      )
                    }
                    onClick={() => {
                      if (!source.origin) {
                        void update("refresh", { sourceId: source.id });
                        return;
                      }
                      const prior = latestRequests.current[source.id];
                      const value =
                        prior?.revision === target.revision
                          ? prior
                          : {
                              requestId: "import-" + crypto.randomUUID(),
                              targetId: target.id,
                              revision: target.revision,
                              repo: source.repo,
                              url: source.origin,
                              branch: source.branch,
                              replaceId: source.id
                            };
                      latestRequests.current[source.id] = value;
                      void importRepo(value);
                    }}
                  >
                    {source.origin ? "Import latest" : "Refresh commit"}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={disabled}
                    onClick={() =>
                      void update("detach", { sourceId: source.id })
                    }
                  >
                    Remove source
                  </Button>
                </div>
              </div>
            ))}
            {pending
              .filter((p) => p.targetId === target.id)
              .map((item) => (
                <div role="status" key={item.requestId}>
                  <p>
                    Import requested: {item.url}. It is not attached until
                    Cloudflare finishes.
                  </p>
                  {item.revision === target.revision ? (
                    <Button
                      variant="secondary"
                      disabled={disabled}
                      onClick={() => void importRepo(item)}
                    >
                      Check import
                    </Button>
                  ) : (
                    <p>
                      The target changed. Load existing repositories to attach{" "}
                      {item.repo} after its import finishes.
                    </p>
                  )}
                </div>
              ))}
            {(target.sources?.length ?? 0) < 5 && (
              <>
                <Select
                  label="Source location"
                  value={mode}
                  onValueChange={(value) => setMode(String(value))}
                  disabled={disabled}
                >
                  <Select.Option value="artifacts">
                    Existing Artifacts repository
                  </Select.Option>
                  <Select.Option value="github">
                    Public GitHub repository
                  </Select.Option>
                </Select>
                {mode === "artifacts" ? (
                  <>
                    <Button
                      variant="secondary"
                      disabled={disabled}
                      onClick={() => void load()}
                    >
                      {repos
                        ? cursor
                          ? "Load more repositories"
                          : "Reload repositories"
                        : "Load existing repositories"}
                    </Button>
                    {!!repos?.length && (
                      <Select
                        label="Artifacts repository"
                        placeholder="Choose a repository"
                        value={repo}
                        disabled={disabled}
                        onValueChange={(value) => {
                          const name = String(value ?? "");
                          setRepo(name);
                          setBranch(
                            repos.find((r) => r.name === name)?.defaultBranch ??
                              ""
                          );
                        }}
                      >
                        {repos.map((r) => (
                          <Select.Option key={r.name} value={r.name}>
                            {r.name}
                          </Select.Option>
                        ))}
                      </Select>
                    )}
                    {repos?.length === 0 && (
                      <p>
                        No Artifacts repositories are available in this
                        installation.
                      </p>
                    )}
                  </>
                ) : (
                  <Input
                    label="Public GitHub repository URL"
                    value={url}
                    onValueChange={setURL}
                    disabled={disabled}
                    placeholder="Paste the repository URL"
                  />
                )}
                <Input
                  label="Source branch"
                  value={branch}
                  onValueChange={setBranch}
                  disabled={disabled}
                  placeholder="Repository default"
                />
                <Button
                  variant="secondary"
                  disabled={
                    disabled || (mode === "artifacts" ? !repo : !url.trim())
                  }
                  onClick={() =>
                    void (mode === "artifacts"
                      ? update("attach", { repo, branch })
                      : importRepo())
                  }
                >
                  {mode === "artifacts" ? "Attach source" : "Import source"}
                </Button>
                <Text variant="secondary">
                  For private GitHub source, use your terminal to copy it into
                  Artifacts, then select it here. A Workers & Pages GitHub
                  connection does not itself grant PentCloud source access.
                </Text>
              </>
            )}
            <Text variant="secondary">
              Removing a source affects future runs. Existing runs keep their
              commit references. Imported repositories remain in Artifacts.
            </Text>
          </div>
        </Collapsible.DefaultPanel>
      </Collapsible>
    </section>
  );
}
