# AGENTS.md

Guidance for coding agents working in this repository.

**Be brief.** Short answers, small diffs, no filler.

## What this is

Nest is an Electron desktop app (Windows-first) for running parallel CLI agent sessions in isolated
git worktrees: real PTY terminal (xterm + node-pty), git panel, diff with review comments, session
resume, auto-updates.

Stack: Electron 45, React 19, TypeScript, electron-vite, Tailwind 4, SQLite via `node:sqlite`,
pnpm workspaces. Design decisions live in `docs/architecture.md`.

## Commands

Run from the repo root. Requires Node 24 and pnpm 12.18 (see `.github/workflows/ci.yml`).

```powershell
pnpm install
pnpm dev          # electron-vite dev
pnpm build        # emit apps/desktop/out
pnpm typecheck    # tsc across all packages
pnpm lint         # eslint
pnpm test         # vitest, all packages
pnpm test:e2e     # build + playwright (Windows, slow)
pnpm format       # prettier --write
```

## Layout

- `apps/desktop/src/main` — BrowserWindow, IPC router, watcher, tray, notifications, updates.
- `apps/desktop/src/preload` — contextBridge surface only: `invoke`, `on`, `platform`.
- `apps/desktop/src/renderer` — React UI.
- `apps/desktop/e2e` — Playwright specs.
- `packages/core` — db, git, tasks, sessions, comments, harness, settings, setup.
- `packages/shared` — zod schemas, RPC contract and types, events, utils.
- `packages/ui` — design primitives and theme.
- `docs` — architecture, product, release, harness compatibility (Russian).

## Rules

- `packages/core` stays pure Node: no `electron` imports, no native modules. That is why
  `@parcel/watcher` lives in `apps/desktop/src/main`.
- The renderer never touches `fs`, `child_process` or `ipcRenderer`; it calls `window.nest.invoke`.
  The preload surface stays a thin allowlist.
- A new RPC method means three edits: zod `params`/`result` in `packages/shared/src/rpc.ts`, a
  handler in `apps/desktop/src/main/ipc.ts`, and the call site. Main validates input.
- The renderer never sends shell commands — only a `harnessId` from the registry.
- Throw `NestError(code, message)` with a stable snake_case code; the UI surfaces the message.
- Verify every path stays inside the registered project or worktree before using it.
- Pass process arguments as arrays, never concatenated strings (Windows paths with spaces and
  Cyrillic).
- Schema changes go through `packages/core/src/db/migrations.ts`. SQLite runs in WAL mode.
- TypeScript is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`: relative imports
  carry `.js`, and types use `import type`.

## Conventions

- Unit tests are colocated `*.test.ts` next to the source (vitest, node environment). E2E lives in
  `apps/desktop/e2e`.
- Prettier: single quotes, semicolons, print width 100. Unused identifiers must be prefixed with `_`.
- Code, identifiers, comments and UI strings are English. `README.md` and `docs/` are Russian — keep
  that split.
- Done means `pnpm typecheck`, `pnpm lint` and `pnpm test` pass. Cover core logic with tests; small
  renderer changes do not need e2e.

## Guardrails

- Never delete or reset a user's main checkout. `worktree` tasks are disposable; the `checkout` task
  is a per-project singleton and only goes away with its project.
- Update `docs/architecture.md` only when a decision actually changes.
- Avoid new dependencies; a native module needs an `asarUnpack` entry in the electron-builder config.
