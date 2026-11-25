# Nest — архитектура

![Архитектура MVP](mockups/architecture.png)

## 0. Принятые решения

| # | Решение | Следствие |
|---|---|---|
| ADR-001 | **Electron**, не Tauri | проверенный `node-pty` + `xterm` на Windows; Tauri 2 остаётся future experiment, не MVP |
| ADR-002 | **Windows-first** | Windows 11 — основной таргет CI и ручных тестов; macOS вторичен; Linux best effort |
| ADR-003 | **Main checkout — singleton-workspace проекта** | можно работать без worktree; один на проект, не удаляется, сессии и git доступны |
| ADR-004 | **Без daemon в MVP** | Закрытие окна скрывает Nest в трей, PTY продолжают работать; полный выход завершает PTY, а живые сессии автоматически возобновляются через resume harness; scrollback сохраняется |
| ADR-005 | **Harness-профили MVP** | Claude Code, Codex, DeepSeek Harness, OpenCode, pi, GitHub Copilot CLI, custom |
| ADR-006 | **Комментарии к diff — в MVP** | хранятся в SQLite, привязаны к task/file/line, отправляются в активную PTY-сессию |
| ADR-007 | **PR-провайдеров нет в MVP** | только commit/push; GitHub/GitLab PR и checks — позже |
| ADR-008 | **Remote/SSH/mobile — долгий ящик** | `HostAdapter` остаётся тонким и локальным; remote не проектируем |
| ADR-009 | **Без spike** | Orca подтвердила Electron + PTY + worktrees; начинаем сразу с Phase 1 |
| ADR-010 | **SQLite через `node:sqlite`** | встроен в Node 24 внутри Electron 45: не нужен native rebuild, WAL, синхронный API; при необходимости переход на `better-sqlite3` — за тонким интерфейсом `Db` |

Tauri-заметка: если позже понадобится установщик < 30 МБ, мобильный клиент или минимальный runtime, делаем отдельный spike на Tauri 2 + `portable-pty` + `xterm`. Это не «переезд одной кнопкой»: Node-core придётся переписать на Rust или тащить sidecar. Поэтому решение по Tauri принимается отдельно и по цифрам, а не по умолчанию.

## 1. TL;DR

| Слой | Выбор |
|---|---|
| Desktop shell | Electron 45 |
| UI | React 19 + TypeScript + Vite (`electron-vite`) |
| Стили | Tailwind CSS 4 + дизайн-токены и собственные примитивы в `packages/ui` |
| Состояние | React state в foundation; Zustand + TanStack Query — когда появится необходимость |
| Терминал | `@xterm/xterm` + `@xterm/addon-fit` + `@xterm/addon-search` |
| PTY | `node-pty` (ConPTY на Windows) |
| БД | SQLite через `node:sqlite` (Node 24 в Electron 45), WAL |
| Git | системный `git` через `node:child_process` |
| Watcher | `@parcel/watcher` в Phase 4; в foundation — ручной refresh и события после мутаций |
| Diff | `git diff` + собственный парсер и viewer; Shiki/виртуализация — позже |
| Review comments | SQLite + inline threads в diff; отправка в активную PTY-сессию |
| PR | не в MVP; GitHub/GitLab и checks — позже |
| Валидация | `zod` на границе IPC |
| Сборка | `electron-builder` (NSIS / dmg / AppImage) |
| Тесты | Vitest + Playwright |
| Платформы | Windows-first; macOS вторичен; Linux best effort |
| Task kinds | `worktree` (по умолчанию) + `checkout` (singleton main checkout) |
| Сессии | без daemon в MVP: закрытие окна прячет приложение в трей и PTY живут; полный выход завершает PTY, живые сессии возобновляются через `--continue`/`resume` |

Монорепозиторий на pnpm. Ядро (`packages/core`) — обычный Node-код, который сейчас живёт в main-процессе, а позже может быть вынесен в отдельный daemon без переписывания UI.

## 2. Почему Electron, а не Tauri

Nest — это на 70% терминал и процессы, а не рендеринг. В этом месте у Electron есть проверенный стек:

- `node-pty` — де-факто стандарт PTY для Electron, включая ConPTY на Windows;
- `xterm.js` — тот же терминал, что в VS Code;
- весь код на TypeScript, без переключения контекста в Rust;
- Orca сама построена на Electron, то есть модель проверена на Windows;
- проще нанимать людей и переиспользовать примеры.

Минусы: размер дистрибутива (~120–180 МБ) и память. Для инструмента, который держит 3–10 терминалов, это приемлемо.

**Tauri 2** — разумная альтернатива, если критичен размер (~10–20 МБ). Но тогда PTY, git и файловые операции уходят в Rust (`portable-pty`, `git2`/CLI, `rusqlite`), а это больше работы и больше платформенных сюрпризов на Windows. Решение: начать на Electron, не смешивать слои, чтобы при необходимости заменить shell. Tauri-спайк — отдельный эксперимент после MVP, не часть текущего scope (ADR-001).

