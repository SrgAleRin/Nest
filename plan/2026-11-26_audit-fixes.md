# План: исправление замечаний аудита 26.11.2026

Источник: `docs/audit-2026-11-26.md`. Дефекты A1–A16 + защита границ Electron. Продуктовые
уточнения (FR-01/02/03/09/12, NFR-10) — отдельным решением с пользователем, без кода в этом заходе.

## Схема

- Ветка интеграции: `audit/2026-11-fixes` (создана от `main` в главном checkout). `main` не меняется.
- Каждая задача — отдельный Orca-воркер в дочернем worktree; коммитит в свою ветку, не пушит.
- Координатор (я): мержит волны в `audit/2026-11-fixes`, гоняет `typecheck`/`lint`/`test`/`build`,
  добавляет сквозной E2E (улучшение №4), правит `docs/architecture.md` только при смене решений.

## Волна 1 (параллельно, 4 воркера)

| #   | Задача                         | Файлы (владелец)                                                                                                    |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | A1+A2 — безопасное удаление    | `core/services/tasks.ts`, `core/services/projects.ts`, `core/index.ts`, `main/ipc.ts`, `renderer/App.tsx` (удаление) |
| 2   | A5 — парсер diff               | `core/git/diff.ts`, `core/test/diff.test.ts`                                                                        |
| 3   | A3 — `Resume exact`            | `core/harness/discovery.ts`, `core/services/sessions.ts` (resume/discovery)                                          |
| 4   | A16 — состояние обновлений     | `main/updates.ts`, `main/updateFeed.ts`, `main/ipc.ts` (settings/update)                                             |

## Волна 2 (после слияния волны 1)

| #   | Задача                                     | Файлы (владелец)                                                                     |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------ |
| 5   | A4+A8+A11 — поток PTY и crash persistence  | `core/services/sessions.ts`, `renderer/components/TerminalPane.tsx`, `shared/rpc.ts` |
| 6   | A6+A7+A15 — ревью diff, заметки, якоря     | `core/services/git.ts` (diff), `core/services/comments.ts`, `DiffPanel.tsx`          |

## Волна 3 (после слияния волны 2)

| #   | Задача                                        | Файлы (владелец)                                                                     |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| 7   | A9+A10+A12 — задачи, push, rename             | `core/services/tasks.ts` (create), `projects.ts` (add), `git.ts` (push/status/discard), `GitPanel.tsx` |
| 8   | A13+A14 — состояние ветки и вкладок           | `renderer/App.tsx`, `main/ipc.ts` (checkout-обновление метаданных)                   |
| 9   | Границы Electron (улучшение №3)               | `main/index.ts`, `main/ipc.ts`, `core/services/comments.ts`, `core/services/setup.ts` |

## Остаётся за координатором

1. Слияние веток в `audit/2026-11-fixes`, разрешение конфликтов в `ipc.ts`/`rpc.ts`/`App.tsx`.
2. Сквозной E2E: New Task через UI → FakeHarness → staged/unstaged diff → заметка → commit/push в
   локальный bare remote → рестарт/удаление (улучшение №4).
3. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, E2E-прогон; при смене решений —
   `docs/architecture.md`.
4. Продуктовые вопросы из аудита (§ «Требования, которые надо уточнить»): New Task
   (`Create` / `Create & start`, прогресс по ID, `Close` vs `Cancel`, фокус), default base ref,
   `needs_input`/Idle в мониторинге, `Commit & push`, worktree root в настройках, default GitHub feed
   и `.env`-копирование, `Ctrl+K` vs `Ctrl+Shift+P`.
