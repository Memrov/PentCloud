import { describe, expect, it } from "vite-plus/test";
import {
  assertSearchBinding,
  managedBrowser,
  managedWebSearch,
  nativeSearchOptions
} from "../src/native/managed-retrieval";
import { SEARCH_PROVIDERS } from "../../../shared/search-providers";
import type { OpenCodeWorkerd } from "@opencode/sdk/workerd";

const signal = () => new AbortController().signal;
const binding = {
  toMarkdown: async () => ({
    format: "markdown",
    data: "# Converted\n\nA **real** link."
  })
} as unknown as Ai;
const page = (body: string, type = "text/html") =>
  new Response(body, { headers: { "content-type": type } });
const scopes = ["https://example.com/docs/"];

describe("managed browser compatibility", () => {
  it("uses stock Web Fetch conversion and preserves original markdown response fields", async () => {
    const result = await managedBrowser(
      { url: "https://example.com/docs/page", action: "markdown" },
      {
        binding,
        scopes,
        signal: signal(),
        fetch: async () => page("<h1>Converted</h1><p>A <b>real</b> link.</p>")
      }
    );
    expect(result).toMatchObject({
      status: 200,
      url: "https://example.com/docs/page",
      markdown: "# Converted\n\nA **real** link."
    });
  });

  it("requests HTML for html action even when the origin supports Markdown negotiation", async () => {
    const result = await managedBrowser(
      { url: "https://example.com/docs/page", action: "html" },
      {
        binding,
        scopes,
        signal: signal(),
        fetch: async (_url, init) => {
          const accept = new Headers(init?.headers).get("accept");
          return accept?.startsWith("text/html")
            ? page("<h1>Original</h1>")
            : page("# Original", "text/markdown");
        }
      }
    );
    expect(result).toEqual({
      status: 200,
      url: "https://example.com/docs/page",
      html: "<h1>Original</h1>"
    });
  });

  it("accepts negotiated Markdown without invoking conversion", async () => {
    const result = await managedBrowser(
      { url: "https://example.com/docs/page", action: "markdown" },
      {
        binding: {} as Ai,
        scopes,
        signal: signal(),
        fetch: async () => page("# Negotiated", "text/markdown")
      }
    );
    expect(result).toMatchObject({
      markdown: "# Negotiated",
      format: "markdown-negotiated"
    });
  });

  it("refuses URLs outside the explicit path scope before issuing any request", async () => {
    for (const url of [
      "https://example.com/docs-other/page",
      "https://example.com/private",
      "https://user:pass@example.com/docs/page",
      "https://other.com/docs/"
    ]) {
      let requested = false;
      await expect(
        managedBrowser(
          { url, action: "html" },
          {
            binding,
            scopes,
            signal: signal(),
            fetch: async () => {
              requested = true;
              return page("must not fetch");
            }
          }
        )
      ).rejects.toThrow("explicit engagement scope");
      expect(requested).toBe(false);
    }
  });

  it("rechecks redirect targets against the full path scope before following", async () => {
    const visited: string[] = [];
    await expect(
      managedBrowser(
        { url: "https://example.com/docs/page", action: "markdown" },
        {
          binding,
          scopes,
          signal: signal(),
          fetch: async (url) => {
            visited.push(String(url));
            return new Response(null, {
              status: 302,
              headers: { location: "/private" }
            });
          }
        }
      )
    ).rejects.toThrow("explicit engagement scope");
    expect(visited).toEqual(["https://example.com/docs/page"]);
  });

  it("reads an explicitly scoped private lab URL and follows a redirect within its origin and path", async () => {
    const start = "http://10.23.45.67:8081/lab/start";
    const final = "http://10.23.45.67:8081/lab/final";
    const visited: string[] = [];
    const result = await managedBrowser(
      { url: start, action: "html" },
      {
        binding,
        scopes: ["http://10.23.45.67:8081/lab/"],
        signal: signal(),
        fetch: async (url) => {
          visited.push(String(url));
          return String(url) === start
            ? new Response(null, {
                status: 302,
                headers: { location: "/lab/final" }
              })
            : page("<h1>Scoped lab</h1>");
        }
      }
    );
    expect(result).toEqual({
      status: 200,
      url: final,
      html: "<h1>Scoped lab</h1>"
    });
    expect(visited).toEqual([start, final]);
  });

  it("refuses private lab redirects to a different origin or outside the scoped path before fetching them", async () => {
    const start = "http://10.23.45.67:8081/lab/start";
    for (const location of [
      "http://192.168.50.12:8081/lab/final",
      "http://10.23.45.67:8082/lab/final",
      "/private"
    ]) {
      const visited: string[] = [];
      await expect(
        managedBrowser(
          { url: start, action: "html" },
          {
            binding,
            scopes: ["http://10.23.45.67:8081/lab/"],
            signal: signal(),
            fetch: async (url) => {
              visited.push(String(url));
              return new Response(null, { status: 302, headers: { location } });
            }
          }
        )
      ).rejects.toThrow("explicit engagement scope");
      expect(visited).toEqual([start]);
    }
  });

  it("bounds streamed bodies and converted output", async () => {
    await expect(
      managedBrowser(
        { url: "https://example.com/docs/page", action: "html" },
        {
          binding,
          scopes,
          signal: signal(),
          fetch: async () => page("a".repeat(2 * 1024 * 1024 + 1))
        }
      )
    ).rejects.toThrow(/large|limit/i);
    await expect(
      managedBrowser(
        { url: "https://example.com/docs/page", action: "markdown" },
        {
          binding: {
            toMarkdown: async () => ({
              format: "markdown",
              data: "大".repeat(1024 * 1024)
            })
          } as unknown as Ai,
          scopes,
          signal: signal(),
          fetch: async () => page("<h1>small source</h1>")
        }
      )
    ).rejects.toThrow(/limit/i);
  });

  it("cancels conversion without publishing its late result", async () => {
    const abort = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = managedBrowser(
      { url: "https://example.com/docs/page", action: "markdown" },
      {
        binding: {
          toMarkdown: async () => {
            entered();
            await delayed;
            return { format: "markdown", data: "late result" };
          }
        } as unknown as Ai,
        scopes,
        signal: abort.signal,
        fetch: async () => page("<h1>late</h1>")
      }
    );
    await started;
    abort.abort(new Error("engagement cancelled"));
    await expect(result).rejects.toThrow("engagement cancelled");
    release();
  });
});