**VS Code extension** — дешёвый UI, но мы получаем чужие ограничения на layout, процессы и распространение. Не подходит.

## 3. Процессы и слои

```
┌──────────────────────────── Electron ────────────────────────────┐
│                                                                  │
│  Renderer (React)                                                │
│  ┌──────────────┬──────────────────────────┬──────────────────┐  │
│  │ Sidebar      │ Terminal (xterm.js)      │ Git / Diff /     │  │
│  │ Projects     │ Session tabs             │ Comments /       │  │
│  │              │                          │ Sessions         │  │
│  └──────────────┴──────────────────────────┴──────────────────┘  │
│          │ typed IPC (contextBridge, zod)                        │
│  Preload │ allowlisted API, no node integration                  │
│          │                                                       │
│  Main process                                                    │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ RPC router                                                 │  │
│  │   ├─ ProjectService                                        │  │
│  │   ├─ TaskService ── GitService ── git CLI                  │  │
│  │   ├─ SessionService ── node-pty ── harness process         │  │
│  │   ├─ HarnessRegistry                                       │  │
│  │   ├─ CommentService                                        │  │
│  │   ├─ Watcher (@parcel/watcher, Phase 4)                    │  │
│  │   └─ Db (node:sqlite, WAL)                                 │  │
│  └────────────────────────────────────────────────────────────┘  │
│          │                                                       │
│  SQLite (nest.db)   session logs / snapshots   worktrees on disk │
└──────────────────────────────────────────────────────────────────┘
```

Почему ядро не в renderer:

- PTY, файлы и git не должны жить в sandboxed renderer;
- при перезапуске окна процессы и состояние не должны зависеть от UI;
- ядро можно позже вынести в `nestd` и подключить по named pipe / WebSocket.

Почему не отдельный daemon сразу:

- для MVP это лишняя сложность (IPC, lifecycle, версионирование протокола);
- но границы (`HostAdapter`, RPC-контракт) проектируем так, чтобы вынос был механическим.

## 4. Модули

### `packages/shared`

- zod-схемы доменных объектов;
- типы RPC-контракта и событий;
- общие утилиты: slug, branch name, форматирование, пути.

### `packages/core`

Чистый Node, без импортов Electron.

| Модуль | Ответственность |
|---|---|
| `db` | подключение SQLite, миграции, prepared statements |
| `projects` | регистрация репозиториев, base ref, настройки |
| `tasks` | worktree + main checkout, статусы, архив |
| `git` | status, diff, stage, commit, push, worktree list; для checkout — корень проекта |
| `comments` | review comments: CRUD, anchor task/file/line, отправка в сессию |
| `sessions` | запуск PTY, lifecycle, статусы, scrollback; без daemon в MVP |
| `harness` | реестр профилей, detect installed, resume |
| `hosts` | `HostAdapter`; сейчас только `LocalHost` |
| `watcher` | debounce-события файлов и `.git` |
| `rpc` | регистрация методов, валидация, ошибки |

### `apps/desktop/src/main`

- создание `BrowserWindow`;
- wiring core-сервисов;
- IPC-роутер;
- tray, notifications, deep links (позже);
- graceful shutdown: остановить PTY, закрыть watcher, checkpoint БД.

### `apps/desktop/src/preload`

- `contextBridge.exposeInMainWorld('nest', ...)`;
- только `invoke(method, input)` и `on(event, handler)`;
- никаких прямых `ipcRenderer`, `fs`, `child_process`.

### `apps/desktop/src/renderer`

- layout и экраны;
- TanStack Query для `projects/tasks/sessions/git`;
- Zustand для выбранной задачи, таба, размеров панелей;
- xterm-инстансы в отдельном реестре, чтобы переживать переключение задач.

### `packages/ui`

- кнопки, инпуты, табы, диалоги, статус-точки;
- тема (dark first), типографика, иконки.

## 5. RPC-контракт

Один типизированный канал. Все входы валидируются zod, все ошибки — структурированные.

