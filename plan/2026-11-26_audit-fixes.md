# План: исправление замечаний аудита 26.11.2026

Источник: `docs/audit-2026-11-26.md`. Дефекты A1–A16 + защита границ Electron. Продуктовые
уточнения (FR-01/02/03/09/12, NFR-10) — отдельным решением с пользователем, без кода в этом заходе.

## Схема

- Ветка интеграции: `audit/2026-11-fixes` (создана от `main` в главном checkout). `main` не меняется.
- Каждая задача — отдельный Orca-воркер в дочернем worktree; коммитит в свою ветку, не пушит.
- Координатор (я): мержит волны в `audit/2026-11-fixes`, гоняет `typecheck`/`lint`/`test`/`build`,
  добавляет сквозной E2E (улучшение №4), правит `docs/architecture.md` только при смене решений.

## Волна 1 (параллельно, 4 воркера) — запущена 26.11

| Задача | Воркспейс | Dispatch |
| --- | --- | --- |
| A1+A2 | `a1a2-lifecycle` | `ctx_87a9b8367c59` |
| A5 | `a5-diff-parser` | `ctx_dbf3a2afa3d8` |
| A3 | `a3-resume-exact` | `ctx_119958eaf4cc` |
| A16 | `a16-update-feed` | `ctx_faa6cdc1596b` |

База всех воркспейсов: `audit/2026-11-fixes` (`cb42253`), агент `pi`.

| #   | Задача                         | Файлы (владелец)                                                                                                    |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1   | A1+A2 — безопасное удаление    | `core/services/tasks.ts`, `core/services/projects.ts`, `core/index.ts`, `main/ipc.ts`, `renderer/App.tsx` (удаление) |
| 2   | A5 — парсер diff               | `core/git/diff.ts`, `core/test/diff.test.ts`                                                                        |
| 3   | A3 — `Resume exact`            | `core/harness/discovery.ts`, `core/services/sessions.ts` (resume/discovery)                                          |
| 4   | A16 — состояние обновлений     | `main/updates.ts`, `main/updateFeed.ts`, `main/ipc.ts` (settings/update)                                             |

## Волна 2 (после слияния волны 1) — запущена

A6 слит (`9ae60ce`), миграция A6 перенумерована в 8 (A3 занял 7).

| Задача | Воркспейс | Dispatch |
| --- | --- | --- |
| A4+A8+A11 | `a4a8a11-pty-stream` | `ctx_f2067d21b48e` |
| A6 | `a6-diff-modes` | `ctx_e3243e71a3a6` (слит) |

## Волна 3 (после слияния волны 1) — запущена

| Задача | Воркспейс | Dispatch |
| --- | --- | --- |
| A9+A10+A12 | `a9a10a12-git-tasks` | `ctx_8637ce3285c1` |
| A13+A14 | `a13a14-branch-tabs` | `ctx_3ad287916bcc` |
| Границы Electron | `boundaries-electron` | `ctx_d2382358438a` |



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

## Итог: всё слито в `audit/2026-11-fixes`

A1–A16 и границы Electron закрыты; сквозной E2E добавлен. Проверка после всех мерджей:
`typecheck`, `lint`, `build` — зелёные; `test` — 5 shared + 183 core (2 skipped) + 104 desktop;
`playwright --grep-invert 'packaged|plain HTTP feed'` — 12 passed, включая новый
`e2e/workflow.spec.ts` (New Task через UI → FakeHarness → diff-режимы → заметка и отправка →
commit → первый push в локальный bare origin → рестарт → удаление).

Решения координатора при слиянии:

1. Нумерация миграций: A3/A6/A4/A7 писали на одной базе — итог 7 (`resume_mode_heuristic`),
   8 (`task_base_ref`), 9 (`stream_position`), 10 (`stop_requested`), 11 (anchor-*).
2. Конфликт `comments.ts`: взят side-aware reader из A7 (`git/sides.ts`), в него возвращена
   проверка границ из Electron-хардненинга (realpath symlink/junction, отказ — ошибка, а не
   «нет якоря»).
3. `eslint.config.js` игнорирует вложенные git-worktree (`.git`-файл), иначе `pnpm lint` падал на
   `flatworm/` и на самих воркспейсах Orca.
4. `docs/product.md`: поиск везде `Ctrl+Shift+P`.

## Клавиатурные сокращения (запрос пользователя)

`Ctrl+N`, `Ctrl+W`, `Ctrl+Tab`/`Ctrl+Shift+Tab`, `Ctrl+`` реализованы: `renderer/src/shortcuts.ts`
+ `shortcuts.test.ts`, проводка в `App`, xterm-хендлер не отдаёт PTY только `Ctrl+Tab`/`Ctrl+``,
а `Ctrl+N`/`Ctrl+W` остаются шеллу при фокусе в терминале. Покрыто e2e в `terminals.spec.ts`,
описано в `docs/architecture.md` §6.9 и `docs/product.md` §7.

## Отменено по решению пользователя

Не считаем блокерами и не ждём результатов: packaged/update e2e, чистая Windows без Node.js,
smoke реальных CLI, нагрузочный прогон 10 сессий. NFR-01/02/03 замерами не подтверждаем —
в отчётах это указывать как «не измерялось», а не как дефект.

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

## Волна 4 — продуктовые дефолты (утверждены пользователем)

| Пункт | Решение | Исполнитель |
|---|---|---|
| FR-02 / §5.2 | `Create task` + `Create & start`, профиль harness в диалоге, путь и эффективная база до создания, прогресс по `operationId` в дереве, `Cancel` отменяет операцию, фокус не перехватывается | worker `w11-new-task` |
| FR-01 | default base ref проекта (`origin/HEAD` → текущая ветка), хранится при добавлении проекта | worker `w11-new-task` |
| FR-12 / NFR-04 / privacy | worktree root в настройках, `.env` копируется только по галочке (по умолчанию выкл.), встроенный GitHub feed остаётся дефолтом + явный выключатель проверок | worker `w12-settings` |
| FR-03/06/14 | `Idle` вместо «Waiting for you», `needs_input` из статусов убран, панель Sessions — по выбранной задаче | координатор |
| FR-09 / §5.5 | `Commit` и `Push` раздельно, упавший push не откатывает коммит и говорит об этом | координатор |

После мерджа: удалить дочерние воркспейсы волн 1–3 и ветки `Serge/*` (по слову пользователя),
прогнать `typecheck`/`lint`/`test`/e2e на интеграционной ветке.
