import {
  test,
  expect,
  expect as browserExpect
} from "../../../scripts/browser-qa/fixtures.mts";
test.describe("target-first setup in a real browser", () => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 }
  ])
    test(
      "stops a setup-stage run without opening chat at " +
        viewport.width +
        "px",
      async ({ context, page, baseURL }) => {
        const origin = baseURL!;
        await page.setViewportSize(viewport);
        const target = {
          id: "target-stop",
          kind: "website",
          name: "Stop fixture",
          url: "https://owned.example/",
          revision: 1,
          archived: false
        };
        let run: any = {
          id: "run-stop",
          phase: "setup",
          status: "waiting",
          target,
          baselineRepo: "fixture",
          inputCommit: "a".repeat(40),
          maxDepth: 4,
          maxJobs: 48
        };
        let job: any = {
          id: "discovery-stop",
          runId: run.id,
          role: "pentester",
          tool: "native_discovery",
          status: "created",
          revision: 1
        };
        const writes: string[] = [];
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
                state: { revision: 1, runs: [run], jobs: [job] }
              })
            );
          }
        );
        await page.route("**/v1/ui/**", async (route) => {
          const request = route.request(),
            path = new URL(request.url()).pathname;
          const json = (value: unknown) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(value)
            });
          if (request.method() === "POST") writes.push(path);
          if (path.endsWith("/cancel")) {
            run = { ...run, phase: "cancelled", status: "interrupted" };
            job = { ...job, status: "interrupted", revision: 2 };
            return json({ cancelled: true, draining: false });
          }
          if (path === "/v1/ui/runs") return json({ runs: [run] });
          if (path.endsWith("/jobs")) return json({ run, jobs: [job] });
          if (path === "/v1/ui/onboarding")
            return json({
              run,
              targets: [target],
              credentials: [],
              defaults: [],
              draft: { revision: 0, publicAPI: true, updatedBy: "owner" },
              readiness: {
                modelsTested: false,
                apiTested: true,
                discoverySettled: false
              }
            });
          if (path === "/v1/ui/settings/models")
            return json({
              models: [],
              stale: false,
              fetchedAt: new Date().toISOString()
            });
          if (path.endsWith("/events"))
            return route.fulfill({
              status: 200,
              contentType: "text/event-stream",
              body: "event: end\ndata: {}\n\n"
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
        await page.goto(origin + "?run=" + run.id + "&job=" + job.id);
        const management = page;
        await browserExpect(
          page.getByRole("heading", { name: "OpenCode models", exact: true })
        ).toBeVisible();
        await management
          .getByRole("button", { name: "Stop run", exact: true })
          .click();
        await browserExpect(
          management.getByRole("button", { name: "Stop run", exact: true })
        ).toHaveCount(0);
        expect(run.phase).toBe("cancelled");
        expect(job.status).toBe("interrupted");
        expect(writes).toEqual(["/v1/ui/runs/run-stop/cancel"]);
      }
    );
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 390, height: 844 }
  ])
    test(
      "saves and reuses a target, opens chat during discovery with Cloudflare secrets at " +
        viewport.width +
        "px",
      async ({ context, page, baseURL }) => {
        const origin = baseURL!;
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: "reduce" });
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        page.on("console", (message) => {
          if (
            message.type() === "error" &&
            !message.text().includes("Failed to load resource: net::ERR_FAILED")
          )
            pageErrors.push(message.text());
        });
        let target: any,
          run: any,
          job: any,
          primary: any,
          draft: any = { revision: 0, publicAPI: true, updatedBy: "owner" },
          modelsTested = false,
          revision = 0;
        const discoveryFailed = viewport.width === 390;
        let loseCreate = viewport.width === 1440;
        let publish = () => {};
        const requests: { path: string; value: any }[] = [];
        const credentials: any[] = [
          {
            id: "bound-go",
            purpose: "model",
            label: "OpenCode workspace key · Cloudflare",
            version: 0,
            revoked: false
          }
        ];
        const model = {
          id: "opencode-go:deepseek-v4-pro",
          modelId: "deepseek-v4-pro",
          provider: "opencode-go",
          name: "DeepSeek V4 Pro",
          route: "go",
          adapter: "chat-completions",
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportedParameters: [],
          reasoningEfforts: ["default"]
        };
        await context.routeWebSocket(
          "**/agents/coordinator/global*",
          (socket) => {
            const state = () =>
              socket.send(
                JSON.stringify({
                  type: "cf_agent_state",
                  state: {
                    revision: ++revision,
                    runs: run ? [run] : [],
                    jobs: job ? [job, ...(primary ? [primary] : [])] : []
                  }
                })
              );
            publish = state;
            socket.send(
              JSON.stringify({
                type: "cf_agent_identity",
                name: "global",
                agent: "coordinator",
                stateFollows: true
              })
            );
            state();
          }
        );
        await page.route("**/v1/ui/**", async (route) => {
          const req = route.request(),
            url = new URL(req.url()),
            path = url.pathname,
            value = req.postData() ? req.postDataJSON() : undefined;
          requests.push({ path, value });
          const json = (v: unknown) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(v)
            });
          if (path.includes("/onboarding/pending/"))
            return json(run ? { accepted: { run, rootJob: job } } : {});
          if (path.endsWith("/onboarding"))
            return json({
              targets: target ? [target] : [],
              credentials,
              defaults: [],
              ...(run
                ? {
                    run,
                    draft,
                    discovery: [job],
                    readiness: {
                      modelsTested,
                      apiTested: true,
                      discoverySettled:
                        run.phase === "setup" && run.discoveryDrained === true
                    }
                  }
                : {})
            });
          if (path.endsWith("/settings/models"))
            return json({
              models:
                url.searchParams.get("route") === "go"
                  ? [
                      model,
                      {
                        ...model,
                        id: "opencode-go:alternate",
                        modelId: "alternate",
                        name: "Alternate model"
                      }
                    ]
                  : [
                      {
                        ...model,
                        id: "opencode:byok/conn_fixture123/muse-spark-1.3",
                        modelId: "muse-spark-1.3",
                        provider: "opencode",
                        route: "console",
                        connectionId: "conn_fixture123",
                        name: "Meta BYOK · Muse Spark 1.3"
                      }
                    ],
              fetchedAt: new Date().toISOString(),
              stale: false
            });
          if (path.endsWith("/target.save")) {
            target = {
              ...value,
              revision: 1,
              archived: false,
              url: "https://owned.example/",
              createdAt: 1,
              updatedAt: 1,
              updatedBy: "owner"
            };
            return json(target);
          }
          if (path.endsWith("/target.check"))
            return json({
              classification: "reachable",
              status: 200,
              url: target.url
            });
          if (path.endsWith("/credential.save")) {
            const c = {
              id: value.id,
              purpose: "model",
              label: value.label,
              version: 1,
              revoked: false
            };
            credentials.push(c);
            return json(c);
          }
          if (path.endsWith("/setup.save")) {
            if (value.revision !== draft.revision)
              return route.fulfill({
                status: 409,
                contentType: "application/json",
                body: JSON.stringify({ error: "Setup changed" })
              });
            draft = {
              ...value.draft,
              revision: draft.revision + 1,
              updatedBy: "owner"
            };
            return json(draft);
          }
          if (path.endsWith("/model.test")) {
            modelsTested = true;
            publish();
            return json({ testedAt: Date.now() });
          }
          if (path === "/v1/ui/runs" && req.method() === "GET")
            return json({ runs: run ? [run] : [] });
          if (path === "/v1/ui/runs" && req.method() === "POST") {
            run = {
              id: value.run_id,
              phase: "discovery",
              status: "running",
              target,
              baselineRepo: "fixture",
              inputCommit: "a".repeat(40),
              maxDepth: 4,
              maxJobs: 48
            };
            job = {
              id: "discovery-1",
              runId: run.id,
              role: "pentester",
              tool: "native_discovery",
              status: "created",
              revision: 1,
              model: "none"
            };
            publish();
            if (loseCreate) {
              loseCreate = false;
              return route.abort("failed");
            }
            return json({ run, rootJob: job });
          }
          if (path.endsWith("/jobs"))
            return json({ run, jobs: [job, ...(primary ? [primary] : [])] });
          if (path.endsWith("/analysis")) {
            run = { ...run, phase: "primary", status: "running" };
            primary = {
              ...job,
              id: "primary-1",
              role: "primary",
              tool: "primary",
              status: "created",
              model: model.id,
              nativeSession: true,
              preparingConversation: true
            };
            return json({ run, rootJob: primary });
          }
          if (path.endsWith("/discovery.acknowledge")) {
            run = { ...run, discoveryAcknowledged: true };
            publish();
            return json({ acknowledged: true });
          }
          if (path.endsWith("/session-controls"))
            return json({
              session: "ses_root",
              canReply: true,
              forms: [],
              permissions: [],
              usage: {
                stats: {
                  steps: 0,
                  tokens: {
                    input: 0,
                    output: 0,
                    reasoning: 0,
                    cache: { read: 0, write: 0 }
                  },
                  cost: 0,
                  tools: { mode: "summary", totals: { calls: 0, failed: 0 } }
                },
                limits: null,
                limitsStatus: "not-connected"
              }
            });
          if (path.endsWith("/events"))
            return route.fulfill({
              status: 200,
              contentType: "text/event-stream",
              body: 'event: snapshot\ndata: {"messages":[{"id":"fixture-assistant","type":"assistant","content":[{"type":"text","text":"We can discuss your project while discovery runs."}]}],"pending":[],"busy":false}\n\nevent: end\ndata: {}\n\n'
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
        await page.goto(origin);
        expect(new URL(page.url()).origin).toBe(new URL(origin).origin);
        expect(await page.title()).toContain("PentCloud");
        await browserExpect(page.locator("vite-error-overlay")).toHaveCount(0);
        await page.getByLabel("Name", { exact: true }).fill("My project");
        await page.getByLabel("Website address").fill("owned.example");
        await page
          .getByRole("button", { name: "Save target", exact: true })
          .click();
        await browserExpect(
          page.getByRole("button", { name: "Verify address & start discovery" })
        ).toBeDisabled();
        expect(requests.some((r) => r.path.endsWith("/target.check"))).toBe(
          false
        );
        await page
          .getByRole("checkbox", { name: /I own this project/ })
          .check();
        await page
          .getByRole("button", { name: "Verify address & start discovery" })
          .click();
        if (viewport.width === 1440) {
          await browserExpect(page.getByRole("alert")).toBeVisible();
          expect(new URL(page.url()).searchParams.get("draft")).toBe(run.id);
          await page.reload();
        }
        await browserExpect(
          page.getByRole("heading", { name: "OpenCode models", exact: true })
        ).toBeVisible();
        const progress = page.getByRole("region", {
          name: "Discovery progress",
          exact: true
        });
        await browserExpect(
          progress.getByText("Waiting for discovery to start", { exact: true })
        ).toBeVisible();
        await browserExpect(
          progress.getByLabel("Discovery in progress", { exact: true })
        ).toBeVisible();
        await browserExpect(
          page.getByLabel("Default model", { exact: true })
        ).toBeEnabled();
        await browserExpect(
          page.getByRole("combobox", { name: "Default model", exact: true })
        ).toHaveText("Choose an OpenCode model");
        expect(
          requests.filter((r) => r.path === "/v1/ui/runs" && r.value).length
        ).toBe(1);
        expect(
          requests.find((r) => r.path === "/v1/ui/runs" && r.value)?.value
        ).toMatchObject({
          target_id: target.id,
          target_revision: 1,
          authorized: true
        });
        expect(requests.some((r) => r.path.endsWith("/model.test"))).toBe(
          false
        );
        await browserExpect(
          page.getByRole("button", { name: "Open chat" })
        ).toBeDisabled();
        await browserExpect(
          page.getByLabel("New OpenCode key", { exact: true })
        ).toHaveCount(0);
        await browserExpect(
          page.getByRole("button", { name: "Save new key", exact: true })
        ).toHaveCount(0);
        await page
          .getByText("Configure OpenCode in Cloudflare", { exact: true })
          .click();
        await browserExpect(
          page.getByRole("button", { name: "Manage Cloudflare secrets" })
        ).toBeVisible();
        await page
          .getByRole("combobox", { name: "Default model", exact: true })
          .click();
        await page
          .getByRole("option", { name: "DeepSeek V4 Pro", exact: true })
          .click();
        await page
          .getByText("Choose models for individual agents", { exact: true })
          .click();
        await browserExpect(page.getByLabel("Reporter model")).toBeVisible();
        await page
          .getByRole("combobox", { name: "Reporter model", exact: true })
          .click();
        await page
          .getByRole("option", {
            name: "Meta BYOK · Muse Spark 1.3",
            exact: true
          })
          .click();
        await browserExpect(
          page.getByRole("combobox", { name: "Reporter model", exact: true })
        ).toHaveText("Meta BYOK · Muse Spark 1.3");
        const size = await page
          .getByText("Use an OpenCode Console or Go key", { exact: false })
          .evaluate((el) => getComputedStyle(el).fontSize);
        expect(size).toBe("14px");
        job = { ...job, status: "running", revision: 2 };
        publish();
        await browserExpect(
          progress.getByText("Preparing discovery and checking your target", {
            exact: true
          })
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Test selected models", exact: true })
          .click();
        await browserExpect(
          page.getByText(
            "Selected OpenCode models passed the native connection test.",
            { exact: true }
          )
        ).toBeVisible();
        expect(
          requests.some(
            (request) =>
              request.path.endsWith("/model.test") &&
              request.value?.choice?.model ===
                "opencode:byok/conn_fixture123/muse-spark-1.3" &&
              request.value.choice.credentialId === "bound-go"
          )
        ).toBe(true);
        await browserExpect(
          page.getByRole("button", { name: "Open chat" })
        ).toBeEnabled();
        if (process.env.PENTCLOUD_SCREENSHOT_DIR) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.locator(".onboarding").evaluate((el) => el.scrollTo(0, 0));
          await page.screenshot({
            path:
              process.env.PENTCLOUD_SCREENSHOT_DIR +
              "/pentcloud-discovery-loading-" +
              viewport.width +
              ".png",
            fullPage: true
          });
        }
        draft = {
          ...draft,
          revision: draft.revision + 1,
          profile: {
            ...draft.profile,
            default: {
              ...draft.profile.default,
              model: "opencode-go:alternate"
            }
          }
        };
        job = { ...job, revision: job.revision + 1 };
        publish();
        await browserExpect(
          page.getByRole("combobox", { name: "Default model", exact: true })
        ).toHaveText("Alternate model");
        await page
          .getByRole("combobox", { name: "Default model", exact: true })
          .click();
        await page
          .getByRole("option", { name: "DeepSeek V4 Pro", exact: true })
          .click();
        draft = { ...draft, revision: draft.revision + 1 };
        job = { ...job, revision: job.revision + 1 };
        publish();
        await browserExpect(
          page.getByRole("button", { name: "Reload saved setup" })
        ).toBeVisible();
        await browserExpect(
          page.getByRole("button", { name: "Open chat" })
        ).toBeDisabled();
        await browserExpect(
          page.getByRole("button", { name: "Save setup", exact: true })
        ).toBeDisabled();
        await page.getByRole("button", { name: "Reload saved setup" }).click();
        await browserExpect(
          page.getByRole("combobox", { name: "Default model", exact: true })
        ).toHaveText("Alternate model");
        await browserExpect(
          page.getByRole("button", { name: "Open chat" })
        ).toBeEnabled();

        await page
          .getByRole("button", { name: "Open chat", exact: true })
          .click();
        await browserExpect(
          page.getByRole("textbox", { name: /^Message / })
        ).toBeEnabled();
        await browserExpect(
          page
            .locator(".chat-header")
            .getByText("Preparing assessment", { exact: true })
        ).toBeVisible();
        await browserExpect(
          page.getByRole("button", { name: "Attach files", exact: true })
        ).toHaveCount(0);
        if (process.env.PENTCLOUD_SCREENSHOT_DIR)
          await page.screenshot({
            path:
              process.env.PENTCLOUD_SCREENSHOT_DIR +
              "/pentcloud-chat-layout-" +
              viewport.width +
              ".png"
          });
        await browserExpect(
          page.getByText("We can discuss your project while discovery runs.", {
            exact: true
          })
        ).toBeInViewport();
        await page
          .getByRole("textbox", { name: /^Message / })
          .fill("Please review the project goals while the scanner starts");
        await page
          .getByRole("button", { name: "Send message", exact: true })
          .click();
        expect(
          requests.find((request) => request.path.endsWith("/primary-1/steer"))
            ?.value
        ).toMatchObject({
          message: "Please review the project goals while the scanner starts"
        });
        await browserExpect(
          page.getByRole("textbox", { name: /^Message / })
        ).toHaveValue("");
        await browserExpect(
          page.getByRole("button", { name: "Stop attempt", exact: true })
        ).toBeEnabled();
        expect(
          requests.some((request) => request.path.includes("browser-live-view"))
        ).toBe(false);
        if (process.env.PENTCLOUD_SCREENSHOT_DIR)
          await page.screenshot({
            path:
              process.env.PENTCLOUD_SCREENSHOT_DIR +
              "/pentcloud-early-chat-" +
              viewport.width +
              ".png",
            fullPage: true
          });
        await page.getByLabel("Discovery status and details").click();
        run = { ...run, discoveryDrained: false };
        job = {
          ...job,
          status: discoveryFailed ? "failed" : "completed",
          revision: job.revision + 1
        };
        publish();
        const chatProgress = page.getByRole("region", {
          name: "Discovery progress",
          exact: true
        });
        await browserExpect(
          chatProgress.getByText(
            discoveryFailed
              ? "Discovery needs attention"
              : "Finishing discovery",
            { exact: true }
          )
        ).toBeVisible();
        const continueAssessment = page.getByRole("button", {
          name: "Accept incomplete discovery & continue assessment"
        });
        if (discoveryFailed)
          await browserExpect(continueAssessment).toBeDisabled();
        run = { ...run, discoveryDrained: true };
        job = { ...job, revision: job.revision + 1 };
        publish();
        if (discoveryFailed) {
          await browserExpect(continueAssessment).toBeEnabled();
          await continueAssessment.click();
        }
        await browserExpect(chatProgress).toHaveCount(0);
        await browserExpect(
          page.getByRole("textbox", { name: /^Message / })
        ).toBeEnabled();
        if (process.env.PENTCLOUD_SCREENSHOT_DIR)
          await page.screenshot({
            path:
              process.env.PENTCLOUD_SCREENSHOT_DIR +
              "/pentcloud-onboarding-" +
              viewport.width +
              ".png",
            fullPage: true
          });
        primary = {
          ...primary,
          status: "invalid_result",
          inputError: "File input could not be admitted",
          revision: primary.revision + 1
        };
        publish();
        await browserExpect(
          page.getByText("Assessment input rejected", { exact: true })
        ).toBeVisible();
        await browserExpect(
          page.getByText("We can discuss your project while discovery runs.", {
            exact: true
          })
        ).toBeVisible();
        if (viewport.width < 900)
          await page.getByRole("button", { name: "Open navigation" }).click();
        await page
          .getByRole("link", { name: "Dashboard", exact: true })
          .click();
        await page.getByRole("tab", { name: "Targets", exact: true }).click();
        await browserExpect(
          page.getByRole("heading", { name: "Your targets" })
        ).toBeVisible();
        await browserExpect(
          page.getByRole("button", { name: /My project.*owned.example/ })
        ).toBeVisible();
        await browserExpect(page.locator("vite-error-overlay")).toHaveCount(0);
        expect(pageErrors).toEqual([]);
      }
    );
});
