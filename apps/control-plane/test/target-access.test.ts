import { describe, it, expect } from "vite-plus/test";
import {
  compileProgramScope,
  assertTargetRequest,
  validateTargetAccess,
  browserGuardrails,
  requestHeaders,
  readTargetSecret,
  targetSecretBindings,
  resolveTargetHeaders
} from "../../../shared/target-access";

it("generates stable distinct Cloudflare names without embedding target names or addresses", async () => {
  const a = await targetSecretBindings("target-one"),
    b = await targetSecretBindings("target_one");
  expect(a).toEqual(await targetSecretBindings("target-one"));
  expect(a).not.toEqual(b);
  expect(a.username).toMatch(/^PENTCLOUD_TARGET_[A-F0-9]{24}_USERNAME$/);
});
it("resolves required headers only from Cloudflare and rejects identity/header injection", async () => {
  const target = {
    url: "https://example.com/",
    access: { headers: [], headerBinding: "PENTCLOUD_TARGET_HEADERS" }
  };
  const value = await resolveTargetHeaders(target, async () =>
    JSON.stringify({ "X-Bug-Bounty": "researcher" })
  );
  expect(requestHeaders(value).get("X-Bug-Bounty")).toBe("researcher");
  expect(JSON.stringify(target)).not.toContain("researcher");
  for (const raw of [
    '{"Cookie":"session=x"}',
    '{"X-Researcher":"line\\nvalue"}',
    "[]",
    "bad"
  ])
    await expect(resolveTargetHeaders(target, async () => raw)).rejects.toThrow(
      /header/i
    );
});

const program = {
  id: "hackerone:example",
  name: "Example",
  platform: "hackerone",
  url: "https://hackerone.com/example",
  targets: {
    in_scope: [
      { type: "URL", value: "https://example.com/api/", instructions: null },
      { type: "WILDCARD", value: "*.example.net", instructions: null }
    ],
    out_of_scope: [
      {
        type: "URL",
        value: "https://example.com/api/admin/",
        instructions: null
      },
      { type: "URL", value: "private.example.net", instructions: null }
    ]
  }
};
const provenance = {
  catalogCommit: "a".repeat(40),
  sourceCommit: "b".repeat(40),
  sha256: "c".repeat(64),
  publishedAt: "2026-11-04T12:00:00Z"
};
function target(url = "https://example.com/api/") {
  return {
    url,
    access: {
      program: compileProgramScope(program, provenance, url),
      headers: [{ name: "X-Bug-Bounty", value: "researcher" }]
    }
  };
}

