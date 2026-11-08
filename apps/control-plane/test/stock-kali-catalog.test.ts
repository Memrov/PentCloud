import { expect, it } from "vite-plus/test";
import baseline from "./fixtures/stock-kali-catalog.json";
import { stockKaliCatalogReady } from "../src/native/stock-kali-catalog";

it("requires exact unchanged stock tool names and schemas before model startup", async () => {
  expect(await stockKaliCatalogReady(baseline.tools)).toBe(true);
  expect(await stockKaliCatalogReady(baseline.tools.slice(0, -1))).toBe(false);
  expect(
    await stockKaliCatalogReady(
      baseline.tools.map((tool, i) =>
        i ? tool : { ...tool, name: "replacement" }
      )
    )
  ).toBe(false);
  expect(
    await stockKaliCatalogReady(
      baseline.tools.map((tool, i) =>
        i
          ? tool
          : {
              ...tool,
              inputSchema: {
                type: "object",
                properties: { changed: { type: "string" } }
              }
            }
      )
    )
  ).toBe(false);
});
