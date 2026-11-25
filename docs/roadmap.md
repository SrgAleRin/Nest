# Nest — roadmap и риски

## 1. Границы MVP

MVP считается готовым, если можно:

1. добавить git-репозиторий;
2. создать задачу и получить отдельный worktree с веткой;
3. открыть основной checkout (main checkout) и работать в нём без worktree;
4. запустить Claude Code / Codex / DeepSeek Harness / OpenCode / pi / Copilot / любой CLI;
5. увидеть статус сессии в сайдбаре и правой панели;
6. посмотреть diff, stage, commit и push;
7. оставить комментарии к строкам diff и отправить их в активную сессию;
8. переключиться на другую задачу и вернуться без потери контекста;
9. закрыть и открыть приложение — задачи и scrollback на месте.

В MVP **нет**: нативного чата, browser, плагинов, remote/SSH, mobile, split panes, PR-провайдеров и checks, фонового daemon. Закрытие окна скрывает Nest в трей, поэтому PTY продолжают работать; полный выход завершает их, но сессии, живые в этот момент, автоматически продолжаются через resume harness; метаданные и scrollback сохраняются.

## 1.1 Ближайший план

Разработка идёт **одним потоком**: без dev worktree и параллельных workstreams. `NEST_PROFILE` остаётся утилитой для изолированной БД и чистого профиля при отладке, но второй одновременный инстанс больше не нужен.

Порядок работ после текущего foundation:

| # | Шаг | Статус / зачем |
|---|---|---|
| 1 | ~~Точный resume по `harness_session_id`~~ | Сделано: resume продолжает именно эту беседу, а не последнюю в workspace |
| 2 | OpenCode smoke — сделан, Codex — после MVP | Проверить TUI, ввод, resize, exit и resume на живых CLI |
| 3 | NSIS-установщик — собран; запуск на чистой Windows — когда будет машина | Проверить `node-pty` prebuilds, `node:sqlite`, asar, первый запуск |
| 4 | Тег `foundation-v0.1` | Базовая точка для откатов и сравнения, без fork point |
| 5 | Phase 2 → 3 → 4 | Задачи и worktrees, терминал, git/diff/комментарии — по порядку |
| 6 | Phase 5 | Полировка, e2e, поставка |

Точный resume изменил контракты и схему БД, поэтому он сделан до тега. CI не блокирует foundation: удалённого репозитория пока нет.

## 2. План разработки

Фазы идут строго последовательно, каждая заканчивается рабочим приложением:

```
Phase 1 Foundation ──► тег foundation-v0.1 ──► Phase 2 задачи/worktrees
     ──► Phase 3 терминал ──► Phase 4 git/diff/комментарии
     ──► Phase 5 полировка и поставка
```

Один поток выбран сознательно: контракты `packages/shared`, RPC, схема БД и layout меняются часто, а параллельные ветки на них дают конфликты дороже выигранного времени. Worktree внутри продукта (tasks) от этого не зависит — это фича Nest, а не способ его разработки.

### Phase 1 — foundation (1 неделя)

Отдельного spike нет: Orca уже доказала Electron + PTY + worktrees. Сразу строим вертикальный срез.

- Electron + electron-vite + React;
- трёхколоночный layout, ресайз, тёмная тема;
- `projects.add/list/remove`, определение base ref;
- автосоздание main checkout при добавлении проекта;
- дерево проектов: main checkout + задачи;
- `node-pty` + `xterm.js` на одном тестовом терминале;
- SQLite + baseline-миграция;
- типизированный RPC + preload + `MockRpcClient` для UI;
- `NEST_PROFILE` для изолированной БД и чистого профиля при отладке;
- CI на Windows: typecheck, lint, unit, build.

**Exit criteria:** можно добавить 2–3 репозитория, main checkout открывается, терминал печатает, проекты переживают перезапуск, контракты заморожены.

**Статус foundation-v0.1:**

