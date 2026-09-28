/** Web search, page fetch, library docs, and repo Q&A for Pi. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { context7Tool } from "./context7.ts";
import { deepwikiTool } from "./deepwiki.ts";
import websearchExtension from "./websearch.ts";

export default function piWebxp(pi: ExtensionAPI) {
  websearchExtension(pi);

  for (const [tool, callArg, resultKey, noun] of [
    [context7Tool, "libraryName", "libraryId", "Docs"],
    [deepwikiTool, "repo", "repo", "Answer"],
  ] as const) {
    pi.registerTool({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      parameters: tool.parameters,

      async execute(_id, params, signal, _onUpdate, _ctx) {
        try {
          return await tool.execute(_id, params as Record<string, unknown>, signal);
        } catch (error) {
          throw new Error(`${tool.label} error: ${(error as Error).message}`, { cause: error });
        }
      },

      renderCall(args, theme) {
        return new Text(
          theme.fg("toolTitle", theme.bold(`${tool.label} `)) +
            theme.fg("dim", ((args as Record<string, unknown>)[callArg] as string) ?? ""),
          0,
          0,
        );
      },

      renderResult(result, _options, theme, context) {
        if (context.isError) {
          return new Text(theme.fg("error", `✗ ${tool.label} failed`), 0, 0);
        }
        const details = result.details as Record<string, string> | undefined;
        return new Text(
          theme.fg("success", `✓ ${noun} `) + theme.fg("muted", details?.[resultKey] ?? ""),
          0,
          0,
        );
      },
    });
  }
}
