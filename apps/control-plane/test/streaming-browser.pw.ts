import {
  test,
  expect,
  expect as browserExpect
} from "../../../scripts/browser-qa/fixtures.mts";

// Real EventSource bytes, with the text-end frame withheld until assertions finish.
// Local API/model substitutes only; no production target, provider or scanner.
test.describe("continuous native streaming chat", () => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 }
  ])
    test(`streams actual partial text and groups tool steps at ${viewport.width} px`, async ({
      context,
      page,
      baseURL,
      request
    }) => {
      const origin = baseURL!;
      await page.setViewportSize(viewport);
      const id = `live-${viewport.width}`;
      context.setDefaultTimeout(7000);
      const run = {
        id: `run-${id}`,
        status: "running",
        baselineRepo: "fixture",
        inputCommit: "a".repeat(40),
        maxDepth: 4,
        maxJobs: 32,
        target: {
          name: "Local stream fixture",
          url: "https://scope.invalid/",
          kind: "website"
        }
      };
      const job = {
        id,
        runId: run.id,
        role: "primary",
        task: "Assess the supplied project",
        status: "running",
        revision: 1,
        nativeSession: true
      };
      const endpoint = `/__fixtures/streams/${id}`;
      const update = async (data: unknown) => {
        const response = await request.post(endpoint, { data });
        expect(response.ok()).toBe(true);
      };
      const connections = async () =>
        (await (await request.get(endpoint)).json()).connections;
      await update({ snapshot: { messages: [], pending: [], busy: true } });
      const emit = (event: unknown) => update({ event });
      let publishLifecycle: (
        lifecycle: "active" | "archived"
      ) => void = () => {};
      let stateRevision = 1;
      await context.routeWebSocket(
        "**/agents/coordinator/global*",
        (socket) => {
          publishLifecycle = (lifecycle) =>
            socket.send(
              JSON.stringify({
                type: "cf_agent_state",
                state: {
                  revision: ++stateRevision,
                  runs: [
                    { ...run, lifecycle, lifecycleRevision: stateRevision }
                  ],
                  jobs: [job]
                }
              })
            );
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
        }
      );

      const browserErrors: string[] = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning")
          browserErrors.push(message.text());
      });
      const posts: string[] = [];
      let permissions: unknown[] = [];
      let controlReads = 0;
      await page.route("**/v1/ui/**", (route) => {
        const path = new URL(route.request().url()).pathname,
          json = (body: unknown) =>
            route.fulfill({
              contentType: "application/json",
              body: JSON.stringify(body)
            });
        if (route.request().method() === "POST") posts.push(path);
        if (path.endsWith("/events")) return route.continue();
        if (path === "/v1/ui/runs") return json({ runs: [run] });
        if (path.endsWith("/jobs")) return json({ run, jobs: [job] });
        if (path.endsWith("/files"))
          return json({ runId: run.id, commit: "a".repeat(40), files: [] });
        if (path.endsWith("/session-controls")) {
          controlReads++;
          return json({
            session: "ses_root",
            canReply: true,
            forms: [],
            permissions,
            usage: {
              stats: {
                steps: 2,
                tokens: { input: 10, output: 5 },
                cost: 0,
                tools: { mode: "summary", totals: { calls: 1, failed: 0 } }
              },
              limits: null,
              limitsStatus: "not-connected"
            }
          });
        }
        return json({ ok: true });
      });
      try {
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
        await page.goto(`${origin}?run=${run.id}&job=${id}`);
        await browserExpect(
          page.getByRole("heading", { name: "Primary", exact: true })
        ).toBeVisible();
        expect(await page.title()).toBe("PentCloud Control Room");
        const composer = page.getByRole("textbox", {
          name: "Message Primary",
          exact: true
        });
        const initialHeight = (await composer.boundingBox())!.height;
        await composer.fill(
          "Line one\nLine two\nLine three\nLine four\nLine five"
        );
        await browserExpect
          .poll(async () => (await composer.boundingBox())!.height)
          .toBeGreaterThan(initialHeight);
        await composer.fill("");
        await browserExpect
          .poll(async () => (await composer.boundingBox())!.height)
          .toBe(initialHeight);
        await browserExpect(page.locator("vite-error-overlay")).toHaveCount(0);
        await browserExpect.poll(connections).toBe(1);
        await emit({
          type: "message_start",
          messageId: "first",
          agent: "primary",
          model: { providerID: "opencode-go", id: "fixture" }
        });
        await emit({
          type: "text_delta",
          messageId: "first",
          ordinal: 0,
          delta: "I am inspecting the supplied project."
        });
        await browserExpect(page.locator(".message-assistant")).toContainText(
          "I am inspecting the supplied project."
        );
        // There has been no text_end/message_end yet: this must be genuinely live prose.
        await emit({
          type: "text_end",
          messageId: "first",
          ordinal: 0,
          text: "I am inspecting the supplied project."
        });
        await emit({
          type: "reasoning_delta",
          messageId: "first",
          ordinal: 0,
          delta: "PRIVATE_REASONING"
        });
        await emit({
          type: "reasoning_end",
          messageId: "first",
          ordinal: 0,
          text: "PRIVATE_REASONING"
        });
        await emit({
          type: "tool_start",
          messageId: "first",
          toolCallId: "browser",
          name: "cloudflare_browser",
          input: { private: "PRIVATE_TOOL_ARGUMENT" }
        });
        await browserExpect(
          page.getByRole("button", { name: /Using the browser/ })
        ).toBeVisible();
        await emit({
          type: "tool_end",
          messageId: "first",
          toolCallId: "browser",
          name: "cloudflare_browser",
          error: false,
          output: "HTTP 200"
        });
        await emit({
          type: "message_end",
          messageId: "first",
          finish: "tool-calls"
        });
        await emit({
          type: "message_start",
          messageId: "second",
          agent: "primary",
          model: { providerID: "opencode-go", id: "fixture" }
        });
        await emit({
          type: "text_delta",
          messageId: "second",
          ordinal: 0,
          delta: "",
          text: "The response is available"
        });
        await emit({
          type: "text_delta",
          messageId: "second",
          ordinal: 0,
          delta: "",
          text: "The response is available for review."
        });
        await browserExpect(page.locator(".message-assistant")).toHaveCount(1);
        await browserExpect(page.locator(".message-assistant")).toContainText(
          "The response is available for review."
        );
        await browserExpect(
          page.locator(".message-assistant .message-avatar")
        ).toHaveCount(0);
        await browserExpect(
          page.getByText("PRIVATE_TOOL_ARGUMENT", { exact: false })
        ).toBeHidden();
        await browserExpect(
          page.getByText("PRIVATE_REASONING", { exact: true })
        ).toBeHidden();
        if (process.env.PENTCLOUD_CAPTURE_UI) {
          await browserExpect
            .poll(() =>
              page
                .locator(".prose-block [data-sd-animate]")
                .evaluateAll((elements) =>
                  elements.every(
                    (el) => Number(getComputedStyle(el).opacity) >= 0.99
                  )
                )
            )
            .toBe(true);
          await page.screenshot({
            path: `${process.env.PENTCLOUD_CAPTURE_UI}/pentcloud-streaming-${viewport.width}.png`
          });
        }
        const activityToggle = page.getByRole("button", { name: /Activity/ });
        await browserExpect
          .poll(async () => (await activityToggle.boundingBox())!.height)
          .toBeLessThan(30);
        await activityToggle.click();
        await browserExpect
          .poll(
            async () =>
              (await page
                .getByRole("button", { name: /^Reasoning/ })
                .first()
                .boundingBox())!.height
          )
          .toBeLessThan(30);
        await page.getByRole("button", { name: /cloudflare browser/ }).click();
        await browserExpect(
          page.getByText("PRIVATE_TOOL_ARGUMENT", { exact: false })
        ).toBeVisible();
        // Reasoning ordinals restart in each native message. Both rows must retain
        // their identity, and finishing an inline spinner must not resize the row.
        const reasoningRows = page.getByRole("button", { name: /^Reasoning/ });
        const settledHeight = (await reasoningRows.first().boundingBox())!
          .height;
        await emit({
          type: "reasoning_delta",
          messageId: "second",
          ordinal: 0,
          delta: "SECOND_PRIVATE_REASONING"
        });
        await browserExpect(reasoningRows).toHaveCount(2);
        await browserExpect(
          reasoningRows
            .last()
            .getByRole("status", { name: "Loading", exact: true })
        ).toBeVisible();
        await browserExpect
          .poll(async () => (await reasoningRows.last().boundingBox())!.height)
          .toBe(settledHeight);
        await emit({
          type: "reasoning_end",
          messageId: "second",
          ordinal: 0,
          text: "SECOND_PRIVATE_REASONING"
        });
        await browserExpect(
          reasoningRows
            .last()
            .getByRole("status", { name: "Loading", exact: true })
        ).toHaveCount(0);
        expect((await reasoningRows.last().boundingBox())!.height).toBe(
          settledHeight
        );
        await reasoningRows.first().click();
        await browserExpect(
          page.getByText("PRIVATE_REASONING", { exact: true })
        ).toBeVisible();
        await browserExpect(
          page.getByText("SECOND_PRIVATE_REASONING", { exact: true })
        ).toBeHidden();
        await reasoningRows.last().click();
        await browserExpect(
          page.getByText("SECOND_PRIVATE_REASONING", { exact: true })
        ).toBeVisible();
        await page.getByRole("button", { name: /Activity/ }).click();
        // A fresh native snapshot replaces partially streamed text when EventSource reconnects.
        const snapshot = {
          messages: [
            {
              id: "first",
              type: "assistant",
              time: { completed: 1 },
              content: [
                { type: "text", text: "I am inspecting the supplied project." }
              ]
            },
            {
              id: "second",
              type: "assistant",
              time: { created: 1 },
              content: [{ type: "text", text: "" }]
            }
          ],
          pending: [],
          busy: true,
          pendingSpans: ["second:text:0"]
        };
        await update({ snapshot, disconnect: true });
        await browserExpect(page.locator(".current-activity")).toContainText(
          "Reconnecting"
        );
        await browserExpect.poll(connections, { timeout: 7000 }).toBe(2);
        await browserExpect(page.locator(".message-assistant")).toContainText(
          "The response is available for review."
        );
        await browserExpect(page.locator(".current-activity")).toContainText(
          "Restoring response"
        );
        await emit({
          type: "text_end",
          messageId: "second",
          ordinal: 0,
          text: "The response is available for review."
        });
        await emit({
          type: "message_end",
          messageId: "second",
          finish: "stop"
        });
        await browserExpect(page.locator(".message-assistant")).toHaveCount(1);
        expect(await page.locator(".message-assistant").innerText()).toMatch(
          /^I am inspecting the supplied project\.\s+The response is available for review\./
        );
        // New deltas must not drag an operator away from older text they are reading.
        await emit({
          type: "message_start",
          messageId: "long",
          agent: "primary",
          model: { providerID: "opencode-go", id: "fixture" }
        });
        await emit({
          type: "text_delta",
          messageId: "long",
          ordinal: 0,
          delta: "Review context.\n\n".repeat(100)
        });
        const scroll = page.locator(".message-scroll");
        await browserExpect
          .poll(() =>
            scroll.evaluate((el) => el.scrollHeight > el.clientHeight)
          )
          .toBe(true);
        await scroll.evaluate((el) => {
          el.scrollTop = 0;
          el.dispatchEvent(new Event("scroll", { bubbles: true }));
        });
        await browserExpect(
          page.getByRole("button", { name: "Jump to latest", exact: true })
        ).toBeVisible();
        await emit({
          type: "text_delta",
          messageId: "long",
          ordinal: 0,
          delta: "Additional live result."
        });
        await browserExpect(page.locator(".message-assistant")).toContainText(
          "Additional live result."
        );
        expect(await scroll.evaluate((el) => el.scrollTop)).toBeLessThan(40);
        await page
          .getByRole("button", { name: "Jump to latest", exact: true })
          .click();
        await browserExpect(
          page.getByRole("button", { name: "Jump to latest", exact: true })
        ).toHaveCount(0);
        if (viewport.width < 760)
          expect((await scroll.boundingBox())!.height).toBeGreaterThan(220);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth
          )
        ).toBe(true);
        await browserExpect(
          page.getByRole("textbox", { name: "Message Primary" })
        ).toHaveCSS("font-size", "14px");
        const mode = await page.locator("html").getAttribute("data-mode");
        await page
          .getByRole("button", { name: "Toggle theme", exact: true })
          .click();
        await browserExpect(page.locator("html")).toHaveAttribute(
          "data-mode",
          mode === "dark" ? "light" : "dark"
        );
        const before = controlReads;
        permissions = [
          {
            id: "perm_attention",
            sessionID: "ses_root",
            action: "fixture request",
            resources: []
          }
        ];
        await emit({ type: "permission_asked", permission: permissions[0] });
        await browserExpect(
          page
            .getByRole("region", { name: "Native session controls" })
            .getByText("Needs your answer", { exact: true })
        ).toBeVisible({ timeout: 2000 });
        await browserExpect.poll(() => controlReads).toBeGreaterThan(before);
        await browserExpect
          .poll(() => page.title())
          .toBe("Needs your answer · PentCloud");
        await browserExpect(page.locator(".current-activity")).toContainText(
          "Needs your answer"
        );
        if (process.env.PENTCLOUD_CAPTURE_UI)
          await page.screenshot({
            path: `${process.env.PENTCLOUD_CAPTURE_UI}/pentcloud-attention-${viewport.width}.png`
          });
        publishLifecycle("archived");
        await browserExpect(
          page.locator(".current-activity")
        ).not.toContainText("Needs your answer");
        await browserExpect
          .poll(() => page.title())
          .toBe("PentCloud Control Room");
        await browserExpect(
          page.getByRole("textbox", { name: "Message Primary" })
        ).toHaveCount(0);
        publishLifecycle("active");
        await browserExpect(page.locator(".current-activity")).toContainText(
          "Needs your answer"
        );
        permissions = [];
        await emit({
          type: "permission_replied",
          permissionId: "perm_attention",
          reply: "reject"
        });
        await browserExpect
          .poll(() => page.title())
          .toBe("PentCloud Control Room");
        await page
          .getByRole("button", { name: "Stop attempt", exact: true })
          .click();
        await browserExpect
          .poll(() => posts)
          .toContain(`/v1/ui/jobs/${id}/interrupt`);
        // The deliberate EventSource socket destruction above produces one Chromium network diagnostic.
        expect(
          browserErrors.filter(
            (message) =>
              message !==
              "Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING"
          )
        ).toEqual([]);
        expect(
          browserErrors.filter(
            (message) =>
              message ===
              "Failed to load resource: net::ERR_INCOMPLETE_CHUNKED_ENCODING"
          )
        ).toHaveLength(1);
      } finally {
        await request.delete(endpoint);
      }
    });
});