type QueryAPI = Pick<OpenCodeWorkerd.Interface["websearch"], "query">;
const native = (
  results: Array<{ url: string; title?: string; content?: string }>
): QueryAPI => ({
  query: async () => ({
    location: { directory: "/" },
    data: {
      providerID: "tinyfish",
      results: results.map((result) => ({ ...result, time: {} }))
    }
  })
});

describe("native OpenCode web search compatibility", () => {
  it.each(SEARCH_PROVIDERS)(
    "routes only to the selected $id provider",
    async ({ id }) => {
      let calls = 0;
      const api: QueryAPI = {
        query: async (input, options) => {
          calls++;
          expect(input).toEqual({ providerID: id, query: "Cloudflare" });
          expect(options?.signal).toBeInstanceOf(AbortSignal);
          return {
            location: { directory: "/" },
            data: {
              providerID: id,
              results: [{ url: "https://example.org/source", time: {} }]
            }
          };
        }
      };
      expect(
        (await managedWebSearch("Cloudflare", 3, signal(), api, id)).provider
      ).toBe(id);
      expect(calls).toBe(1);
    }
  );
  it("rejects provider substitution and propagates rate limits without fallback", async () => {
    await expect(
      managedWebSearch(
        "Cloudflare",
        3,
        signal(),
        native([{ url: "https://example.org" }]),
        "exa"
      )
    ).rejects.toThrow("unexpected provider");
    let calls = 0;
    const api: QueryAPI = {
      query: async () => {
        calls++;
        throw new Error("HTTP 429");
      }
    };
    await expect(
      managedWebSearch("Cloudflare", 3, signal(), api, "tavily")
    ).rejects.toThrow("HTTP 429");
    expect(calls).toBe(1);
  });
  it("states retrieval semantics and rejects unsupported exploit selectors before querying", () => {
    expect(nativeSearchOptions({ mode: "research" })).toMatchObject({
      requested_mode: "research",
      behavior: expect.stringContaining("Sourced retrieval only")
    });
    expect(() =>
      nativeSearchOptions({ mode: "exploit", sort: "date" })
    ).toThrow("does not support");
    expect(() =>
      nativeSearchOptions({ mode: "exploit", exploit_type: "tools" })
    ).toThrow("does not filter");
    expect(
      nativeSearchOptions({ mode: "links", sort: "default" }).requested_mode
    ).toBe("links");
  });
  it("maps real native sources to bounded original source fields and honors max_results", async () => {
    const output = await managedWebSearch(
      "Cloudflare Agents",
      2,
      signal(),
      native([
        {
          url: "https://developers.cloudflare.com/agents/",
          title: "Agents",
          content: "Official documentation"
        },
        {
          url: "https://developers.cloudflare.com/agents/",
          title: "duplicate"
        },
        { url: "javascript:alert(1)", title: "unsafe" },
        {
          url: "https://github.com/cloudflare/agents",
          title: "x".repeat(700),
          content: "y".repeat(3000)
        },
        { url: "https://example.org/third" }
      ])
    );
    expect(output.provider).toBe("tinyfish");
    expect(output.items).toEqual([
      {
        url: "https://developers.cloudflare.com/agents/",
        title: "Agents",
        description: "Official documentation"
      },
      {
        url: "https://github.com/cloudflare/agents",
        title: "x".repeat(500),
        description: "y".repeat(2000)
      }
    ]);
    expect(output.metadata).toMatchObject({
      query: "Cloudflare Agents",
      limit: 2
    });
  });

  it("rejects empty source evidence and never silently falls back to a paid provider", async () => {
    await expect(
      managedWebSearch("Cloudflare", 3, signal(), native([]))
    ).rejects.toThrow("no usable source evidence");
  });

  it("validates query bounds and cancellation before calling the native provider", async () => {
    let queried = false;
    const api: QueryAPI = {
      query: async () => {
        queried = true;
        throw new Error("must not search");
      }
    };
    await expect(managedWebSearch(" ", 3, signal(), api)).rejects.toThrow(
      "1–1024"
    );
    await expect(
      managedWebSearch("x".repeat(1025), 3, signal(), api)
    ).rejects.toThrow("1–1024");
    const abort = new AbortController();
    abort.abort(new Error("search cancelled"));
    await expect(
      managedWebSearch("Cloudflare", 3, abort.signal, api)
    ).rejects.toThrow("search cancelled");
    expect(queried).toBe(false);
  });

  it("passes cancellation to the native request and refuses a result returned after cancellation", async () => {
    const abort = new AbortController();
    const api: QueryAPI = {
      query: async (input, options) => {
        expect(input).toMatchObject({
          providerID: "tinyfish",
          query: "Cloudflare"
        });
        abort.abort(new Error("search cancelled"));
        expect(options?.signal?.aborted).toBe(true);
        return native([{ url: "https://example.org/late" }]).query(input);
      }
    };
    await expect(
      managedWebSearch("Cloudflare", 3, abort.signal, api)
    ).rejects.toThrow("search cancelled");
  });
});