- [x] pnpm-монорепо, Electron + React + TypeScript strict, Tailwind;
- [x] трёхколоночный layout, дерево проектов, main checkout, New task;
- [x] `packages/shared`: zod-схемы и RPC для projects/tasks/sessions/git/comments/harness;
- [x] `packages/core`: SQLite baseline, миграции, project/task/git/session/comment services;
- [x] PTY + xterm, scrollback в SQLite, восстановление `exited` после рестарта;
- [x] Resume завершённой сессии в той же вкладке (`--continue` / `resume --last`);
- [x] Авто-возобновление сессий, живых при закрытии/краше (`resume_on_start`);
- [x] Точный resume по сохранённому `harness_session_id` (OpenCode проверен вручную);
- [x] git status/diff/stage/commit/push, inline-комментарии, отправка в сессию;
- [x] `MockRpcClient` и `FakeHarness`;
- [x] `NEST_PROFILE` изолирует userData, БД, worktree-root;
- [x] unit/integration тесты и e2e FakeHarness → рестарт;
- [x] CI-конфиг для Windows;
- [x] `pnpm dist` и NSIS-установщик (локально: тихая установка, запуск, PTY, БД);
- [ ] первый прогон GitHub Actions на удалённом репозитории;
- [ ] smoke реального harness (Claude Code / Codex) на машине коллег;
- [ ] установщик на чистой Windows без Node.js.

### Сборка и упакованный смоук (сделано)

`pnpm dist` собирает `apps/desktop/release/win-unpacked` и `Nest Setup 0.1.0.exe` (NSIS x64, без подписи). Проверено локально:

1. asar содержит `out/**` и workspace-пакеты; `node-pty` распакован в `app.asar.unpacked`, `fake-harness.mjs` лежит в `resources/`.
2. `e2e/packaged.spec.ts` запускает `win-unpacked\Nest.exe` (или установленную копию через `NEST_E2E_EXE`) и проверяет старт окна, `projects.add`, PTY из ресурсного `fake-harness.mjs`, ввод и создание `nest.db`; без собранного релиза шаг пропускается.
3. Тихая установка `Nest Setup 0.1.0.exe /S /D=...` проходит, установленный `Nest.exe` тоже проходит смоук.

`npmRebuild: false` в [electron-builder.yml](../apps/desktop/electron-builder.yml): `node-pty` 1.1.0 собран на node-addon-api и поставляет prebuilds под `win32-x64`, поэтому `@electron/rebuild` не нужен и Visual Studio на сборочной машине не требуется.

Отдельно: оболочки на базе Electron (например, агентский harness) могут экспортировать `ELECTRON_RUN_AS_NODE=1`; тогда `Nest.exe` стартует как Node и отвергает `--remote-debugging-port`. e2e-спеки удаляют эту переменную из окружения дочернего процесса.

### Базовая точка foundation-v0.1

После проверки текущего состояния ставим локальный тег:

```bash
git tag foundation-v0.1
```

Это просто зафиксированная базовая точка: к ней можно откатиться и с ней сравнивать изменения. Fork point, dev worktree и отдельные ветки на workstreams не нужны — дальше работа идёт в `master` одним потоком.

Порядок фаз после тега: Phase 2 → Phase 3 → Phase 4 → Phase 5, каждая до рабочего состояния.

### Точный resume по session id (сделано)

`--continue` продолжает последнюю беседу harness в рабочей директории. Если в задаче несколько сессий одного CLI, этого мало. Теперь Nest хранит id беседы и продолжает именно её.

Реализовано:

1. Миграция 3: `sessions.harness_session_id TEXT`, `sessions.resume_mode TEXT NOT NULL DEFAULT 'latest'` (`exact` / `latest`).
2. После старта сессии discovery-адаптер ищет id, созданный после `created_at`, для текущего `cwd`. Первый запуск сразу, дальше повторы с backoff до ~18 с; ввод в терминал перезапускает поиск, потому что многие CLI создают беседу только после первого промпта.
3. Resume: если id известен — запускается exact-команда; иначе fallback на `--continue` / `resume --last`. После latest-resume поиск повторяется и может повысить сессию до `exact`.
4. UI показывает режим: `Resume exact` / `Resume latest`, бейдж `exact`/`latest` и короткий id в панели Sessions.
5. Если exact-resume падает в первые 20 с, id сбрасывается, сессия остаётся и предлагает `Resume latest`; ничего не теряется.

