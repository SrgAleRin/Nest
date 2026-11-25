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
| Claude Code | `claude` | `claude` | PTY | `claude --resume <id>` / `claude --continue` | best effort по docs | supported; реальный smoke — после MVP, коллеги |
| Codex | `codex` | `codex` | PTY | `codex resume <id>` / `codex resume --last` | `notify` | tested |
| DeepSeek Harness | `dsh` | `dsh` | PTY | `dsh tui --resume <session>` (нужен id; пока не подключено) | generic | tested |
| OpenCode | `opencode` | `opencode` | PTY | `opencode --session <id>` / `opencode --continue` | generic | tested: exact resume проверен вручную |
| pi | `pi` | `pi` | PTY | `pi --session-id <id>` / `pi --continue` | generic | supported |
| GitHub Copilot CLI | `copilot` | `copilot` | PTY | `copilot --resume <id>` / `copilot --continue` | generic | supported |
| Blank terminal | `shell` | `$SHELL` / `pwsh` | PTY | — | — | tested |
| Custom | `custom` | любая | PTY | — | — | generic |

## Resume в Nest

Завершённая сессия продолжается **в той же вкладке и той же строке БД**, новая сессия не создаётся:

1. если сессия была жива при закрытии приложения, при следующем запуске она **возобновляется автоматически**;
2. для остальных завершённых сессий есть кнопка **Resume exact** или **Resume latest**;
3. если сохранён `harness_session_id`, запускается exact-команда профиля (`--session <id>`, `resume <id>`, `--resume <id>`);
4. если id ещё не найден, используется fallback `--continue` / `resume --last`;
5. в scrollback добавляется маркер `── resume <harness> ──`, дальше идёт вывод продолженной сессии;
6. `session id`, заголовок и позиция вкладки сохраняются;
7. если harness не умеет resume, остаётся только **New session**.

`NEST_AUTO_RESUME=0` отключает автозапуск.

### Как определяется id беседы

После старта сессии Nest запускает discovery-адаптер: OpenCode — через `opencode session list --format json`, Codex/pi/Claude — по свежим JSONL в домашней директории CLI, Copilot — по `workspace.yaml`. Совпадение проверяется по `cwd` и времени создания, побеждает самая новая беседа.

Поиск повторяется с backoff, а также после ввода в терминал: большинство CLI создают беседу только после первого промпта. Когда id найден, сессия получает `resume_mode = exact`; иначе остаётся `latest`.

Ограничения:

- discovery — best effort; при нескольких одновременных сессиях одного CLI в одном `cwd` возможна неоднозначность;
- для `dsh` источник id пока неизвестен, поэтому доступен только latest/best effort;
- Claude-адаптер написан по формату `~/.claude/projects`, но вручную не проверялся;
- если exact resume падает в первые 20 секунд, Nest сбрасывает id и предлагает `Resume latest`.

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
  "resumeArgs": ["--continue"],
  "statusHooks": "best-effort"
}
```

`resumeArgs` — fallback-аргументы для последней беседы. Exact-команда строится в реестре по id (`--session <id>`, `resume <id>`, `--resume <id>`). Если id ещё не найден, показывается `Resume latest`; если у профиля нет resume-аргументов вовсе — только `New session`. Custom-профиль exact resume не поддерживает.

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
