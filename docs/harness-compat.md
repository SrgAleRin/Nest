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
| DeepSeek Harness | `dsh` | `dsh --profile <tui>` | PTY | `dsh --profile <tui> --continue` / `dsh --profile <tui> --resume <session>` | generic | tested |
| OpenCode | `opencode` | `opencode` | PTY | `opencode --session <id>` / `opencode --continue` | generic | tested: exact resume проверен вручную |
| pi | `pi` | `pi` | PTY | `pi --session-id <id>` / `pi --continue` | generic | supported |
| GitHub Copilot CLI | `copilot` | `copilot` | PTY | `copilot --resume <id>` / `copilot --continue` | generic | supported |
| ZCode | `zcode` | `zcode` | PTY | `zcode --resume <id>` / `zcode --continue` | generic | supported |
| Qwen Code | `qwen` | `qwen` | PTY | `qwen --resume <id>` / `qwen --continue` | generic | supported |
| Blank terminal | `shell` | `$NEST_SHELL` / `pwsh` / `$SHELL` | PTY | — | — | tested |
| Custom | `custom` | любая | PTY | — | — | generic |

`fake` — служебный профиль для e2e и разработки; в обычных списках он скрыт и появляется только при заданном `NEST_FAKE_SESSION_DIR` или `NEST_ENABLE_FAKE_HARNESS=1`. Через `get()` он остаётся доступен уже сохранённым сессиям и тестам.

`dsh` — только лончер: без `--profile <name>` он выходит с `error: --profile <name> is required`. Имя профиля реестр читает с диска (`$DSH_HOME/profiles`, по умолчанию `~/.dsh/profiles`): сначала `tui`, затем любой профиль, который подключает TUI-бандл (`@deepseek-harness-tui/dsh-tui`, у части релизов профиль называется `dsh-tui`). Если профилей нет, профиль остаётся пустым и лончер печатает свою ошибку. Флаги лончера всегда идут первыми, аргументы из Settings — после них.

Для `shell` команда резолвится так: `NEST_SHELL`, если задан; на Windows — `pwsh` при наличии в `PATH`, иначе `powershell.exe`, иначе `ComSpec`/`cmd.exe`; на остальных платформах — `$SHELL` или `bash`.

## Многострочный ввод (review-заметки и вставки)

Nest пишет многострочный блок в PTY сам; свободного текста в shell он не передаёт. Режим хранится в реестре (`HarnessRegistry.inputMode`, `packages/core/src/harness/paste.ts`):

| Режим | Профили | Что пишется |
|---|---|---|
| `bracketed-paste` | `claude`, `codex`, `opencode`, `pi`, `copilot`, `zcode`, `qwen`, `fake` | `ESC[200~` + текст (переводы строк `\n`) + `ESC[201~` + один `\r` |
| `line` | `shell`, `dsh`, `custom` | без escape-последовательностей: каждая непустая строка + `\r`, то есть каждая отправляется отдельно |

Почему так: агентские TUI включают bracketed paste и держат весь блок как один ввод — один `Enter` отправляет заметку целиком. `shell` (особенно `cmd.exe`), `dsh` и произвольная `custom`-команда такой режим не подтверждают: literal `ESC[200~` попал бы в транскрипт, поэтому им уходит текст без escape-последовательностей. Профиль без регистрации получает `bracketed-paste` — общий случай не регрессирует.

Проверка: `packages/core/test/paste.test.ts` фиксирует точные байты для обоих режимов и выбор режима по `harnessId`; смоук реальных CLI (строки 1–7 протокола ниже) — всё ещё после MVP.

## Resume в Nest

Завершённая сессия продолжается **в той же вкладке и той же строке БД**, новая сессия не создаётся:

1. закрытие окна не завершает сессию: Nest остаётся в трее, PTY продолжает работать;
2. если сессия была жива при **полном выходе**, при следующем запуске она **возобновляется автоматически**;
3. для остальных завершённых сессий есть кнопка **Resume exact**, **Resume unverified** (эвристический id) или **Resume latest**;
4. если сохранён подтверждённый `harness_session_id` (или пользователь нажал кнопку для эвристического), запускается exact-команда профиля (`--session <id>`, `resume <id>`, `--resume <id>`);
5. если id ещё не найден, используется fallback `--continue` / `resume --last`;
6. в scrollback добавляется маркер `── resume <harness> ──`, дальше идёт вывод продолженной сессии;
7. `session id`, заголовок и позиция вкладки сохраняются;
8. если harness не умеет resume, остаётся только **New session**.

