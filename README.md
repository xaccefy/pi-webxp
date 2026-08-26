<div align="center">

# pi-webxp

**Web research + offensive HTTP transport for the [Pi agent](https://github.com/earendil-works/pi-coding-agent).**

[![npm](https://img.shields.io/npm/v/@xaccefy/pi-webxp?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@xaccefy/pi-webxp)
[![License: MIT](https://img.shields.io/github/license/xaccefy/pi-webxp?style=flat-square&color=blueviolet)](LICENSE)

</div>

## What it is

Two things in one package, deliberately:

**Research** — ground the agent in reality instead of its training data:
`web_search`, `web_fetch`, `deepwiki` (repo/library docs), `exploit_search` (exploit-technique lookup; needs `PREVIEW_IS_API_KEY`)

**Transport** — byte-exact attack primitives for classes where ordinary HTTP clients lie:
`raw_request` (byte-exact smuggling/desync probes), `race_send` (last-byte-sync batch-release racing), `http_request` (general purpose)

Network safety gates (`network-safety.ts`) scope what targets the transport tools will touch.

Works for **human + AI workflows**: you point it at an authorized target, it does the legwork — no autonomy layer included or wanted.

## Install

```bash
pi install npm:@xaccefy/pi-webxp
```

Peer-depends on a Pi-compatible agent host (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `typebox`). Runtime deps: `@xaccefy/pi-shared`, `open-websearch`, `tough-cookie`, `undici`.

## Development

```bash
bun install
bun test --isolate   # 61 tests
bun run typecheck
```

## License

MIT
