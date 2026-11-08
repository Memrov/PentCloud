import { test, expect } from "playwright/test";
import fs from "node:fs/promises";
import { join } from "node:path";

// Local UI contract smoke only. API/SSE fixtures never start a paid model or toolbox.
test.use({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
test("native UI contracts across desktop and mobile", async ({
  page,
  baseURL
}, testInfo) => {
  test.setTimeout(120_000);
  const origin = baseURL;
  const screenshotDir =
    process.env.PENTCLOUD_UI_SCREENSHOT_DIR ?? testInfo.outputPath("evidence");
  await fs.mkdir(screenshotDir, { recursive: true });
  const run = {
    id: "run-1",
    status: "running",
    baselineRepo: "native-fixture",
    inputCommit: "a".repeat(40),
    maxDepth: 4,
    maxJobs: 32
  };
  const jobs = [
    {
      id: "job-1",
      runId: run.id,
      role: "primary",
      tool: "primary",
      depth: 0,
      status: "running",
      revision: 2,
      model: "opencode-go:deepseek-v4-pro",
      task: "Inspect the authorized fixture",
      logicalThreadId: "job-1",
      attempt: 1,
      nativeSession: true
    },
    {
      id: "job-coder",
      runId: run.id,
      parentJobId: "job-1",
      role: "coder",
      tool: "coder",
      depth: 1,
      status: "completed",
      revision: 3,
      model: "opencode-go:deepseek-v4-pro",
      logicalThreadId: "job-coder",
      attempt: 1,
      outputCommit: "b".repeat(40),
      nativeSession: true
    },
    {
      id: "job-legacy",
      runId: run.id,
      role: "searcher",
      tool: "searcher",
      depth: 1,
      status: "completed",
      revision: 4,
      archiveStatus: "complete"
    },
    {
      id: "job-legacy-no-metadata",
      runId: run.id,
      role: "adviser",
      tool: "adviser",
      depth: 1,
      status: "failed",
      revision: 3
    }
  ];
  const roleIds = [
    "primary",
    "adviser",
    "coder",
    "maintenance",
    "memorist",
    "pentester",
    "searcher"
  ];
  const roles = Object.fromEntries(
    roleIds.map((id) => [
      id,
      {
        promptFormat: "markdown",
        promptTemplate: `\t${id} template {{ .Task }}\r\n  original guidance  \r\n\r\n`,
        upstreamPromptDigest: "a".repeat(64),
        model: "opencode-go:deepseek-v4-pro",
        reasoningEffort: "default"
      }
    ])
  );
  let settings = {
    settings: {
      schemaVersion: 1,
      revision: "b".repeat(64),
      upstreamManifestDigest: "c".repeat(64),
      savedAt: "2026-10-31T00:00:00Z",
      savedBy: "fixture-operator",
      roles
    },
    casRevision: 3,
    locked: false,
    blockingRunIds: [],
    upstreamRoles: Object.fromEntries(
      roleIds.map((id) => [
        id,
        {
          promptFormat: "markdown",
          promptTemplate: `# ${id} default instructions`,
          upstreamPromptDigest: "a".repeat(64)
        }
      ])
    )
  };
  const catalog = {
    models: [
      {
        id: "opencode-go:deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        provider: "opencode-go",
        contextLength: 128000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        supportedParameters: [],
        reasoningEfforts: ["default"]
      }
    ],
    fetchedAt: "2026-10-31T00:00:00Z",
    stale: false
  };
  catalog.models.push(
    {
      ...catalog.models[0],
      id: "anthropic/claude-fixture",
      name: "Claude Fixture",
      provider: "anthropic",
      reasoningEfforts: ["low", "high"]
    },
    {
      ...catalog.models[0],
      id: "openai/gpt-fixture",
      name: "GPT Fixture",
      provider: "openai"
    }
  );
  const calls = [];
  /** @type {import('../apps/control-plane/src/ui/api.ts').UIRuntimeDiagnostics} */
  let runtimeDiagnostics = {
    coordinator: {
      recovery: {
        reason: "alarm_memory_limit",
        sealed: true,
        observedAt: 100,
        purgedJobs: 2
      },
      version: { id: "fixture-runtime-v1" }
    },
    backlog: { waiting: 1, oldestWaitingMs: 2000 }
  };
  const recoveryCalls = () =>
    calls.filter(
      (call) =>
        call.path === "/v1/ui/runtime-recovery" && call.method === "POST"
    );
  const recoveryEvidence = [];
  let recoveryConflictResponses = 0;
  const sessionControls = {
    session: "ses_root",
    canReply: true,
    forms: [
      {
        id: "frm_operator",
        sessionID: "ses_root",
        title: "Operator question",
        fields: [
          {
            key: "continue",
            title: "Continue?",
            type: "boolean",
            required: true
          },
          {
            key: "approach",
            title: "Approach",
            type: "string",
            options: [{ value: "safe", label: "Safe choice" }],
            required: true,
            when: [{ key: "continue", op: "eq", value: true }]
          }
        ]
      }
    ],
    permissions: [
      {
        id: "per_operator",
        sessionID: "ses_root",
        action: "fixture.read",
        resources: ["exact-fixture-resource"]
      }
    ],
    usage: {
      stats: {
        steps: 2,
        tokens: {
          input: 1200,
          output: 350,
          reasoning: 20,
          cache: { read: 0, write: 0 }
        },
        cost: 0,
        tools: {
          mode: "summary",
          totals: { calls: 1, succeeded: 1, failed: 0, unfinished: 0 }
        }
      },
      limits: null,
      limitsStatus: "not-connected"
    }
  };
  const operatorQuestion = sessionControls.forms[0],
    operatorPermission = sessionControls.permissions[0];
  const stockQuestion = {
    id: "frm_native_custom",
    sessionID: "ses_root",
    title: "Native question choices",
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Approach preference",
        description: "Which approach should continue?",
        options: [
          {
            value: "Focused",
            label: "Focused",
            description: "Keep the existing scope"
          },
          {
            value: "Broader",
            label: "Broader",
            description: "Include the optional section"
          }
        ],
        custom: true
      },
      {
        key: "details",
        type: "string",
        title: "Focused details",
        when: [{ key: "q0", op: "eq", value: "Focused" }]
      }
    ]
  };
  const consoleErrors = [];
  const expectedConflictConsoleErrors = [];
  const externalRequests = [];
  const stateSockets = new Set();
  const clientStateWrites = [];
  let holdNextRunJobs = false;
  let heldRunJobsBody;
  let releaseHeldRunJobs;
  const stateEvidence = [];
  let stateRevision = 0;
  const stateProjection = () => ({
    revision: stateRevision,
    runs: [run],
    jobs: jobs.filter((job) => job.nativeSession)
  });
  const broadcastState = () => {
    stateRevision++;
    for (const socket of stateSockets)
      socket.send(
        JSON.stringify({ type: "cf_agent_state", state: stateProjection() })
      );
  };
  await page.routeWebSocket(
    (url) => url.pathname === "/agents/coordinator/global",
    (socket) => {
      stateSockets.add(socket);
      socket.onClose(() => stateSockets.delete(socket));
      socket.onMessage((message) => {
        const value = JSON.parse(String(message));
        if (value.type === "cf_agent_state") clientStateWrites.push(value);
      });
      socket.send(
        JSON.stringify({
          type: "cf_agent_identity",
          name: "global",
          agent: "coordinator",
          stateFollows: true
        })
      );
      socket.send(
        JSON.stringify({ type: "cf_agent_state", state: stateProjection() })
      );
    }
  );
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("request", (request) => {
    if (new URL(request.url()).origin !== origin)
      externalRequests.push(request.url());
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (
      message.location().url === origin + "/v1/ui/runtime-recovery" &&
      /409/.test(message.text()) &&
      expectedConflictConsoleErrors.length < recoveryConflictResponses
    ) {
      expectedConflictConsoleErrors.push({
        url: message.location().url,
        text: message.text()
      });
    } else consoleErrors.push(message.text());
  });
  await page.route("**/v1/ui/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    calls.push({
      path,
      method: request.method(),
      body: request.postData(),
      headers: request.headers()
    });
    const json = (value) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(value)
      });
    if (path === "/v1/ui/setup")
      return json({
        schemaVersion: 1,
        access: true,
        missing: [],
        storage: true,
        models: true,
        ready: true
      });
    const sse = (body) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        headers: { "cache-control": "no-cache" },
        body
      });
    if (path === "/v1/ui/runs")
      return json({
        runs: [
          run,
          ...Array.from({ length: 23 }, (_, index) => ({
            ...run,
            id: `history-${String(index).padStart(2, "0")}`,
            status: "completed"
          }))
        ]
      });
    if (path.endsWith("/jobs")) {
      if (holdNextRunJobs) {
        holdNextRunJobs = false;
        // Capture the response before newer State arrives; never read live jobs on release.
        heldRunJobsBody = JSON.stringify({ run, jobs: [jobs[0]] });
        await new Promise((resolve) => {
          releaseHeldRunJobs = resolve;
        });
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: heldRunJobsBody
        });
      }
      return json({ run, jobs });
    }
    if (path.endsWith("/session-controls")) {
      if (path.includes("/job-legacy"))
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "404: Attempt is not initialized" })
        });
      return json({
        ...sessionControls,
        canReply: jobs.some(
          (job) => path.includes("/" + job.id + "/") && job.status === "running"
        )
      });
    }
    if (path.endsWith("/forms/frm_operator/reply")) {
      sessionControls.forms = [];
      return json({ replied: true });
    }
    if (path.endsWith("/forms/frm_native_custom/reply")) {
      sessionControls.forms = [];
      return json({ replied: true });
    }
    if (path.endsWith("/permissions/per_operator/reply")) {
      sessionControls.permissions = [];
      return json({ replied: true });
    }
    if (path === "/v1/ui/settings/models") return json(catalog);
    if (path === "/v1/ui/settings") {
      if (request.method() === "PUT") {
        settings = {
          ...settings,
          casRevision: 4,
          settings: {
            ...settings.settings,
            revision: "d".repeat(64),
            roles: JSON.parse(request.postData()).roles
          }
        };
      }
      return json(settings);
    }
    if (path === "/v1/ui/runtime-diagnostics" && request.method() === "GET")
      return json(runtimeDiagnostics);
    if (path === "/v1/ui/runtime-recovery" && request.method() === "POST") {
      const body = JSON.parse(request.postData());
      const conflict = (error) => {
        recoveryConflictResponses++;
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error })
        });
      };
      if (
        !["coordinator", "attempt"].includes(body.scope) ||
        !Number.isSafeInteger(body.observedAt)
      )
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ error: "invalid runtime recovery identity" })
        });
      const target =
        body.scope === "coordinator"
          ? runtimeDiagnostics.coordinator
          : runtimeDiagnostics.active?.id === body.attemptId
            ? runtimeDiagnostics.active
            : undefined;
      if (
        !target?.recovery?.sealed ||
        target.recovery.observedAt !== body.observedAt
      )
        return conflict(
          "409: platform recovery marker changed; reload diagnostics"
        );
      if (runtimeDiagnostics.active?.unresolvedRemote)
        return conflict(
          "409: reconcile remote scanner outcomes before platform recovery"
        );
      delete target.recovery;
      return json({ resumed: true });
    }
    if (path.endsWith("/revisions")) {
      const fresh = {
        ...jobs[1],
        id: "job-revision",
        revisionOf: "job-coder",
        attempt: 2,
        status: "created",
        revision: 1
      };
      delete fresh.outputCommit;
      jobs.push(fresh);
      broadcastState();
      return json({ job: fresh });
    }
    if (request.method() === "POST") return json({ ok: true });
    if (path.endsWith("/workflow-events"))
      return sse(
        "id: 0\ndata: " +
          JSON.stringify({
            instanceId: path.split("/").at(-2),
            eventId: 0,
            timestamp: Date.now() - 2000,
            type: "run.started"
          }) +
          "\n\nid: 1\ndata: " +
          JSON.stringify({
            instanceId: path.split("/").at(-2),
            eventId: 1,
            timestamp: Date.now() - 1500,
            type: "phase.started",
            stepName: "Primary review"
          }) +
          "\n\nid: 2\ndata: " +
          JSON.stringify({
            instanceId: path.split("/").at(-2),
            eventId: 2,
            timestamp: Date.now() - 1000,
            type: "phase.completed",
            stepName: "Primary review"
          }) +
          "\n\nid: 3\ndata: " +
          JSON.stringify({
            instanceId: path.split("/").at(-2),
            eventId: 3,
            timestamp: Date.now() - 500,
            type: "run.completed"
          }) +
          "\n\nevent: up-to-date\ndata: {}\n\n"
      );
    if (path.includes("/jobs/") && path.endsWith("/events")) {
      const job =
        jobs.find((job) => path.includes("/" + job.id + "/")) ?? jobs[0];
      if (job.id.startsWith("job-legacy"))
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          headers: {
            "cache-control": "no-store",
            "x-legacy-state-commit": "fad4ac3b8c97e1370565d9d968f22e6a2e707ca8"
          },
          body:
            "event: snapshot\ndata: " +
            JSON.stringify({
              messages: [
                {
                  id: "legacy-answer",
                  role: "assistant",
                  parts: [
                    {
                      type: "text",
                      text: "Preserved legacy transcript",
                      state: "done"
                    }
                  ]
                }
              ],
              busy: false,
              pending: [],
              cursor: 0,
              job
            }) +
            "\n\nevent: end\ndata: {}\n\n"
        });
      const settled = job.status === "completed" && !!job.outputCommit;
      const fence = { type: "Error", message: "Attempt has settled" };
      const transcript =
        job.id === "job-state-child"
          ? "Newer State child transcript remains selected."
          : "Native session transcript is ready.";
      return sse(
        "id: 10\nevent: snapshot\ndata: " +
          JSON.stringify({
            messages: [
              {
                id: "msg_user",
                type: "user",
                text: "Inspect the authorized fixture",
                time: { created: 1 }
              },
              {
                id: "msg_answer",
                type: "assistant",
                content: [
                  {
                    type: "reasoning",
                    text: "Review target scope first.",
                    time: { created: 1, completed: 2 }
                  },
                  {
                    type: "tool",
                    id: "call-1",
                    name: "computer_exec",
                    state: {
                      status: "completed",
                      input: { command: "pwd" },
                      content: [
                        {
                          type: "text",
                          text: "/workspace/" + "abcdef0123456789".repeat(80)
                        }
                      ]
                    }
                  },
                  { type: "text", text: transcript }
                ],
                time: { created: 1, completed: 2 }
              },
              ...(settled
                ? [
                    {
                      id: "msg_fence",
                      type: "idle",
                      outcome: "failed",
                      error: fence
                    }
                  ]
                : [])
            ],
            pending: [],
            busy: false,
            job,
            cursor: 10
          }) +
          (settled
            ? "\n\nid: 11\nevent: session\ndata: " +
              JSON.stringify({
                id: "evt_fence",
                created: 4,
                type: "session.execution.failed",
                data: { sessionID: "ses_fixture", error: fence },
                durable: { seq: 11 }
              })
            : "") +
          "\n\nevent: end\ndata: {}\n\n"
      );
    }
    return route.fulfill({ status: 404, body: "unhandled fixture" });
  });
  const assertHealthy = async (label) => {
    await expect(page).toHaveTitle("PentCloud Control Room");
    await expect(page.locator("#root")).not.toBeEmpty();
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    expect(externalRequests).toEqual([]);
    if (consoleErrors.length)
      throw new Error(label + ": " + JSON.stringify(consoleErrors));
  };
  const layouts = [];
  const assertChatLayout = async (label) => {
    const layout = await page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          height: box.height
        };
      };
      const attemptsOpen =
        document
          .querySelector(".conversation-details [aria-expanded]")
          .getAttribute("aria-expanded") === "true";
      return {
        viewport: innerWidth,
        height: innerHeight,
        scrollY,
        header: rect(".chat-header"),
        frame: rect(".app-frame"),
        details: rect(".conversation-details"),
        attemptsOpen,
        ...(attemptsOpen ? { attempts: rect('[role="tablist"]') } : {}),
        messages: rect(".message-scroll"),
        composer: rect(".composer-wrap"),
        toolCards: [...document.querySelectorAll(".tool-card")].map((card) => {
          const box = card.getBoundingClientRect();
          return { left: box.left, right: box.right };
        }),
        actions: [...document.querySelectorAll(".chat-header button")].map(
          (button) => {
            const box = button.getBoundingClientRect();
            return { left: box.left, right: box.right };
          }
        )
      };
    });
    layouts.push({ label, ...layout });
    expect(layout.scrollY).toBe(0);
    expect(layout.frame.height).toBeLessThanOrEqual(layout.height);
    expect(layout.header.top).toBeGreaterThanOrEqual(0);
    expect(layout.details.top).toBeGreaterThanOrEqual(0);
    expect(layout.details.right).toBeLessThanOrEqual(layout.viewport);
    if (layout.attemptsOpen) {
      expect(layout.attempts.top).toBeGreaterThanOrEqual(0);
      expect(layout.attempts.height).toBeLessThan(80);
    }
    expect(layout.messages.height).toBeGreaterThan(200);
    expect(layout.composer.right).toBeLessThanOrEqual(layout.viewport);
    expect(layout.composer.bottom).toBeLessThanOrEqual(layout.height);
    for (const card of layout.toolCards) {
      expect(card.left).toBeGreaterThanOrEqual(0);
      expect(card.right).toBeLessThanOrEqual(layout.viewport);
    }
    for (const action of layout.actions) {
      expect(action.left).toBeGreaterThanOrEqual(0);
      expect(action.right).toBeLessThanOrEqual(layout.viewport);
    }
  };
  const shots = [];
  const choose = async (label, option) => {
    await page.getByLabel(label, { exact: false }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  try {
    holdNextRunJobs = true;
    await page.goto(origin + "/?run=run-1&job=job-1");
    await expect(
      page.getByText("Native session transcript is ready.")
    ).toBeVisible();
    await expect.poll(() => Boolean(releaseHeldRunJobs)).toBe(true);
    expect(JSON.parse(heldRunJobsBody).jobs.map((job) => job.id)).toEqual([
      "job-1"
    ]);
    const stateChild = {
      ...jobs[0],
      id: "job-state-child",
      parentJobId: "job-1",
      logicalThreadId: "job-state-child",
      role: "maintenance",
      tool: "maintenance",
      depth: 1,
      revision: 1
    };
    jobs.push(stateChild);
    broadcastState();
    const stateChildButton = page
      .getByRole("complementary", { name: "Run navigation" })
      .getByRole("button", { name: "Maintenance", exact: true });
    await stateChildButton.click();
    await expect(stateChildButton).toHaveAttribute("data-active", "true");
    await expect(
      page.getByRole("region", { name: "maintenance chat", exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("Newer State child transcript remains selected.", {
        exact: true
      })
    ).toBeVisible();
    const oldRestResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/v1/ui/runs/run-1/jobs" &&
        response.request().method() === "GET"
    );
    releaseHeldRunJobs();
    await (await oldRestResponse).finished();
    await page.waitForLoadState("networkidle");
    await expect(stateChildButton).toHaveAttribute("data-active", "true");
    await expect(
      page.getByRole("region", { name: "maintenance chat", exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("Newer State child transcript remains selected.", {
        exact: true
      })
    ).toBeVisible();
    expect(JSON.parse(heldRunJobsBody).jobs.map((job) => job.id)).toEqual([
      "job-1"
    ]);
    stateEvidence.push({
      state: "selected-newer-State-child-survives-old-REST",
      selectedJob: stateChild.id,
      oldResponseJobs: JSON.parse(heldRunJobsBody).jobs.map((job) => job.id),
      stateRevision
    });
    const lateRestSelection = join(
      screenshotDir,
      "late-rest-state-selection.png"
    );
    await page.screenshot({ path: lateRestSelection });
    shots.push(lateRestSelection);
    jobs.splice(jobs.indexOf(stateChild), 1);
    await page.goto(origin + "/?run=run-1&job=job-1");
    await expect(
      page.getByText("Native session transcript is ready.")
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Conversation details", exact: true })
      .click();
    jobs[0].revision++;
    jobs[0].model = "fixture-state-model";
    broadcastState();
    await expect(
      page.getByText("fixture-state-model", { exact: true })
    ).toBeVisible();
    for (const socket of stateSockets)
      socket.send(
        JSON.stringify({
          type: "cf_agent_state",
          state: {
            ...stateProjection(),
            revision: 0,
            jobs: [{ ...jobs[0], model: "stale-state-model", revision: 1 }]
          }
        })
      );
    await expect(
      page.getByText("fixture-state-model", { exact: true })
    ).toBeVisible();
    jobs[0].revision++;
    jobs[0].model = "opencode-go:deepseek-v4-pro";
    broadcastState();
    await expect(
      page.getByText("opencode-go:deepseek-v4-pro", { exact: true })
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Activity 1 tool", exact: true })
      .click();
    await page
      .getByRole("button", { name: "computer exec Done", exact: true })
      .click();
    await expect(
      page.getByText("Tool: computer_exec", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("Operator question", { exact: true })
    ).toBeVisible();
    await expect(page.getByLabel("Approach", { exact: false })).toHaveCount(0);
    await choose("Continue?", "Yes");
    await choose("Approach", "Safe choice");
    const pendingDesktop = join(screenshotDir, "native-controls-desktop.png");
    await page.screenshot({ path: pendingDesktop });
    shots.push(pendingDesktop);
    await page
      .getByRole("button", { name: "Send answer", exact: true })
      .click();
    await expect(
      page.getByText("Operator question", { exact: true })
    ).toHaveCount(0);
    expect(
      calls.some(
        (call) =>
          call.path.endsWith("/forms/frm_operator/reply") &&
          JSON.parse(call.body).session === "ses_root" &&
          JSON.parse(call.body).answer.continue === true &&
          JSON.parse(call.body).answer.approach === "safe"
      )
    ).toBe(true);
    await page.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Allow once", exact: true })
    ).toHaveCount(0);
    expect(
      calls.some(
        (call) =>
          call.path.endsWith("/permissions/per_operator/reply") &&
          JSON.parse(call.body).decision === "once" &&
          JSON.parse(call.body).session === "ses_root"
      )
    ).toBe(true);
    await page.getByRole("button", { name: "Usage", exact: true }).click();
    await expect(
      page.getByText("2 steps · 1,200 input / 350 output tokens", {
        exact: true
      })
    ).toBeVisible();
    sessionControls.forms = [stockQuestion];
    await page.reload();
    await expect(
      page.getByText("Native question choices", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("Focused: Keep the existing scope", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("Broader: Include the optional section", { exact: true })
    ).toBeVisible();
    await choose("Approach preference", "Focused");
    await page
      .getByLabel("Focused details", { exact: false })
      .fill("Only the existing scope");
    const stockChoices = join(screenshotDir, "native-stock-question.png");
    await page.screenshot({ path: stockChoices });
    shots.push(stockChoices);
    await choose("Approach preference", "Type your own answer");
    await expect(
      page.getByLabel("Focused details", { exact: false })
    ).toHaveCount(0);
    await page
      .getByLabel("Approach preference custom answer", { exact: true })
      .fill("My custom approach");
    const stockCustom = join(screenshotDir, "native-stock-question-custom.png");
    await page.screenshot({ path: stockCustom });
    shots.push(stockCustom);
    await page
      .getByRole("button", { name: "Send answer", exact: true })
      .click();
    await expect(
      page.getByText("Native question choices", { exact: true })
    ).toHaveCount(0);
    expect(
      calls.some(
        (call) =>
          call.path.endsWith("/forms/frm_native_custom/reply") &&
          JSON.stringify(JSON.parse(call.body).answer) ===
            JSON.stringify({ q0: "My custom approach" })
      )
    ).toBe(true);
    await page
      .getByRole("textbox", { name: "Message Primary", exact: true })
      .fill("Continue with the authorized scope");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message Primary", exact: true })
    ).toHaveValue("");
    expect(
      calls.some(
        (call) =>
          call.path.endsWith("/steer") &&
          JSON.parse(call.body).message === "Continue with the authorized scope"
      )
    ).toBe(true);
    await page
      .getByRole("button", { name: "Stop attempt", exact: true })
      .click();
    expect(calls.some((call) => call.path.endsWith("/interrupt"))).toBe(true);
    await page
      .getByRole("button", { name: "Conversation details", exact: true })
      .click();
    await assertHealthy("chat");
    await assertChatLayout("desktop");
    const desktop = join(screenshotDir, "chat-desktop.png");
    await page.screenshot({ path: desktop });
    shots.push(desktop);
    for (const id of ["job-legacy", "job-legacy-no-metadata"]) {
      const start = calls.length;
      await page.goto(origin + "/?run=run-1&job=" + id);
      await expect(
        page.getByText("Preserved legacy transcript", { exact: true })
      ).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(
        calls
          .slice(start)
          .some((call) => call.path.endsWith("/session-controls"))
      ).toBe(false);
      await expect(
        page.getByLabel("Native session controls", { exact: true })
      ).toHaveCount(0);
      await assertHealthy("legacy archive " + id);
      const archiveShot = join(screenshotDir, id + ".png");
      await page.screenshot({ path: archiveShot });
      shots.push(archiveShot);
    }
    await page.goto(origin + "/?run=run-1&job=job-coder");
    await expect(
      page.getByRole("textbox", { name: "Message Coder", exact: true })
    ).toHaveAttribute("placeholder", /fresh revision/);
    await expect(
      page.getByText("Attempt has settled", { exact: false })
    ).toHaveCount(0);
    await page
      .getByRole("textbox", { name: "Message Coder", exact: true })
      .fill("Review the result once more");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Conversation details", exact: true })
      .click();
    await expect(page.getByRole("tab", { name: /Attempt 2/ })).toBeVisible();
    expect(
      calls.some(
        (call) =>
          call.path.endsWith("/revisions") &&
          JSON.parse(call.body).instructions ===
            "Review the result once more" &&
          typeof JSON.parse(call.body).request_id === "string"
      )
    ).toBe(true);
    run.status = "completed";
    jobs.forEach((job) => {
      job.status = "completed";
      job.revision += 1;
    });
    await page.goto(origin + "/dashboard/runs/run-1/jobs/job-coder");
    await expect(page.getByLabel("Run steps")).toBeVisible();
    await expect(
      page.getByText("Primary review", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByText("History complete", { exact: true })
    ).toBeVisible();
    await assertHealthy("dashboard");
    const dashboard = join(screenshotDir, "dashboard-desktop.png");
    await page.screenshot({ path: dashboard });
    shots.push(dashboard);
    settings.settings.roles.primary.model = "retired/saved-model";
    delete settings.settings.roles.primary.promptFormat;
    const originalSettingsRoles = structuredClone(settings.settings.roles);
    const promptDraft =
      "\tPrimary revised template {{- if .Task }}\n  {{ .Task }}  \n{{ end -}}\n\n";
    await page.goto(origin + "/settings");
    await expect(
      page.getByRole("heading", { name: "Prompts and models" })
    ).toBeVisible();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Go template execution is retired" })
    ).toBeVisible();
    await expect(page.getByLabel("Primary prompt template")).toHaveValue(
      originalSettingsRoles.primary.promptTemplate.replaceAll("\r\n", "\n")
    );
    await page
      .getByRole("button", { name: "Reset to default", exact: true })
      .click();
    await expect(page.getByLabel("Primary prompt template")).toHaveValue(
      "# primary default instructions"
    );
    expect(settings.settings.roles.primary).toEqual(
      originalSettingsRoles.primary
    );
    const modelSearch = page.getByRole("combobox", {
      name: "Search connected models",
      exact: true
    });
    const selectedModel = page.locator(".settings-model-selection");
    await expect(modelSearch).toHaveValue("retired/saved-model");
    await expect(selectedModel).toContainText("retired/saved-model");
    await expect(
      page.getByText("Saved selection is not in the connected catalog", {
        exact: true
      })
    ).toBeVisible();
    await modelSearch.fill("missing-search");
    await expect(
      page.getByText("No connected models match this search.", { exact: true })
    ).toBeVisible();
    await modelSearch.press("Escape");
    await expect(selectedModel).toContainText("retired/saved-model");
    await page
      .getByRole("button", { name: "Clear model search", exact: true })
      .click();
    await expect(selectedModel).toContainText("retired/saved-model");
    await modelSearch.fill("anthropic");
    await expect(
      page.getByRole("option", { name: /Claude Fixture/ })
    ).toBeVisible();
    await modelSearch.press("ArrowDown");
    await modelSearch.press("Enter");
    await expect(selectedModel).toContainText("anthropic/claude-fixture");
    await expect(
      page.getByRole("combobox", { name: "Reasoning effort", exact: true })
    ).toContainText("low");
    await modelSearch.fill("openai/gpt-fixture");
    await expect(
      page.getByRole("option", { name: /GPT Fixture/ })
    ).toBeVisible();
    await modelSearch.press("Escape");
    await expect(selectedModel).toContainText("anthropic/claude-fixture");
    await page.getByLabel("Primary prompt template").fill(promptDraft);
    await page
      .locator(".settings-role-rail")
      .getByRole("button")
      .filter({ hasText: "Coder" })
      .click();
    await expect(page.getByLabel("Coder prompt template")).toHaveValue(
      originalSettingsRoles.coder.promptTemplate.replaceAll("\r\n", "\n")
    );
    await page
      .locator(".settings-role-rail")
      .getByRole("button")
      .filter({ hasText: "Primary" })
      .click();
    await expect(page.getByLabel("Primary prompt template")).toHaveValue(
      promptDraft
    );
    await expect(selectedModel).toContainText("anthropic/claude-fixture");
    expect(
      calls.filter(
        (call) => call.method === "PUT" && call.path === "/v1/ui/settings"
      )
    ).toHaveLength(0);
    const themeBefore = await page.locator("html").getAttribute("data-mode");
    await page
      .getByRole("button", { name: "Toggle theme", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-mode",
      themeBefore === "dark" ? "light" : "dark"
    );
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe(
      themeBefore === "dark" ? "light" : "dark"
    );
    await page
      .getByRole("button", { name: "Toggle theme", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: "Runtime diagnostics and recovery",
        exact: true
      })
      .click();
    const recoveryPanel = page.getByRole("region", {
      name: "Runtime recovery",
      exact: true
    });
    await expect(
      recoveryPanel.getByText(
        "Coordinator recovery paused after memory resets",
        { exact: true }
      )
    ).toBeVisible();
    await expect(recoveryPanel).toContainText(
      "1 waiting · No active attempt · Version fixture-runtime-v1"
    );
    const coordinatorPaused = join(
      screenshotDir,
      "runtime-recovery-paused-desktop.png"
    );
    await recoveryPanel.screenshot({ path: coordinatorPaused });
    shots.push(coordinatorPaused);
    // A second memory reset changes the durable CAS marker after this page read it.
    runtimeDiagnostics.coordinator.recovery.observedAt = 101;
    await recoveryPanel
      .getByRole("button", { name: "Resume recovery", exact: true })
      .click();
    await expect(recoveryPanel.getByRole("alert")).toContainText(
      "platform recovery marker changed; reload diagnostics"
    );
    await expect(
      recoveryPanel.getByRole("button", {
        name: "Resume recovery",
        exact: true
      })
    ).toBeEnabled();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    expect(recoveryCalls().map((call) => JSON.parse(call.body))).toEqual([
      { scope: "coordinator", observedAt: 100 }
    ]);
    recoveryEvidence.push({
      state: "stale-marker-rejected",
      requests: recoveryCalls().length,
      observedAt: 100
    });
    const coordinatorStale = join(
      screenshotDir,
      "runtime-recovery-stale-desktop.png"
    );
    await recoveryPanel.screenshot({ path: coordinatorStale });
    shots.push(coordinatorStale);
    // Reading a fresh marker must not implicitly resume its unresolved scanner.
    runtimeDiagnostics.active = {
      id: "job-1",
      state: "cancelled",
      drained: false,
      unresolvedRemote: 1,
      sessionCleanupPending: false
    };
    await recoveryPanel
      .getByRole("button", { name: "Refresh status", exact: true })
      .click();
    await expect(recoveryPanel).toContainText(
      "1 scanner outcome(s) require reconciliation before recovery can resume."
    );
    await expect(recoveryPanel.getByRole("alert")).toHaveCount(0);
    expect(recoveryCalls()).toHaveLength(1);
    await recoveryPanel
      .getByRole("button", { name: "Resume recovery", exact: true })
      .click();
    await expect(recoveryPanel.getByRole("alert")).toContainText(
      "reconcile remote scanner outcomes before platform recovery"
    );
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    expect(recoveryCalls().map((call) => JSON.parse(call.body))).toEqual([
      { scope: "coordinator", observedAt: 100 },
      { scope: "coordinator", observedAt: 101 }
    ]);
    await expect(
      recoveryPanel.getByText(
        "Coordinator recovery paused after memory resets",
        { exact: true }
      )
    ).toBeVisible();
    recoveryEvidence.push({
      state: "unresolved-scanner-refused",
      requests: recoveryCalls().length,
      observedAt: 101,
      unresolvedRemote: 1
    });
    const coordinatorUnresolved = join(
      screenshotDir,
      "runtime-recovery-unresolved-desktop.png"
    );
    await recoveryPanel.screenshot({ path: coordinatorUnresolved });
    shots.push(coordinatorUnresolved);
    // Reconciliation is an external operator event in this UI-only fixture.
    runtimeDiagnostics.active = {
      ...runtimeDiagnostics.active,
      drained: true,
      unresolvedRemote: 0
    };
    await recoveryPanel
      .getByRole("button", { name: "Refresh status", exact: true })
      .click();
    await expect(
      recoveryPanel.getByText(/scanner outcome\(s\) require reconciliation/)
    ).toHaveCount(0);
    expect(recoveryCalls()).toHaveLength(2);
    await recoveryPanel
      .getByRole("button", { name: "Resume recovery", exact: true })
      .click();
    await expect(
      recoveryPanel.getByText(
        "Coordinator recovery paused after memory resets",
        { exact: true }
      )
    ).toHaveCount(0);
    await expect(
      recoveryPanel.getByRole("button", {
        name: "Resume recovery",
        exact: true
      })
    ).toHaveCount(0);
    await expect(recoveryPanel.getByRole("alert")).toHaveCount(0);
    expect(recoveryCalls().map((call) => JSON.parse(call.body))).toEqual([
      { scope: "coordinator", observedAt: 100 },
      { scope: "coordinator", observedAt: 101 },
      { scope: "coordinator", observedAt: 101 }
    ]);
    recoveryEvidence.push({
      state: "coordinator-resumed-explicitly",
      requests: recoveryCalls().length,
      observedAt: 101
    });
    const coordinatorResumed = join(
      screenshotDir,
      "runtime-recovery-resumed-desktop.png"
    );
    await recoveryPanel.screenshot({ path: coordinatorResumed });
    shots.push(coordinatorResumed);
    await page
      .getByRole("button", { name: "Validate and save", exact: true })
      .first()
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Saved revision dddddddddddd" })
    ).toBeVisible();
    expect(
      calls.some(
        (call) =>
          call.method === "PUT" &&
          call.path === "/v1/ui/settings" &&
          call.headers["if-match"] === "3"
      )
    ).toBe(true);
    const savedRoles = JSON.parse(
      calls.find(
        (call) => call.method === "PUT" && call.path === "/v1/ui/settings"
      ).body
    ).roles;
    expect(savedRoles.primary).toEqual({
      ...originalSettingsRoles.primary,
      promptFormat: "markdown",
      promptTemplate: promptDraft,
      model: "anthropic/claude-fixture",
      reasoningEffort: "low"
    });
    for (const role of roleIds.filter((role) => role !== "primary"))
      expect(savedRoles[role]).toEqual(originalSettingsRoles[role]);
    await assertHealthy("settings");
    const settingsShot = join(screenshotDir, "settings-desktop.png");
    await page.screenshot({ path: settingsShot });
    shots.push(settingsShot);
    settings = { ...settings, locked: true, blockingRunIds: ["run-1"] };
    await page.reload();
    await expect(
      page.getByText("Defaults locked by unfinished runs", { exact: true })
    ).toBeVisible();
    await expect(modelSearch).toBeDisabled();
    await expect(page.getByLabel("Primary prompt template")).toBeDisabled();
    await expect(
      page.getByRole("combobox", { name: "Reasoning effort", exact: true })
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Reset to default", exact: true })
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Apply to all roles", exact: true })
    ).toBeDisabled();
    await expect(
      page
        .getByRole("button", { name: "Validate and save", exact: true })
        .first()
    ).toBeDisabled();
    settings = { ...settings, locked: false, blockingRunIds: [] };
    run.status = "running";
    jobs[0].status = "running";
    jobs[0].revision += 1;
    await page.setViewportSize({ width: 390, height: 844 });
    sessionControls.forms = [operatorQuestion];
    sessionControls.permissions = [operatorPermission];
    await page.goto(origin + "/?run=run-1&job=job-1");
    await expect(
      page.getByText("Native session transcript is ready.")
    ).toBeVisible();
    await expect(
      page.getByText("Operator question", { exact: true })
    ).toBeVisible();
    await assertChatLayout("mobile-native-controls");
    const pendingMobile = join(screenshotDir, "native-controls-mobile.png");
    await page.screenshot({ path: pendingMobile });
    shots.push(pendingMobile);
    await choose("Continue?", "No");
    await page
      .getByRole("button", { name: "Send answer", exact: true })
      .click();
    await expect(
      page.getByText("Operator question", { exact: true })
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Reject", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Reject", exact: true })
    ).toHaveCount(0);
    expect(
      calls.some(
        (call) =>
          call.path.endsWith("/permissions/per_operator/reply") &&
          JSON.parse(call.body).decision === "reject"
      )
    ).toBe(true);
    await page
      .getByRole("button", { name: "Open navigation", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", { name: "Run navigation", exact: true })
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "Run navigation", exact: true })
      .getByRole("button", { name: "Close navigation", exact: true })
      .click();
    await expect(
      page.getByRole("navigation", { name: "Run navigation", exact: true })
    ).toBeHidden();
    await assertChatLayout("mobile");
    const width = await page.evaluate(() => ({
      viewport: innerWidth,
      scroll: document.documentElement.scrollWidth
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.viewport);
    await assertHealthy("mobile");
    const mobile = join(screenshotDir, "chat-mobile.png");
    await page.screenshot({ path: mobile });
    shots.push(mobile);
    run.status = "completed";
    jobs.forEach((job) => {
      job.status = "completed";
      job.revision += 1;
    });
    await page.goto(origin + "/dashboard/runs/run-1/jobs/job-coder");
    await expect(page.getByLabel("Run steps")).toBeVisible();
    await expect(
      page.getByText("History complete", { exact: true })
    ).toBeVisible();
    const dashboardBounds = await page
      .locator(
        ".dashboard-shell,.dashboard-topbar,.dashboard-workspace-grid,.dashboard-map-card,.workflow-panel"
      )
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right };
        })
      );
    for (const box of dashboardBounds) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(390);
    }
    layouts.push({
      label: "dashboard-mobile",
      viewport: 390,
      panels: dashboardBounds
    });
    await assertHealthy("dashboard-mobile");
    const mobileDashboard = join(screenshotDir, "dashboard-mobile.png");
    await page.screenshot({ path: mobileDashboard });
    shots.push(mobileDashboard);
    await page.locator(".workflow-panel").scrollIntoViewIfNeeded();
    const mobileInspector = join(
      screenshotDir,
      "dashboard-mobile-inspector.png"
    );
    await page.screenshot({ path: mobileInspector });
    shots.push(mobileInspector);
    runtimeDiagnostics = {
      coordinator: { version: { id: "fixture-runtime-v1" } },
      backlog: { waiting: 1, oldestWaitingMs: 2000 },
      active: {
        id: "job-1",
        state: "cancelled",
        drained: true,
        unresolvedRemote: 0,
        sessionCleanupPending: false,
        recovery: {
          reason: "alarm_memory_limit",
          sealed: true,
          observedAt: 200,
          purgedJobs: 1
        }
      }
    };
    await page.getByRole("link", { name: "All runs", exact: true }).click();
    await page.getByRole("tab", { name: "Settings", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Settings", exact: true })
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.getByLabel("Primary prompt template")).not.toHaveValue(
      ""
    );
    await page
      .getByRole("button", {
        name: "Runtime diagnostics and recovery",
        exact: true
      })
      .click();
    await expect(
      recoveryPanel.getByText("Attempt recovery paused after memory resets", {
        exact: true
      })
    ).toBeVisible();
    await expect(recoveryPanel).toContainText("Active attempt: job-1");
    const attemptPaused = join(
      screenshotDir,
      "runtime-recovery-paused-mobile.png"
    );
    await recoveryPanel.screenshot({ path: attemptPaused });
    shots.push(attemptPaused);
    await recoveryPanel
      .getByRole("button", { name: "Resume recovery", exact: true })
      .click();
    await expect(
      recoveryPanel.getByText("Attempt recovery paused after memory resets", {
        exact: true
      })
    ).toHaveCount(0);
    expect(recoveryCalls()).toHaveLength(4);
    expect(JSON.parse(recoveryCalls()[3].body)).toEqual({
      scope: "attempt",
      observedAt: 200,
      attemptId: "job-1"
    });
    recoveryEvidence.push({
      state: "attempt-resumed-explicitly",
      requests: recoveryCalls().length,
      observedAt: 200,
      attemptId: "job-1"
    });
    const attemptResumed = join(
      screenshotDir,
      "runtime-recovery-resumed-mobile.png"
    );
    await recoveryPanel.screenshot({ path: attemptResumed });
    shots.push(attemptResumed);
    const settingsBounds = await page
      .locator(
        ".settings-page,.settings-workspace,.settings-detail,.settings-prompt-editor"
      )
      .evaluateAll((nodes) =>
        nodes.map((node) => {
          const box = node.getBoundingClientRect();
          return { left: box.left, right: box.right };
        })
      );
    for (const box of settingsBounds) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(390);
    }
    layouts.push({
      label: "settings-mobile",
      viewport: 390,
      panels: settingsBounds
    });
    await modelSearch.fill("openai");
    await expect(
      page.getByRole("option", { name: /GPT Fixture/ })
    ).toBeVisible();
    const popupBounds = await page
      .locator(".settings-model-popup")
      .boundingBox();
    expect(popupBounds.x).toBeGreaterThanOrEqual(0);
    expect(popupBounds.x + popupBounds.width).toBeLessThanOrEqual(390);
    await modelSearch.press("Escape");
    for (const name of ["Chats", "Dashboard"])
      await expect(
        page
          .getByRole("navigation", { name: "Product navigation" })
          .getByRole("link", { name, exact: true })
      ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Settings", exact: true })
    ).toHaveAttribute("aria-selected", "true");
    await assertHealthy("settings-mobile");
    expect(clientStateWrites).toEqual([]);
    expect(
      calls.some((call) => /^\/v1\/ui\/runs\/[^/]+\/events$/.test(call.path))
    ).toBe(false);
    const mobileSettings = join(screenshotDir, "settings-mobile.png");
    await page.screenshot({ path: mobileSettings });
    shots.push(mobileSettings);
    await fs.writeFile(
      join(screenshotDir, "result.json"),
      JSON.stringify(
        {
          url: origin,
          title: await page.title(),
          viewports: ["1440x1000", "390x844"],
          consoleErrors,
          expectedConflictConsoleErrors,
          externalRequests,
          screenshots: shots,
          requestCount: calls.length,
          stateEvidence,
          recoveryEvidence,
          recoveryRequests: recoveryCalls().map((call) =>
            JSON.parse(call.body)
          ),
          interactions: [
            "native transcript and tool render",
            "native conditional form reply",
            "native permission allow once",
            "recorded session usage",
            "steer",
            "interrupt",
            "fresh revision",
            "dashboard native phases",
            "settings recovery stale CAS rejection without retry",
            "unresolved scanner refusal",
            "explicit coordinator and attempt recovery",
            "settings save If-Match",
            "selected State child survives delayed root-only REST",
            "Kumo keyboard model selection and missing saved selection",
            "exact edited and untouched prompt bytes",
            "locked Kumo settings controls",
            "shared theme persistence",
            "mobile Kumo popup bounds",
            "mobile navigation"
          ],
          mobileWidth: width,
          layouts
        },
        null,
        2
      )
    );
    console.log(
      JSON.stringify({
        passed: true,
        screenshots: shots,
        consoleErrors,
        expectedConflictConsoleErrors,
        externalRequests,
        stateEvidence,
        recoveryEvidence,
        requests: calls.length
      })
    );
  } catch (error) {
    await fs.writeFile(
      join(screenshotDir, "failure.json"),
      JSON.stringify(
        {
          url: page.url(),
          consoleErrors,
          expectedConflictConsoleErrors,
          externalRequests,
          stateEvidence,
          recoveryEvidence,
          recoveryRequests: recoveryCalls().map((call) =>
            JSON.parse(call.body)
          ),
          layouts,
          error: String(error),
          snapshot: await page.locator("body").ariaSnapshot()
        },
        null,
        2
      )
    );
    await page
      .screenshot({ path: join(screenshotDir, "failure.png") })
      .catch(() => {});
    throw error;
  }
});