describe("target network scope", () => {
  it("retains explicit email provider selection while keeping old Cloudflare settings compatible", () => {
    const login = {
      url: "https://example.com/api/login",
      usernameBinding: "PENTCLOUD_TARGET_USER",
      passwordBinding: "PENTCLOUD_TARGET_PASS"
    };
    expect(
      validateTargetAccess("https://example.com/api/", {
        headers: [],
        login: {
          ...login,
          verification: {
            kind: "email",
            sender: "example.com",
            provider: "agentmail"
          }
        }
      }).login?.verification
    ).toEqual({ kind: "email", sender: "example.com", provider: "agentmail" });
    expect(
      validateTargetAccess("https://example.com/api/", {
        headers: [],
        login: {
          ...login,
          verification: { kind: "email", sender: "example.com" }
        }
      }).login?.verification
    ).toEqual({ kind: "email", sender: "example.com" });
    expect(() =>
      validateTargetAccess("https://example.com/api/", {
        headers: [],
        login: {
          ...login,
          verification: {
            kind: "email",
            sender: "example.com",
            provider: "other"
          }
        }
      })
    ).toThrow(/provider/);
  });
  it("matches effective default ports and preserves explicit scheme-less port restrictions", () => {
    const scoped = {
      ...program,
      targets: {
        in_scope: [{ type: "URL", value: "example.com" }],
        out_of_scope: [{ type: "URL", value: "example.com:80/admin" }]
      }
    };
    const t = {
      url: "http://example.com/",
      access: {
        headers: [],
        program: compileProgramScope(scoped, provenance, "http://example.com/")
      }
    };
    expect(() => assertTargetRequest(t, "http://example.com/admin/")).toThrow(
      /scope/i
    );
    const only443 = {
      ...scoped,
      targets: {
        in_scope: [{ type: "URL", value: "example.com:443" }],
        out_of_scope: []
      }
    };
    expect(() =>
      compileProgramScope(only443, provenance, "http://example.com/")
    ).toThrow(/scope/i);
  });
  it("keeps a selected concrete target within the imported program and gives exclusions precedence", () => {
    const t = target();
    expect(() =>
      assertTargetRequest(t, "https://example.com/api/reports?q=1")
    ).not.toThrow();
    for (const url of [
      "https://example.com/api/admin/users",
      "https://example.com/apiculture/",
      "https://other.example.net/",
      "http://example.com/api/",
      "https://example.com:8443/api/",
      "https://example.com.evil.test/api/"
    ])
      expect(() => assertTargetRequest(t, url)).toThrow();
  });
  it("does not expand a wildcard to its apex or to other selected-program assets", () => {
    const t = target("https://app.example.net/");
    expect(browserGuardrails(t)).toEqual({
      allowedDomains: ["app.example.net"]
    });
    expect(() =>
      compileProgramScope(program, provenance, "https://example.net/")
    ).toThrow(/scope/i);
    expect(() =>
      compileProgramScope(program, provenance, "https://private.example.net/")
    ).toThrow(/scope/i);
  });
  it("blocks encoded separator and repeated decoding tricks before making a request", () => {
    for (const path of [
      "%2fadmin",
      "%252fadmin",
      "%5cadmin",
      "%255cadmin",
      "%00admin"
    ])
      expect(() =>
        assertTargetRequest(target(), "https://example.com/api/" + path)
      ).toThrow();
    for (const path of [
      "%61dmin/users",
      "%2561dmin/users",
      "./admin/users",
      "reports/../admin/users",
      "/admin/users",
      "admin;ignored/users"
    ])
      expect(() =>
        assertTargetRequest(target(), "https://example.com/api/" + path)
      ).toThrow();
  });
  it("will not infer web authorization from an app identifier or silently discard an ambiguous web exclusion", () => {
    expect(() =>
      compileProgramScope(
        {
          ...program,
          targets: {
            in_scope: [
              { type: "GOOGLE_PLAY_APP_ID", value: "com.example.app" }
            ],
            out_of_scope: []
          }
        },
        provenance,
        "https://com.example.app/"
      )
    ).toThrow(/scope/i);
    expect(() =>
      compileProgramScope(
        {
          ...program,
          targets: {
            ...program.targets,
            out_of_scope: [
              { type: "URL", value: "example.com/{private,admin}" }
            ]
          }
        },
        provenance,
        "https://example.com/api/"
      )
    ).toThrow(/exclusion/i);
  });
  it("blocks private and non-HTTP target addresses", () => {
    for (const url of [
      "http://localhost/",
      "http://127.0.0.1/",
      "http://169.254.169.254/",
      "http://[::1]/",
      "file:///etc/passwd"
    ])
      expect(() => validateTargetAccess(url, { headers: [] })).toThrow();
  });
  it("rejects credential audience changes and operator or hop-by-hop headers", () => {
    for (const name of [
      "Host",
      "Cookie",
      "Authorization",
      "CF-Access-Client-Secret",
      "Connection",
      "Content-Length"
    ])
      expect(() =>
        validateTargetAccess(target().url, { headers: [{ name, value: "x" }] })
      ).toThrow(/header/i);
    expect(() =>
      validateTargetAccess(target().url, {
        headers: [],
        login: {
          url: "https://other.example/",
          usernameBinding: "PENTCLOUD_TARGET_USER",
          passwordBinding: "PENTCLOUD_TARGET_PASS"
        }
      })
    ).toThrow();
  });
  it("overwrites researcher header overrides and removes operator identity before egress", () => {
    const h = requestHeaders(target(), {
      "X-Bug-Bounty": "override",
      "CF-Access-Jwt-Assertion": "operator-jwt",
      Cookie: "login=secret",
      Accept: "application/json"
    });
    expect(h.get("X-Bug-Bounty")).toBe("researcher");
    expect(h.get("Accept")).toBe("application/json");
    expect(h.has("CF-Access-Jwt-Assertion")).toBe(false);
    expect(h.has("Cookie")).toBe(false);
  });
  it("only resolves target-prefixed bindings and supports the Secrets Store get interface", async () => {
    await expect(
      readTargetSecret(
        { OPENCODE_GO_API_KEY: "model-secret" },
        "OPENCODE_GO_API_KEY"
      )
    ).rejects.toThrow();
    await expect(
      readTargetSecret(
        { PENTCLOUD_TARGET_PASS: { get: async () => "target-password" } },
        "PENTCLOUD_TARGET_PASS"
      )
    ).resolves.toBe("target-password");
    const broker = {
      read: async (name: string) =>
        name === "PENTCLOUD_TARGET_PASS" ? "broker-password" : ""
    };
    await expect(
      readTargetSecret({ TARGET_SECRETS: broker }, "PENTCLOUD_TARGET_PASS")
    ).resolves.toBe("broker-password");
    await expect(
      readTargetSecret({ TARGET_SECRETS: broker }, "OPENCODE_GO_API_KEY")
    ).rejects.toThrow(/target credential/i);
    await expect(readTargetSecret({}, "PENTCLOUD_TARGET_PASS")).rejects.toThrow(
      /Cloudflare/i
    );
  });
});
