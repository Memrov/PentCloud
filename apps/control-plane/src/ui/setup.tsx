import { useEffect, useState, type ReactNode } from "react";
import { Button, Input, Text } from "@cloudflare/kumo";

interface Status {
  schemaVersion: 1;
  access: boolean;
  accountId?: string;
  worker?: string;
  missing: string[];
  storage: boolean;
  models: boolean;
  ready: boolean;
}
const dashboard = "https://dash.cloudflare.com/";
const accessTokenURL =
  dashboard +
  "?" +
  new URLSearchParams({
    to: "/:account/api-tokens",
    permissionGroupKeys: JSON.stringify([
      { key: "e086da7e2179491d91ee5f35b3ca210a", type: "edit" },
      { key: "1e13c5124ca64b72b1969a67e8829049", type: "edit" },
      { key: "b219cc392cc843cfab473cf3abd06c5b", type: "read" }
    ]),
    name: "PentCloud first setup"
  });
const tokenURL =
  dashboard +
  "?" +
  new URLSearchParams({
    to: "/:account/api-tokens",
    permissionGroupKeys: JSON.stringify([
      { key: "e086da7e2179491d91ee5f35b3ca210a", type: "edit" }
    ]),
    name: "PentCloud setup"
  });
async function request(path: string, input?: Record<string, unknown>) {
  const response = await fetch("/v1/ui/setup" + path, {
    method: input ? "POST" : "GET",
    cache: "no-store",
    ...(input
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input)
        }
      : {}),
    signal: AbortSignal.timeout(30000)
  });
  const value = (await response.json()) as Status & { error?: string };
  if (!response.ok)
    throw Error(value.error ?? "Setup could not be checked. Try again.");
  return value;
}
export function SetupGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(),
    [error, setError] = useState<string>();
  const refresh = async () => {
    try {
      const next = await request("");
      if (next.schemaVersion !== 1)
        throw Error("Setup could not be checked. Try again.");
      setStatus(next);
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Setup could not be checked.");
    }
  };
  useEffect(() => {
    void refresh();
  }, []);
  if (status?.ready && window.location.pathname !== "/setup") return children;
  return <SetupWizard status={status} error={error} refresh={refresh} />;
}
function Link({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="text-kumo-link underline"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}
function SetupWizard({
  status,
  error,
  refresh
}: {
  status: Status | undefined;
  error: string | undefined;
  refresh: () => Promise<void>;
}) {
  const [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [email, setEmail] = useState(""),
    [accessDone, setAccessDone] = useState(false);
  const [accountId, setAccount] = useState(""),
    [worker, setWorker] = useState(
      window.location.hostname.endsWith(".workers.dev")
        ? window.location.hostname.split(".")[0]!
        : ""
    ),
    [apiToken, setToken] = useState(""),
    [key, setKey] = useState(""),
    [route, setRoute] = useState("go");
  useEffect(() => {
    if (status?.accountId) setAccount(status.accountId);
    if (status?.worker) setWorker(status.worker);
  }, [status?.accountId, status?.worker]);
  async function perform(path: string, input: Record<string, unknown>) {
    setBusy(true);
    setMessage("");
    try {
      await request(path, input);
      if (path === "/access") {
        setAccessDone(true);
        setMessage(
          "Access configured. Sign in to continue, then revoke your setup token."
        );
        return;
      }
      setMessage(
        path === "/model"
          ? "Key saved in Cloudflare. Refresh the check if the update is still deploying."
          : "Workspace ready."
      );
      await refresh();
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Setup could not finish. Try again."
      );
    } finally {
      setToken("");
      setKey("");
      setBusy(false);
    }
  }
  const connected = !!status?.access && status.missing.length === 0;
  const complete = [connected, !!status?.storage, !!status?.models];
  return (
    <main className="h-dvh overflow-y-auto bg-kumo-base px-4 py-10 text-sm text-kumo-default">
      <div className="mx-auto grid max-w-xl gap-6">
        <div className="grid gap-1.5">
          <Text as="h1" variant="heading1">
            Set up PentCloud
          </Text>
          <Text variant="secondary">
            Three quick checks, then your first project.
          </Text>
        </div>
        <nav aria-label="Setup steps" className="flex flex-wrap gap-2">
          {["Cloudflare", "Workspace", "Models"].map((label, index) => (
            <Button
              key={label}
              variant={step === index ? "primary" : "secondary"}
              disabled={busy || (index > 0 && !connected)}
              onClick={() => {
                setStep(index);
                setMessage("");
              }}
              aria-current={step === index ? "step" : undefined}
            >
              {index + 1}. {label}
              {complete[index] ? " ✓" : ""}
            </Button>
          ))}
        </nav>
        <section
          className="grid gap-4 rounded-lg border border-kumo-line px-5 py-4"
          aria-busy={busy}
        >
          {!status ? (
            <>
              <Text>{error ?? "Checking your installation…"}</Text>
              {error && (
                <Button variant="secondary" onClick={() => void refresh()}>
                  Try again
                </Button>
              )}
            </>
          ) : step === 0 ? (
            <>
              <Text as="h2" variant="heading2">
                Connect Cloudflare services
              </Text>
              <Text>
                {connected
                  ? "Your deployment has the required service bindings."
                  : "Finish the missing Cloudflare deployment settings, then check again."}
              </Text>
              {!status.access ? (
                <>
                  {accessDone ? (
                    <Button onClick={() => window.location.assign("/setup")}>
                      Sign in to continue
                    </Button>
                  ) : (
                    <form
                      className="grid gap-3"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void perform("/access", {
                          accountId,
                          worker,
                          apiToken,
                          email,
                          key,
                          route
                        });
                      }}
                    >
                      <Text>
                        Protect this installation with your email address.
                        Cloudflare handles sign-in.
                      </Text>
                      <Text variant="secondary">
                        Enable{" "}
                        <Link href="https://one.dash.cloudflare.com/">
                          Zero Trust
                        </Link>{" "}
                        first. The free Access plan is sufficient within its
                        limits.{" "}
                        <Link href="https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/">
                          Access setup
                        </Link>
                      </Text>
                      <Input
                        label="Owner email"
                        type="email"
                        value={email}
                        onValueChange={setEmail}
                        required
                      />
                      <Link href={accessTokenURL}>
                        Create first-setup token
                      </Link>
                      <Text variant="secondary">
                        Allow Workers Scripts Edit, Access Apps and Policies
                        Edit, and Access Organizations Read in this account. The
                        token is used once and never saved.
                      </Text>
                      <Input
                        label="Cloudflare account ID"
                        value={accountId}
                        onValueChange={setAccount}
                        required
                      />
                      <Input
                        label="App Worker name"
                        value={worker}
                        onValueChange={setWorker}
                        required
                      />
                      <Input
                        label="Setup API token"
                        type="password"
                        autoComplete="new-password"
                        value={apiToken}
                        onValueChange={setToken}
                        required
                      />
                      <Input
                        label="OpenCode key (optional)"
                        type="password"
                        autoComplete="new-password"
                        value={key}
                        onValueChange={setKey}
                      />
                      <label className="grid gap-1.5">
                        OpenCode billing route
                        <select
                          className="rounded-md border border-kumo-line bg-kumo-base px-3 py-2"
                          value={route}
                          onChange={(e) => setRoute(e.target.value)}
                        >
                          <option value="go">Go</option>
                          <option value="console">Console</option>
                        </select>
                      </label>
                      <Button
                        type="submit"
                        disabled={
                          busy || !email || !accountId || !worker || !apiToken
                        }
                      >
                        {busy ? "Protecting…" : "Protect this installation"}
                      </Button>
                    </form>
                  )}
                </>
              ) : (
                status.missing.length > 0 && (
                  <Text>
                    Missing: {status.missing.join(", ")}.{" "}
                    <Link href={dashboard}>Open Cloudflare</Link>
                  </Text>
                )
              )}
              <Text variant="secondary">
                Cloudflare deploys the bindings. No separate API key is needed
                for each service.
              </Text>
              <Button variant="secondary" onClick={() => void refresh()}>
                Check again
              </Button>
              <Button disabled={!connected} onClick={() => setStep(1)}>
                Continue
              </Button>
            </>
          ) : step === 1 ? (
            <>
              <Text as="h2" variant="heading2">
                Prepare your workspace
              </Text>
              <Text>
                {status.storage
                  ? "Your Artifacts workspace is connected."
                  : "Create the initial workspace in your own Cloudflare Artifacts storage."}
              </Text>
              <Text variant="secondary">
                Existing repositories are preserved.
              </Text>
              {!status.storage && (
                <Button
                  disabled={!connected || busy}
                  onClick={() => void perform("/storage", {})}
                >
                  {busy ? "Preparing…" : "Prepare workspace"}
                </Button>
              )}
              <Button disabled={!status.storage} onClick={() => setStep(2)}>
                Continue
              </Button>
            </>
          ) : (
            <>
              <Text as="h2" variant="heading2">
                Connect your models
              </Text>
              {status.models ? (
                <Text>Your OpenCode key is configured in Cloudflare.</Text>
              ) : (
                <form
                  className="grid gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform("/model", {
                      accountId,
                      worker,
                      apiToken,
                      key,
                      route
                    });
                  }}
                >
                  <Text>
                    Save your OpenCode key directly into this app’s Cloudflare
                    Worker secret.
                  </Text>
                  <label className="grid gap-1.5">
                    OpenCode billing route
                    <select
                      className="rounded-md border border-kumo-line bg-kumo-base px-3 py-2"
                      value={route}
                      onChange={(e) => setRoute(e.target.value)}
                    >
                      <option value="go">Go</option>
                      <option value="console">Console</option>
                    </select>
                  </label>
                  <Input
                    label="OpenCode key"
                    type="password"
                    autoComplete="new-password"
                    value={key}
                    onValueChange={setKey}
                    required
                  />
                  <details>
                    <summary className="cursor-pointer">
                      Allow this one-time secret save
                    </summary>
                    <div className="mt-3 grid gap-3">
                      <Text>
                        Create a setup token with Workers Scripts Edit for this
                        account. It is used for this request and is never saved.
                        Revoke it afterward.
                      </Text>
                      <Link href={tokenURL}>Create scoped setup token</Link>
                      <Input
                        label="Cloudflare account ID"
                        value={accountId}
                        onValueChange={setAccount}
                        required
                      />
                      <Input
                        label="App Worker name"
                        value={worker}
                        onValueChange={setWorker}
                        required
                      />
                      <Input
                        label="Setup API token"
                        type="password"
                        autoComplete="new-password"
                        value={apiToken}
                        onValueChange={setToken}
                        required
                      />
                    </div>
                  </details>
                  <Text variant="secondary">
                    You can also{" "}
                    <Link href={dashboard}>add the secret in Cloudflare</Link>,
                    then check again.
                  </Text>
                  <Button
                    type="submit"
                    disabled={
                      busy ||
                      !connected ||
                      !status.storage ||
                      !apiToken ||
                      !key ||
                      !accountId ||
                      !worker
                    }
                  >
                    {busy ? "Saving…" : "Save key in Cloudflare"}
                  </Button>
                </form>
              )}
              <Text variant="secondary">
                Saving a key does not run a model or a scan. Test selected
                models when you create your first project.
              </Text>
              <Button variant="secondary" onClick={() => void refresh()}>
                Check again
              </Button>
              <Button
                disabled={!status.ready}
                onClick={() => window.location.assign("/")}
              >
                Open PentCloud
              </Button>
            </>
          )}
          {(message || error) && (
            <p role="status" className="text-sm">
              {message || error}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
