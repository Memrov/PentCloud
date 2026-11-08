import {mkdir} from "node:fs/promises";
import {resolve} from "node:path";

export async function inspectNativeBrowser(server, result, release, settled, screenshots) {
  const {chromium} = await import("playwright");
  const browser = await chromium.launch({headless: true, ...(process.platform === "linux" ? {executablePath: "/usr/bin/chromium"} : {})});
  const context = await browser.newContext({httpCredentials: {username: "opencode", password: server.password}, viewport: {width: 1440, height: 1000}});
  const page = await context.newPage();
  const observed = {errors: [], screenshots: []};
  page.on("pageerror", error => observed.errors.push(server.clean(error.message)));
  try {
    await page.goto(server.url, {waitUntil: "domcontentloaded"});
    await page.waitForTimeout(1500);
    const passwordMode = page.getByRole("button", {name: "Use password", exact: true});
    if (await passwordMode.count()) await passwordMode.click();
    observed.connectionFields = await page.locator("input").evaluateAll(elements => elements.map(element =>
      ({type: element.type, placeholder: element.placeholder, name: element.name, label: element.getAttribute("aria-label")})));
    const serverAddress = page.locator('input[name="server"]');
    if (await serverAddress.count()) await serverAddress.first().fill(server.url);
    const password = page.locator('input[type="password"]');
    if (await password.count()) {await password.first().fill(server.password); await password.first().press("Enter"); await page.waitForTimeout(1500);}
    const project = page.getByText("workspace", {exact: true});
    if (await project.count()) {await project.first().click(); await page.waitForTimeout(1000);}
    const session = page.getByText("PentCloud full-server trial", {exact: true});
    if (await session.count()) {await session.first().click(); await page.waitForTimeout(1000);}
    const link = page.locator('a[href*="/session/ses_root"]');
    if (await link.count()) {await link.first().click(); await page.waitForTimeout(1000);}
    observed.url = page.url();
    observed.title = await page.title();
    observed.body = (await page.locator("body").innerText()).slice(0, 18000);
    observed.links = await page.locator("a").evaluateAll(elements => elements.map(element => ({text: element.textContent, href: element.getAttribute("href")})).slice(0, 25));
    observed.sessionVisible = observed.body.includes("Execute the pinned specialist launch") && observed.url.includes("ses_root");
    if (screenshots) {
      await mkdir(screenshots, {recursive: true});
      const path = resolve(screenshots, `opencode-${result.scenario}-running.png`);
      await page.screenshot({path, fullPage: true}); observed.screenshots.push(path);
    }
    await release();
    await settled();
    const answer = page.getByText("PentCloud full-server trial completed: baseline", {exact: false});
    await answer.first().waitFor({state: "visible", timeout: 10000});
    observed.completedAnswerVisible = true;
    observed.completedBody = (await page.locator("body").innerText()).slice(0, 18000);
    if (screenshots) {
      const path = resolve(screenshots, `opencode-${result.scenario}-completed.png`);
      await page.screenshot({path, fullPage: true}); observed.screenshots.push(path);
    }
  } catch (error) {observed.error = server.clean(String(error));}
  finally {await browser.close();}
  return observed;
}
