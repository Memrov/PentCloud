import { describe, expect, it } from "vite-plus/test";
import { canActivate } from "../src/ui/onboarding/api";
import { reconcileFormRevision } from "../src/ui/onboarding/form-revision";
describe("onboarding UI readiness", () => {
  it("ties CAS revisions to displayed inputs and requires explicit dirty-conflict resolution", () => {
    expect(
      reconcileFormRevision({ revision: 1, dirty: false, initialized: true }, 2)
    ).toBe("hydrate");
    expect(
      reconcileFormRevision({ revision: 1, dirty: true, initialized: true }, 2)
    ).toBe("conflict");
    expect(
      reconcileFormRevision(
        { revision: 1, dirty: true, initialized: true },
        2,
        true
      )
    ).toBe("hydrate");
  });
  it("opens chat during discovery after required connection tests, without admitting assessment work", () => {
    const value = {
      targets: [],
      credentials: [],
      defaults: [],
      run: { phase: "setup" },
      readiness: {
        modelsTested: true,
        apiTested: true,
        discoverySettled: false
      }
    };
    expect(canActivate(value as any)).toBe(true);
    expect(
      canActivate({
        ...value,
        readiness: { ...value.readiness, discoverySettled: true }
      } as any)
    ).toBe(true);
    expect(canActivate({ ...value, run: { phase: "discovery" } } as any)).toBe(
      true
    );
    expect(
      canActivate({
        ...value,
        readiness: { ...value.readiness, modelsTested: false }
      } as any)
    ).toBe(false);
    expect(
      canActivate({
        ...value,
        readiness: { ...value.readiness, apiTested: false }
      } as any)
    ).toBe(false);
    expect(canActivate({ ...value, run: { phase: "primary" } } as any)).toBe(
      false
    );
  });
});

it("reports catalog failures and explicitly refreshes catalogs before model testing", async () => {
  const { catalogs } = await import("../src/ui/onboarding/api");
  const paths: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    paths.push(String(input));
    return Response.json(
      { error: "OpenCode Go catalog returned HTTP 403" },
      { status: 503 }
    );
  };
  await expect(catalogs(true, fetcher)).rejects.toThrow(/HTTP 403/);
  expect(paths.every((path) => path.includes("refresh=1"))).toBe(true);
});