```ts
// packages/shared/src/rpc.ts
import { z } from 'zod';

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  baseRef: z.string(),
  createdAt: z.number(),
});

export const TaskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  kind: z.enum(['worktree', 'checkout']),
  branch: z.string(),
  workspacePath: z.string(),
  baseRef: z.string(),
  status: z.enum(['creating', 'active', 'review', 'done', 'archived', 'error']),
});

export const SessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  harnessId: z.string(),
  title: z.string(),
  status: z.enum(['starting', 'running', 'idle', 'needs_input', 'exited', 'failed']),
  pid: z.number().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  exitCode: z.number().optional(),
});

export const CommentSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  path: z.string(),
  side: z.enum(['old', 'new']),
  line: z.number().int().positive(),
  body: z.string(),
  status: z.enum(['open', 'sent', 'resolved']),
  sessionId: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sentAt: z.number().optional(),
});

export const rpcContract = {
  'projects.list':   { input: z.void(), output: z.array(ProjectSchema) },
  'projects.add':    { input: z.object({ path: z.string() }), output: ProjectSchema },
  'projects.remove': { input: z.object({ id: z.string() }), output: z.void() },

  'tasks.list':   { input: z.object({ projectId: z.string().optional() }), output: z.array(TaskSchema) },
  'tasks.create': { input: z.object({
    projectId: z.string(),
    title: z.string().min(1),
    location: z.enum(['worktree', 'checkout']).default('worktree'),
    baseRef: z.string().optional(),
    harnessId: z.string().optional(),
  }), output: TaskSchema },
  'tasks.delete': { input: z.object({ id: z.string(), deleteBranch: z.boolean() }), output: z.void() },
  'tasks.mainCheckout': { input: z.object({ projectId: z.string() }), output: TaskSchema },

  'sessions.start':  { input: z.object({ taskId: z.string(), harnessId: z.string(), cols: z.number(), rows: z.number() }), output: SessionSchema },
  'sessions.write':  { input: z.object({ id: z.string(), data: z.string() }), output: z.void() },
  'sessions.resize': { input: z.object({ id: z.string(), cols: z.number(), rows: z.number() }), output: z.void() },
  'sessions.stop':   { input: z.object({ id: z.string(), force: z.boolean().optional() }), output: z.void() },
  'sessions.list':   { input: z.object({ taskId: z.string().optional() }), output: z.array(SessionSchema) },

  'git.status': { input: z.object({ taskId: z.string() }), output: GitStatusSchema },
  'git.diff':   { input: z.object({ taskId: z.string(), path: z.string(), staged: z.boolean().optional() }), output: DiffSchema },
  'git.stage':  { input: z.object({ taskId: z.string(), paths: z.array(z.string()), staged: z.boolean() }), output: z.void() },
  'git.commit': { input: z.object({ taskId: z.string(), message: z.string().min(1) }), output: z.object({ sha: z.string() }) },
  'git.push':   { input: z.object({ taskId: z.string() }), output: z.void() },

  'comments.list':   { input: z.object({ taskId: z.string(), path: z.string().optional() }), output: z.array(CommentSchema) },
  'comments.create': { input: z.object({
    taskId: z.string(),
    path: z.string(),
    side: z.enum(['old', 'new']),
    line: z.number().int().positive(),
    body: z.string().min(1),
  }), output: CommentSchema },
  'comments.update': { input: z.object({
    id: z.string(),
    body: z.string().min(1).optional(),
    status: z.enum(['open', 'sent', 'resolved']).optional(),
  }), output: CommentSchema },
  'comments.delete': { input: z.object({ id: z.string() }), output: z.void() },
  'comments.send':   { input: z.object({
    ids: z.array(z.string()).min(1),
    sessionId: z.string().optional(),
  }), output: z.object({ sent: z.number(), sessionId: z.string() }) },
};
```

События main → renderer:

```ts
export type NestEvent =
  | { type: 'session:data'; sessionId: string; data: string }
  | { type: 'session:status'; sessionId: string; status: SessionStatus; exitCode?: number }
  | { type: 'task:updated'; task: Task }
  | { type: 'task:progress'; taskId: string; step: string; message?: string }
  | { type: 'git:changed'; taskId: string }
  | { type: 'notification'; level: 'info' | 'warn' | 'error'; title: string; body: string };
```

Preload:

```ts
contextBridge.exposeInMainWorld('nest', {
  invoke: (method: keyof typeof rpcContract, input: unknown) =>
    ipcRenderer.invoke('nest:rpc', method, input),
  on: (handler: (event: NestEvent) => void) => {
    const listener = (_: unknown, event: NestEvent) => handler(event);
    ipcRenderer.on('nest:event', listener);
    return () => ipcRenderer.removeListener('nest:event', listener);
  },
});
```

Правила:

- renderer не передаёт произвольные shell-команды; только `harnessId` из реестра;
- все пути проверяются: должны лежать внутри зарегистрированного проекта/worktree;
- ошибки имеют код (`GIT_DIRTY`, `WORKTREE_EXISTS`, `HARNESS_NOT_FOUND`, `PTY_SPAWN_FAILED`);
- долгие операции возвращают `operationId` и стримят прогресс событиями.

## 6. PTY и терминал

### 6.0 Последовательность запуска

```
User            Renderer              Main / Core             Machine
 │  New task       │                       │                     │
 ├────────────────►│  tasks.create         │                     │
 │                 ├──────────────────────►│  git worktree add   │
 │                 │                       ├────────────────────►│
 │                 │                       │  insert task row    │
 │                 │  task:updated         │                     │
 │                 │◄──────────────────────┤                     │
 │                 │  sessions.start       │                     │
 │                 ├──────────────────────►│  node-pty.spawn     │
 │                 │                       ├────────────────────►│
 │                 │  session:data         │  stdout/stderr      │
 │                 │◄──────────────────────┤◄────────────────────┤
 │  type in term   │                       │                     │
 ├────────────────►│  sessions.write       │                     │
 │                 ├──────────────────────►│  pty.write          │
 │                 │                       ├────────────────────►│
```

