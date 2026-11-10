import {
  test,
  expect,
  expect as browserExpect
} from "../../../scripts/browser-qa/fixtures.mts";
import { SETTINGS_ROLES } from "../src/ui/settings/model";

// Isolated local API fixtures: no production requests, model calls or scanners.
test.describe("agent conversations and report reader", () => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 }
  ])
    test(`isolates agent chats, retains navigation and reads the accepted report at ${viewport.width} px`, async ({
      context,
      page,
      baseURL
    }) => {
      const origin = baseURL!;
      await page.setViewportSize(viewport);
      const commit = "b".repeat(40),
        run = {
          id: "run-conversations",
          status: "running",
          baselineRepo: "repo",
          inputCommit: "a".repeat(40),
          maxDepth: 4,
          maxJobs: 32
        };
      const make = (id: string, role: string, order: number, patch = {}) => ({
        id,
        runId: run.id,
        role,
        task:
          role === "searcher"
            ? `Search task ${order}`
            : "Coordinate assessment",
        conversationOrder: order,
        status: "created",
        revision: 1,
        nativeSession: true,
        ...patch
      });
      const jobs = [
        make("p", "primary", 1, { status: "waiting" }),
        make("s1", "searcher", 2, { status: "completed" }),
        make("s2", "searcher", 3, { status: "waiting" }),
        make("s3", "searcher", 4),
        make("report", "reporter", 5, {
          status: "completed",
          outputCommit: commit
        }),
        make("s1-retry", "searcher", 2, {
          logicalThreadId: "s1",
          attempt: 2,
          revisionOf: "s1",
          status: "running"
        })
      ];
      const assessment =
        "# Assessment deliverable\n\n## Findings\n\nConfirmed access control issue.\n\n## Coverage\n\nSQL injection: not assessed.\n\n![remote](https://evidence.invalid/image.png)\n\n<script>window.evil=true</script>\n";
      const calls: { path: string; method: string }[] = [];
      let releaseRevision: () => void = () => {};
      const revisionGate = new Promise<void>((resolve) => {
        releaseRevision = resolve;
      });
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
      const outside: string[] = [];
      await page.route("https://evidence.invalid/**", (route) => {
        outside.push(route.request().url());
        return route.abort();
      });
      await page.route("**/v1/ui/**", (route) => {
        const request = route.request(),
          url = new URL(request.url()),
          path = url.pathname;
        calls.push({ path, method: request.method() });
        const json = (value: unknown) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(value)
          });
        if (path === "/v1/ui/runs") return json({ runs: [run] });
        if (path.endsWith("/jobs")) return json({ run, jobs });
        if (path.endsWith("/events")) {
          const job = jobs.find((j) => path.includes("/" + j.id + "/"))!;
          return route.fulfill({
            contentType: "text/event-stream",
            body: `event: snapshot\ndata: ${JSON.stringify({
              job,
              messages: [
                {
                  id: job.id + "-text",
                  type: "assistant",
                  time: { completed: 1 },
                  content: [
                    { type: "text", text: "Messages only for " + job.id },
                    {
                      type: "tool",
                      id: "tool-" + job.id,
                      name: "browser",
                      state: {
                        status: "completed",
                        input: { private: "PRIVATE_TOOL_ARGUMENT" },
                        content: [{ type: "text", text: "HTTP 200" }]
                      }
                    }
                  ]
                }
              ],
              busy: job.status === "running",
              pending: [],
              cursor: 1
            })}\n\nevent: end\ndata: {}\n\n`
          });
        }
        if (path.endsWith("/files"))
          return json({
            runId: run.id,
            commit,
            files: [
              {
                path: "security-assessment.md",
                name: "security-assessment.md",
                size: new TextEncoder().encode(assessment).length,
                mediaType: "text/plain",
                kind: "output",
                commit,
                previewable: true
              }
            ]
          });
        if (path.endsWith("/file"))
          return route.fulfill({
            body: assessment,
            contentType: "application/octet-stream"
          });
        if (path.endsWith("/report"))
          return route.fulfill({
            body: "Reviewer verdict: SUCCESS. See `security-assessment.md`.",
            contentType: "text/markdown",
            headers: { "X-Source-Commit": commit }
          });
        if (path.endsWith("/steer")) return json({ ok: true });
        if (path.endsWith("/revisions"))
          return revisionGate.then(() => {
            const job = make("s1-next", "searcher", 2, {
              logicalThreadId: "s1",
              revisionOf: "s1",
              attempt: 3
            });
            jobs.push(job);
            return json({ job });
          });
        if (path.endsWith("/session-controls"))
          return json({
            session: "session",
            canReply: true,
            forms: [],
            permissions: [],
            usage: {
              stats: {
                steps: 1,
                tokens: { input: 5, output: 3 },
                cost: 0,
                tools: { mode: "summary", totals: { calls: 1, failed: 0 } }
              },
              limits: null,
              limitsStatus: "not-connected"
            }
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
      await page.goto(`${origin}?run=${run.id}&job=s1-retry`);
      await browserExpect(
        page.getByRole("heading", { name: "Searcher 1", exact: true })
      ).toBeVisible();
      if (viewport.width < 760)
        expect(
          (await page.locator(".workspace").boundingBox())?.width
        ).toBeGreaterThanOrEqual(viewport.width - 1);
      await browserExpect(
        page.getByText("Messages only for s1-retry", { exact: true })
      ).toBeVisible();
      await browserExpect(
        page.getByText("PRIVATE_TOOL_ARGUMENT", { exact: false })
      ).toBeHidden();
      const openNav = async () => {
        if (viewport.width < 760)
          await page
            .getByRole("button", { name: "Open navigation", exact: true })
            .click();
      };
      await page
        .getByRole("textbox", { name: "Message Searcher 1", exact: true })
        .fill("Unsent searcher one draft");
      await openNav();
      await browserExpect(page.locator(".job-row")).toHaveCount(5);
      await page
        .getByRole("button", { name: "Searcher 2", exact: true })
        .click();
      await browserExpect(
        page.getByRole("heading", { name: "Searcher 2", exact: true })
      ).toBeVisible();
      await browserExpect(
        page.getByText("Messages only for s1-retry", { exact: true })
      ).toHaveCount(0);
      expect(new URL(page.url()).searchParams.get("job")).toBe("s2");
      await page.goBack();
      await browserExpect(
        page.getByRole("textbox", { name: "Message Searcher 1", exact: true })
      ).toHaveValue("Unsent searcher one draft");
      await browserExpect(
        page.getByRole("heading", { name: "Searcher 1", exact: true })
      ).toBeVisible();
      await page.reload();
      await browserExpect(
        page.getByRole("heading", { name: "Searcher 1", exact: true })
      ).toBeVisible();
      await page
        .getByRole("textbox", { name: "Message Searcher 1", exact: true })
        .fill("Focus on the reports endpoint.");
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await browserExpect
        .poll(() => calls.filter((c) => c.method === "POST").map((c) => c.path))
        .toEqual(["/v1/ui/jobs/s1-retry/steer"]);
      await page
        .getByRole("button", { name: "Conversation details", exact: true })
        .click();
      await page
        .getByRole("tab", { name: "Attempt 1 · completed", exact: true })
        .click();
      await page
        .getByRole("textbox", { name: "Message Searcher 1", exact: true })
        .fill("Review the saved findings again.");
      await page
        .getByRole("button", { name: "Send message", exact: true })
        .click();
      await browserExpect
        .poll(() => calls.some((c) => c.path === "/v1/ui/jobs/s1/revisions"))
        .toBe(true);
      await openNav();
      await page
        .getByRole("button", { name: "Searcher 2", exact: true })
        .click();
      await browserExpect(
        page.getByRole("heading", { name: "Searcher 2", exact: true })
      ).toBeVisible();
      await page
        .getByRole("textbox", { name: "Message Searcher 2", exact: true })
        .fill("Keep this newer draft");
      const revisionResponse = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/v1/ui/jobs/s1/revisions"
      );
      releaseRevision();
      await (await revisionResponse).finished();
      await page.waitForLoadState("networkidle");
      await browserExpect(
        page.getByRole("textbox", { name: "Message Searcher 2", exact: true })
      ).toHaveValue("Keep this newer draft");
      await browserExpect(
        page.getByRole("heading", { name: "Searcher 2", exact: true })
      ).toBeVisible();
      expect(new URL(page.url()).searchParams.get("job")).toBe("s2");
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
      await page.goto(`${origin}/dashboard/runs/${run.id}`);
      await page
        .locator(".run-management")
        .getByRole("button", { name: "Open report", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await browserExpect(
        dialog.getByRole("heading", {
          name: "Assessment deliverable",
          exact: true
        })
      ).toBeVisible();
      await browserExpect(
        dialog.getByText("SQL injection: not assessed.", { exact: true })
      ).toBeVisible();
      await browserExpect(
        dialog.getByText("Reviewer verdict:", { exact: false })
      ).toBeHidden();
      await browserExpect(dialog.locator("img,script")).toHaveCount(0);
      await browserExpect(
        dialog.getByRole("link", { name: "Markdown", exact: true })
      ).toHaveAttribute(
        "href",
        `/v1/ui/runs/${run.id}/file?commit=${commit}&path=security-assessment.md`
      );
      await page.emulateMedia({ media: "print" });
      await browserExpect(page.locator("#root")).toHaveCSS("display", "none");
      await browserExpect(page.locator(".assessment-document")).toHaveCSS(
        "visibility",
        "visible"
      );
      await page.emulateMedia({ media: "screen" });
      await dialog
        .getByRole("button", { name: "Close report", exact: true })
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
      await page.goto(`${origin}/dashboard?run=${run.id}&job=s2`);
      await page.getByRole("link", { name: "Open chats", exact: true }).click();
      await browserExpect(
        page.getByRole("heading", { name: "Searcher 2", exact: true })
      ).toBeVisible();
      expect(outside).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
    });
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 }
  ])
    test(`uses native settings controls at ${viewport.width} px`, async ({
      page,
      baseURL
    }) => {
      const origin = baseURL!;
      await page.setViewportSize(viewport);
      const errors: string[] = [];
      const roles = Object.fromEntries(
        SETTINGS_ROLES.map((role) => [
          role.id,
          {
            promptFormat: "markdown",
            promptTemplate: `Instructions for ${role.label}`,
            upstreamPromptDigest: "a".repeat(64),
            model: "opencode-go:fixture",
            reasoningEffort: "default"
          }
        ])
      );
      const model = {
        id: "opencode-go:fixture",
        name: "Fixture model",
        provider: "opencode-go",
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportedParameters: ["tools"],
        reasoningEfforts: ["default", "max"]
      };
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/v1/ui/**", (route) => {
        const path = new URL(route.request().url()).pathname,
          json = (value: unknown) =>
            route.fulfill({
              contentType: "application/json",
              body: JSON.stringify(value)
            });
        if (path.endsWith("/settings/models"))
          return json({
            models: [
              model,
              {
                ...model,
                id: "opencode-go:alternate",
                name: "Alternate fixture"
              }
            ],
            fetchedAt: "2026-11-03T00:00:00Z",
            stale: false
          });
        if (path.endsWith("/settings"))
          return json({
            settings: {
              schemaVersion: 1,
              revision: "b".repeat(64),
              upstreamManifestDigest: "c".repeat(64),
              savedAt: "2026-11-03T00:00:00Z",
              savedBy: "fixture owner",
              roles
            },
            casRevision: 1,
            locked: false,
            blockingRunIds: [],
            upstreamRoles: roles
          });
        if (path.endsWith("/agent-connection"))
          return json({
            endpoint: "https://customer.example/mcp",
            browser: true
          });
        if (path.endsWith("/runtime-diagnostics"))
          return json({
            coordinator: {},
            backlog: { waiting: 0, oldestWaitingMs: 0 }
          });
        return json({});
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
      await page.goto(`${origin}/settings`);
      await browserExpect(
        page.getByRole("heading", { name: "Prompts and models", exact: true })
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Connect your agent", exact: true })
        .click();
      await browserExpect(
        page.getByText("https://customer.example/mcp", { exact: true })
      ).toBeVisible();
      await browserExpect(
        page.getByText(
          "Sign in through Cloudflare Access with your operator account.",
          { exact: true }
        )
      ).toBeVisible();
      await browserExpect(
        page.getByText(/Your agent client must also run in the cloud/)
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
      if (process.env.PENTCLOUD_CAPTURE_UI)
        await page
          .getByRole("link", { name: "Managed OAuth", exact: true })
          .scrollIntoViewIfNeeded();
      if (process.env.PENTCLOUD_CAPTURE_UI)
        await page.screenshot({
          path: `${process.env.PENTCLOUD_CAPTURE_UI}/pentcloud-agent-connection-${viewport.width}.png`
        });
      await page
        .getByRole("button", { name: "Connect your agent", exact: true })
        .click();
      if (viewport.width < 721) {
        await page
          .getByRole("combobox", { name: "Agent", exact: true })
          .click();
        await page.getByRole("option", { name: "Coder", exact: true }).click();
      } else
        await page.getByRole("button", { name: "Coder", exact: true }).click();
      await browserExpect(
        page.getByRole("textbox", {
          name: "Coder prompt template",
          exact: true
        })
      ).toHaveValue("Instructions for Coder");
      await page
        .getByRole("combobox", { name: "Search connected models", exact: true })
        .fill("Alternate");
      await page.getByRole("option", { name: /Alternate fixture/ }).click();
      await page
        .getByRole("combobox", { name: "Reasoning effort", exact: true })
        .click();
      await page.getByRole("option", { name: "max", exact: true }).click();
      await browserExpect(
        page.getByRole("combobox", {
          name: "Reasoning effort",
          exact: true
        })
      ).toContainText("max");
      await page
        .getByRole("textbox", { name: "Coder prompt template", exact: true })
        .fill("Edited fixture instructions");
      if (viewport.width < 721)
        await browserExpect(
          page.getByRole("combobox", { name: "Agent", exact: true })
        ).toContainText("Coder");
      else
        await browserExpect(
          page.getByRole("button", { name: "Coder Edited", exact: true })
        ).toBeVisible();
      await page
        .getByRole("button", { name: "Discard draft", exact: true })
        .click();
      await browserExpect(
        page.getByRole("textbox", {
          name: "Coder prompt template",
          exact: true
        })
      ).toHaveValue("Instructions for Coder");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth
        )
      ).toBe(true);
      await browserExpect(page.locator("vite-error-overlay")).toHaveCount(0);
      expect(errors).toEqual([]);
      if (process.env.PENTCLOUD_CAPTURE_UI) {
        await page
          .locator(".settings-scroll")
          .evaluate((el) => (el.scrollTop = 0));
        await browserExpect(
          viewport.width < 721
            ? page.getByRole("combobox", { name: "Agent", exact: true })
            : page.getByRole("button", { name: "Coder", exact: true })
        ).toBeInViewport();
        await page.screenshot({
          path: `${process.env.PENTCLOUD_CAPTURE_UI}/pentcloud-settings-${viewport.width}.png`
        });
        if (viewport.width < 721) {
          await page
            .getByRole("combobox", {
              name: "Reasoning effort",
              exact: true
            })
            .scrollIntoViewIfNeeded();
          await page.screenshot({
            path: `${process.env.PENTCLOUD_CAPTURE_UI}/pentcloud-reasoning-${viewport.width}.png`
          });
        }
      }
    });
  test("keeps native questions, required fields, custom choices and permissions working with Kumo", async ({
    context,
    page,
    baseURL
  }) => {
    const origin = baseURL!;
    await page.setViewportSize({ width: 390, height: 844 });
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const run = {
      id: "run-questions",
      status: "running",
      baselineRepo: "fixture",
      inputCommit: "a".repeat(40),
      maxDepth: 4,
      maxJobs: 32
    };
    const job = {
      id: "questions",
      runId: run.id,
      role: "primary",
      task: "Local question fixture",
      status: "running",
      revision: 1,
      nativeSession: true
    };
    const form = {
      id: "frm_fixture",
      sessionID: "ses_root",
      title: "Assessment choices",
      fields: [
        { key: "proceed", type: "boolean", title: "Proceed", required: true },
        {
          key: "hidden",
          type: "string",
          title: "Conditional answer",
          when: [{ key: "proceed", op: "eq", value: true }]
        },
        {
          key: "approach",
          type: "string",
          title: "Approach",
          required: true,
          custom: true,
          options: [
            {
              value: "focused",
              label: "Focused",
              description: "Keep the supplied scope"
            }
          ]
        },
        {
          key: "checks",
          type: "multiselect",
          title: "Checks",
          required: true,
          custom: true,
          options: [
            {
              value: "headers",
              label: "Headers",
              description: "Check response headers"
            }
          ]
        },
        {
          key: "limit",
          type: "integer",
          title: "Limit",
          minimum: 1,
          maximum: 3,
          required: true
        },
        {
          key: "external",
          type: "external",
          title: "External step",
          url: "https://scope.invalid/login"
        }
      ]
    };
    const replies: Array<{ path: string; body: unknown }> = [];
    let answered = false,
      permitted = false;
    await context.routeWebSocket("**/agents/coordinator/global*", (socket) => {
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
          state: { revision: 1, runs: [run], jobs: [job] }
        })
      );
    });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning")
        errors.push(message.text());
    });
    await page.route("**/v1/ui/**", (route) => {
      const request = route.request(),
        path = new URL(request.url()).pathname,
        json = (value: unknown) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(value)
          });
      if (request.method() === "POST") {
        replies.push({ path, body: request.postDataJSON() });
        if (path.includes("/forms/")) answered = true;
        if (path.includes("/permissions/")) permitted = true;
        return json({ ok: true });
      }
      if (path === "/v1/ui/runs") return json({ runs: [run] });
      if (path.endsWith("/jobs")) return json({ run, jobs: [job] });
      if (path.endsWith("/events"))
        return route.fulfill({
          contentType: "text/event-stream",
          body: `event: snapshot\ndata: ${JSON.stringify({ messages: [{ id: "copy-fixture", type: "assistant", time: { completed: 1 }, content: [{ type: "text", text: "```bash\nprintf copy-fixture\n```\n\n| Check | Result |\n| --- | --- |\n| Fixture | Complete |" }] }], pending: [], busy: true })}\n\nevent: end\ndata: {}\n\n`
        });
      if (path.endsWith("/session-controls"))
        return json({
          session: "ses_root",
          canReply: true,
          forms: answered ? [] : [form],
          permissions: permitted
            ? []
            : [
                {
                  id: "perm_fixture",
                  sessionID: "ses_root",
                  action: "fixture",
                  resources: ["local fixture"]
                }
              ],
          usage: {
            stats: {
              steps: 1,
              tokens: { input: 1, output: 1 },
              cost: 0,
              tools: { mode: "summary", totals: { calls: 0, failed: 0 } }
            },
            limits: null,
            limitsStatus: "not-connected"
          }
        });
      return json({ ok: true });
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
    await page.goto(`${origin}?run=${run.id}&job=${job.id}`);
    await browserExpect(
      page.getByText("Assessment choices", { exact: true })
    ).toBeVisible();
    await page.getByRole("button", { name: "Copy Code", exact: true }).click();
    await browserExpect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("printf copy-fixture");
    await browserExpect(
      page.getByRole("button", { name: "Copy table", exact: true })
    ).toBeVisible();
    await browserExpect(
      page.getByRole("button", {
        name: /Download file|Download table|View fullscreen/
      })
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Send answer", exact: true })
      .click();
    expect(replies).toEqual([]);
    await page.getByRole("combobox", { name: "Proceed", exact: true }).click();
    await page.getByRole("option", { name: "No", exact: true }).click();
    await browserExpect(
      page.getByRole("textbox", { name: "Conditional answer" })
    ).toHaveCount(0);
    await page.getByRole("combobox", { name: "Approach", exact: true }).click();
    await browserExpect(
      page.getByRole("option", { name: "Focused", exact: true })
    ).toBeVisible();
    await browserExpect(
      page.getByText("Focused: Keep the supplied scope", { exact: true })
    ).toBeVisible();
    await page
      .getByRole("option", { name: "Type your own answer", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Approach custom answer", exact: true })
      .fill("Review the supplied context");
    await page.getByRole("combobox", { name: "Checks", exact: true }).click();
    await browserExpect(
      page.getByRole("option", { name: "Headers", exact: true })
    ).toBeVisible();
    await browserExpect(
      page.getByText("Headers: Check response headers", { exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await browserExpect(
      page.getByRole("link", { name: "External step", exact: true })
    ).toHaveCount(0);
    await page
      .getByRole("textbox", { name: "Checks custom choices", exact: true })
      .fill("Authentication");
    await page
      .getByRole("spinbutton", { name: "Limit", exact: true })
      .fill("0");
    await page
      .getByRole("checkbox", { name: "I completed this step", exact: true })
      .check();
    await page
      .getByRole("button", { name: "Send answer", exact: true })
      .click();
    expect(replies).toEqual([]);
    await page
      .getByRole("spinbutton", { name: "Limit", exact: true })
      .fill("2");
    await page
      .getByRole("button", { name: "Send answer", exact: true })
      .click();
    await browserExpect.poll(() => replies.length).toBe(1);
    expect(replies[0]).toEqual({
      path: "/v1/ui/jobs/questions/forms/frm_fixture/reply",
      body: {
        session: "ses_root",
        answer: {
          proceed: false,
          approach: "Review the supplied context",
          checks: ["Authentication"],
          limit: 2,
          external: true
        }
      }
    });
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await browserExpect.poll(() => replies.length).toBe(2);
    expect(replies[1]).toEqual({
      path: "/v1/ui/jobs/questions/permissions/perm_fixture/reply",
      body: { session: "ses_root", decision: "once" }
    });
    expect(errors).toEqual([]);
  });
});
