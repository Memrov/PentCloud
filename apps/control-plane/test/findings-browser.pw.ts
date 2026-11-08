import { tmpdir } from "node:os";
import {
  test,
  expect,
  expect as check
} from "../../../scripts/browser-qa/fixtures.mts";
test.describe("target findings dashboard", () => {
  for (const width of [1440, 390])
    test(`separates targets, retains archived assessments and handles thirty findings at ${width} px`, async ({
      context,
      page,
      baseURL
    }) => {
      const origin = baseURL!;
      await page.setViewportSize({ width, height: 900 });
      const commit = "b".repeat(40);
      const make = (id: string, target: string, lifecycle = "active") => ({
        id,
        status: "completed",
        lifecycle,
        baselineRepo: "r",
        inputCommit: "a".repeat(40),
        maxDepth: 4,
        maxJobs: 32,
        target: {
          id: target,
          name: target,
          url: `https://${target}.invalid/`,
          kind: "website",
          revision: 1
        }
      });
      const runs = [
        make("a", "alpha"),
        make("archive", "alpha", "archived"),
        make("b", "beta"),
        make("trash", "alpha", "trashed")
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
              state: { revision: 1, runs, jobs: [] }
            })
          );
        }
      );
      page.on("pageerror", (error) =>
        console.error("PAGE ERROR", error.message)
      );
      let alphaGate: Promise<void> | undefined,
        releaseAlpha = () => {};
      const calls: string[] = [];
      await page.route("**/v1/ui/**", (route) => {
        const u = new URL(route.request().url()),
          p = u.pathname;
        calls.push(p);
        const json = (x: unknown) =>
          route.fulfill({
            contentType: "application/json",
            body: JSON.stringify(x)
          });
        if (p === "/v1/ui/runs") return json({ runs });
        const id = p.split("/")[4]!,
          run = runs.find((r) => r.id === id),
          job = {
            id: "r-" + id,
            runId: id,
            role: "reporter",
            task: "Report",
            status: "completed",
            revision: 1,
            nativeSession: true,
            outputCommit: commit
          };
        if (p.endsWith("/jobs")) return json({ run, jobs: [job] });
        if (p.endsWith("/findings")) {
          const count = id === "b" ? 1 : 15,
            root = `.pentagi/evidence/${job.id}`,
            doc = {
              version: 1,
              coverage: "complete",
              summary: "Accepted assessment",
              reportPath: root + "/assessment.md",
              findings: Array.from({ length: count }, (_, i) => ({
                id: "f" + i,
                title: `${id} issue ${i}`,
                severity: "high",
                status: "confirmed",
                target: run!.target.url,
                summary: "Owned test issue",
                evidence: "GET returned owned proof",
                report: "## Remediation\nCheck record ownership.",
                evidencePaths: [root + "/proof.txt"]
              }))
            };
          const value = {
            version: 1,
            runId: id,
            jobId: job.id,
            commit,
            bundle: {
              document: doc,
              files: [
                { path: doc.reportPath, size: 30 },
                { path: root + "/proof.txt", size: 10 }
              ]
            }
          };
          return alphaGate && id === "a"
            ? alphaGate.then(() => json(value))
            : json(value);
        }
        if (p.endsWith("/report"))
          return route.fulfill({
            body: "Reviewed assessment",
            headers: { "X-Source-Commit": commit }
          });
        if (p.endsWith("/file"))
          return route.fulfill({
            body: "# Full assessment\n\nOwned report.",
            headers: { "Content-Type": "text/plain" }
          });
        return route.fulfill({ status: 404, body: "{}" });
      });
      try {
        await page.goto(
          origin + "/dashboard?view=findings&target=target:alpha"
        );
        await check(
          page.getByRole("heading", { name: "Findings", exact: true })
        )
          .toBeVisible()
          .catch(async (error) => {
            throw new Error(
              String(error) +
                " BODY " +
                (await page.locator("body").innerText()).slice(0, 1800)
            );
          });
        await check(
          page.getByText("30 findings", { exact: true })
        ).toBeVisible();
        await check(page.getByRole("table")).toBeVisible();
        await check(
          page.getByRole("button", { name: "Next page", exact: true })
        ).toBeEnabled();
        await page
          .getByRole("button", { name: "Next page", exact: true })
          .click({ timeout: 3000 });
        await check(
          page.getByRole("button", { name: "Next page", exact: true })
        ).toBeDisabled();
        await page
          .getByRole("button", { name: "archive issue 9", exact: true })
          .click({ timeout: 3000 });
        await check(
          page
            .getByRole("dialog")
            .getByText("GET returned owned proof", { exact: true })
        ).toBeVisible();
        await check(
          page
            .getByRole("dialog")
            .getByText("Check record ownership.", { exact: true })
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Close finding", exact: true })
          .click();
        await page
          .getByRole("combobox", { name: "Target", exact: true })
          .click({ timeout: 3000 });
        await page
          .getByRole("option", {
            name: "beta · https://beta.invalid/",
            exact: true
          })
          .click({ timeout: 3000 });
        await check(page.getByText("1 finding", { exact: true })).toBeVisible();
        await check(
          page.getByRole("button", { name: "beta issue 0", exact: true })
        ).toHaveCount(0);
        await check(
          page.getByRole("button", { name: "b issue 0", exact: true })
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Full report", exact: true })
          .click();
        await check(
          page
            .getByRole("dialog")
            .getByRole("heading", { name: "Full assessment", exact: true })
        ).toBeVisible();
        await check(
          page
            .getByRole("dialog")
            .getByRole("link", { name: "Markdown", exact: true })
        ).toHaveAttribute(
          "href",
          `/v1/ui/runs/b/file?commit=${commit}&path=.pentagi%2Fevidence%2Fr-b%2Fassessment.md`
        );
        await page
          .getByRole("button", { name: "Close report", exact: true })
          .click();
        await check(page.getByRole("dialog")).toHaveCount(0);
        if (width === 1440) {
          const before = calls.filter(
            (p) => p === "/v1/ui/runs/a/findings"
          ).length;
          alphaGate = new Promise<void>((resolve) => {
            releaseAlpha = resolve;
          });
          await page
            .getByRole("combobox", { name: "Target", exact: true })
            .click();
          await page
            .getByRole("option", {
              name: "alpha · https://alpha.invalid/",
              exact: true
            })
            .click();
          await check
            .poll(
              () => calls.filter((p) => p === "/v1/ui/runs/a/findings").length
            )
            .toBeGreaterThan(before);
          await page
            .getByRole("combobox", { name: "Target", exact: true })
            .click();
          await page
            .getByRole("option", {
              name: "beta · https://beta.invalid/",
              exact: true
            })
            .click();
          await check(
            page.getByText("1 finding", { exact: true })
          ).toBeVisible();
          const delayed = page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === "/v1/ui/runs/a/findings"
          );
          releaseAlpha();
          await delayed;
          await check(
            page.getByRole("button", { name: "b issue 0", exact: true })
          ).toBeVisible();
          await check(
            page.getByRole("button", { name: "a issue 0", exact: true })
          ).toHaveCount(0);
        }
        expect(calls).not.toContain("/v1/ui/runs/trash/jobs");
        await page.goto(origin + "/dashboard/runs/b");
        await page
          .locator(".run-management")
          .getByRole("button", { name: "Open report", exact: true })
          .click();
        await check(
          page
            .getByRole("dialog")
            .getByRole("heading", { name: "Full assessment", exact: true })
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Close report", exact: true })
          .click();
        await check(page.getByRole("dialog")).toHaveCount(0);
        await page.goto(origin + "/dashboard?view=findings&target=target:beta");
        await check(page.getByText("1 finding", { exact: true })).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth
          )
        ).toBe(true);
        await page.screenshot({
          path: `${tmpdir()}/pentcloud-findings-${width}.png`
        });
      } catch (error) {
        await page.screenshot({
          path: `${tmpdir()}/pentcloud-findings-${width}-failure.png`
        });
        console.error(
          "POPUP",
          await page.getByRole("option").evaluateAll((es) =>
            es.map((e) => ({
              text: e.textContent,
              rect: e.getBoundingClientRect().toJSON(),
              z: getComputedStyle(e.parentElement!).zIndex
            }))
          )
        );
        console.error(
          "FINDINGS BODY",
          await page.locator(".findings-workspace").innerText(),
          calls
        );
        throw error;
      } finally {
        releaseAlpha();
      }
    });
  for (const width of [1440, 390])
    test(`keeps long target names and report content inside the viewport at ${width} px`, async ({
      context,
      page,
      baseURL
    }) => {
      const origin = baseURL!;
      await page.setViewportSize({ width, height: 844 });
      const commit = "b".repeat(40);
      const target = {
        id: "long",
        name: "Customer security assessment",
        url: `https://${"project".repeat(10)}.invalid/reports/`,
        kind: "website",
        revision: 1
      };
      const run = {
        id: "run-layout",
        status: "completed",
        baselineRepo: "fixture",
        inputCommit: "a".repeat(40),
        maxDepth: 4,
        maxJobs: 32,
        target
      };
      const job = {
          id: "reporter-" + "a".repeat(80),
          runId: run.id,
          role: "reporter",
          status: "completed",
          revision: 1,
          outputCommit: commit
        },
        path = `.pentagi/evidence/${job.id}/assessment.md`;
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
      await page.route("**/v1/ui/**", (route) => {
        const p = new URL(route.request().url()).pathname,
          json = (value: unknown) =>
            route.fulfill({
              contentType: "application/json",
              body: JSON.stringify(value)
            });
        if (p === "/v1/ui/runs") return json({ runs: [run] });
        if (p.endsWith("/jobs")) return json({ run, jobs: [job] });
        if (p.endsWith("/findings"))
          return json({
            version: 1,
            runId: run.id,
            jobId: job.id,
            commit,
            bundle: {
              document: {
                version: 1,
                coverage: "complete",
                summary: "Assessment complete",
                reportPath: path,
                findings: []
              },
              files: [{ path, size: 500 }]
            }
          });
        if (p.endsWith("/report"))
          return route.fulfill({
            body: "Reviewed assessment",
            headers: { "X-Source-Commit": commit }
          });
        if (p.endsWith("/file"))
          return route.fulfill({
            body: `# Full assessment\n\nAccepted source: \`${commit.repeat(3)}\`.\n\nTarget: ${target.url}\n\n| Evidence | Result |\n| --- | --- |\n| ${path} | Reviewed |`,
            contentType: "text/plain"
          });
        return route.fulfill({ status: 404, body: "{}" });
      });

      await page.goto(origin + "/dashboard?view=findings");
      await check(
        page.getByText("No findings were reported in these assessments.", {
          exact: true
        })
      ).toBeVisible();
      const select = page.getByRole("combobox", {
        name: "Target",
        exact: true
      });
      const inside = async () => {
        const box = (await select.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      };
      await inside();
      await select.click();
      await check(page.getByRole("option")).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true);
      const option = (await page.getByRole("option").boundingBox())!;
      expect(option.x).toBeGreaterThanOrEqual(0);
      expect(option.x + option.width).toBeLessThanOrEqual(width);
      expect(
        await page
          .getByRole("option")
          .evaluate((e) => e.scrollWidth <= e.clientWidth + 1)
      ).toBe(true);
      await page.keyboard.press("Escape");
      await inside();
      await page
        .getByRole("button", { name: "Full report", exact: true })
        .click();
      const reportDocument = page.locator(".assessment-document");
      await check(
        reportDocument.getByRole("heading", {
          name: "Full assessment",
          exact: true
        })
      ).toBeVisible();
      const box = (await reportDocument.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(
        await reportDocument.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)
      ).toBe(true);
    });
  for (const count of [20, 21])
    test(`keeps the exact page boundary correct for ${count} findings`, async ({
      context,
      page,
      baseURL
    }) => {
      const origin = baseURL!;
      await page.setViewportSize({ width: 390, height: 844 });
      const commit = "b".repeat(40);
      const run = {
          id: "boundary",
          status: "completed",
          baselineRepo: "fixture",
          inputCommit: "a".repeat(40),
          maxDepth: 4,
          maxJobs: 32,
          target: {
            id: "owned",
            name: "Owned",
            url: "https://owned.invalid/",
            kind: "website",
            revision: 1
          }
        },
        job = {
          id: "reporter",
          runId: run.id,
          role: "reporter",
          status: "completed",
          revision: 1,
          outputCommit: commit
        };
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
      await page.route("**/v1/ui/**", (route) => {
        const p = new URL(route.request().url()).pathname,
          json = (value: unknown) =>
            route.fulfill({
              contentType: "application/json",
              body: JSON.stringify(value)
            });
        if (p === "/v1/ui/runs") return json({ runs: [run] });
        if (p.endsWith("/jobs")) return json({ run, jobs: [job] });
        if (p.endsWith("/findings"))
          return json({
            version: 1,
            runId: run.id,
            jobId: job.id,
            commit,
            bundle: {
              document: {
                version: 1,
                coverage: "complete",
                summary: "Owned boundary fixture",
                reportPath: "assessment.md",
                findings: Array.from({ length: count }, (_, i) => ({
                  id: "f" + i,
                  title: "Issue " + i,
                  severity: "info",
                  status: "suspected",
                  target: run.target.url,
                  summary: "Owned fixture",
                  evidence: "Observation",
                  report: "Review configuration.",
                  evidencePaths: []
                }))
              },
              files: [{ path: "assessment.md", size: 10 }]
            }
          });
        return route.fulfill({ status: 404, body: "{}" });
      });
      await page.goto(origin + "/dashboard?view=findings");
      await check(
        page.getByText(count + " findings", { exact: true })
      ).toBeVisible();
      await check(page.getByRole("row")).toHaveCount(21);
      const next = page.getByRole("button", { name: "Next page", exact: true });
      if (count === 20) await check(next).toBeDisabled();
      else {
        await next.click();
        await check(page.getByRole("row")).toHaveCount(2);
        await check(
          page.getByRole("button", { name: "Issue 20", exact: true })
        ).toBeVisible();
        await check(next).toBeDisabled();
        await page
          .getByRole("button", { name: "Previous page", exact: true })
          .click();
        await check(page.getByRole("row")).toHaveCount(21);
      }
    });
  for (const mode of ["legacy", "error", "empty", "partial"])
    test(`keeps ${mode} results explicit`, async ({
      context,
      page,
      baseURL
    }) => {
      const origin = baseURL!;
      const commit = "b".repeat(40),
        run = {
          id: "r",
          status: "completed",
          baselineRepo: "repo",
          inputCommit: "a".repeat(40),
          maxDepth: 4,
          maxJobs: 32,
          target: {
            id: "t",
            name: "Owned",
            url: "https://owned.invalid/",
            kind: "website",
            revision: 1
          }
        },
        job = {
          id: "j",
          runId: "r",
          role: "reporter",
          task: "Report",
          status: "completed",
          revision: 1,
          outputCommit: commit
        };
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
      await page.route("**/v1/ui/**", (route) => {
        const p = new URL(route.request().url()).pathname;
        const json = (x: unknown, status = 200) =>
          route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify(x)
          });
        if (p === "/v1/ui/runs") return json({ runs: [run] });
        if (p.endsWith("/jobs")) return json({ run, jobs: [job] });
        if (p.endsWith("/findings"))
          return mode === "error"
            ? json({ error: "unavailable" }, 503)
            : json({
                version: 1,
                runId: "r",
                jobId: "j",
                commit,
                ...(mode === "legacy"
                  ? {}
                  : {
                      bundle: {
                        document: {
                          version: 1,
                          coverage: mode === "partial" ? "partial" : "complete",
                          summary: "Owned test",
                          reportPath: "assessment.md",
                          findings: []
                        },
                        files: [{ path: "assessment.md", size: 10 }]
                      }
                    })
              });
        return json({ error: "unused" }, 404);
      });
      await page.goto(origin + "/dashboard?view=findings");
      if (mode === "error") {
        await check(page.getByRole("alert")).toContainText("incomplete");
        await check(
          page.getByText("No findings were reported in these assessments.", {
            exact: true
          })
        ).toHaveCount(0);
      } else if (mode === "legacy") {
        await check(
          page.getByText(/older assessment has no structured findings index/)
        ).toBeVisible();
        await check(
          page.getByRole("button", { name: "Assessment files", exact: true })
        ).toBeVisible();
      } else {
        await check(
          page.getByText("No findings were reported in these assessments.", {
            exact: true
          })
        ).toBeVisible();
        if (mode === "partial")
          await check(
            page.getByText(/Assessment coverage is partial/)
          ).toBeVisible();
      }
    });

  test("discloses delayed and failed all-runs inventory and retries it from Findings", async ({
    context,
    page,
    baseURL
  }) => {
    const origin = baseURL!;
    const commit = "b".repeat(40);
    let failed = true,
      releaseInventory = () => {};
    const inventoryGate = new Promise<void>((resolve) => {
      releaseInventory = resolve;
    });
    const make = (id: string, lifecycle = "active") => ({
        id,
        status: "completed",
        lifecycle,
        baselineRepo: "repo",
        inputCommit: "a".repeat(40),
        maxDepth: 4,
        maxJobs: 32,
        target: {
          id: "owned",
          name: "Owned",
          url: "https://owned.invalid/",
          kind: "website",
          revision: 1
        }
      }),
      runs = [make("a"), make("old", "archived")];
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
          state: { revision: 1, runs: [runs[0]], jobs: [] }
        })
      );
    });
    await page.route("**/v1/ui/**", (route) => {
      const p = new URL(route.request().url()).pathname,
        id = p.split("/")[4]!,
        run = runs.find((r) => r.id === id),
        job = {
          id: "report-" + id,
          runId: id,
          role: "reporter",
          task: "Report",
          status: "completed",
          revision: 1,
          outputCommit: commit
        };
      const json = (x: unknown, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(x)
        });
      if (p === "/v1/ui/runs")
        return failed
          ? inventoryGate.then(() =>
              json({ error: "inventory unavailable" }, 503)
            )
          : json({ runs });
      if (p.endsWith("/jobs")) return json({ run, jobs: [job] });
      if (p.endsWith("/findings"))
        return json({
          version: 1,
          runId: id,
          jobId: job.id,
          commit,
          bundle: {
            document: {
              version: 1,
              coverage: "complete",
              summary: "Owned test",
              reportPath: "report.md",
              findings: [
                {
                  id: "one",
                  title: id + " issue",
                  severity: "low",
                  status: "suspected",
                  target: run!.target.url,
                  summary: "Observation",
                  evidence: "Owned marker",
                  report: "Review configuration.",
                  evidencePaths: []
                }
              ]
            },
            files: [{ path: "report.md", size: 20 }]
          }
        });
      return json({}, 404);
    });
    try {
      await page.goto(origin + "/dashboard?view=findings");
      await check(
        page.getByText("Loading target assessments…", { exact: true })
      ).toBeVisible();
      await check(
        page.getByText("No target assessments yet.", { exact: true })
      ).toHaveCount(0);
      releaseInventory();
      await check(page.getByRole("alert")).toContainText("inventory");
      failed = false;
      await page
        .getByRole("button", { name: "Refresh findings", exact: true })
        .click();
      await check(page.getByText("2 findings", { exact: true })).toBeVisible();
      await check(
        page.getByRole("button", { name: "old issue", exact: true })
      ).toBeVisible();
      await check(page.getByRole("alert")).toHaveCount(0);
    } finally {
      releaseInventory();
    }
  });
});
