import { test, expect, expect as browserExpect } from "playwright/test";

// Local React browser fixture only. Never calls production, inference or scanners.
test.describe("run lifecycle in the browser", () => {
  for (const viewport of [
    { width: 1440, height: 1000, remote: false },
    { width: 390, height: 844, remote: false },
    { width: 1440, height: 1000, remote: true },
    { width: 1440, height: 1000, remote: false, recent: true },
    { width: 390, height: 844, remote: false, recent: true }
  ])
    test(`manages lifecycle and fences stale State at ${viewport.width} px / remote=${viewport.remote} / recent=${"recent" in viewport && viewport.recent}`, async ({
      context,
      page,
      baseURL
    }) => {
      const origin = baseURL!;
      await page.setViewportSize({
        width: viewport.width,
        height: viewport.height
      });
      const original = {
        id: "run-lifecycle",
        status: "completed",
        baselineRepo: "repo",
        inputCommit: "a".repeat(40),
        maxDepth: 4,
        maxJobs: 32,
        lifecycle: "active",
        lifecycleRevision: 0
      };
      const job = {
        id: "job-report",
        runId: original.id,
        role: "reporter",
        status: "completed",
        revision: 1,
        nativeSession: true,
        outputCommit: "b".repeat(40)
      };
      let current = { ...original },
        purged = false,
        failDelete = true;
      let publish: (
        revision: number,
        purgedRunIds?: string[],
        runs?: (typeof original)[]
      ) => void = () => {};
      const calls: Array<{ path: string; method: string; body: unknown }> = [];
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
          publish = (revision, purgedRunIds = [], runs = [original]) =>
            socket.send(
              JSON.stringify({
                type: "cf_agent_state",
                state: { revision, runs, jobs: [job], purgedRunIds }
              })
            );
          publish(1, purged ? [original.id] : []);
        }
      );

      await page.route("**/v1/ui/**", async (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        calls.push({
          path,
          method: request.method(),
          body: request.postData()
        });
        const json = (value: unknown, status = 200) =>
          route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify(value)
          });
        // Deliberately include all metadata in each view; local filtering must still work.
        if (path === "/v1/ui/runs")
          return json({ runs: purged ? [] : [current] });
        if (path.endsWith("/jobs")) return json({ run: current, jobs: [job] });
        if (/\/(archive|trash|restore)$/.test(path)) {
          current = {
            ...current,
            lifecycle: path.endsWith("/archive")
              ? "archived"
              : path.endsWith("/trash")
                ? "trashed"
                : "active",
            lifecycleRevision: current.lifecycleRevision + 1
          };
          return json({ run: current, jobs: [job] });
        }
        if (request.method() === "DELETE") {
          if (failDelete) {
            failDelete = false;
            current = {
              ...current,
              lifecycle: "trashed",
              lifecycleRevision: current.lifecycleRevision + 1
            };
            return json(
              {
                error:
                  "Remote scanner outcomes must be reconciled before deletion"
              },
              409
            );
          }
          purged = true;
          return json({ runId: original.id, deleted: true });
        }
        if (path.endsWith("/events"))
          return route.fulfill({
            status: 200,
            contentType: "text/event-stream",
            body: `event: snapshot\ndata: ${JSON.stringify({ messages: [{ id: "history", type: "user", text: "Preserved investigation" }], job, busy: false, pending: [], cursor: 1 })}\n\nevent: end\ndata: {}\n\n`
          });
        if (path.endsWith("/files"))
          return json({
            runId: current.id,
            commit: job.outputCommit,
            files: []
          });
        if (path.endsWith("/session-controls"))
          return json({
            session: "ses",
            canReply: false,
            forms: [],
            permissions: [],
            usage: {
              stats: {
                steps: 0,
                tokens: { input: 0, output: 0 },
                cost: 0,
                tools: { mode: "summary", totals: { calls: 0, failed: 0 } }
              },
              limits: null,
              limitsStatus: "not-connected"
            }
          });
        return json({ error: "Unknown fixture route" }, 404);
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
      await page.goto(`${origin}?run=${original.id}&job=${job.id}`);
      if (viewport.width < 760)
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
      await browserExpect(
        page.getByRole("link", { name: "Dashboard", exact: true })
      ).toBeVisible();
      if (viewport.width < 760)
        await page
          .getByRole("button", { name: "Close navigation", exact: true })
          .click();
      if (viewport.remote) {
        await browserExpect(
          page.getByText("Preserved investigation", { exact: true })
        ).toBeVisible();
        publish(2, [original.id]);
        await browserExpect(
          page.getByText("Preserved investigation", { exact: true })
        ).toHaveCount(0);
        publish(3);
        await browserExpect(page.locator(".run-row")).toHaveCount(0);
        await browserExpect(
          page.getByRole("heading", { name: "No active runs" })
        ).toBeVisible();
        return;
      }
      if ("recent" in viewport && viewport.recent) {
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
        await page.goto(`${origin}/dashboard`);
        await page
          .getByRole("button", {
            name: `Delete run ${original.id}`,
            exact: true
          })
          .click();
        const dialog = page.getByRole("dialog"),
          remove = dialog.getByRole("button", {
            name: "Permanently delete run",
            exact: true
          });
        await dialog.getByRole("textbox").fill("wrong-run");
        await browserExpect(remove).toBeDisabled();
        await dialog.getByRole("textbox").fill(original.id);
        await browserExpect(remove).toBeEnabled();
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        expect(calls.some((call) => call.method === "DELETE")).toBe(false);
        await page
          .getByRole("button", {
            name: `Delete run ${original.id}`,
            exact: true
          })
          .click();
        await dialog.getByRole("textbox").fill(original.id);
        await remove.click();
        await browserExpect(dialog).toContainText("Remote scanner outcomes");
        // Simulate the lifecycle update removing this row from the retained filter.
        publish(2, [], [current]);
        await browserExpect(
          page.getByRole("button", {
            name: `Delete run ${original.id}`,
            exact: true
          })
        ).toHaveCount(0);
        await browserExpect(dialog).toContainText("Remote scanner outcomes");
        await remove.click();
        await browserExpect(
          page.getByText("No runs yet", { exact: true })
        ).toBeVisible();
        publish(3);
        await browserExpect(
          page.getByRole("button", {
            name: `Delete run ${original.id}`,
            exact: true
          })
        ).toHaveCount(0);
        expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(
          2
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth
          )
        ).toBe(true);
        return;
      }
      const manage = async () => {
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
        await page.goto(`${origin}/dashboard/runs/${original.id}`);
        await page
          .getByRole("button", { name: "Run details", exact: true })
          .click();
      };
      await manage();
      await page
        .getByRole("button", { name: "Archive run", exact: true })
        .click();
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
      await page.goto(`${origin}?run=${original.id}&job=${job.id}`);
      await browserExpect(
        page.getByRole("textbox", { name: /^Message / })
      ).toHaveCount(0);
      await browserExpect(
        page.getByRole("button", { name: "Attach files" })
      ).toHaveCount(0);
      await browserExpect(
        page.getByText("Preserved investigation", { exact: true })
      ).toBeVisible();
      await manage();
      await page
        .getByRole("button", { name: "Restore run", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Move run to Trash", exact: true })
        .click();
      await browserExpect(page.getByRole("dialog")).toContainText(
        "chats and files"
      );
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Move to Trash", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Delete run", exact: true })
        .click();
      await browserExpect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Permanently delete run", exact: true })
      ).toBeDisabled();
      await page.getByRole("dialog").getByRole("textbox").fill(original.id);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Permanently delete run", exact: true })
        .click();
      await browserExpect(page.getByRole("dialog")).toContainText(
        "Remote scanner outcomes"
      );
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
      await page.goto(`${origin}?run=${original.id}&job=${job.id}`);
      await browserExpect(
        page.getByText("Preserved investigation", { exact: true })
      ).toBeVisible();
      await manage();
      await page
        .getByRole("button", { name: "Delete run", exact: true })
        .click();
      await browserExpect(
        page
          .getByRole("dialog")
          .getByRole("button", { name: "Permanently delete run", exact: true })
      ).toBeDisabled();
      await page.getByRole("dialog").getByRole("textbox").fill(original.id);
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Permanently delete run", exact: true })
        .click();
      await browserExpect(
        page.getByText("No runs yet", { exact: true })
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
      expect(
        calls.some((call) =>
          /\/(steer|revisions|interrupt|cancel)$/.test(call.path)
        )
      ).toBe(false);
      expect(
        JSON.parse(
          calls.filter((call) => call.method === "DELETE").at(-1)!
            .body as string
        )
      ).toEqual({ confirm: original.id });
    });
});
