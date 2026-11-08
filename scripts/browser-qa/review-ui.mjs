import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const safeURL = (value) => {
  try {
    const u = new URL(value);
    return u.origin + u.pathname;
  } catch {
    return "[invalid URL]";
  }
};
const check = (value, message) => {
  if (!value) throw Error(message);
};
export async function reviewUI(browser, input) {
  const origin = new URL(input.origin);
  check(
    origin.protocol === "https:" && origin.origin === input.origin,
    "Use an HTTPS origin"
  );
  check(
    !input.runId || /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(input.runId),
    "Invalid run selection"
  );
  check(
    Object.keys(input.headers).sort().join(",") ===
      "CF-Access-Client-Id,CF-Access-Client-Secret",
    "Use native Access headers"
  );
  const result = {
    mode: "Cloudflare Browser Run / authenticated Node CDP",
    startedAt: new Date().toISOString(),
    cases: [],
    captures: [],
    events: [],
    traces: [],
    modifiedConditions: [
      "Exact-origin network guardrail",
      "Only readonly app requests permitted",
      "Trace DOM snapshots/network bodies omitted",
      "Bounded readonly app health readiness probe",
      "Native screenshot animation handling"
    ],
    unverified: [
      "Paid live-run streaming",
      "Safari and real devices",
      "Full accessibility conformance"
    ]
  };
  result.sessionId = input.sessionId;
  result.phase = "journeys";
  try {
    if (input.probe) {
      const page = await browser.newPage();
      await page.setContent(
        "<button onclick=\"this.textContent='Clicked'\">Test</button>"
      );
      await page.getByRole("button", { name: "Test", exact: true }).click();
      check(
        (await page.getByRole("button").innerText()) === "Clicked",
        "Capability click failed"
      );
      result.cases.push({ name: "native-cdp-capability", result: "passed" });
      result.result = "checks-passed";
      return result;
    }
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 390, height: 844 }
    ]) {
      const context = await browser.newContext({
        viewport,
        extraHTTPHeaders: input.headers
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12_000);
      page.setDefaultNavigationTimeout(30_000);
      const record = (event) => {
        if (result.events.length < 150)
          result.events.push({ viewport: viewport.width, ...event });
      };
      page.on("console", (m) => {
        if (m.type() === "error") record({ kind: "console-error" });
      });
      page.on("pageerror", () => record({ kind: "uncaught-exception" }));
      page.on("requestfailed", (r) =>
        record({
          kind: "request-failed",
          url: safeURL(r.url()),
          reason: r.failure()?.errorText?.slice(0, 100)
        })
      );
      page.on("response", (r) => {
        if (r.status() >= 400)
          record({
            kind: "http-error",
            url: safeURL(r.url()),
            status: r.status()
          });
      });
      const readonlyPosts = new Set([
        "bounty.status",
        "scope.names",
        "scope.preview",
        "source.list",
        "access.email.address"
      ]);
      await context.route("**/*", (route) => {
        const request = route.request();
        if (new URL(request.url()).origin !== origin.origin)
          return route.abort();
        const readonlyPost =
          request.method() === "POST" &&
          new URL(request.url()).pathname.startsWith("/v1/ui/onboarding/") &&
          readonlyPosts.has(new URL(request.url()).pathname.split("/").at(-1));
        if (
          !["GET", "HEAD", "OPTIONS"].includes(request.method()) &&
          !readonlyPost
        ) {
          record({
            kind: "mutation-blocked",
            method: request.method(),
            url: safeURL(request.url())
          });
          return route.abort();
        }
        return route.continue();
      });
      await context.addInitScript(() => {
        window.__pentcloudQA = { shifts: 0, longTasks: 0, maxTaskMs: 0 };
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries())
              if (!e.hadRecentInput) window.__pentcloudQA.shifts += e.value;
          }).observe({ type: "layout-shift", buffered: true });
        } catch {}
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              window.__pentcloudQA.longTasks++;
              window.__pentcloudQA.maxTaskMs = Math.max(
                window.__pentcloudQA.maxTaskMs,
                e.duration
              );
            }
          }).observe({ type: "longtask", buffered: true });
        } catch {}
      });
      // A newly issued Service Auth policy may not be usable at the browser's edge immediately.
      // Probe only the app's readonly health route; never the target, model or scanner.
      const readiness = {
        viewport: viewport.width,
        attempts: [],
        ready: false
      };
      result.accessReadiness ??= [];
      result.accessReadiness.push(readiness);
      for (let attempt = 0; attempt < 8; attempt++) {
        try {
          const response = await page.goto(input.origin + "/health", {
            waitUntil: "domcontentloaded",
            timeout: 8000
          });
          const status = response?.status();
          let health;
          if (response?.ok())
            try {
              health = await response.json();
            } catch {}
          readiness.attempts.push({
            status: status ?? null,
            applicationVerified: health?.application === "PentCloud"
          });
          if (health?.application === "PentCloud") {
            readiness.ready = true;
            readiness.modelBindingConfigured = health.goConfigured === true;
            break;
          }
        } catch (error) {
          readiness.attempts.push({ errorType: error.name });
        }
        if (attempt < 7)
          await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      check(
        readiness.ready,
        "Application Access readiness failed before UI assertions"
      );
      // Auth precedes tracing. Node sanitizes the archive again before saving.
      await context.tracing.start({
        screenshots: true,
        snapshots: false,
        sources: false
      });
      const capture = async (name) => {
        // Playwright finishes finite transitions and freezes looping animations
        // for the capture; hidden or continuously updating UI cannot stall QA.
        const png = await page.screenshot({
          fullPage: false,
          animations: "disabled",
          mask: [page.locator('input[type="password"]')]
        });
        const layout = await page.evaluate(() => {
          const width = innerWidth,
            height = innerHeight;
          const visible = (e) => {
            const r = e.getBoundingClientRect(),
              s = getComputedStyle(e);
            return (
              r.width > 0 &&
              r.height > 0 &&
              r.right > 0 &&
              r.left < width &&
              r.bottom > 0 &&
              r.top < height &&
              s.visibility !== "hidden" &&
              s.display !== "none"
            );
          };
          return {
            viewport: { width, height },
            documentWidth: document.documentElement.scrollWidth,
            performance: window.__pentcloudQA,
            overflows: [
              ...document.querySelectorAll(
                'main,section,header,nav,article,button,input,textarea,[role="dialog"],[role="tablist"]'
              )
            ]
              .filter(visible)
              .map((e) => {
                const r = e.getBoundingClientRect();
                return {
                  tag: e.tagName,
                  role: e.getAttribute("role"),
                  className: String(e.className).slice(0, 100),
                  left: Math.round(r.left),
                  right: Math.round(r.right),
                  width: Math.round(r.width)
                };
              })
              .filter((r) => r.left < -2 || r.right > width + 2)
              .slice(0, 24),
            smallControls: [
              ...document.querySelectorAll("button,input,textarea,select")
            ]
              .filter(visible)
              .filter((e) => parseFloat(getComputedStyle(e).fontSize) < 14)
              .length,
            conversation: {
              assistantProse: document.querySelectorAll(
                ".message-assistant .prose-block"
              ).length,
              activities:
                document.querySelectorAll(".response-activity").length,
              scrollHeight:
                document.querySelector(".message-scroll")?.clientHeight
            }
          };
        });
        result.captures.push({
          name,
          viewport,
          screenshot: `${name}-${viewport.width}.png`,
          url: safeURL(page.url()),
          layout,
          png
        });
      };
      const test = async (name, run) => {
        const item = {
          name,
          viewport: viewport.width,
          result: "passed",
          startedAt: new Date().toISOString()
        };
        try {
          const note = await run();
          if (note) {
            item.result = "not-run";
            item.note = note;
          }
        } catch (error) {
          item.result = "failed";
          item.errorType = error.name;
          item.reason = String(error.message).split("\n")[0].slice(0, 160);
          try {
            await capture(name + "-failed");
          } catch {}
        }
        item.finishedAt = new Date().toISOString();
        result.cases.push(item);
        return item.result;
      };
      const withinViewport = async (locator, label) => {
        const box = await locator.boundingBox();
        check(
          box && box.x >= 0 && box.x + box.width <= viewport.width + 1,
          `${label} exceeds the viewport`
        );
      };
      const go = async (path, selector) => {
        const response = await page.goto(input.origin + path, {
          waitUntil: "domcontentloaded"
        });
        check(response?.ok(), "Application navigation HTTP failure");
        check(
          new URL(page.url()).origin === input.origin,
          "Navigation reached another origin"
        );
        await page.locator(selector).waitFor({ state: "visible" });
        check(
          (await page.title()).includes("PentCloud"),
          "Application identity missing"
        );
      };
      const targetsReady = await test("targets", async () => {
        await go("/", '.onboarding[aria-busy="false"]');
        await page
          .getByRole("heading", { name: "Your targets", exact: true })
          .waitFor();
        await capture("targets");
      });
      await test("target-form", async () => {
        if (targetsReady !== "passed")
          return "Blocked by the initial target navigation failure";
        await page
          .getByRole("button", { name: "Add target", exact: true })
          .click();
        for (const name of ["Name", "Website address"])
          check(
            (await page
              .getByRole("textbox", { name, exact: true })
              .inputValue()) === "",
            "New target includes seeded values"
          );
        const hints = await page
          .locator("input[placeholder]")
          .evaluateAll((inputs) =>
            inputs.map((input) => input.getAttribute("placeholder"))
          );
        check(
          !hints.some((value) =>
            /example\.|github\.com\/owner|no-reply@/i.test(value ?? "")
          ),
          "A canned address is shown in a form hint"
        );
        await page
          .getByRole("textbox", { name: "Name", exact: true })
          .fill("QA draft — not saved");
        await page
          .getByRole("combobox", { name: "Target type", exact: true })
          .click();
        await page.getByRole("option", { name: "API", exact: true }).click();
        await page
          .getByRole("textbox", { name: "API base address", exact: true })
          .waitFor();
        for (const name of [
          "What should PentCloud investigate?",
          "Exclusions"
        ]) {
          const box = await page
            .getByRole("textbox", { name, exact: true })
            .boundingBox();
          check(box && box.width > 250, "Target field is cramped");
        }
        check(
          (
            await page
              .getByRole("combobox", { name: "Target type", exact: true })
              .innerText()
          ).includes("API"),
          "Target type shows an internal value"
        );
        await page.keyboard.press("Tab");
        await capture("target-form");
        await page
          .getByRole("textbox", { name: "Exclusions", exact: true })
          .scrollIntoViewIfNeeded();
        await capture("target-form-fields");
      });
      await test("dashboard", async () => {
        await go("/dashboard", '.dashboard-scroll[aria-busy="false"]');
        await capture("dashboard");
      });
      await test("run-delete-cancel", async () => {
        const trigger = page
          .getByRole("button", { name: /^Delete run run-/ })
          .first();
        if (!(await trigger.count()))
          return "No retained runs available; no run created for QA";
        const runId = (await trigger.getAttribute("aria-label")).slice(
          "Delete run ".length
        );
        await trigger.click();
        const dialog = page.getByRole("dialog"),
          remove = dialog.getByRole("button", {
            name: "Permanently delete run",
            exact: true
          });
        await dialog.getByRole("textbox").fill("wrong-run");
        check(
          !(await remove.isEnabled()),
          "Wrong confirmation enabled deletion"
        );
        await capture("run-delete-confirmation");
        await dialog.getByRole("textbox").fill(runId);
        check(
          await remove.isEnabled(),
          "Exact run confirmation did not enable deletion"
        );
        await capture("run-delete-ready");
        await dialog
          .getByRole("button", { name: "Cancel", exact: true })
          .click();
        await dialog.waitFor({ state: "hidden" });
        check((await trigger.count()) === 1, "Cancel removed a run");
        await capture("run-delete-cancelled");
        try {
          await go(
            "/dashboard/runs/" + encodeURIComponent(runId),
            ".run-management"
          );
          await capture("run-management");
          await page
            .getByRole("button", { name: "Delete run", exact: true })
            .click();
          await page
            .getByRole("dialog")
            .getByRole("button", { name: "Cancel", exact: true })
            .click();
          await page.getByRole("dialog").waitFor({ state: "hidden" });
        } finally {
          await go("/dashboard", '.dashboard-scroll[aria-busy="false"]');
        }
      });
      await test("findings", async () => {
        await page.getByRole("tab", { name: "Findings", exact: true }).click();
        await page.locator('.findings-workspace[aria-busy="false"]').waitFor();
        await capture("findings");
        const select = page.getByRole("combobox", {
          name: "Target",
          exact: true
        });
        if (await select.count()) {
          await withinViewport(select, "Target selector");
          await select.click();
          await capture("findings-target-menu");
          check(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= innerWidth + 1
            ),
            "Target menu widens the page"
          );
          check(
            await page
              .getByRole("option")
              .evaluateAll((options) =>
                options.every((e) => e.scrollWidth <= e.clientWidth + 1)
              ),
            "Target options are clipped horizontally"
          );
          await page.keyboard.press("Escape");
        }
      });
      await test("report", async () => {
        const report = page.getByRole("button", {
          name: /^(Full report|Assessment files)$/
        });
        if (!(await report.count()) || (await report.isDisabled()))
          return "No report available for this target";
        await report.click();
        await page.getByRole("dialog").waitFor();
        await page.locator(".report-loading").waitFor({ state: "hidden" });
        await capture("report");
        const file = page.getByRole("combobox", {
          name: "Assessment file",
          exact: true
        });
        if (await file.count()) {
          await file.click();
          const options = await page.getByRole("option").allTextContents();
          result.reportOptions ??= [];
          result.reportOptions.push({ viewport: viewport.width, options });
          await page.keyboard.press("Escape");
        }
        if (await page.locator(".assessment-document").count()) {
          await capture("report-document");
          await withinViewport(
            page.locator(".assessment-document"),
            "Report document"
          );
          check(
            await page
              .locator(".assessment-document")
              .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
            "Report content is clipped horizontally"
          );
        } else if (
          !result.unverified.includes(
            "Report document body: no canonical document selected"
          )
        )
          result.unverified.push(
            "Report document body: no canonical document selected"
          );
        await page
          .getByRole("button", { name: "Close report", exact: true })
          .click();
        await page.getByRole("dialog").waitFor({ state: "hidden" });
      });
      await test("settings", async () => {
        await page.getByRole("tab", { name: "Settings", exact: true }).click();
        await page
          .getByRole("heading", { name: "Agent configuration", exact: true })
          .waitFor();
        if (viewport.width < 721) {
          await page
            .getByRole("combobox", { name: "Agent", exact: true })
            .click();
          await page
            .getByRole("option", { name: "Searcher", exact: true })
            .click();
        } else await page.locator(".settings-role-rail button").last().click();
        check(
          !(await page.locator(".settings-detail-footer").innerText()).includes(
            "Last saved by"
          ),
          "Settings expose the account audit identity"
        );
        await capture("settings");
        const model = page.getByRole("combobox", {
          name: "Search connected models",
          exact: true
        });
        if (await model.isDisabled())
          return "Settings locked by existing runtime state; dropdown not exercised";
        await model.click();
        await capture("model-menu");
        await page.keyboard.press("Escape");
      });
      await test("light-theme", async () => {
        await page
          .getByRole("button", { name: "Toggle theme", exact: true })
          .last()
          .click();
        await capture("settings-light");
      });
      await test("bug-bounty", async () => {
        await page
          .getByRole("tab", { name: "Bug bounty", exact: true })
          .click();
        await page
          .getByRole("region", { name: "HackerOne", exact: true })
          .waitFor();
        for (const name of ["Bugcrowd", "YesWeHack"]) {
          const card = page.getByRole("region", { name, exact: true });
          await card.getByText("In development", { exact: true }).waitFor();
          check(
            (await card.getByRole("button").count()) === 0,
            "Unvalidated platform offers an account connection"
          );
        }
        await capture("bug-bounty");
      });
      await test("targets-recheck", async () => {
        await go("/", '.onboarding[aria-busy="false"]');
        await capture("targets-recheck");
      });
      if (input.runId) {
        await test("chat", async () => {
          await go(
            "/?run=" + encodeURIComponent(input.runId),
            '.chat-shell[aria-busy="false"] .message-column'
          );
          await capture("chat");
        });
        await test("conversation-navigation", async () => {
          if (viewport.width < 760) {
            await page
              .getByRole("button", { name: "Open navigation", exact: true })
              .click();
            await capture("navigation");
          }
          const chats = page.locator(".job-row");
          check((await chats.count()) > 0, "No agent conversations visible");
          await chats.last().click();
          await page.locator('.chat-shell[aria-busy="false"]').waitFor();
          await capture("agent-conversation");
          if (viewport.width < 760)
            await page
              .getByRole("button", { name: "Close navigation", exact: true })
              .waitFor({ state: "hidden" });
        });
        await test("conversation-details", async () => {
          const trigger = page.getByRole("button", {
            name: "Conversation details",
            exact: true
          });
          await trigger.click();
          await capture("conversation-details");
          await trigger.click();
        });
        await test("tool-activity", async () => {
          const trigger = page
            .locator(".response-activity")
            .first()
            .getByRole("button")
            .first();
          if (!(await trigger.count()))
            return "No tool activity in this conversation";
          check(
            (await trigger.boundingBox())?.height < 30,
            "Activity trigger wraps into multiple rows"
          );
          await trigger.click();
          const reasoning = page
            .getByRole("button", { name: /^Reasoning/ })
            .first();
          if (await reasoning.count())
            check(
              (await reasoning.boundingBox())?.height < 30,
              "Reasoning trigger wraps into multiple rows"
            );
          await capture("tool-activity");
        });
        await test("chat-scroll", async () => {
          const scroll = page.locator(".message-scroll");
          const size = await scroll.evaluate((e) => ({
            height: e.clientHeight,
            scrollHeight: e.scrollHeight
          }));
          check(size.height > 80, "Conversation viewport is too short");
          if (size.scrollHeight <= size.height + 60)
            return "Conversation does not overflow; jump-to-latest not exercised";
          await scroll.hover();
          await page.mouse.wheel(0, -100_000);
          await page
            .getByRole("button", { name: "Jump to latest", exact: true })
            .waitFor();
          await capture("chat-scrolled");
          await page
            .getByRole("button", { name: "Jump to latest", exact: true })
            .click();
          await page.waitForFunction(() => {
            const e = document.querySelector(".message-scroll");
            return e && e.scrollHeight - e.clientHeight - e.scrollTop < 50;
          });
        });
      }
      await test("frame-sample", async () => {
        result.frameSample ??= [];
        result.frameSample.push({
          viewport: viewport.width,
          ...(await page.evaluate(
            () =>
              new Promise((resolve) => {
                const samples = [];
                let previous;
                function frame(now) {
                  if (previous !== undefined) samples.push(now - previous);
                  previous = now;
                  if (samples.length < 60) requestAnimationFrame(frame);
                  else
                    resolve({
                      frames: samples.length,
                      maxGapMs: Math.max(...samples),
                      gapsOver50Ms: samples.filter((n) => n > 50).length
                    });
                }
                requestAnimationFrame(frame);
              })
          ))
        });
      });
      const traceDirectory = await mkdtemp(
        join(tmpdir(), "pentcloud-qa-trace-")
      );
      try {
        const path = join(traceDirectory, "actions.zip");
        await context.tracing.stop({ path });
        result.traces.push({
          name: `actions-${viewport.width}.zip`,
          zip: (await readFile(path)).toString("base64")
        });
      } catch {
        result.traceUnavailable = true;
      } finally {
        await rm(traceDirectory, { recursive: true, force: true });
      }
      await context.close();
    }
  } catch (error) {
    result.errorType = error.name;
    result.error = "Native QA setup or browser connection failed";
    result.providerStatus =
      Number(/code: (\d{3})/.exec(error.message)?.[1]) || undefined;
  } finally {
    result.finishedAt = new Date().toISOString();
  }
  result.result = result.error
    ? "blocked"
    : result.cases.some((c) => c.result === "failed")
      ? "issues-found"
      : "checks-passed";
  return result;
}
