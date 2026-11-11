/**
 * pi-websearch — keyless web search and page fetch adapter powered by open-websearch daemon.
 *
 * Exposes:
 * - Tool: web_search — query the internet using open-websearch engines.
 * - Tool: web_fetch — retrieve clean page markdown or article content.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { abortableSleep } from "@xaccefy/pi-shared";
import { Type } from "typebox";
import { assertPublicDns, isPublicHttpHost } from "./network-safety.ts";

// ── Constants & Environment ──────────────────────────────────────────

function resolveDaemonPort(): string {
  const raw = (process.env.PI_WEBSEARCH_PORT || "3210").trim();
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return "3210";
  return String(n);
}
const DAEMON_PORT = resolveDaemonPort();
const DEFAULT_ENGINES = (process.env.PI_WEBSEARCH_ENGINES || "duckduckgo,startpage")
  .split(",")
  .map((engine) => engine.trim())
  .filter(Boolean);
const DAEMON_URL = `http://127.0.0.1:${DAEMON_PORT}`;
let shuttingDown = false;

const POLL_INTERVAL_MS = 350;
const STARTUP_RETRIES = 15;
const REQUEST_TIMEOUT_MS = 30000;

let daemonProcess: ChildProcess | null = null;
let daemonSpawnError: Error | null = null;
let startupPromise: Promise<boolean> | null = null;

type DaemonResponse<T> = {
  status?: string;
  data?: T;
  error?: { message?: string; retryable?: boolean };
  hint?: string | null;
};

/** An error the daemon reported itself, so it is reachable and needs no startup hint. */
class DaemonReportedError extends Error {}

async function readDaemonError(res: Response): Promise<DaemonResponse<unknown>> {
  try {
    return (await res.json()) as DaemonResponse<unknown>;
  } catch {
    return {};
  }
}

type SearchResult = {
  title?: string;
  url?: string;
  content?: string;
  description?: string;
};

type SearchData = {
  results?: SearchResult[];
};

type FetchData =
  | string
  | {
      markdown?: string;
      content?: string;
      text?: string;
      retrievalMethod?: string;
      links?: Array<{ text?: string; href?: string }>;
      [key: string]: unknown;
    };

const DEFAULT_MAX_CHARS = 30000;
const MAX_LINKS = 100;

type FetchRoute = { endpoint: "/fetch-web" | "/fetch-github-readme"; url: string };

/** Bare github.com/owner/repo -> README; blob -> raw file; anything else -> page. */
export function resolveFetchRoute(parsed: URL): FetchRoute {
  const target = parsed.toString();
  if (parsed.hostname.toLowerCase() !== "github.com") {
    return { endpoint: "/fetch-web", url: target };
  }
  const segments = parsed.pathname.split("/").filter((seg) => seg.length > 0);
  if (segments.length === 2 && !parsed.search) {
    return { endpoint: "/fetch-github-readme", url: target };
  }
  if (segments.length >= 5 && segments[2] === "blob") {
    const [owner, repo, , ...rest] = segments;
    return {
      endpoint: "/fetch-web",
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}`,
    };
  }
  return { endpoint: "/fetch-web", url: target };
}

function truncateContent(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[...truncated ${text.length - maxChars} characters]`;
}

// ── Helpers ──────────────────────────────────────────────────────────

function getDaemonScriptPath(): string {
  try {
    const _require = createRequire(import.meta.url);
    return _require.resolve("open-websearch/build/index.js");
  } catch {
    return "";
  }
}

async function checkDaemonRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(500) });
    if (res.ok) {
      const body = (await res.json()) as DaemonResponse<{ daemon?: string }>;
      return body?.status === "ok" || body?.data?.daemon === "running";
    }
  } catch {}
  return false;
}

let resolvedDaemonBin: string | null = null;

/**
 * Pick the binary that runs the open-websearch daemon. open-websearch targets
 * Node; when pi runs under Bun, process.execPath is the bun binary, which may
 * not run a Node-oriented package. Prefer a real node binary: execPath when it
 * IS node, else a PATH lookup (probed once with --version), else execPath as a
 * last resort — the error handling in startDaemon surfaces the failure cleanly.
 */
function getDaemonBin(): string {
  if (resolvedDaemonBin) return resolvedDaemonBin;
  const execName = process.execPath.split(/[\\/]/).pop() ?? "";
  if (execName.startsWith("node")) {
    resolvedDaemonBin = process.execPath;
  } else {
    const probe = spawnSync("node", ["--version"], { stdio: "ignore" });
    resolvedDaemonBin = probe.status === 0 ? "node" : process.execPath;
  }
  return resolvedDaemonBin;
}

