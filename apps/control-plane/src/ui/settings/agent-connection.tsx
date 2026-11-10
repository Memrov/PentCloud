import { Banner, ClipboardText, Collapsible, Link } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import { setupRequest } from "../onboarding/api";

export function AgentConnection() {
  const [connection, setConnection] = useState<{
    endpoint: string;
    browser: boolean;
  }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void setupRequest<{ endpoint: string; browser: boolean }>(
      "/agent-connection"
    )
      .then((value) => {
        if (live) setConnection(value);
      })
      .catch(() => {
        if (live)
          setError("Could not load the agent connection. Reload to retry.");
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <Collapsible className="settings-diagnostics">
      <Collapsible.DefaultTrigger>
        Connect your agent
      </Collapsible.DefaultTrigger>
      <Collapsible.Panel className="grid gap-4 py-4 text-sm">
        <p>
          Drive assessments and the PentCloud UI from your agent. The connection
          and browser run in Cloudflare, so your computer can sleep.
        </p>
        {error && <Banner variant="error" title={error} />}
        {!connection && !error && <output>Loading connection…</output>}
        {connection && (
          <>
            <div className="grid min-w-0 gap-2">
              <strong>Remote MCP URL</strong>
              <ClipboardText
                text={connection.endpoint}
                className="max-w-full break-all"
              />
            </div>
            <ol className="list-decimal space-y-2 pl-5">
              <li>Add this URL as a remote MCP server in your agent client.</li>
              <li>
                Sign in through Cloudflare Access with your operator account.
              </li>
              <li>
                Ask your agent to read your targets or open the PentCloud
                browser.
              </li>
            </ol>
            <p>
              Agents have your operator access to this installation, including
              shared assessments. Browser sessions are private to your account
              and expire when idle. Your agent client must also run in the cloud
              to continue while your computer sleeps.
            </p>
            {!connection.browser && (
              <Banner
                variant="alert"
                title="Deploy the agent browser binding to enable direct UI control."
              />
            )}
            <p>
              The installation owner must enable{" "}
              <Link
                href="https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/"
                target="_blank"
                rel="noreferrer"
              >
                Managed OAuth
              </Link>{" "}
              for this hostname. Your client needs remote MCP and OAuth resource
              indicator support. Access grants expire; reconnect when asked.
              Manage or revoke agent grants in Cloudflare Access.
            </p>
          </>
        )}
      </Collapsible.Panel>
    </Collapsible>
  );
}