Discovery по harness:

| Harness | Где искать id | Resume exact |
|---|---|---|
| Claude Code | `~/.claude/projects/<escaped-cwd>/*.jsonl`, `sessionId`/`cwd` в первых строках | `claude --resume <id>` |
| Codex | `~/.codex/sessions/.../rollout-*.jsonl`, `session_meta.payload.id` | `codex resume <id>` |
| OpenCode | `opencode session list --format json` в cwd | `opencode --session <id>` |
| pi | `~/.pi/agent/sessions/**/*.jsonl`, первая строка `{type:"session", id, cwd}` | `pi --session-id <id>` |
| Copilot | `~/.copilot/session-state/<uuid>/workspace.yaml` | `copilot --resume <id>` |
| DSH | пока неизвестно | latest / best effort |
| Fake | `NEST_FAKE_SESSION_DIR/*.json` | тестовый полигон |

Проверка: 9 unit-тестов на выбор id по cwd/mtime, core-интеграция и e2e на `FakeHarness`, ручной smoke OpenCode (id захвачен, после рестарта продолжена та же беседа). Codex smoke отложен до после MVP.

### Phase 2 — задачи и worktrees (сделано)

Частично сделано в foundation: `worktree add/remove`, main checkout, New task.

Добавлено в Phase 2: `git fetch --prune` перед созданием (best effort, база может быть `origin/main`), setup script на проекте + копирование `.env` / `.env.local`, `setup_error` и бейдж `setup` при падении скрипта, проверка dirty перед удалением worktree (`workspace_dirty` без `force`, файлы перечисляются в подтверждении), выбор `New worktree` / `Main checkout` в модалке (`tasks.openCheckout` возвращает singleton), прогресс создания (`task:progress`: fetch → worktree → setup) и running-секция в сайдбаре.

- [x] модалка New task с выбором `New worktree` / `Main checkout`;
- [x] `git fetch` + `git worktree add` для worktree;
- [x] прогресс создания, rollback;
- [x] setup script, копирование `.env` (только worktree);
- [x] удаление worktree-задачи с проверкой dirty; main checkout не удаляется;
- [x] сайдбар: main checkout, задачи, статусы, running-секция.

**Exit criteria:** задача создаётся за < 10 секунд на среднем репо, main checkout открывается мгновенно, ошибки показываются с retry.

Shared dirs (`node_modules`) остаются в P1.

### Phase 3 — сессии и терминал (сделано)

Сделано в foundation: профили, start/stop/resume, табы, resize, scrollback, статусы, завершение PTY, точный resume по session id.

Добавлено в Phase 3: поиск по терминалу (`Ctrl/Cmd+F`, подсветка всех совпадений, счётчик, Enter/Shift+Enter), кликабельные ссылки через allowlist `app.openExternal`, copy/paste через системный clipboard (`Ctrl/Cmd+Shift+C/V`, `Ctrl+C` копирует только при выделении), лимит 8 смонтированных xterm с вытеснением по LRU и восстановлением из scrollback.

- [x] реестр harness-профилей: Claude Code, Codex, DeepSeek Harness, OpenCode, pi, Copilot, custom;
- [x] запуск/остановка/рестарт сессии;
- [x] табы сессий, переключение задач без убийства PTY;
- [x] resize, copy/paste, search, links;
- [x] scrollback snapshot;
- [x] статусы running/idle/exited/failed;
- [x] завершение всех PTY при выходе из приложения (без daemon);
- [x] лимит смонтированных xterm (8, LRU).

