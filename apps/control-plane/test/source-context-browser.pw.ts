import {
  test,
  expect,
  expect as browserExpect
} from "../../../scripts/browser-qa/fixtures.mts";
test.describe("optional source context in target setup", () => {
  for (const width of [390, 1440])
    test(
      "attaches existing source and recovers a pending native import at " +
        width +
        "px",
      async ({ context, page, baseURL }) => {
        const origin = baseURL!;
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        let target: any = {
            id: "target-owned",
            kind: "website",
            name: "Owned project",
            url: "https://owned.example/",
            revision: 1,
            archived: false,
            objective: "Assess my project",
            exclusions: ""
          },
          pending: any[] = [];
        const writes: { name: string; value: any }[] = [],
          errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        const pin = {
          id: "source-one",
          repo: "context",
          repoId: "repo-one",
          branch: "main",
          commit: "a".repeat(40),
          addedAt: 1,
          addedBy: "owner"
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
                state: { revision: 1, runs: [], jobs: [] }
              })
            );
          }
        );
        await page.route("**/v1/ui/**", async (route) => {
          const request = route.request(),
            path = new URL(request.url()).pathname;
          const json = (v: unknown) =>
            route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify(v)
            });
          if (path === "/v1/ui/runs") return json({ runs: [] });
          if (path === "/v1/ui/onboarding")
            return json({
              targets: [target],
              credentials: [],
              defaults: [],
              sourceImports: pending
            });
          const name = path.split("/").at(-1)!,
            value = request.method() === "POST" ? request.postDataJSON() : {};
          if (request.method() === "POST") writes.push({ name, value });
          if (name === "source.list")
            return json({
              repos: [{ name: "context", defaultBranch: "main" }]
            });
          if (name === "source.attach") {
            target = { ...target, revision: 2, sources: [pin] };
            return json(target);
          }
          if (name === "source.import") {
            if (!pending.length) {
              pending = [
                { ...value, targetId: target.id, repo: "context-import" }
              ];
              return json({ status: "pending", repo: "context-import" });
            }
            target = {
              ...target,
              revision: 3,
              sources: [
                pin,
                {
                  ...pin,
                  id: "source-two",
                  repo: "context-import",
                  origin: value.url
                }
              ]
            };
            pending = [];
            return json({ status: "ready", target });
          }
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
        await page
          .getByRole("button", { name: /Owned project.*owned.example/ })
          .click();
        await page
          .getByRole("button", { name: /Source context \(optional\)/ })
          .click();
        await page
          .getByRole("button", {
            name: "Load existing repositories",
            exact: true
          })
          .click();
        await page
          .getByRole("combobox", { name: "Artifacts repository" })
          .click();
        await page
          .getByRole("option", { name: "context", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Attach source", exact: true })
          .click();
        await browserExpect(
          page.getByText("aaaaaaaaaaaa", { exact: true })
        ).toBeVisible();
        expect(
          writes.find((w) => w.name === "source.attach")?.value
        ).toMatchObject({
          id: target.id,
          revision: 1,
          repo: "context",
          branch: "main"
        });
        await page.getByRole("combobox", { name: "Source location" }).click();
        await page
          .getByRole("option", {
            name: "Public GitHub repository",
            exact: true
          })
          .click();
        await page
          .getByLabel("Public GitHub repository URL")
          .fill("https://github.com/owner/project");
        await page
          .getByRole("button", { name: "Import source", exact: true })
          .click();
        await browserExpect(
          page.getByRole("button", { name: "Check import", exact: true })
        ).toBeVisible();
        await page.reload();
        await page
          .getByRole("button", { name: /Owned project.*owned.example/ })
          .click();
        await page
          .getByRole("button", { name: /Source context \(optional\)/ })
          .click();
        await page
          .getByRole("button", { name: "Check import", exact: true })
          .click();
        await browserExpect(
          page.getByRole("button", { name: "Import latest", exact: true })
        ).toBeVisible();
        const imports = writes.filter((w) => w.name === "source.import");
        expect(imports).toHaveLength(2);
        expect(imports[0]!.value.requestId).toBe(imports[1]!.value.requestId);
        expect(
          writes.some((w) => ["target.check", "model.test"].includes(w.name))
        ).toBe(false);
        expect(
          await page
            .locator("body")
            .evaluate((el) => el.scrollWidth <= window.innerWidth)
        ).toBe(true);
        expect(errors).toEqual([]);
        if (process.env.PENTCLOUD_SCREENSHOT_DIR)
          await page.screenshot({
            path:
              process.env.PENTCLOUD_SCREENSHOT_DIR +
              "/source-context-" +
              width +
              ".png",
            fullPage: true
          });
      }
    );
});
