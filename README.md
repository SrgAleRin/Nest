# Nest

Лёгкий desktop-воркспейс для параллельной работы с CLI-агентами. Аналог Orca по сути, но без ботов, браузера, плагинов и нативного чата.

**Статус:** foundation v0.1 собран. Работают: три колонки, проекты и main checkout, worktree-задачи, PTY + xterm, SQLite, git/diff/комментарии, `FakeHarness` и e2e. Реальные harness-профили ждут smoke-теста на машинах коллег.

```
Project (git repo)
├── Main checkout (singleton)
│   └── Session
└── Task (worktree + branch)
    ├── Session (Claude Code / Codex / DSH / OpenCode / pi / Copilot)
    └── Session (второй harness на ту же задачу)
```

Три колонки:

- **слева** — проекты, main checkout, задачи и запущенные harness;
- **в центре** — настоящий терминал с harness CLI;
- **справа** — git, diff с комментариями и сессии.

Windows-first. В MVP нет фонового daemon: при закрытии приложения PTY-сессии завершаются, а задачи и scrollback сохраняются.

## Быстрый старт

Нужны Node.js 22.12+ (проверено на 24), pnpm и `git` в `PATH`.

```powershell
pnpm install
pnpm dev
```

Изолированный профиль для параллельного dev worktree:

```powershell
$env:NEST_PROFILE="core"; pnpm dev
```

Профиль переключает `userData`, `nest.db`, worktree-root и single-instance lock.

Проверки:

```powershell
pnpm typecheck
pnpm lint
pnpm test        # unit + PTY integration
pnpm build
pnpm test:e2e    # FakeHarness: старт, ввод, рестарт, scrollback
```

`FakeHarness` запускается через `node`, поэтому в dev-окружении Node должен быть в `PATH`. Реальные harness-профили ищутся по `where`/`which` и показываются в UI как доступные или отсутствующие.

## Структура

```text
apps/desktop        Electron main / preload / renderer
packages/shared     zod-схемы, RPC-контракт, harness-типы
packages/core       SQLite, миграции, git, PTY, sessions, comments
packages/ui         Button / Badge / EmptyState и другие примитивы
scripts             fake-harness.mjs
docs                продукт, архитектура, roadmap, макеты
```

## Скриншоты

### Workspace

![Workspace](docs/mockups/main.png)

### Foundation — реальное приложение

![Foundation](docs/mockups/foundation.png)

`FakeHarness` в main checkout, git и diff.

### Git

![Git](docs/mockups/git.png)

### Sessions

![Sessions](docs/mockups/sessions.png)

### New task

![New task](docs/mockups/new-task.png)

Интерактивный макет: [`docs/mockups/preview.html`](docs/mockups/preview.html). Можно открыть в браузере и переключать экраны сверху.

### Архитектура

![Архитектура](docs/mockups/architecture.png)

### Параллельная разработка

![План параллельной разработки](docs/mockups/parallel-plan.png)

## Документы

- [Продукт: идея, модель, сценарии, требования](docs/product.md)
- [Архитектура: стек, процессы, PTY, git, БД, безопасность](docs/architecture.md)
- [Harness compatibility: Claude, Codex, DSH, OpenCode, pi, Copilot](docs/harness-compat.md)
- [Roadmap: MVP, фазы, риски, открытые вопросы](docs/roadmap.md)
- [Параллельная разработка через dev worktrees](docs/parallel-dev.md)

## Коротко о стеке

**Electron 45** + React + TypeScript, `node-pty` + `xterm.js`, SQLite через встроенный `node:sqlite`, системный `git`. Ядро — отдельный пакет на Node; daemon для выживания сессий — позже, remote/SSH — долгий ящик.

Tauri 2 не входит в MVP, но оставлен как future experiment: если понадобится установщик < 30 МБ или мобильный клиент, делаем отдельный spike и сравниваем на цифрах. Подробнее — [ADR-001](docs/architecture.md#0-принятые-решения).

## Коротко о модели

- **Project** — зарегистрированный git-репозиторий.
- **Main checkout** — singleton-воркспейс проекта в корне репозитория, без worktree. Создаётся автоматически, не удаляется.
- **Task** — работа в отдельном `git worktree` + ветка `nest/<slug>`.
- **Session** — PTY-процесс с harness CLI; у задачи или main checkout может быть несколько сессий.
- **Comment** — локальный комментарий к строке diff; можно отправить в активную сессию.
- **Harness** — профиль команды: Claude Code, Codex, DeepSeek Harness, OpenCode, pi, GitHub Copilot CLI, custom.

## Что сознательно не входит в MVP

Нативный чат, browser/design mode, bots, Slack/Linear/Jira, плагины, split panes, Monaco, аккаунты, PR-провайдеры, фоновый daemon. Remote/SSH и mobile — долгий ящик, сценария пока нет.

## Следующий шаг

Foundation собран локально. Перед тегом `foundation-v0.1`:

1. прогнать CI на удалённом репозитории;
2. сделать smoke реального harness (Claude Code / Codex) на машине коллег;
3. проверить два одновременных dev-профиля;
4. собрать NSIS-установщик.

После этого — fork point и параллельные workstreams из [parallel-dev.md](docs/parallel-dev.md). Оставшиеся продуктовые вопросы — в [roadmap](docs/roadmap.md#5-открытые-вопросы).