`NEST_AUTO_RESUME=0` отключает автозапуск.

### Как определяется id беседы

После старта сессии Nest запускает discovery-адаптер: OpenCode — через `opencode session list --format json`, Codex/pi/Claude — по свежим JSONL в домашней директории CLI, Qwen — по `~/.qwen/projects/<sanitized-cwd>/chats/*.jsonl` (учитываются `QWEN_HOME` и `QWEN_RUNTIME_DIR`), Copilot — по `~/.copilot/session-state/<id>/events.jsonl`. Адаптер собирает все беседы этого `cwd`, попавшие во временное окно, а решение о принадлежности принимается отдельно.

У Copilot разговор (`events.jsonl`) появляется только с первым ходом, а `workspace.yaml` — уже при старте. Поэтому кандидатом считается лишь сессия с `events.jsonl`: Copilot отказывается продолжать сессию без разговора (`No session, task, or name matched`), и привязка такого id давала вечно падающий Resume. Время создания берётся из `created_at` в `workspace.yaml`, так что старая беседа, продолженная в другой вкладке, не привязывается как `exact`.

Правила выбора:

- `exact` — только если id напечатал сам запущенный процесс, либо это единственная беседа, созданная после старта, и на том же `cwd` нет второй вкладки того же harness;
- `heuristic` — беседа, которую CLI продолжил по `--continue`; id виден в UI, но помечен как неподтверждённый и **никогда** не применяется при автозапуске — только по явному нажатию;
- id не записывается совсем (остаётся `latest`), если кандидатов на `cwd` несколько, если беседа существовала до старта вкладки или если id уже закреплён за другой сессией проекта.

Проверка claim выполняется в том же `UPDATE`, что и запись id, и повторно при возобновлении: один id не может принадлежать двум вкладкам проекта.

Поиск повторяется с backoff, а также после ввода в терминал: большинство CLI создают беседу только после первого промпта. `heuristic` id может быть позже повышен до `exact`, если процесс напечатает его сам.

Ограничения:

- discovery — best effort; при отложенном создании беседы или молчащем CLI id может не найтись;
- для `dsh` discovery не подключён, поэтому exact-id не появляется и доступен только latest (`--continue`); на случай ручного id exact-команда в реестре уже есть;
- Claude-адаптер написан по формату `~/.claude/projects`, но вручную не проверялся;
- автоматический resume не запускает `--continue`, если на том же `cwd` есть другая вкладка того же harness, и никогда не подставляет `heuristic` id;
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

Свой CLI подключается в **Settings** (⚙ в статусбаре):

- поле **Custom command** — имя исполняемого файла на `PATH` или полный путь; аргументов нет, процесс стартует в workspace задачи;
- пустое поле убирает профиль из пикера новой вкладки и стартового экрана;
- встроенные профили выключаются чекбоксами: они пропадают из выбора, но уже существующие сессии продолжают возобновляться;
- список показывает `found` / `not found` — так видно, что команда действительно находится в `PATH`.

Настройки хранятся в локальной SQLite, поэтому переживают рестарт; env `NEST_CUSTOM_COMMAND` — dev-fallback, когда поле пустое. Exact resume и discovery для custom не поддерживаются, остаётся только новая сессия. Аргументы, env и иконка в UI пока не редактируются (P2).

Renderer не может передать произвольную shell-команду: единственный вход — `harnessId` из реестра, а custom-команда сохраняется в БД.

## Что проверять в первую очередь на Windows

- `.cmd` / `.bat` шимы (`claude.cmd`, `codex.cmd`, `dsh.cmd`);
- пробелы и кириллица в пути;
- PowerShell vs cmd;
- clipboard и IME;
- ConPTY resize;
- долгие TUI-сессии и scrollback.
