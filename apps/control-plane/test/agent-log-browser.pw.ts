import { test, expect } from "playwright/test";

// Isolated local API fixtures: no production requests, model calls or scanners.
test.describe("run steps live output", () => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 }
  ])
    test(`opens a specialist's live log from the run steps at ${viewport.width} px`, async ({
      context,
      page
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const run = {
        id: "run-log",
        status: "running",
        baselineRepo: "repo",
        inputCommit: "a".repeat(40),
        maxDepth: 4,
        maxJobs: 32
      };
      const make = (id: string, role: string, patch = {}) => ({
        id,
        runId: run.id,
        role,
        task: `${role} task`,
        status: "running",
        revision: 1,
        nativeSession: true,
        depth: 0,
        ...patch
      });
      const jobs = [
        make("primary", "primary", { status: "waiting", conversationOrder: 1 }),
        make("scanner", "searcher", {
          parentJobId: "primary",
          depth: 1,
          conversationOrder: 2
        }),
        make("scanner-2", "searcher", {
          parentJobId: "primary",
          depth: 1,
          status: "completed",
          conversationOrder: 3
        }),
        make("coder", "coder", {
          parentJobId: "primary",
          depth: 1,
          status: "completed",
          conversationOrder: 4
        }),
        make("reporter", "reporter", {
          parentJobId: "primary",
          depth: 1,
          status: "created",
          conversationOrder: 5
        })
      ];
      await context.routeWebSocket(
        "**/agents/coordinator/global*",
        (socket) => {
          socket.send(
            JSON.stringify({
              type: "cf_agent_identity",
              name: "global",
              agent: "coordinator",
              stateFollows: true
            })
          );
          socket.send(
            JSON.stringify({
              type: "cf_agent_state",
              state: { revision: 1, runs: [run], jobs }
            })
          );
        }
      );
      const streams: string[] = [];
      await page.route("**/v1/ui/**", (route) => {
        const path = new URL(route.request().url()).pathname;
        const json = (value: unknown) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(value)
          });
        if (path === "/v1/ui/runs") return json({ runs: [run] });
        if (path === `/v1/ui/runs/${run.id}/jobs`) return json({ run, jobs });
        if (path === `/v1/ui/runs/${run.id}/workflow-events`)
          return route.fulfill({
            contentType: "text/event-stream",
            body: "event: up-to-date\ndata: {}\n\n"
          });
        const jobId = path.match(/^\/v1\/ui\/jobs\/([^/]+)\/events$/)?.[1];
        if (jobId) {
          streams.push(jobId);
          const job = jobs.find((j) => j.id === jobId)!;
          const messages = [
            {
              id: `${jobId}-user`,
              type: "user",
              text: `Probe ${jobId} surface`
            },
            {
              id: `${jobId}-reply`,
              type: "assistant",
              time: { completed: 1 },
              content: [
                {
                  type: "tool",
                  id: `${jobId}-tool`,
                  name: "terminal",
                  state: {
                    status: "completed",
                    input: { command: "nmap -sV target.invalid" },
                    content: [
                      { type: "text", text: "22/tcp open ssh OpenSSH 9.6" }
                    ]
                  }
                },
                {
                  type: "tool",
                  id: `${jobId}-fail`,
                  name: "web_search",
                  state: {
                    status: "error",
                    input: { q: "OpenSSH 9.6 CVE" },
                    error: "rate limited"
                  }
                },
                {
                  type: "text",
                  text: `Output only for ${jobId}: SSH exposed on 22/tcp.`
                }
              ]
            }
          ];
          return route.fulfill({
            contentType: "text/event-stream",
            body: `event: snapshot\ndata: ${JSON.stringify({ job, messages })}\n\nevent: end\ndata: {}\n\n`
          });
        }
        if (path.endsWith("/session-controls"))
          return json({
            session: "session",
            canReply: false,
            forms: [],
            permissions: [],
            usage: null
          });
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: '{"error":"Unknown local fixture route"}'
        });
      });
      await page.route("**/v1/ui/setup", (route) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            schemaVersion: 1,
            access: true,
            missing: [],
            storage: true,
            models: true,
            ready: true
          })
        })
      );

      await page.goto(`/dashboard/runs/${run.id}`);
      await expect(
        page.getByText("Select a specialist", { exact: true })
      ).toBeVisible();
      await page.locator(".run-step-node", { hasText: "Searcher 1" }).click();
      await expect(page).toHaveURL(
        new RegExp(`/dashboard/runs/${run.id}/jobs/scanner$`)
      );
      await expect(
        page.locator(".run-step-node", { hasText: "Searcher 1" })
      ).toHaveAttribute("aria-current", "true");
      const log = page.getByRole("log", { name: "Live output" });
      await expect(log).toBeVisible();
      await expect(log.locator(".log-entry")).toHaveCount(6);
      await expect(
        log.getByText('{"command":"nmap -sV target.invalid"}', { exact: true })
      ).toBeVisible();
      await expect(
        log.getByText("22/tcp open ssh OpenSSH 9.6", { exact: true })
      ).toBeVisible();
      await expect(log.locator(".log-entry-error")).toContainText(
        "rate limited"
      );
      await expect(
        log.getByText("Output only for scanner: SSH exposed on 22/tcp.", {
          exact: true
        })
      ).toBeVisible();
      if (viewport.width < 760)
        expect(
          (await page.locator(".log-panel").boundingBox())?.width
        ).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({
        path: testInfo.outputPath(`agent-log-${viewport.width}.png`),
        fullPage: false
      });

      await page
        .getByRole("button", { name: "Clear log", exact: true })
        .click();
      await expect(
        log.getByText("Waiting for this specialist to start working…", {
          exact: true
        })
      ).toBeVisible();

      await page.locator(".run-step-node", { hasText: "Coder" }).click();
      await expect(
        log.getByText("Output only for coder: SSH exposed on 22/tcp.", {
          exact: true
        })
      ).toBeVisible();
      await expect(
        log.getByText("Output only for scanner", { exact: false })
      ).toHaveCount(0);
      expect(streams).toContain("coder");
    });
});
