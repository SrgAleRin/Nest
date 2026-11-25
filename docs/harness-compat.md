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
| Claude Code | `claude` | `claude` | PTY | `claude --resume <id>` (best effort) | best effort по docs | supported; реальный smoke — после MVP, коллеги |
| Codex | `codex` | `codex` | PTY | `codex resume <id>` | `notify` | tested |
| DeepSeek Harness | `dsh` | `dsh` | PTY | по возможностям CLI | generic | tested |
| OpenCode | `opencode` | `opencode` | PTY | по возможностям CLI | generic | tested |
| pi | `pi` | `pi` | PTY | по возможностям CLI | generic | supported |
| GitHub Copilot CLI | `copilot` | `copilot` | PTY | по возможностям CLI | generic | supported |
| Blank terminal | `shell` | `$SHELL` / `pwsh` | PTY | — | — | tested |
| Custom | `custom` | любая | PTY | — | — | generic |

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
