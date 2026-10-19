# Contributing

Thanks for helping out. The project is small and dependency-free on purpose: plain TypeScript in the browser, Bun on the server.

## Setup

```sh
bun install
bun run demo      # simulated sessions, no OpenCode needed
bun run dev       # against your local OpenCode, with hot reload
```

## Before you open a pull request

```sh
bun run typecheck
bun test
```

`bun test` also runs isolated Chromium checks for browser input, questions, and session transcripts when Chrome/Chromium is installed. Set `CANVAS_BROWSER_BIN` for a custom executable path. Those checks are skipped when no browser is found.

To verify question payloads against an installed OpenCode v2 executable:

```sh
OPENCODE_TEST_BIN="$(command -v opencode)" bun test test/opencode.test.ts
```

This opt-in check starts its own loopback server with temporary configuration, data, and credentials. It creates only synthetic sessions and forms, makes no model inference requests, and removes its temporary state afterwards. It never uses your running OpenCode service.

- Keep layouts, formatting and status logic as pure functions with tests (`test/`).
- Try UI changes in demo mode (`?demo=1`) and against a real OpenCode server.
- If you add an OpenCode endpoint, list it in the README's "How it works" section. The full API spec is at `GET /openapi.json` on any OpenCode v2 server.

## Reporting bugs

Include your OpenCode version (`opencode --version`), browser, and what you expected versus what happened. Screenshots help, but check them for session content you don't want to share.
