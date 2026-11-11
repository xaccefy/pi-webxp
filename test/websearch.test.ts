import assert from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import piWebxp from "../src/index.ts";
import { MockExtensionAPI } from "../test-utils.ts";

// Save original global fetch
const originalFetch = globalThis.fetch;

describe("pi-webxp: web_search/web_fetch", () => {
  beforeEach(() => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();

      if (urlStr.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", data: { daemon: "running" } }),
        } as Response;
      }

      if (urlStr.endsWith("/search")) {
        const body = JSON.parse((init?.body as string) || "{}");
        return {
          ok: true,
          json: async () => ({
            status: "ok",
            data: {
              query: body.query,
              results: [
                {
                  title: "CVE-2024-1234 Detail",
                  url: "https://nvd.nist.gov/vuln/detail/CVE-2024-1234",
                  content: "A buffer overflow vulnerability in target...",
                },
              ],
            },
          }),
        } as Response;
      }

      if (urlStr.endsWith("/fetch-web") || urlStr.endsWith("/fetch-github-readme")) {
        return {
          ok: true,
          json: async () => ({
            status: "ok",
            data: {
              url: "https://awiki.ai",
              markdown: "# Mocked Markdown Content",
            },
          }),
        } as Response;
      }

      return {
        ok: false,
        status: 404,
      } as Response;
    }) as any;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("registers only research tools and calls mock daemon endpoints", async () => {
    const pi = new MockExtensionAPI();
    piWebxp(pi as any);

    assert.deepStrictEqual(
      pi.tools.map((tool) => tool.name),
      ["web_search", "web_fetch", "context7", "deepwiki"],
    );
    const searchTool = pi.tools.find((t) => t.name === "web_search");
    const fetchTool = pi.tools.find((t) => t.name === "web_fetch");
    assert.ok(searchTool);
    assert.ok(fetchTool);

    // Call web_search
    const searchResult = await searchTool.execute(
      "call-1",
      { query: "CVE-2024-1234" },
      null,
      null,
      null,
    );
    assert.ok(searchResult.details.results.length > 0);
    assert.strictEqual(searchResult.details.results[0].title, "CVE-2024-1234 Detail");
    assert.ok(searchResult.content[0].text.includes("CVE-2024-1234 Detail"));

    // Call web_fetch
    const fetchResult = await fetchTool.execute(
      "call-2",
      { url: "https://github.com/Aas-ee/open-webSearch" },
      null,
      null,
      null,
    );
    assert.strictEqual(fetchResult.details.metadata.markdown, "# Mocked Markdown Content");
    assert.strictEqual(fetchResult.content[0].text, "# Mocked Markdown Content");
  });

  it("routes only bare github.com/owner/repo to /fetch-github-readme", async () => {
    const pi = new MockExtensionAPI();
    piWebxp(pi as any);
    const fetchTool = pi.tools.find((t) => t.name === "web_fetch");
    assert.ok(fetchTool);

    const hits: Array<[string, string]> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      const path = urlStr.slice(urlStr.indexOf("/", "http://x".length)); // everything after host
      if (urlStr.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", data: {} }) } as Response;
      }
      if (urlStr.endsWith("/fetch-github-readme") || urlStr.endsWith("/fetch-web")) {
        hits.push([path, JSON.parse(init?.body as string).url]);
        return {
          ok: true,
          json: async () => ({ status: "ok", data: { url: "", markdown: "x" } }),
        } as Response;
      }
      throw new Error(`unexpected endpoint: ${urlStr}`);
    }) as any;

    const urls = [
      "https://github.com/owner/repo",
      "https://github.com/owner/repo/issues/12",
      "https://github.com/owner/repo/blob/main/src/a.ts",
      "https://gist.github.com/user/id",
      "https://docs.github.com/en/actions",
      "https://example.com/page",
      // Substring in the query string must NOT trigger the GitHub route.
      "https://evil.example/?q=github.com",
    ];
    for (const [i, url] of urls.entries()) {
      await fetchTool.execute(`c${i}`, { url }, null, null, null);
    }

    assert.deepStrictEqual(hits, [
      ["/fetch-github-readme", "https://github.com/owner/repo"],
      ["/fetch-web", "https://github.com/owner/repo/issues/12"],
      ["/fetch-web", "https://raw.githubusercontent.com/owner/repo/main/src/a.ts"],
      ["/fetch-web", "https://gist.github.com/user/id"],
      ["/fetch-web", "https://docs.github.com/en/actions"],
      ["/fetch-web", "https://example.com/page"],
      ["/fetch-web", "https://evil.example/?q=github.com"],
    ]);
  });

  it("falls back to /fetch-web when the README fetcher 404s", async () => {
    const pi = new MockExtensionAPI();
    piWebxp(pi as any);
    const fetchTool = pi.tools.find((t) => t.name === "web_fetch");

    const hits: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", data: {} }) } as Response;
      }
      if (urlStr.endsWith("/fetch-github-readme")) {
        hits.push("readme");
        return { ok: false, status: 404, body: null } as unknown as Response;
      }
      if (urlStr.endsWith("/fetch-web")) {
        hits.push("web");
        return {
          ok: true,
          json: async () => ({ status: "ok", data: { content: "Copilot page" } }),
        } as Response;
      }
      throw new Error(`unexpected endpoint: ${urlStr}`);
    }) as any;

    const result = await fetchTool.execute(
      "c1",
      { url: "https://github.com/features/copilot" },
      null,
      null,
      null,
    );
    assert.deepStrictEqual(hits, ["readme", "web"]);
    assert.strictEqual(result.content[0].text, "Copilot page");
  });

  it("passes maxChars/renderMode to /fetch-web and truncates README output", async () => {
    const pi = new MockExtensionAPI();
    piWebxp(pi as any);
    const fetchTool = pi.tools.find((t) => t.name === "web_fetch");

    const bodies: any[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", data: {} }) } as Response;
      }
      bodies.push(JSON.parse(init?.body as string));
      if (urlStr.endsWith("/fetch-github-readme")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", data: { content: "r".repeat(1500) } }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          status: "ok",
          data: { content: "page", retrievalMethod: "browser-html" },
        }),
      } as Response;
    }) as any;

    const page = await fetchTool.execute(
      "c1",
      { url: "https://example.com/spa", maxChars: 5000, renderMode: "browser" },
      null,
      null,
      null,
    );
    assert.deepStrictEqual(bodies[0], {
      url: "https://example.com/spa",
      maxChars: 5000,
      renderMode: "browser",
    });
    assert.strictEqual(page.details.renderedBy, "browser-html");

    const readme = await fetchTool.execute(
      "c2",
      { url: "https://github.com/owner/repo", maxChars: 1000 },
      null,
      null,
      null,
    );
    assert.deepStrictEqual(bodies[1], { url: "https://github.com/owner/repo" });
    assert.strictEqual(
      readme.content[0].text,
      `${"r".repeat(1000)}\n\n[...truncated 500 characters]`,
    );
  });

  it("retries fetchWithRetry once on a transient 500 then succeeds", async () => {
    const pi = new MockExtensionAPI();
    piWebxp(pi as any);
    const searchTool = pi.tools.find((t) => t.name === "web_search");

    let searchCalls = 0;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", data: { daemon: "running" } }),
        } as Response;
      }
      if (urlStr.endsWith("/search")) {
        searchCalls++;
        if (searchCalls === 1) {
          return { ok: false, status: 500, json: async () => ({}) } as Response;
        }
        const body = JSON.parse((init?.body as string) || "{}");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: "ok",
            data: {
              query: body.query,
              results: [{ title: "Retry OK", url: "https://e/r", content: "x" }],
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as any;

    const result = await searchTool.execute("call-1", { query: "retryme" }, null, null, null);
    assert.strictEqual(searchCalls, 2); // initial 500 + one retry
    assert.strictEqual(result.details.results[0].title, "Retry OK");
  });

  it("passes readability/includeLinks and appends article links", async () => {
    const pi = new MockExtensionAPI();
    piWebxp(pi as any);
    const fetchTool = pi.tools.find((t) => t.name === "web_fetch");

    let sent: any;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (url.toString().endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", data: {} }) } as Response;
      }
      sent = JSON.parse(init?.body as string);
      return {
        ok: true,
        json: async () => ({
          status: "ok",
          data: {
            content: "Article",
            readableHtml: "<p>Article</p>",
            links: [{ text: "Docs", href: "https://example.com/docs" }, { text: "no href" }],
          },
        }),
      } as Response;
    }) as any;

    const result = await fetchTool.execute(
      "c1",
      { url: "https://example.com/post", includeLinks: true },
      null,
      null,
      null,
    );
    assert.strictEqual(sent.readability, true);
    assert.strictEqual(sent.includeLinks, true);
    assert.strictEqual(
      result.content[0].text,
      "Article\n\nLinks:\n- [Docs](https://example.com/docs)",
    );
    assert.strictEqual(result.details.metadata.readableHtml, undefined);
  });

  it("surfaces daemon error messages without the startup hint", async () => {
    const pi = new MockExtensionAPI();
    piWebxp(pi as any);
    const fetchTool = pi.tools.find((t) => t.name === "web_fetch");

    let calls = 0;
    let status = 502;
    let error: Record<string, unknown> = { message: "Target returned HTTP 404", retryable: true };
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (url.toString().endsWith("/health")) {
        return { ok: true, json: async () => ({ status: "ok", data: {} }) } as Response;
      }
      calls++;
      return {
        ok: false,
        status,
        json: async () => ({ status: "error", data: null, error, hint: "Try again" }),
      } as unknown as Response;
    }) as any;

    await assert.rejects(
      () => fetchTool.execute("c1", { url: "https://example.com/missing" }, null, null, null),
      (err: Error) => err.message === "Web fetch failed: Target returned HTTP 404\nHint: Try again",
    );
    assert.strictEqual(calls, 2);

    calls = 0;
    status = 503;
    error = { message: "Playwright is not available", retryable: false };
    await assert.rejects(
      () =>
        fetchTool.execute(
          "c2",
          { url: "https://example.com", renderMode: "browser" },
          null,
          null,
          null,
        ),
      /Playwright is not available/,
    );
    assert.strictEqual(calls, 1);
  });

  it("web_fetch blocks private/internal hosts (SSRF guard)", async () => {
    const pi = new MockExtensionAPI();
    piWebxp(pi as any);
    const fetchTool = pi.tools.find((t) => t.name === "web_fetch");
    await assert.rejects(
      () => fetchTool.execute("c1", { url: "http://127.0.0.1:8080/admin" }, null, null, null),
      /private\/internal host/,
    );
    await assert.rejects(
      () => fetchTool.execute("c2", { url: "http://[::ffff:10.0.0.1]/x" }, null, null, null),
      /private\/internal host/,
    );
  });

  it("web_fetch keeps thin SPA shells inside the daemon result", async () => {
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/health")) {
        return {
          ok: true,
          json: async () => ({ status: "ok", data: { daemon: "running" } }),
        } as Response;
      }
      if (urlStr.endsWith("/fetch-web")) {
        return {
          ok: true,
          json: async () => ({
            status: "ok",
            data: {
              contentType: "text/html; charset=utf-8",
              retrievalMethod: "request",
              content: "Loading...",
            },
          }),
        } as Response;
      }
      return { ok: false, status: 404 } as Response;
    }) as any;

    const pi = new MockExtensionAPI();
    piWebxp(pi as any);
    const fetchTool = pi.tools.find((t) => t.name === "web_fetch");
    assert.ok(fetchTool);

    const result = await fetchTool.execute(
      "call-spa",
      { url: "https://example.com/app" },
      null,
      null,
      null,
    );
    assert.strictEqual(result.content[0].text, "Loading...");
    assert.strictEqual(result.details.renderedBy, undefined);
  });

  it("session_start does not start or probe the daemon", async () => {
    const pi = new MockExtensionAPI();
    piWebxp(pi as any);

    let healthChecks = 0;
    globalThis.fetch = (async (url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.endsWith("/health")) {
        healthChecks++;
        throw new Error("session_start should not touch daemon health");
      }
      return { ok: true, json: async () => ({ status: "ok", data: {} }) } as Response;
    }) as any;

    const start = Date.now();
    await Promise.race([
      pi.emit("session_start", {}, {}),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("session_start blocked on daemon")), 1000),
      ),
    ]);
    assert.ok(Date.now() - start < 1000, "session_start should not await daemon startup");
    assert.strictEqual(healthChecks, 0);
  });
});