### 6.1 Запуск

```ts
import * as pty from 'node-pty';

const proc = pty.spawn(command, args, {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: workspacePath,
  env: { ...process.env, ...profile.env, NEST_SESSION_ID: sessionId },
  useConpty: process.platform === 'win32',
});
```

Windows-нюанс: `claude`, `codex`, `dsh` часто являются `.cmd`-шимами. `node-pty` не запускает `.cmd` напрямую. Решение:

- резолвить команду через `where.exe` / `which`;
- если это `.cmd`/`.bat`, запускать `cmd.exe /d /s /c "<command> <args>"`;
- аргументы экранировать по правилам Windows (`windowsVerbatimArguments` / собственная функция);
- логировать фактическую команду в session metadata для диагностики.

### 6.2 Поток данных

```
pty.onData(chunk)
  → batch 8–16 ms
  → webContents.send('nest:event', { type:'session:data', ... })
  → xterm.write(chunk, ack)
  → ack every 64 KB
  → if unacked > 1 MB: pty.pause()
```

- batching обязателен: TUI-агенты выдают много мелких escape-последовательностей;
- backpressure защищает renderer от OOM при `yes` или огромном логе;
- для 10+ сессий можно перейти на `MessageChannelMain` (отдельный port на сессию), но это оптимизация, не MVP.

### 6.3 Resize

- `FitAddon.fit()` на `ResizeObserver` контейнера;
- debounce 50 мс;
- `pty.resize(cols, rows)`;
- при скрытом табе не ресайзить, а запомнить размеры и применить при показе.

### 6.4 Scrollback и восстановление

Два уровня:

1. **Raw log** — всё, что пришло из PTY, пишется в `sessions/<id>.log` (append-only, с лимитом).
2. **Snapshot** — в main держим headless-xterm (`@xterm/headless`) и раз в 5 секунд (или при закрытии) сериализуем состояние через `@xterm/addon-serialize`.

При открытии сессии:

- если процесс жив — создаём xterm и продолжаем поток;
- если процесс умер — пишем snapshot, затем хвост raw log (если snapshot старше);
- если snapshot нет — replay последних N КБ raw log.

Это даёт быстрый возврат к задаче без хранения мегабайт ANSI в SQLite.

### 6.5 Инстансы терминалов

- Держим смонтированными до 8 xterm-инстансов (активные + недавние).
- Остальные dispose и восстанавливаются из snapshot.
- При переключении задачи не убиваем PTY; скрываем контейнер.
- При закрытии таба спрашиваем: `Stop session` или `Keep running` (P1).

### 6.6 Жизненный цикл и приложение

В MVP **нет фонового daemon**, но закрытие окна не убивает работу:

- при закрытии окна Nest скрывается в трей, PTY-процессы и xterm продолжают жить; повторный клик по иконке или запуск Nest показывает то же окно и те же терминалы;
- полный выход (**Quit Nest** в меню трея) завершает все PTY-процессы;
- сессии, которые были живы в этот момент, помечаются `resume_on_start = 1`;
- при следующем запуске они автоматически возобновляются в тех же вкладках: по сохранённому `harness_session_id` (exact), иначе через `--continue` / `resume --last` (latest);
- id беседы определяется discovery-адаптером после старта: OpenCode — `session list --format json`, Codex/pi/Claude — свежие JSONL по `cwd`, Copilot — `workspace.yaml`; поиск повторяется после ввода;
- в БД сессии, завершившиеся сами или остановленные пользователем, помечаются `exited`/`failed`;
- snapshot/scrollback сохраняется, новый вывод дописывается после маркера `── resume <harness> ──`;
- для остальных завершённых сессий доступна кнопка `Resume exact` / `Resume latest`; неудачный exact-resume сбрасывает id и оставляет сессию для latest-повтора;
- `NEST_AUTO_RESUME=0` отключает автозапуск.

Это осознанное упрощение: PTY переживает закрытие окна, пока приложение живёт в трее, но не полный выход из процесса или перезагрузку. Полное выживание PTY без перезапуска CLI после Quit — отдельный этап с `nestd`, после MVP.

### 6.7 Безопасность терминала

- `allowProposedApi: false`;
- OSC 8 ссылки — только по подтверждению, открывать в системном браузере;
- clipboard: `Ctrl+Shift+C/V` на Linux/Windows, `Cmd+C/V` на macOS;
- не интерпретировать вывод агента как HTML.

## 7. Git и workspace

### 7.0 Два вида workspace

| kind | path | branch | setup | delete |
|---|---|---|---|---|
| `worktree` | `~/Nest/worktrees/<project>/<task>` | `nest/<slug>` | да | да, с проверкой dirty |
| `checkout` | корень проекта | текущая ветка | нет | нет, только вместе с проектом |

`checkout` — singleton: один на проект. Он создаётся автоматически при добавлении проекта и не участвует в `git worktree add/remove`. Все git-операции для него выполняются в корне проекта.

