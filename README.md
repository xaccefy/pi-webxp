<div align="center">

# pi-webxp

**Web search, page fetch, and documentation tools for the [Pi agent](https://github.com/earendil-works/pi-coding-agent).**

[![npm](https://img.shields.io/npm/v/@xaccefy/pi-webxp?style=flat-square&color=cb3837)](https://www.npmjs.com/package/@xaccefy/pi-webxp)
[![License: MIT](https://img.shields.io/github/license/xaccefy/pi-webxp?style=flat-square&color=blueviolet)](LICENSE)

</div>

## What it is

Four research tools in one package:

- `web_search`: search the web
- `web_fetch`: read a public web page
- `context7`: look up library documentation
- `deepwiki`: ask questions about a repository

`web_fetch` blocks private/internal hosts before submitting a URL to its fetch daemon.

## Install

```bash
pi install npm:@xaccefy/pi-webxp
```

Peer-depends on a Pi-compatible agent host (`@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `typebox`). Runtime deps: `@xaccefy/pi-shared`, `open-websearch`.

## Development

```bash
bun install
bun test --isolate
bun run typecheck
```

## License

MIT