**Exit criteria:** 5 параллельных сессий, переключение между ними < 100 мс, память < 500 МБ, после рестарта scrollback на месте, процессы не висят.

### Phase 4 — git, diff и комментарии (сделано)

Сделано в foundation: status/diff/stage/commit/push, inline-комментарии, отправка в сессию, Sessions-панель.

Сделано в Phase 4 (первый заход): watcher файлов и git-каталога (`@parcel/watcher`, debounce 350 мс, `git:changed` на задачу), numstat в списке изменённых файлов (`+N −M`, включая untracked), виртуализированный diff (в DOM только окно строк, липкий заголовок файла) и подсветка Shiki с ленивыми грамматиками.

Затем: range-комментарии (Shift+клик по `+` расширяет диапазон) и re-anchor — якорь хранится как текст блока, при изменении файла комментарий переезжает следом, а при исчезновении текста помечается stale и показывается в начале файла.

- [x] `git status` с watcher;
- [x] список файлов, numstat;
- [x] unified diff с подсветкой;
- [x] stage/unstage;
- [x] commit/push;
- [x] branch/ahead/behind;
- [x] комментарии к строкам diff: создание, inline, resolve, удаление;
- [x] range-комментарии и re-anchor при изменении diff;
- [x] отправка комментариев в активную сессию (bracketed paste + fallback);
- [x] Sessions-панель;
- [x] одинаковый git/diff для worktree и main checkout, с бейджем `main`.

**Exit criteria:** полный цикл «изменил → посмотрел → оставил комментарий → отправил агенту → закоммитил → запушил» без терминала и в worktree, и в main checkout.

### Phase 5 — интеграция, полировка и поставка (1–2 недели)

- [x] настройки harness: custom-команда и вкл/выкл встроенных профилей (⚙ в статусбаре, SQLite);
- [ ] уведомления;
- [ ] command palette;
- [ ] empty states, ошибки, скелетоны;
- [ ] e2e-тесты (main checkout, FakeHarness, комментарии к diff);
- [ ] сборка: Windows NSIS — обязательна, macOS dmg — вторично, Linux — best effort;
- [ ] auto-update;
- [ ] документация.

**Exit criteria:** установщик на чистой Windows-машине, первый запуск без Node.js, обновление работает; main checkout и хотя бы 2 harness проходят smoke-тест.

Оценка для одного потока: foundation уже собран, осталось три-четыре недели последовательной работы.

| Фаза | Оценка |
|---|---|
| Phase 2 — задачи и worktrees | ~1 неделя |
| Phase 3 — сессии и терминал | ~1 неделя |
| Phase 4 — git, diff, комментарии | ~1–2 недели |
| Phase 5 — полировка и поставка | ~1–2 недели |

Параллелить фазы больше не планируем: экономия от двух одновременных веток меньше стоимости конфликтов в контрактах и схеме БД. Внутри фазы можно резать шаги на небольшие коммиты, но работа идёт в `master`.

## 3. Приоритеты после MVP

### P1 — «удобно каждый день»

- системные уведомления + бейдж;
- command palette;
- shared dirs (`node_modules`) через junction/symlink;
- архив задач и очистка старых worktree;
- настройки темы и шрифта терминала.

### P2 — «как Orca, но не всё»

- PR-провайдер (GitHub/GitLab) и checks — когда появится запрос;
- split panes (терминал + diff);
- фоновый daemon (сессии переживают закрытие окна);
- native chat;
- browser/design mode;
- plugins;
- usage tracking.

### Долгий ящик

- remote/SSH host;
- mobile companion.

Сценария «агент на другой машине» нет, поэтому remote не проектируем. Mobile — отдельный продукт, не часть Nest MVP. Вернуться можно только если появится реальная необходимость.

Каждый пункт P2 добавляется только если он не ломает три колонки и не превращает Nest в комбайн.

## 4. Риски

