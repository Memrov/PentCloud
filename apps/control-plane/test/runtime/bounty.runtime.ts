import { expect, it } from "vite-plus/test";
import { BountyConnections } from "../../src/native/bounty-platform";
it("checks a native secret binding in workerd and gates rotated credentials without returning them", async () => {
  const records = new Map<string, unknown>();
  let token = "fixture-only";
  const connections = new BountyConnections(
    { PENTCLOUD_INTIGRITI_API_TOKEN: { get: async () => token } },
    {
      get: (k) => records.get(k) as never,
      put: (k, v) => records.set(k, v),
      remove: (k) => records.delete(k),
      fetcher: async (url, options) => {
        expect(String(url)).toContain(
          "api.intigriti.com/external/researcher/v1/programs?"
        );
        expect(new Headers(options?.headers).get("Authorization")).toBe(
          "Bearer fixture-only"
        );
        return Response.json({ records: [], maxCount: 0 });
      }
    }
  );
  await expect(connections.require("intigriti")).rejects.toThrow(/Bug bounty/);
  await connections.check("intigriti");
  await expect(connections.require("intigriti")).resolves.toBeUndefined();
  expect(JSON.stringify(await connections.list())).not.toContain(token);
  token = "rotated";
  await expect(connections.require("intigriti")).rejects.toThrow(/Bug bounty/);
});
it("blocks development integrations in workerd even if native bindings and old check receipts exist", async () => {
  let reads = 0,
    requests = 0;
  const binding = {
      get: async () => {
        reads++;
        return "unused-fixture-token";
      }
    },
    records = new Map<string, unknown>();
  const connections = new BountyConnections(
    {
      PENTCLOUD_BUGCROWD_API_TOKEN: binding,
      PENTCLOUD_YESWEHACK_API_TOKEN: binding
    },
    {
      get: (k) => records.get(k) as never,
      put: (k, v) => records.set(k, v),
      remove: (k) => records.delete(k),
      fetcher: async () => {
        requests++;
        return Response.json({ data: [] });
      }
    }
  );
  for (const platform of ["bugcrowd", "yeswehack"] as const) {
    records.set("bounty:connection:" + platform, {
      fingerprint: "old",
      checkedAt: Date.now()
    });
    expect(await connections.status(platform)).toEqual({
      platform,
      status: "development"
    });
    await expect(connections.check(platform)).rejects.toThrow(
      /in development/i
    );
    await expect(connections.require(platform)).rejects.toThrow(
      /in development/i
    );
  }
  expect(reads).toBe(0);
  expect(requests).toBe(0);
});