### 7.1 Создание задачи

Для `worktree`:

```
1. validate project path
2. save setup script on the project (если пришёл из модалки)
3. git fetch --prune            (best effort: 60 с, пропускается без remotes)
4. git worktree add -b <branch> <path> <base>
5. insert task row (kind=worktree, status=active)
6. setup:
   - copy .env / .env.local    (только если файла ещё нет в worktree)
   - run setup script in the worktree (10 минут, вывод попадает в ошибку)
7. on setup failure: tasks.setup_error = причина, задача и worktree остаются
8. start session (optional)
```

`base` — локальная ветка (`main`) или remote-tracking (`origin/main`); вторая разрешается после `git fetch`, поэтому задача может стартовать от свежего upstream. Setup script хранится в `projects.setup_script`, запоминается при создании задачи и подставляется в модалку New task.

Для `checkout`:

```
1. validate project path
2. ensure main checkout task exists (create singleton if missing)
3. read current branch: git rev-parse --abbrev-ref HEAD
4. insert/update task row (kind=checkout, status=active)
5. start session (optional)
```

В UI это `tasks.openCheckout`: возвращает существующий singleton, ничего не создаёт и не трогает файлы; выбор `Main checkout` в модалке просто открывает его.

Rollback:

- если worktree создан, а setup упал — задача остаётся, причина лежит в `tasks.setup_error`, worktree не удаляем автоматически (пользователь может зайти и посмотреть, в сайдбаре горит бейдж `setup`);
- если worktree не создан — ничего не пишем в БД, показываем ошибку;
- branch создаётся только вместе с worktree; при откате удаляем, если она пустая;
- для checkout rollback не нужен: мы не создаём файлов и не меняем ветку.

### 7.2 Команды

| Действие | Команда |
|---|---|
| repo root | `git rev-parse --show-toplevel` |
| common dir | `git rev-parse --git-common-dir` |
| current branch | `git rev-parse --abbrev-ref HEAD` (для main checkout) |
| base ref | `git symbolic-ref refs/remotes/origin/HEAD` → fallback `origin/main` |
| status | `git status --porcelain=v2 --branch -z` |
| numstat | `git diff --numstat` + `git diff --cached --numstat` |
| diff | `git diff --no-ext-diff --no-color --unified=3 -- <path>` |
| staged diff | `git diff --cached --no-ext-diff --no-color -- <path>` |
| untracked | читать файл, показывать как added; бинарные — placeholder |
| stage | `git add -A -- <path>` |
| unstage | `git restore --staged -- <path>` |
| commit | `git commit -m <message>` |
| push | `git push -u origin HEAD` |
| delete worktree | `git worktree remove <path>`; `--force` — только после подтверждения dirty-файлов |
| list worktrees | `git worktree list --porcelain` |

Все команды — через `execa` с `windowsHide: true`, таймаутом и `maxBuffer`. Долгие (`fetch`, `status` на огромном репо, `diff`) — в worker thread или дочернем процессе, чтобы не блокировать main.

PR и checks в MVP нет. Если появятся позже, это отдельный `CodeHostProvider` (GitHub/GitLab), а не часть GitService.

### 7.3 Watcher

- `@parcel/watcher` на workspace (worktree или корень проекта для main checkout);
- отдельно слушаем `.git/HEAD`, `.git/index`, `.git/refs`;
- debounce 250 мс;
- игнорируем `node_modules`, `.git/objects`, `dist`, `.next`, `target`;
- после события инвалидируем `git.status` и `git.diff` для задачи.

### 7.4 Краевые случаи

- пути с пробелами и кириллицей — всегда массив аргументов, не склейка строк;
- Windows long paths (>260) — включить long path support, предупреждать в настройках;
- file locks (antivirus, editor) — `git worktree remove` может упасть; предложить `Force delete` и повторить;
- dirty worktree — удаление возвращает `workspace_dirty` со списком файлов; UI сначала спрашивает подтверждение и только потом передаёт `force: true`;
- submodules и LFS — не поддерживаем в MVP, показываем предупреждение;
- detached HEAD в worktree-задаче — задача не создаётся, показываем ошибку;
- detached HEAD в main checkout — работать можно, но показываем предупреждение и не даём создать worktree-задачу от «detached» base;
- base ref не существует — предложить `git fetch` или выбрать другой;
- репозиторий уже имеет worktree на этой ветке — предложить открыть существующий;
- main checkout грязный — это нормально: не удаляем, не сбрасываем, показываем изменения в Diff;
- ветку main checkout сменили снаружи — обновляем `branch` при следующем `git.status`, не перезаписываем без предупреждения;
- попытка создать второй main checkout — возвращаем существующий singleton, а не создаём дубль;
- `git worktree list --porcelain` включает основной worktree (корень проекта) — при синхронизации пропускаем его, чтобы не создать дубль main checkout.

### 7.5 Комментарии к diff

Комментарий — локальная сущность, не git и не PR.

Поля:

