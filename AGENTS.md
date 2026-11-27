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

## Orca orchestration & model policy

Keep the expensive model for thinking; spend the cheap one on typing.

- Coordinator: whatever agent and model the user opened this session with. It stays in place —
  plan, decomposition, diff review and judging evidence happen here, on that model.
- Workers: `--agent pi --model Kodik/deepseek/deepseek-v4.1-flash-1017`. Only well-specified,
  mechanical steps: renames, file moves, boilerplate, running and reading a known test command,
  applying a change the coordinator already decided.

Rules:

- Never pass `--model` or `--effort` for the coordinator's own agent, never relaunch this session,
  never hand your own turn to another model, and never switch models mid-Run. The coordinator model
  is the one the user chose to talk to, so different sessions may run it on different models.
- Pass `--model` explicitly on every `orca orchestration worker-start`, always paired with the
  `--agent` that model belongs to. Never rely on an agent's configured default, and never let a
  worker pick or change its own model.
- A worker model id must be valid for its agent (`pi` takes `provider/id`). When you switch the
  worker agent, name that agent's own model id instead of reusing this one.
- Anything that needs a decision rather than a lookup moves back to the coordinator model.
- Specs are self-contained, because the worker is cheap: exact paths, exact change, the exact
  command whose output proves the task is done, and whether a non-zero exit is a failure.
- Omit `--effort` unless the chosen model reports thinking support; `--effort` requires `--model`.
- Fan out up to ~4 workers at once, then start the rest as those report back.