function startDaemon(): void {
  if (shuttingDown) return;
  const scriptPath = getDaemonScriptPath();
  if (!scriptPath) {
    throw new Error(
      "open-websearch package not found. Run npm/bun install so open-websearch is available.",
    );
  }

  daemonSpawnError = null;
  daemonProcess = spawn(getDaemonBin(), [scriptPath, "serve", "--port", DAEMON_PORT], {
    stdio: "ignore",
    env: { ...process.env, PORT: DAEMON_PORT },
    windowsHide: true,
    detached: false,
  });
  // Don't pin the event loop solely because the child is alive.
  daemonProcess.unref?.();

  // Without this, a spawn failure (e.g. missing binary) throws an unhandled
  // 'error' event and can take the whole host process down.
  daemonProcess.on("error", (err) => {
    daemonSpawnError = err;
    daemonProcess = null;
  });

  daemonProcess.on("exit", () => {
    daemonProcess = null;
  });
}

async function ensureDaemonRunning(): Promise<boolean> {
  if (shuttingDown) return false;
  // Assign the shared promise BEFORE any await so concurrent callers coalesce
  // onto one spawn instead of each forking a daemon and orphaning children.
  if (startupPromise) return startupPromise;

  startupPromise = (async () => {
    if (await checkDaemonRunning()) return true;
    // Re-check after the async health probe: a concurrent session_shutdown may
    // have flipped shuttingDown while we were awaiting. Don't spawn a daemon
    // the shutdown just killed.
    if (shuttingDown) return false;
    // startDaemon resets daemonSpawnError, so a call after a failed spawn
    // retries cleanly; the error only blocks when the fresh spawn also failed.
    if (!daemonProcess) startDaemon();
    if (daemonSpawnError) return false;
    for (let i = 0; i < STARTUP_RETRIES; i++) {
      if (shuttingDown) return false;
      if (daemonSpawnError) return false;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      if (await checkDaemonRunning()) return true;
    }
    return false;
  })();

  try {
    return await startupPromise;
  } finally {
    startupPromise = null;
  }
}

async function stopDaemon(): Promise<void> {
  shuttingDown = true;
  // Do NOT await an in-flight startup: the startup loop can run up to
  // STARTUP_RETRIES × POLL_INTERVAL (~5s) against a slow/booting daemon, and
  // session_shutdown must not block that long. No kill-then-respawn race
  // exists: startDaemon() runs exactly once, synchronously, before the poll
  // loop, and the loop checks shuttingDown at every await boundary — it
  // self-terminates on the next wake-up.
  if (daemonProcess) {
    try {
      daemonProcess.kill();
    } catch {}
    daemonProcess = null;
  }
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  parentSignal?: AbortSignal,
): Promise<Response> {
  const doFetch = (): Promise<Response> =>
    fetch(url, {
      ...options,
      signal: AbortSignal.any([
        ...(parentSignal ? [parentSignal] : []),
        AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ]),
    });

  const failure = async (res: Response, suffix = "") => {
    const { error, hint } = await readDaemonError(res);
    const err = error?.message
      ? new DaemonReportedError(hint ? `${error.message}\nHint: ${hint}` : error.message)
      : new Error(`HTTP ${res.status}${suffix}`);
    return { err, retryable: error?.retryable !== false };
  };

  const first = await doFetch();
  if (first.ok) return first;

  const status = first.status;
  const { err, retryable } = await failure(first);
  // Only retry transient failures (408/429/5xx); permanent 4xx should fail fast.
  if (!(status === 408 || status === 429 || status >= 500) || !retryable || parentSignal?.aborted) {
    throw err;
  }

  await abortableSleep(150, parentSignal);
  const retry = await doFetch();
  if (!retry.ok) throw (await failure(retry, " after retry")).err;
  return retry;
}