- `task_id`, `file_path`, `side` (`old`/`new`), `line`;
- `body`, `status` (`open`/`sent`/`resolved`);
- `session_id` (в какую сессию отправили), `sent_at`.

UI:

- клик по номеру строки открывает поповер;
- комментарий рендерится inline под строкой;
- можно редактировать, resolve, удалить;
- один или несколько комментариев можно отправить в активную сессию.

Отправка:

1. Выбрать сессию: явно или самая свежая `running`/`idle` сессия задачи.
2. Сформатировать текст:

```
Review comments from Nest:

src/checkout/total.ts:20 (new)
Should we also cover the negative quantity case here?

src/checkout/CartSummary.tsx:14 (new)
...
```

3. Записать в PTY через `sessions.write`.
4. Пометить комментарии `sent`, сохранить `session_id` и `sent_at`.

Многострочная вставка:

- предпочтительно bracketed paste (`ESC[200~ ... ESC[201~`), если harness/терминал это поддерживает;
- fallback — записать текст и завершить `\r` (как обычный ввод);
- если сессия `running`, предупредить, что текст может встать в очередь; если `exited` — «Copy to clipboard» / «Start session», без скрытой отправки.

Ограничения MVP:

- комментарии только к одной строке (range — P1);
- без GitHub/GitLab sync;
- без тредов и упоминаний;
- при изменении diff комментарий остаётся привязанным к file+line; если строка уехала — показываем предупреждение (re-anchor — P1).

## 8. Harness и статусы

### 8.1 Реестр

```ts
export interface HarnessProfile {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  icon: string;
  resume?: (session: Session) => string[];
  statusHooks?: 'claude' | 'codex' | 'generic';
}
```

Встроенные:

| id | command | resume | примечание |
|---|---|---|---|
| `claude` | `claude` | `claude --resume <id>` / `--continue` | discovery best effort; ручного теста нет |
| `codex` | `codex` | `codex resume <id>` / `resume --last` | smoke после MVP |
| `dsh` | `dsh` | `dsh tui --resume <session>` (нужен id) | discovery неизвестен |
| `opencode` | `opencode` | `opencode --session <id>` / `--continue` | exact resume проверен вручную |
| `pi` | `pi` | `pi --session-id <id>` / `--continue` | базовый PTY-профиль |
| `copilot` | `copilot` | `copilot --resume <id>` / `--continue` | GitHub Copilot CLI |
| `shell` | `$SHELL` / `pwsh` | — | blank terminal |

Claude Code не требует отдельной API-интеграции: базовый запуск — обычный PTY. Всё, что зависит от версии CLI (resume, hooks, точный `needs_input`), делаем best-effort и проверяем на сообществе. Если `claude` не установлен, профиль просто помечается `not found`; приложение не падает.

Custom-профиль добавляется в настройках: имя, команда, аргументы, env, иконка. Это единственный способ запустить произвольную команду.

### 8.2 Определение статуса

```
spawn ──► starting
           │ first output
           ▼
        running ──► idle (45s без вывода)
           │             │
           │             └──► needs_input (hook)
           │
           └──► exited (code 0) / failed (code != 0)
```

- **running** — процесс жив, вывод идёт;
- **idle** — процесс жив, вывода нет 45 секунд; это не обязательно «ждёт ввода»;
- **needs_input** — только по hook-событию от harness (Claude Code hooks, Codex notify) или по явному паттерну профиля;
- **exited/failed** — процесс завершился.

Честность важнее красоты: без hooks мы не показываем «needs input», только `idle`.

### 8.3 Hooks

Маленький CLI `nest hook`:

```bash
nest hook --event stop --session $NEST_SESSION_ID
```

Он пишет JSON в локальный named pipe / HTTP endpoint main-процесса. В env сессии передаём `NEST_SESSION_ID` и `NEST_HOOK_ENDPOINT`.

Для Claude Code можно подключить hooks через `--settings` или проектный `.claude/settings.local.json` (не модифицируя пользовательский репозиторий без согласия). У автора нет доступа к Claude для ручного теста, поэтому hooks/resume для него — best-effort по документации; базовый PTY-запуск от них не зависит. Для Codex — `notify`. Для остальных — generic idle.

## 9. Персистентность

### 9.1 Пути

| Что | Где |
|---|---|
| БД | `app.getPath('userData')/nest.db` |
| Worktrees | `~/Nest/worktrees/<project-slug>/<task-slug>` (настраивается) |
| Main checkout | путь самого проекта (без копии) |
| Логи сессий | `userData/sessions/<session-id>.log` |
| Snapshots | `userData/sessions/<session-id>.snapshot` |
| Настройки | таблица `settings` в БД |

### 9.2 Схема

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE projects (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  path          TEXT NOT NULL UNIQUE,
  base_ref      TEXT NOT NULL DEFAULT 'origin/main',
  setup_script  TEXT,
  created_at    INTEGER NOT NULL
);