describe("native search binding authentication", () => {
  it.each(SEARCH_PROVIDERS)(
    "accepts only the selected $binding runtime secret without reading other bindings",
    ({ id, binding }) => {
      const env = Object.fromEntries(
        SEARCH_PROVIDERS.map((item) => [
          item.binding,
          {
            get() {
              throw new Error("must never resolve a Store binding");
            }
          }
        ])
      );
      Object.assign(env, { [binding]: "private-fixture" });
      expect(() => assertSearchBinding(env, id)).not.toThrow();
    }
  );
  it("keeps historical TinyFish keyless when its binding is absent", () => {
    expect(() => assertSearchBinding({}, "tinyfish")).not.toThrow();
  });
  it.each(SEARCH_PROVIDERS.filter((item) => item.id !== "tinyfish"))(
    "fails clearly for missing $binding without using another provider",
    ({ id, binding }) => {
      expect(() =>
        assertSearchBinding({ TINYFISH_API_KEY: "other-provider-fixture" }, id)
      ).toThrow(binding);
    }
  );
  it("rejects empty secrets and does not resolve Secrets Store bindings", () => {
    for (const value of [
      "",
      "  ",
      {
        get() {
          throw new Error("private getter payload");
        }
      }
    ])
      expect(() => assertSearchBinding({ EXA_API_KEY: value }, "exa")).toThrow(
        "Configure the Cloudflare EXA_API_KEY encrypted Worker secret"
      );
  });
});