| Риск | Вероятность | Влияние | Митигация |
|---|---|---|---|
| Windows ConPTY и `.cmd`-шимы | высокая | высокое | вертикальный срез в Phase 1, запуск через `cmd.exe`, тесты на реальных harness |
| Claude Code не проверить локально | высокая | среднее | базовый запуск через generic PTY, `FakeHarness` в e2e, реальный smoke — после MVP силами коллег, фиксировать версию CLI |
| Main checkout: агент меняет общий checkout | высокая | среднее | бейдж `main`, предупреждение, не сбрасывать изменения автоматически, рекомендовать worktree для рискованных задач |
| Комментарии к diff: anchor и отправка в CLI | средняя | среднее | MVP single-line, file+line, bracketed paste + fallback, без GitHub sync и тредов |
| Статусы агентов врут | высокая | среднее | честный `idle` без hooks, hooks для Claude/Codex, не парсить TUI как основной сигнал |
| Git worktree на Windows: file locks, long paths | средняя | высокое | `Force delete`, long path support, понятные ошибки, тесты с antivirus |
| Утечка памяти при многих терминалах | средняя | среднее | лимит смонтированных xterm, snapshot, dispose |
| Большие репозитории: git status/diff тормозят | средняя | среднее | worker thread, debounce, лимиты diff, кэш |
| Расползание scope в Orca | высокая | высокое | фильтр «это делается командой?», жёсткий out-of-scope |
| Native modules ломаются при обновлении Electron | средняя | среднее | `@electron/rebuild` в CI, pinned Electron |
| Потеря данных при удалении worktree | низкая | высокое | проверка dirty, подтверждение, branch preserve |
| Пользователь ожидает чат | средняя | низкое | явно сказать: только терминал; чат — P2 |

## 5. Открытые вопросы

1. **Проверка Claude Code.** Кто из коллег и на какой версии CLI делает первый реальный smoke-тест после MVP? План: `FakeHarness` в e2e сейчас, реальный запуск — после MVP, фиксация версии в `harness-compat.md`.
2. **Точные команды/версии.** Подтверждены launch/resume-флаги OpenCode (`--continue`, `--session`), Codex (`resume --last`, `resume <id>`), pi (`--continue`, `--session-id`), Copilot (`--continue`, `--resume`). Discovery session id реализован для всех, кроме `dsh`; осталось: `dsh` resume, hooks и smoke Codex после MVP.
3. **Main checkout.** Разрешать несколько сессий одновременно? Рекомендация: да, но с предупреждением; worktree — для рискованных задач.
4. **Комментарии к diff.** Как отправлять многострочный текст в конкретный CLI: bracketed paste, построчная отправка или clipboard fallback? Проверить на Claude/Codex/DSH.
5. **Anchor комментариев.** Что делать, если строка уехала после нового diff: показывать предупреждение или пытаться re-anchor? В MVP — предупреждение, re-anchor в P1.
6. **Tauri.** Когда делать отдельный spike: после MVP или только при жёстком требовании по размеру? Рекомендация: после MVP, по необходимости.
7. **Название.** Nest — рабочее. Если есть конфликт по имени, меняем только брендинг.

## 6. Definition of Done для MVP

- установщик подписан и ставится на чистую Windows без Node.js;
- 3 проекта, 10 задач, 10 сессий — без деградации;
- main checkout открывается без копирования и проходит цикл diff → commit;
- комментарий к строке diff сохраняется после рестарта и отправляется в `FakeHarness`;
- создание worktree-задачи и запуск агента — < 30 секунд на среднем репо;
- ни одного потерянного worktree при штатных сценариях;
- PTY-сессии живут, пока Nest в трее; полный выход завершает их, живые сессии автоматически возобновляются через resume, scrollback восстанавливается;
- хотя бы 2 harness проходят smoke-тест; Claude-профиль проверен через `FakeHarness`;
- ошибки git/PTY показываются человеческим текстом с действием;
- e2e-тест проходит полный цикл;
- README и docs описывают, как собрать и запустить.
