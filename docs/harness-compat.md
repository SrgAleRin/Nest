# Harness compatibility

Nest запускает harness как обычный CLI в PTY. Поэтому базовый сценарий не требует отдельной интеграции под каждого агента. Специфичные вещи — resume, hooks, точный статус `needs_input` — делаем по возможностям конкретного CLI.

## Статусы

- **tested** — автор запускал вручную, сценарий работает.
- **supported** — профиль есть, базовый PTY-запуск должен работать; ручного теста не было.
- **generic** — запускается как произвольная команда, без адаптера.
- **planned** — профиль есть в плане, но не в MVP.

## Матрица MVP

| Harness | id | Команда | Запуск | Resume | Hooks / статус | Тест |
|---|---|---|---|---|---|---|
| Claude Code | `claude` | `claude` | PTY | `claude --continue` / `claude --resume <id>` (best effort) | best effort по docs | supported; реальный smoke — после MVP, коллеги |
| Codex | `codex` | `codex` | PTY | `codex resume --last` | `notify` | tested |
| DeepSeek Harness | `dsh` | `dsh` | PTY | `dsh tui --resume <session>` (нужен id; пока не подключено) | generic | tested |
| OpenCode | `opencode` | `opencode` | PTY | `opencode --continue` | generic | tested |
| pi | `pi` | `pi` | PTY | `pi --continue` | generic | supported |
| GitHub Copilot CLI | `copilot` | `copilot` | PTY | `copilot --continue` | generic | supported |
| Blank terminal | `shell` | `$SHELL` / `pwsh` | PTY | — | — | tested |
| Custom | `custom` | любая | PTY | — | — | generic |

## Resume в Nest

Завершённая сессия продолжается **в той же вкладке и той же строке БД**, новая сессия не создаётся:

1. если сессия была жива при закрытии приложения, при следующем запуске она **возобновляется автоматически**;
2. для остальных завершённых сессий есть кнопка **Resume**;
3. запуск идёт с resume-аргументами профиля (`--continue` / `resume --last`);
4. в scrollback добавляется маркер `── resume <harness> ──`, дальше идёт вывод продолженной сессии;
5. `session id`, заголовок и позиция вкладки сохраняются;
6. если harness не умеет resume, остаётся только **New session**.

`NEST_AUTO_RESUME=0` отключает автозапуск.

Ограничение: `--continue` продолжает **последнюю** беседу в рабочей директории. Если в одной задаче было несколько сессий одного harness, Resume может поднять не ту беседу. Точные session id и resume по id — следующий шаг.

> Важно: «supported» не значит «проверено на всех версиях». Версию CLI фиксируем в отчёте о smoke-тесте.

## Claude Code без доступа автора

Claude Code не блокирует MVP, потому что:

1. базовый запуск — это обычный PTY (`claude`), без API и без парсинга чата;
2. профиль можно проверить через `FakeHarness` и через любого пользователя с аккаунтом;
3. resume/hooks — опциональные улучшения, не влияющие на запуск и терминал.

План проверки:

- e2e сейчас: `FakeHarness` с ANSI, вводом и exit code;
- реальный smoke — **после MVP**, силами коллег с доступом к Claude;
- фиксируем версию CLI и поведение `--resume` в этой таблице;
- если hooks не срабатывают — сессия остаётся `running`/`idle`, ничего не ломается.

Claude не блокирует MVP: профиль можно выпустить как `supported`, а реальный запуск подтвердить после релиза.

## Протокол smoke-теста

Для каждого профиля:

1. `where <command>` / `which <command>` — команда найдена.
2. Запуск в пустом worktree.
3. Проверить первый вывод и ввод.
4. Проверить `Ctrl+C` и корректное завершение.
5. Проверить resize терминала.
6. Проверить exit code 0 и non-zero.
7. Записать версию CLI и ОС.

## Формат профиля

```json
{
  "id": "claude",
  "name": "Claude Code",
  "command": "claude",
  "args": [],
  "env": {},
  "icon": "claude",
  "resume": ["--resume", "{sessionId}"],
  "statusHooks": "best-effort"
}
```

`resume` — шаблон аргументов; `{sessionId}` подставляется, если harness id известен. Если id нет, кнопка Resume не показывается.

## Добавление своего harness

Настройки → Harness → Add:

- имя и иконка;
- команда и аргументы;
- дополнительные env;
- optional resume-шаблон.

Custom-профиль — единственный способ запустить произвольную команду. Renderer не может передать shell-команду напрямую.

## Что проверять в первую очередь на Windows

- `.cmd` / `.bat` шимы (`claude.cmd`, `codex.cmd`, `dsh.cmd`);
- пробелы и кириллица в пути;
- PowerShell vs cmd;
- clipboard и IME;
- ConPTY resize;
- долгие TUI-сессии и scrollback.