CREATE TABLE tasks (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  slug           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'worktree'
                 CHECK (kind IN ('worktree', 'checkout')),
  branch         TEXT NOT NULL,
  workspace_path TEXT NOT NULL UNIQUE,
  base_ref       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',
  created_at     INTEGER NOT NULL,
  archived_at    INTEGER,
  UNIQUE(project_id, slug)
);

-- Один main checkout на проект. slug '@main' зарезервирован.
CREATE UNIQUE INDEX one_checkout_per_project
  ON tasks(project_id) WHERE kind = 'checkout';

CREATE INDEX tasks_by_project_kind ON tasks(project_id, kind);

CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  task_id            TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  harness_id         TEXT NOT NULL,
  title              TEXT NOT NULL,
  status             TEXT NOT NULL,
  pid                INTEGER,
  started_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  exit_code          INTEGER,
  scrollback_path    TEXT,
  harness_session_id TEXT,
  resume_mode        TEXT NOT NULL DEFAULT 'latest',
  last_activity_at   INTEGER
);

CREATE TABLE review_comments (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,
  side        TEXT NOT NULL CHECK (side IN ('old', 'new')),
  line        INTEGER NOT NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open', 'sent', 'resolved')),
  session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  sent_at     INTEGER
);

CREATE INDEX review_comments_by_task
  ON review_comments(task_id, file_path, line);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

`slug = '@main'` зарезервирован за main checkout; пользовательские задачи не могут его использовать. `workspace_path` для checkout равен пути проекта, для worktree — пути worktree. `review_comments` удаляются каскадом вместе с task.

Миграции: `PRAGMA user_version`, SQL-файлы в `packages/core/src/db/migrations`. Перед миграцией — копия БД.

### 9.3 Восстановление

- при старте читаем projects/tasks/sessions;
- main checkout восстанавливается как singleton-задача проекта, его `branch` перечитывается из git;
- комментарии к diff восстанавливаются из SQLite и заново привязываются к file/line;
- сессии со статусом `running`/`idle` помечаем `exited` — в MVP PTY не переживает закрытие приложения;
- scrollback восстанавливаем из snapshot/log;
- `harness_session_id` и `resume_mode` позволяют продолжить именно эту беседу; без id остаётся latest-fallback.

## 10. Структура репозитория

```
nest/
├── apps/
│   └── desktop/
│       ├── src/main/
│       │   ├── index.ts
│       │   ├── ipc.ts
│       │   ├── windows.ts
│       │   └── notifications.ts
│       ├── src/preload/
│       │   └── index.ts
│       └── src/renderer/
│           ├── app.tsx
│           ├── layout/
│           ├── features/
│           │   ├── sidebar/
│           │   ├── terminal/
│           │   ├── git/
│           │   ├── diff/
│           │   ├── comments/
│           │   └── sessions/
│           └── lib/
├── packages/
│   ├── core/
│   │   └── src/
│   │       ├── db/
│   │       ├── projects/
│   │       ├── tasks/
│   │       ├── git/
│   │       ├── comments/
│   │       ├── sessions/
│   │       ├── harness/
│   │       ├── hosts/
│   │       └── rpc/
│   ├── shared/
│   │   └── src/
│   │       ├── schemas.ts
│   │       ├── rpc.ts
│   │       └── utils/
│   └── ui/
│       └── src/
├── docs/
├── package.json
├── pnpm-workspace.yaml
└── electron-builder.yml
```

## 11. Безопасность

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`;
- renderer не имеет доступа к `fs`, `child_process`, `ipcRenderer`;
- все IPC-входы валидируются zod;
- пути нормализуются и проверяются на префикс project/worktree;
- команды запускаются только из реестра harness; custom-профиль добавляет пользователь;
- текст комментариев рендерится как plain text, без HTML/Markdown-инъекций;
- CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'`;
- внешние ссылки — только через `shell.openExternal` после подтверждения;
- автообновление — HTTPS + подпись;
- секреты не храним; env наследуем от пользователя, токены harness — их дело;
- логи не содержат env и токены.

## 12. Производительность

- cold start < 1.5 с до интерактивного UI; сессии догружаются прогрессивно;
- git status — debounce + worker, не чаще 1 раза в 300 мс;
- diff — ленивая загрузка по файлу, лимит 5 МБ, виртуализация строк;
- xterm — `@xterm/addon-webgl` опционально, fallback canvas;
- списки — виртуализация;
- SQLite — prepared statements, WAL, батч-записи;
- watcher — ignore-листы, debounce;
- память: лимит 8 смонтированных терминалов, остальные — snapshot.

## 13. Тестирование

**Unit**

- парсер `git status --porcelain=v2`;
- парсер diff и numstat;
- slug/branch generation;
- state machine сессии;
- path validation;
- RPC-схемы;
- форматирование комментариев и anchor file/side/line.

**Integration**

- временный git-репозиторий: create worktree → status → diff → commit → delete;
- PTY echo-тест (`node -e "process.stdout.write('ok')"`);
- миграции SQLite с нуля и с предыдущей версии;
- watcher: изменение файла → событие;
- comments CRUD, cascade delete вместе с task, отправка в FakeHarness.