function validateAndParseUrl(input: string): URL {
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Protocol must be http: or https:");
    }
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid URL "${input}": ${msg}`);
  }
}

// ── Diagnostic Error Handler ──────────────────────────────────────────

function handleWebsearchError(err: unknown, toolName: string): never {
  const message = err instanceof Error ? err.message : String(err);
  let hint = "";
  if (
    !(err instanceof DaemonReportedError) &&
    (message.includes("establish connection") ||
      message.includes("fetch failed") ||
      message.includes("ECONNREFUSED") ||
      message.includes("HTTP 502") ||
      message.includes("HTTP 504") ||
      message.includes("daemon"))
  ) {
    hint = `\n\nHint: The 'open-websearch' daemon on port ${DAEMON_PORT} could not be reached or failed to start.\nTo troubleshoot:\n  1. Reinstall the package with 'pi install npm:@xaccefy/pi-webxp' so open-websearch is present.\n  2. Verify if another server is already bound to port ${DAEMON_PORT}.\n  3. You can manually launch the daemon by running:\n     npx open-websearch serve --port ${DAEMON_PORT}`;
  }
  throw new Error(`${toolName} failed: ${message}${hint}`, { cause: err });
}

// ── Pi Extension ──────────────────────────────────────────────────────

export default function websearchExtension(pi: ExtensionAPI) {
  // ── Tool: web_search ──
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web via search engines (no API key required).",
    promptSnippet: "Search the web for docs or general info",
    parameters: Type.Object(
      {
        query: Type.String({ description: "Search query string" }),
        limit: Type.Optional(
          Type.Integer({
            description: "Max search results (1-50, default: 10)",
            minimum: 1,
            maximum: 50,
          }),
        ),
        engines: Type.Optional(
          Type.Array(Type.String(), {
            description: `Engines to query (e.g. bing, duckduckgo, brave, exa; default: ${DEFAULT_ENGINES.join(", ")})`,
          }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(_id, params, signal, _onUpdate, _ctx) {
      try {
        const running = await ensureDaemonRunning();
        if (!running) {
          throw new Error(
            daemonSpawnError
              ? `Unable to start open-websearch daemon: ${daemonSpawnError.message}`
              : "Unable to establish connection with local open-websearch daemon.",
          );
        }

        const res = await fetchWithRetry(
          `${DAEMON_URL}/search`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              query: params.query,
              limit: params.limit ?? 10,
              engines: params.engines || DEFAULT_ENGINES,
            }),
          },
          signal,
        );

        const body = (await res.json()) as DaemonResponse<SearchData>;
        if (body?.status !== "ok" || !body?.data) {
          throw new Error(body?.error?.message || "Invalid response format from daemon");
        }

        const results = body.data.results || [];
        if (results.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `No results found for query: "${params.query}"` },
            ],
            details: { results: [] },
          };
        }

        let markdown = `Web Search Results for: "${params.query}"\n\n`;
        results.forEach((item, idx) => {
          markdown += `${idx + 1}. **${item.title || "Untitled"}**\n`;
          markdown += `   URL: ${item.url}\n`;
          if (item.content || item.description) {
            markdown += `   Snippet: ${item.content || item.description}\n`;
          }
          markdown += `\n`;
        });

        return {
          content: [{ type: "text" as const, text: markdown.trim() }],
          details: { results, query: params.query },
        };
      } catch (err) {
        return handleWebsearchError(err, "Web search");
      }
    },

    renderResult(result, { expanded }, theme, context) {
      const details = result.details as { results?: SearchResult[]; query?: string } | undefined;
      if (context.isError) {
        return new Text(theme.fg("error", "✗ Web Search failed"), 0, 0);
      }
      const results = details?.results || [];
      const query = details?.query || "";
      const baseText =
        theme.fg("success", "✓") +
        theme.fg("toolTitle", " Web Search: ") +
        theme.fg("dim", `${results.length} results found for "${query}"`);
      if (expanded) {
        const text = (result.content[0] as { text?: string } | undefined)?.text || "";
        return new Text(`${baseText}\n${text}`, 0, 0);
      }
      return new Text(baseText, 0, 0);
    },
  });

  // ── Tool: web_fetch ──
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Read text or markdown from an HTTP/HTTPS URL. A bare github.com/owner/repo URL returns its README; GitHub blob URLs return the raw file.",
    promptSnippet: "Fetch the text/markdown content of a URL",
    parameters: Type.Object(
      {
        url: Type.String({ description: "Valid HTTP or HTTPS URL to fetch" }),
        maxChars: Type.Optional(
          Type.Integer({
            description: `Max characters of content to return (1000-200000, default: ${DEFAULT_MAX_CHARS})`,
            minimum: 1000,
            maximum: 200000,
          }),
        ),
        renderMode: Type.Optional(
          Type.Union([Type.Literal("request"), Type.Literal("auto"), Type.Literal("browser")], {
            description:
              "request: plain HTTP only; auto (default): fall back to a browser for JS-heavy pages; browser: always render",
          }),
        ),
        readability: Type.Optional(
          Type.Boolean({ description: "Extract only the main article text, dropping nav and ads" }),
        ),
        includeLinks: Type.Optional(
          Type.Boolean({ description: "Append the article's links (implies readability)" }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(_id, params, signal, _onUpdate, _ctx) {
      try {
        const running = await ensureDaemonRunning();
        if (!running) {
          throw new Error(
            daemonSpawnError
              ? `Unable to start open-websearch daemon: ${daemonSpawnError.message}`
              : "Unable to establish connection with local open-websearch daemon.",
          );
        }

        if (!params.url) {
          throw new Error("Missing required 'url' parameter");
        }
        const parsedUrl = validateAndParseUrl(params.url);
        if (!isPublicHttpHost(parsedUrl)) {
          throw new Error(`Blocked: ${parsedUrl.hostname} is a private/internal host.`);
        }
        // This preflight check does not pin the daemon's later DNS resolution.
        await assertPublicDns(parsedUrl.hostname);
        const maxChars = params.maxChars ?? DEFAULT_MAX_CHARS;
        const route = resolveFetchRoute(parsedUrl);
        const targetUrl = route.url;

        const callDaemon = async (endpoint: FetchRoute["endpoint"]): Promise<FetchData> => {
          const res = await fetchWithRetry(
            `${DAEMON_URL}${endpoint}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(
                endpoint === "/fetch-web"
                  ? {
                      url: targetUrl,
                      maxChars,
                      renderMode: params.renderMode,
                      readability: params.readability || params.includeLinks || undefined,
                      includeLinks: params.includeLinks,
                    }
                  : { url: targetUrl },
              ),
            },
            signal,
          );
          const body = (await res.json()) as DaemonResponse<FetchData>;
          if (body?.status !== "ok" || !body?.data) {
            throw new Error(body?.error?.message || "Invalid response from daemon");
          }
          return body.data;
        };

        let endpoint = route.endpoint;
        let data: FetchData;
        try {
          data = await callDaemon(endpoint);
        } catch (err) {
          // Not every github.com/a/b is a repo (e.g. /features/copilot).
          if (endpoint !== "/fetch-github-readme" || signal?.aborted) throw err;
          endpoint = "/fetch-web";
          data = await callDaemon(endpoint);
        }

        const rawText =
          typeof data === "string"
            ? data
            : data.markdown || data.content || data.text || JSON.stringify(data);
        // /fetch-web already truncates to maxChars; the README fetcher does not.
        let textContent =
          endpoint === "/fetch-github-readme" ? truncateContent(rawText, maxChars) : rawText;
        const meta = typeof data === "string" ? undefined : data;
        const links = (meta?.links ?? []).filter((link) => link.href).slice(0, MAX_LINKS);
        if (links.length > 0) {
          textContent += `\n\nLinks:\n${links.map((l) => `- [${l.text || l.href}](${l.href})`).join("\n")}`;
        }
        const retrievalMethod = meta?.retrievalMethod;
        // readableHtml duplicates the text and can be large.
        const { readableHtml: _html, ...metadata } = meta ?? {};

        return {
          content: [{ type: "text" as const, text: textContent }],
          details: {
            metadata: meta ? metadata : data,
            url: targetUrl,
            renderedBy: retrievalMethod?.startsWith("browser") ? retrievalMethod : undefined,
          },
        };
      } catch (err) {
        return handleWebsearchError(err, "Web fetch");
      }
    },

    renderResult(result, { expanded }, theme, context) {
      const details = result.details as { url?: string; renderedBy?: string } | undefined;
      if (context.isError) {
        return new Text(theme.fg("error", "✗ Web Fetch failed"), 0, 0);
      }
      const url = details?.url || "";
      const text = (result.content[0] as { text?: string } | undefined)?.text || "";
      const textLength = text.length;
      const renderedNote = details?.renderedBy ? " (browser-rendered)" : "";
      const baseText =
        theme.fg("success", "✓") +
        theme.fg("toolTitle", " Web Fetch: ") +
        theme.fg("dim", `Fetched ${textLength} characters from "${url}"${renderedNote}`);
      if (expanded) {
        return new Text(`${baseText}\n${text}`, 0, 0);
      }
      return new Text(baseText, 0, 0);
    },
  });

  // ── Session Event Bindings ──────────────────────────────────────────

  pi.on("session_start", async () => {
    // Fresh session can spawn again even if a prior shutdown ran in-process.
    // Daemon startup is intentionally lazy: web_search/web_fetch start it only
    // when called, so installing webxp does not create a local listener during
    // ordinary sessions.
    shuttingDown = false;
  });

  pi.on("session_shutdown", async () => {
    await stopDaemon();
  });
}
