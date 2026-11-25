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

В MVP **нет**: нативного чата, browser, плагинов, remote/SSH, mobile, split panes, PR-провайдеров и checks, фонового daemon. PTY-сессии завершаются вместе с приложением; после перезапуска остаются метаданные и scrollback.

## 2. План разработки

Подробная механика параллельной работы — в [parallel-dev.md](parallel-dev.md). Кратко:

```
Phase 1 Foundation (sequential)
        │
        ▼
   fork point: foundation-v0.1
        │
        ├── Core / Git
        ├── Sessions / Harness
        ├── UI Shell
        ├── Review / Diff
        └── Platform
        │
        ▼
Phase 5 Integration / release
```

До fork point — один поток. После — отдельные dev worktree на каждый workstream, ежедневный rebase и регулярный merge в `main`, а не один большой merge в конце.

### Phase 1 — foundation, sequential (1 неделя)

Отдельного spike нет: Orca уже доказала Electron + PTY + worktrees. Сразу строим вертикальный срез.

- Electron + electron-vite + React;
- трёхколоночный layout, ресайз, тёмная тема;
- `projects.add/list/remove`, определение base ref;
- автосоздание main checkout при добавлении проекта;
- дерево проектов: main checkout + задачи;
- `node-pty` + `xterm.js` на одном тестовом терминале;
- SQLite + baseline-миграция;
- типизированный RPC + preload + `MockRpcClient` для UI;
- `NEST_PROFILE` для изоляции dev worktree;
- CI на Windows: typecheck, lint, unit, build.

**Exit criteria:** можно добавить 2–3 репозитория, main checkout открывается, терминал печатает, проекты переживают перезапуск, контракты заморожены, два dev worktree работают одновременно с разными профилями.

**Статус foundation-v0.1:**

- [x] pnpm-монорепо, Electron + React + TypeScript strict, Tailwind;
- [x] трёхколоночный layout, дерево проектов, main checkout, New task;
- [x] `packages/shared`: zod-схемы и RPC для projects/tasks/sessions/git/comments/harness;
- [x] `packages/core`: SQLite baseline, миграции, project/task/git/session/comment services;
- [x] PTY + xterm, scrollback в SQLite, восстановление `exited` после рестарта;
- [x] git status/diff/stage/commit/push, inline-комментарии, отправка в сессию;
- [x] `MockRpcClient` и `FakeHarness`;
- [x] `NEST_PROFILE` изолирует userData, БД, worktree-root;
- [x] unit/integration тесты и e2e FakeHarness → рестарт;
- [x] CI-конфиг для Windows.
- [ ] первый прогон GitHub Actions на удалённом репозитории;
- [ ] smoke реального harness (Claude Code / Codex) на машине коллег;
- [ ] ручная проверка двух одновременно запущенных dev-профилей;
- [ ] `pnpm dist` и установщик NSIS.

### Fork point

После Phase 1:

```bash
git tag foundation-v0.1

git worktree add ../nest-core     -b feat/core     main
git worktree add ../nest-sessions -b feat/sessions main
git worktree add ../nest-ui       -b feat/ui       main
git worktree add ../nest-review   -b feat/review   main
git worktree add ../nest-platform -b chore/platform main
```

| Workstream | Основной результат |
|---|---|
| Core / Git | projects, main checkout, worktree lifecycle, git, comments backend |
| Sessions / Harness | PTY, harness-профили, статусы, scrollback, FakeHarness |
| UI Shell | layout, sidebar, New task, настройки, command palette |
| Review / Diff | Git-панель, diff viewer, inline-комментарии, send to session |
| Platform | CI, NSIS/dmg, auto-update, dev-профили |

Phase 2–4 — это milestones, а не отдельные ветки. Их закрывают параллельные workstreams; один workstream может трогать несколько фаз. Правила merge, contract changes, миграции и изоляция профилей — в [parallel-dev.md](parallel-dev.md).

### Phase 2 — задачи и worktrees (parallel, 1 неделя)

- модалка New task с выбором `New worktree` / `Main checkout` (второй просто открывает существующий main checkout);
- `git fetch` + `git worktree add` для worktree;
- прогресс создания, rollback;
- setup script, копирование `.env` (только worktree);
- удаление worktree-задачи с проверкой dirty; main checkout не удаляется;
- сайдбар: main checkout, задачи, статусы, running-секция.

**Exit criteria:** задача создаётся за < 10 секунд на среднем репо, main checkout открывается мгновенно, ошибки показываются с retry.

### Phase 3 — сессии и терминал (parallel, 1 неделя)

- реестр harness-профилей: Claude Code, Codex, DeepSeek Harness, OpenCode, pi, Copilot, custom;
- запуск/остановка/рестарт сессии;
- табы сессий, переключение задач без убийства PTY;
- resize, copy/paste, search, links;
- scrollback snapshot;
- статусы running/idle/exited/failed;
- завершение всех PTY при выходе из приложения (без daemon).

**Exit criteria:** 5 параллельных сессий, переключение между ними < 100 мс, память < 500 МБ, после рестарта scrollback на месте, процессы не висят.

### Phase 4 — git, diff и комментарии (parallel, 1–2 недели)

- `git status` с watcher;
- список файлов, numstat;
- unified diff с подсветкой;
- stage/unstage;
- commit/push;
- branch/ahead/behind;
- комментарии к строкам diff: создание, inline, resolve, удаление;
- отправка комментариев в активную сессию (bracketed paste + fallback);
- Sessions-панель;
- одинаковый git/diff для worktree и main checkout, с бейджем `main`.

**Exit criteria:** полный цикл «изменил → посмотрел → оставил комментарий → отправил агенту → закоммитил → запушил» без терминала и в worktree, и в main checkout.

### Phase 5 — интеграция, полировка и поставка (1–2 недели)

- уведомления;
- command palette;
- empty states, ошибки, скелетоны;
- настройки harness;
- e2e-тесты (main checkout, FakeHarness, комментарии к diff);
- сборка: Windows NSIS — обязательна, macOS dmg — вторично, Linux — best effort;
- auto-update;
- документация.

**Exit criteria:** установщик на чистой Windows-машине, первый запуск без Node.js, обновление работает; main checkout и хотя бы 2 harness проходят smoke-тест.

Оценка по команде:

| Команда | Календарь | Как распределять |
|---|---|---|
| 3 разработчика | **5–6 недель** | 1 неделя foundation, 3 недели parallel, 1–2 недели integration |
| 2 разработчика | **5–6 недель** | Core+Sessions и UI+Review; Platform по очереди |
| 1 разработчик | **6–7 недель** | 1–2 dev worktree на независимые задачи, без иллюзии полного параллелизма |

Фазы 2–4 не обязаны идти строго последовательно: после fork point они превращаются в параллельные workstreams. Критический путь — Core / Git и Sessions / Harness.

## 3. Приоритеты после MVP

### P1 — «удобно каждый день»

- системные уведомления + бейдж;
- command palette;
- resume harness-сессии;
- комментарии к диапазону строк (range) и re-anchor при изменении diff;
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
2. **Точные команды/версии.** Подтвердить `pi`, `copilot`, `dsh`, `opencode`: команда, флаги resume, hooks. Собрать в таблицу совместимости.
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
- PTY-сессии завершаются при выходе из приложения, scrollback восстанавливается;
- хотя бы 2 harness проходят smoke-тест; Claude-профиль проверен через `FakeHarness`;
- ошибки git/PTY показываются человеческим текстом с действием;
- e2e-тест проходит полный цикл;
- README и docs описывают, как собрать и запустить.