**E2E (Playwright + Electron)**

- добавить проект;
- открыть main checkout, запустить сессию, увидеть diff;
- создать worktree-задачу;
- запустить `FakeHarness`, увидеть вывод;
- изменить файл, увидеть diff;
- оставить комментарий к строке, отправить в `FakeHarness`, увидеть prompt;
- commit;
- переключить задачу, вернуться, увидеть scrollback;
- закрыть приложение, открыть снова, увидеть задачу и scrollback, но не живой процесс.

**Harness-совместимость**

- `FakeHarness` — маленький Node-скрипт, который печатает ANSI, ждёт ввода, завершается с кодом 0/1. Используется в e2e вместо реальных агентов.
- Smoke-тест для каждого профиля: команда найдена, PTY стартует, первый вывод приходит, процесс завершается.
- Claude Code: базовый smoke-тест через `FakeHarness` + проверка команды `claude`; реальный запуск проверяют коллеги после MVP. Отдельно фиксируем версию CLI, на которой проверяли.
- Матрица в [`docs/harness-compat.md`](harness-compat.md): профиль, версия, launch, resume, hooks, кто тестировал.

**Ручная матрица**

- Windows 11 (ConPTY), macOS arm64, Ubuntu;
- PowerShell, cmd, bash, zsh;
- пути с пробелами и кириллицей;
- long paths;
- 10 параллельных сессий;
- репозиторий 10k файлов;
- main checkout: грязный, сменённая снаружи ветка, detached HEAD.

## 14. Сборка и поставка

Windows-first:

- **Windows 11** — основной таргет: NSIS x64 (arm64 — позже), блокирующий CI и ручная матрица;
- **macOS** — вторичный таргет: dmg universal, notarization;
- **Linux** — best effort: AppImage + deb, без блокирующего CI в MVP.

- `electron-builder` для всех платформ;
- `node-pty` — native module; prebuilds для Electron win32-x64 уже входят в пакет, `@electron/rebuild` нужен только при смене ABI/архитектуры, поэтому в конфиге стоит `npmRebuild: false` и Visual Studio на сборочной машине не требуется;
- `node:sqlite` — встроен в Node 24, отдельной native-сборки нет;
- `pnpm dist` собирает NSIS x64; `apps/desktop/e2e/packaged.spec.ts` проверяет упакованную и установленную сборку (asar, распакованный `node-pty`, ресурсный `fake-harness.mjs`, PTY, БД);
- CI: Windows обязателен, macOS/Ubuntu — по возможности;
- code signing: Windows (Azure Trusted Signing / SignPath), macOS notarization;
- auto-update: `electron-updater` + GitHub Releases;
- crash reporting — opt-in, локальные логи по умолчанию.

## 15. Долгий ящик: daemon и remote

В MVP нет ни daemon, ни remote. Сценария «агент на другой машине» нет, поэтому не проектируем под него UI и не строим `SshHost`.

Оставляем только тонкую границу, чтобы не размазывать процессы по UI:

```ts
export interface HostAdapter {
  id: string;
  exec(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
  spawnPty(opts: PtyOptions): PtyHandle;
  readFile(path: string): Promise<string>;
  watch(paths: string[], cb: (event: WatchEvent) => void): Disposable;
}
```

Сейчас есть только `LocalHost`. Если когда-нибудь понадобится:

- `nestd` — тот же core в отдельном процессе, сессии переживают закрытие окна;
- транспорт: named pipe (Windows) / Unix socket (macOS/Linux);
- remote/SSH/mobile — отдельный проект, не «ещё одна кнопка».

**Tauri 2** остаётся отдельным future experiment, а не частью MVP. Если понадобится установщик < 30 МБ, делаем spike: Tauri shell + `portable-pty` + xterm, сравниваем с Electron по размеру, памяти, задержке ввода и Windows-краям. Важно: это не бесплатная замена shell — Node-core придётся переписать на Rust или запускать как sidecar.

## 16. Рассмотренные альтернативы

| Вариант | Плюсы | Минусы | Решение |
|---|---|---|---|
| Electron + React | зрелый PTY/xterm, TS, скорость разработки | размер, память | **выбран** |
| Tauri 2 + Rust | маленький бинарник, память | больше Rust-кода, PTY/git edge cases | future experiment, отдельный spike; не MVP |
| Web + локальный сервер | remote из коробки | доступ к файлам/PTY, desktop-интеграция | долгий ящик, remote не планируем |
| VS Code extension | дешёвый UI | чужие ограничения layout | нет |
| Форк Orca | быстрый старт | наследуем сложность, которую хотим убрать | нет |

## 17. Главный риск

Не архитектурный, а продуктовый: **расползание в Orca**. Каждая новая функция должна проходить фильтр:

> Это можно сделать командой в терминале или git? Если да — не добавляем кнопку.

Если фильтр не срабатывает, Nest теряет смысл.
