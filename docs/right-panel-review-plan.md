# Ревью правой панели и план доработок (Diff и Git Graph в центре + просмотр веток + исправление дефектов)

База ревью: `main` (`38977a2`), серия коммитов `48d8eff..38977a2` (переработка правой панели по ADR-011 и [исходному плану](right-panel-plan.md)).
Назначение документа: самодостаточное ТЗ и пошаговый план работ для моделей-исполнителей.

Соблюдать правила репозитория из `AGENTS.md`:

- код, идентификаторы, комментарии в коде и строки UI — **только на английском**; документация в `docs/` — **на русском**;
- `packages/core` остаётся чистым Node без `electron` и нативных модулей; не добавлять новые npm-зависимости без крайней необходимости (`@tanstack/react-virtual` и `shiki` уже установлены);
- изменение/добавление RPC всегда проходит через три точки: `packages/shared/src/rpc.ts` (+ схемы в `packages/shared/src/git.ts`), `apps/desktop/src/main/ipc.ts`, вызов в renderer (+ `apps/desktop/src/renderer/src/rpc/mock.ts`);
- все git-аргументы передаются только массивами, все `ref` проходят `assertRef` + `assertRevision`, пути внутри workspace проходят проверку границ;
- относительные импорты в TypeScript с `.js` (в `core`/`shared`), типы через `import type`;
- критерий готовности каждого этапа: `pnpm typecheck`, `pnpm lint`, `pnpm test` (и целевые Playwright-тесты для UI-этапов).

---

## 1. Проверка нюанса с открытием Diff (подтверждено) и новая модель центральной области

### 1.1 Как работает сейчас

Просмотр патча и широкого diff сейчас рендерится **внутри правой панели** (`<aside className="right">`), а не в центральной области приложения (`<section className="center">`):

1. В [App.tsx](../apps/desktop/src/renderer/src/App.tsx#L1229-L1277) средняя колонка жёстко рендерит только `<TerminalPane />`, а `DiffPanel` живёт внутри `<RightPanel />` как `subview === 'diff'` ([RightPanel.tsx](../apps/desktop/src/renderer/src/components/RightPanel.tsx#L94), [строки 369–382](../apps/desktop/src/renderer/src/components/RightPanel.tsx#L369-L382)).
2. Клик по файлу в `Source Control` вызывает `openSelection` → `onOpenPatch={() => setTab('diff')}` ([SourceControlPanel.tsx](../apps/desktop/src/renderer/src/components/SourceControlPanel.tsx#L166-L173), [RightPanel.tsx](../apps/desktop/src/renderer/src/components/RightPanel.tsx#L312)). При этом **`SourceControlPanel` полностью размонтируется** ([RightPanel.tsx](../apps/desktop/src/renderer/src/components/RightPanel.tsx#L304)).
3. Кнопка `Open diff` вызывает `openDiff()` → `onWiden()` + `setTab('diff')` ([RightPanel.tsx](../apps/desktop/src/renderer/src/components/RightPanel.tsx#L117-L121)), раздвигая правую панель минимум до `620 px` (`<= 60 vw`).

### 1.2 Почему это неудобно и какие побочные баги порождает

- **Пропадает список файлов и форма коммита (ломается Master–Detail).** Кликнув по файлу, пользователь теряет дерево изменений, кнопки `Stage`/`Unstage` других файлов и `CommitBox`. Чтобы посмотреть следующий изменённый файл, нужно нажать `← Source Control` (или `Esc`), заново смонтировать список, кликнуть второй файл — и так по кругу. Нельзя писать commit message, глядя в открытый патч.
- **Двойная шапка «Назад».** В режиме `subview === 'diff'` `RightPanel` рисует `.right-subhead` с кнопкой `← Source Control` и заголовком `Diff` ([RightPanel.tsx](../apps/desktop/src/renderer/src/components/RightPanel.tsx#L295-L302)), а сразу под ней `DiffHead` рисует вторую такую же кнопку `.diff-back-btn` `← Source Control` и `Diff · 1 file` ([DiffPanel.tsx](../apps/desktop/src/renderer/src/components/DiffPanel.tsx#L840-L858)).
- **Необратимое раздувание правой панели (`widen()`).** `widen()` в [rightPanelLayout.ts](../apps/desktop/src/renderer/src/rightPanelLayout.ts#L228-L239) перезаписывает `nest.rightPanel` в `localStorage` на `>= 620 px`, но при возврате к списку (`backToList`) прежняя ширина (~`390 px`) **не восстанавливается**. Правая колонка навсегда остаётся на пол-экрана, сжимая терминал.
- **В узком окне (`<= 1180 px`) `widen()` вообще не работает визуально.** Drawer имеет фиксированный CSS `width: min(460px, 92vw)` ([styles.css](../apps/desktop/src/renderer/src/styles.css#L1267-L1273)), игнорируя `rightLayout.width`, но всё равно портя сохранённую ширину для широкого окна.
- **Тупик single-file режима и заблокированный `Open diff`.** Кнопка `Open diff` в [SourceControlPanel.tsx](../apps/desktop/src/renderer/src/components/SourceControlPanel.tsx#L570-L581) и пункт в меню [SourceControlHeader.tsx](../apps/desktop/src/renderer/src/components/SourceControlHeader.tsx#L116-L122) отключены при `memory.selection === null`. Если в проекте 10 изменённых файлов (или рабочее дерево чистое, но нужно посмотреть режим `Base` с уже закоммиченными правками ветки), кнопку `Open diff` нажать нельзя. Обратная проблема: стоит один раз кликнуть любой файл, `selection` запоминается, и внутри `DiffPanel` ([DiffPanel.tsx](../apps/desktop/src/renderer/src/components/DiffPanel.tsx#L861-L867)) нет кнопки сброса фильтра к просмотру **всех** файлов (`target = null`).

### 1.3 Целевая модель: Центральная рабочая область (`CenterPane`: Терминалы + `Diff` + `Git Graph`)

```text
┌──────────────┬───────────────────────────────────────────────┬──────────────────────────┐
│ Sidebar      │ Center workbench                              │ RightPanel (390 px)      │
│              │ [ shell 1 ] [ claude ] [+] │ [Diff ×][Graph ×]│ [Files][Source Control]  │
│ Projects     ├───────────────────────────────────────────────┤ main → origin/main   ↑1  │
│  ▸ main      │                                               │ [Filter] [Diff] [Graph]  │
│  ▸ task-a ●  │  Активный вид центра:                         │ ▾ Staged (1)             │
│              │  • Terminal (до 8 живых xterm в DOM)          │   M app.ts   +8 -2  [-]  │
│              │  • Diff (файл, весь diff или межветочный)     │ ▾ Unstaged (2)           │
│              │  • Git Graph (всё дерево веток + детали       │ ● M app.ts   +1 -0  [+]  │
│              │    коммита и инспекция любой ветки)           │   M util.ts  +4 -1  [+]  │
│              │                                               │ ──────────────────────── │
│              │  (xterm-инстансы остаются смонтированными!)   │ [ Commit message ] [Cmt] │
└──────────────┴───────────────────────────────────────────────┴──────────────────────────┘
```

Ключевые правила целевого решения:

1. **Единая центральная рабочая область (`CenterPane`).** В средней колонке (`section.center`) живут вкладки сессий терминала и по запросу открываются инструментальные вкладки задачи: **`Diff`** и **`Graph`** (полное дерево Git / просмотр веток).
2. **Жёсткий инвариант терминалов (не размонтировать xterm).** Переключение центра в `Diff` или `Graph` и обратно **никогда не размонтирует** контейнер терминалов и смонтированные `TerminalView` (`MOUNT_LIMIT = 8` сохраняется). Слой терминалов скрывается через CSS (`display: none`), `ResizeObserver` в скрытом состоянии не шлёт `0×0` в `sessions.resize` (проверка `cols <= 0 || rows <= 0` в [TerminalPane.tsx](../apps/desktop/src/renderer/src/components/TerminalPane.tsx#L707-L713) сохраняется), а при возврате на вкладку терминала вызывается `applyFit()`.
3. **Правая панель остаётся на месте.** Клик по строке изменения в `Source Control`, нажатие `Open diff` или `Graph`:
   - открывает/активирует `Diff` или `Graph` в центральной области;
   - **не меняет** вкладку правой панели (`source-control` остаётся открытым, список файлов и `CommitBox` на экране, фокус и скролл списка сохраняются; клик по другому файлу мгновенно переключает дифф в центре);
   - **не вызывает** `widen()` (метод `widen` удаляется из `rightPanelLayout.ts`);
   - **в узком окне (`drawer === true`, `<= 1180 px`):** так как `.right-drawer` с подложкой перекрывает центральную область, открытие `Diff` или `Graph` из drawer автоматически закрывает drawer (`onClose()`), чтобы центральная область была сразу видна целиком.
4. **Разделение «файл» vs «весь diff».**
   - Клик по файлу в `Source Control` ставит `selection = { path, mode }` и открывает `Diff` этого файла. В `.diff-target-bar` добавляется кнопка `Show all files` (`×`), сбрасывающая `selection` в `null` без закрытия `Diff`.
   - Кнопка `Open diff` в тулбаре `Source Control`, в меню `⋯` и в палитре команд **всегда доступна** при выбранной задаче (включая `selection === null` и чистый worktree для проверки режима `Base`).
5. **Состояние центра привязано к задаче (`taskId`).** Для каждой задачи хранится, открыты ли вкладки `Diff` и `Graph`, какая поверхность активна (`'terminal' | 'diff' | 'graph'`), а также выбранный фильтр/ветка в `Graph`. Переключение `Task A → Task B → Task A` полностью сохраняет контекст обеих задач.
6. **Быстрый возврат к терминалу:** клик по вкладке сессии, `Ctrl+\`` (`focus-terminal`) или закрытие вкладки `Diff`/`Graph` (`×`, средний клик, `Escape`) возвращает терминал.

---

## 2. Новая функциональность: Полное дерево Git (`Git Graph`) и просмотр других веток

### 2.1 Что сейчас ограничено в коде

1. **Только текущая ветка и плоский список:** [HistoryPanel.tsx](../apps/desktop/src/renderer/src/components/HistoryPanel.tsx#L45) вызывает `git.log` без `ref` (только `HEAD`), рисуя плоский список без линий ветвления/слияний. При этом `GitCommit` в core **уже** парсит `parents: string[]` и `refs: string[]` ([log.ts](../packages/core/src/git/log.ts#L27-L37)), а `git.log` уже принимает `ref`, но UI это никак не использует.
2. **Нельзя посмотреть другую ветку без `git checkout`:** чтобы увидеть коммиты или файлы соседней ветки (`origin/main`, `release/*` или `nest/<slug>` другого параллельного агента), сейчас нужно переключать ветку через `BranchSwitcher`. В Nest это часто невозможно или опасно: в текущем worktree запущен CLI-агент, есть незакоммиченные правки, либо интересующая ветка уже checked out в соседнем worktree (Git запрещает второй checkout той же ветки).
3. **Дерево файлов привязано только к диску:** [FilesService](../packages/core/src/services/files.ts) читает только файлы текущего рабочего дерева (`git ls-files` + `fs.open`), не позволяя заглянуть в файлы другой ветки или коммита.
4. **В `ComparePanel` файлы не открывают патч:** строки `CompareFileRow` ([ComparePanel.tsx](../apps/desktop/src/renderer/src/components/ComparePanel.tsx#L270-L288)) некликабельны — видно статистику `+/-`, но нельзя посмотреть сам diff файла между ветками.

### 2.2 Требования к полному дереву Git (`Git Graph`)

1. **Точки входа:**
   - кнопка **`Graph`** в тулбаре `Source Control` (рядом с `Open diff`), пункт `Git graph (all branches)` в меню `⋯` и команда палитры `Show Git graph` открывают вкладку `Graph` в центральной области (`CenterPane`);
   - клик по коммиту из `ComparePanel` открывает этот коммит прямо в `Graph` в центральной области.
2. **Охват дерева (`scope` в `git.log`):**
   - **`All branches` (по умолчанию в `Graph`):** `git log --topo-order --no-color --branches --remotes --tags` — показывает **всё дерево репозитория** (все локальные ветки, включая параллельные задачи `nest/*`, все remote-tracking ветки `origin/*` и теги; намеренно не `--all`, чтобы служебные `refs/stash` не засоряли граф);
   - переключатель **`Remotes`** (вкл/выкл `--remotes`) для шумных репозиториев с сотнями удалённых веток;
   - **`Current branch (HEAD)`** — только история текущей ветки задачи;
   - **Конкретная ветка / тег (`ref`)** — выбор любой локальной или remote-ветки из выпадающего списка с поиском;
   - **Поиск по коммитам (`search`)** — фильтрация по сообщению, автору или префиксу хеша.
3. **Визуализация DAG (граф ветвлений и слияний):**
   - чистый расчёт раскладки дорожек в `renderer/src/gitGraph.ts` (без внешних библиотек): по массиву коммитов (`hash`, `parents[]`) в `--topo-order` вычисляет колонку узла (`lane`), цвет дорожки, сквозные вертикальные линии и SVG-соединения для merge/fork (включая merge с 2+ родителями и обрыв на границе пагинации `Load older commits`);
   - предки текущего `HEAD` визуально акцентированы (основная линия текущей задачи), на строках отображаются цветные бейджи `HEAD`, локальных веток (с пометкой, если ветка открыта в другом worktree Nest), `origin/*` и тегов;
   - список виртуализируется через `@tanstack/react-virtual`;
   - **Master–Detail внутри `Graph`:** выбор коммита открывает панель деталей справа/снизу внутри центральной области (`CommitDetailView`: автор, дата, полное сообщение, дерево изменённых файлов и патч с подсветкой синтаксиса Shiki).

### 2.3 Требования к просмотру других веток (Read-only, без `checkout`)

Пользователь должен иметь возможность изучить любую локальную или удалённую ветку, **не трогая рабочее дерево, индекс и запущенные терминалы текущей задачи**:

1. **Инспектор ветки (в `Graph` и через селектор веток):**
   При выборе любой ветки `<branch>` (из пикера в шапке `Graph`, кликом по бейджу ветки на коммите в дереве или через команду палитры `Inspect branch…`) доступны:
   - **История ветки:** фильтр дерева только по `<branch>` или прыжок к её верхушке (`Jump to tip`) в общем дереве `All branches`, с показом `↑ahead ↓behind` относительно текущей ветки;
   - **`Compare with current`:** открывает сравнение `<branch>...HEAD` (или `HEAD...<branch>`), где клик по любому изменённому файлу открывает его межветочный патч в центральной вкладке `Diff`;
   - **`Browse files at <branch>`:** переключает вкладку `Files` правой панели в read-only режим просмотра дерева файлов ревизии `<branch>`;
   - **`New task from <branch>`:** открывает `NewTaskDialog` с предзаполненным `baseRef = <branch>` (создание нового изолированного worktree от выбранной ветки в один клик);
   - **`Switch to <branch>`:** явный `git.checkout` (только когда пользователь действительно хочет сменить ветку в текущем workspace).
2. **Просмотр файлов произвольной ветки или коммита в `FilesPanel`:**
   - В шапке `FilesPanel` добавляется селектор ревизии: по умолчанию `Working tree`, но можно выбрать любую локальную/remote-ветку (а также перейти из коммита в `Graph` кнопкой `Browse files at commit`).
   - Когда выбран `ref !== null`, в `FilesPanel` отображается заметная плашка `Viewing <ref> (read-only)` с кнопкой сброса `× Working tree`. Дерево строится через `git ls-tree -r -z --name-only <ref> --`, содержимое файла читается из Git-объекта `<ref>:<path>` без обращения к рабочей копии на диске, превью файла можно открыть и в широкой центральной области.
3. **Полноценный межветочный патч из `ComparePanel`:**
   - Клик по файлу в `ComparePanel` открывает его diff между `mergeBase` (или `base`) и `head` в центральной области `Diff` (в read-only режиме сравнения ревизий, без кнопок `Stage`/`Unstage`).

---

## 3. Найденные недостатки и дефекты текущей реализации правой панели

Ниже перечислены дефекты, обнаруженные при аудите кода коммитов `48d8eff..38977a2`.

### D1 · Критично · Ложное сообщение `Discard` на ветке без коммитов (unborn HEAD) ведёт к удалению файла

- **Где:** [sourceControl.ts](../apps/desktop/src/renderer/src/sourceControl.ts#L211-L243), [SourceControlPanel.tsx](../apps/desktop/src/renderer/src/components/SourceControlPanel.tsx#L148), [packages/core/src/services/git.ts](../packages/core/src/services/git.ts#L546-L585).
- **Суть:** В `discardConfirmation()` проверка `if (!options.hasHead)` стоит **раньше** `if (isUntrackedRow(row))`. В репозитории без коммитов (`unborn`) при нажатии `Discard` на **untracked-файле** диалог пишет: *«the discard fails and nothing on disk changes»* и показывает кнопку `Discard`. Но `GitService.discard()` проверяет `hasHead` только для `tracked.length > 0`, а для `untracked` выполняет `git clean -f -- <path>` — **безвозвратно удаляя файл с диска** вопреки тексту диалога.
- **Дополнительно:**
  1. Для staged-файла на `unborn`-ветке диалог заранее знает, что операция упадёт, но всё равно рендерит активную кнопку `Discard`. Кнопку `Discard` для tracked-строк при `unborn === true` нужно блокировать с подсказкой `Unstage the file first; there is no HEAD commit to restore from`.
  2. `hasHead` в `SourceControlPanel` вычисляется из `branches` (`branches ? !branches.unborn : null`), поэтому пока `branches` грузится или если `git.branches` упал, `hasHead !== false` даёт `true` даже в пустом репозитории. Признак `unborn: boolean` уже виден при разборе `git status --branch` (`## No commits yet on ...` в [status.ts](../packages/core/src/git/status.ts#L50-L52)) — его нужно отдавать прямо в `GitStatus`.

### D2 · Высоко · Сброс видимости задачи в `gitSnapshot.ts` замораживает шапку, статусбар и бейджи при закрытии `SourceControlPanel`

- **Где:** [state/gitSnapshot.ts](../apps/desktop/src/renderer/src/state/gitSnapshot.ts#L144), [строки 373–388](../apps/desktop/src/renderer/src/state/gitSnapshot.ts#L373-L388), [state/GitSnapshotProvider.tsx](../apps/desktop/src/renderer/src/state/GitSnapshotProvider.tsx#L33-L45), [App.tsx](../apps/desktop/src/renderer/src/App.tsx#L154), [SourceControlPanel.tsx](../apps/desktop/src/renderer/src/components/SourceControlPanel.tsx#L92).
- **Суть:** `visible` в `createGitSnapshotStore` хранится как булев `Set<string>`, но `useGitSnapshotFor(store, taskId)` вызывается **одновременно в двух местах** для одной и той же задачи: в `AppShell` (для ветки в шапке/статусбаре и бейджа количества изменений) и в `SourceControlPanel`. Когда пользователь сворачивает правую панель в рейл или переключается на вкладку `Files` / `Sessions` / `Compare`, `SourceControlPanel` размонтируется и его cleanup вызывает `store.setVisible(taskId, false)` → `visible.delete(taskId)`. Хотя задача всё ещё открыта в `AppShell`, все последующие события `git:changed` от watcher складываются в `pendingReload` и **не перезапрашивают `git.status`**, пока пользователь снова не откроет `SourceControlPanel`. В результате бейдж `Source Control · N`, свёрнутый рейл и название ветки перестают обновляться при работе агента в терминале.
- **Решение:** Заменить булев `Set` на счётчик активных подписчиков `Map<string, number>`. Пока `count > 0`, задача считается видимой.

### D3 · Высоко · Флаг `Amend` не сбрасывается после коммита и не подставляет сообщение `HEAD`

- **Где:** [SourceControlPanel.tsx](../apps/desktop/src/renderer/src/components/SourceControlPanel.tsx#L386-L399), [CommitBox.tsx](../apps/desktop/src/renderer/src/components/CommitBox.tsx#L50-L126).
- **Суть:**
  1. После успешного `store.commit(taskId, { message, amend: amending })` очищается только `draft: ''`, а `amend` остаётся `true`. Следующий коммит пользователя в этой задаче незаметно перезапишет предыдущий коммит вместо создания нового. После успешного коммита нужно сбрасывать `{ draft: '', amend: false }`.
  2. При включении `Amend last commit`, если `draft.trim() === ''`, поле сообщения остаётся пустым (и кнопка `Amend commit` заблокирована с `Write a commit message`). При включении `Amend` с пустым черновиком нужно подгружать `subject` (+ `body`) последнего коммита (`git.log` с `limit: 1`).
  3. В `<textarea className="commit-message">` отсутствует отправка по `Ctrl+Enter` / `Cmd+Enter`.

### D4 · Высоко · Неверные `+/-` (`numstat`) у частично staged файлов (`MM`)

- **Где:** [packages/core/src/services/git.ts](../packages/core/src/services/git.ts#L775-L817), [packages/shared/src/git.ts](../packages/shared/src/git.ts), [sourceControl.ts](../apps/desktop/src/renderer/src/sourceControl.ts#L83-L101).
- **Суть:** `readNumstat(cwd)` запускает `git diff --numstat -z -M HEAD`, получая **суммарную** разницу `HEAD → worktree`. Затем `projectChanges` копирует одни и те же `additions`/`deletions` и в строку `Staged`, и в строку `Unstaged`. Если в индексе `+10 -0`, а в рабочем дереве `+1 -0`, обе строки покажут `+11 -0`. Если в индексе `+10 -0`, а в рабочем дереве эти строки откатили (`+0 -10`), `diff HEAD` пуст и обе строки вообще потеряют счётчики.
- **Решение:** Считать `staged` (`git diff --numstat -z -M --cached`) и `unstaged` (`git diff --numstat -z -M`) раздельно и передавать по-сторонние счётчики в `GitFile`.

### D5 · Средне · Избыточные вызовы `git.status`, отсутствие сериализации мутаций по задаче и утечка `gitStore` при удалении задач

- **Где:** [packages/core/src/services/git.ts](../packages/core/src/services/git.ts#L166-L184), [SourceControlPanel.tsx](../apps/desktop/src/renderer/src/components/SourceControlPanel.tsx#L121-L128), [App.tsx](../apps/desktop/src/renderer/src/App.tsx#L309-L324), [строки 673–683](../apps/desktop/src/renderer/src/App.tsx#L673-L683), [state/gitSnapshot.ts](../apps/desktop/src/renderer/src/state/gitSnapshot.ts#L95).
- **Суть:**
  1. Нажатие `Stage` вызывает 3–4 спавна `git status` + `git diff`: из возврата RPC, из `git:changed`, из `onChanged()` (`bumpGit`) и из `useEffect([refreshKey])` в `SourceControlPanel` (плюс через 350 мс от файлового watcher). В `SourceControlPanel` нужно убрать дублирующий `useEffect([refreshKey])`, так как `gitStore.invalidate(taskId)` уже коалесцирует перезапрос.
  2. В ADR-011 ([architecture.md](../docs/architecture.md#L631)) обещана сериализация конфликтующих мутаций одной задачи в main/core, но в `GitService` очереди нет — параллельные вызовы могут столкнуться на `.git/index.lock`.
  3. `gitStore.forgetTask(taskId)` написан, но нигде не вызывается в `App.tsx` при удалении задачи, отмене операции или удалении проекта.
  4. В `reloadSlices` ([gitSnapshot.ts](../apps/desktop/src/renderer/src/state/gitSnapshot.ts#L291-L296)) список веток не перечитывается при инвалидации, если первое чтение упало (`branches.data === null`, `branches.error !== null`). Условие нужно расширить до `branches.data != null || branches.error != null`.

### D6 · Средне · `Discard` на строке `Unstaged` у частично staged файла уничтожает и staged-изменения

- **Где:** [packages/core/src/services/git.ts](../packages/core/src/services/git.ts#L577), [sourceControl.ts](../apps/desktop/src/renderer/src/sourceControl.ts#L234-L242).
- **Суть:** `git.discard` всегда делает `git restore --source=HEAD --staged --worktree`. Клик по `Discard` в секции `Unstaged` у `MM`-файла сносит и застейдженную часть в индексе.
- **Решение:** Поддержать `side?: 'staged' | 'unstaged'` в `git.discard`: для `side: 'unstaged'` при наличии `staged`-части выполнять `git restore --worktree -- <path>` (откат рабочего дерева к индексу без потери индекса).

### D7 · Средне · Клавиатура, доступность, дубли навигации и плотность UI

1. **`Escape` в списке изменений блокирует закрытие узкого drawer:** В [ChangeSections.tsx](../apps/desktop/src/renderer/src/components/ChangeSections.tsx#L50-L55) `Escape` делает `event.preventDefault()` даже при `selection === null`, не пуская событие к закрытию drawer в `RightPanel.tsx`. Перехватывать `Escape` нужно **только когда `selection !== null`**.
2. **Двойная кнопка «Назад» во вложенных экранах правой панели:** В `HistoryPanel` при просмотре коммита рисуются подряд `← Source Control` и `← History`, нет возврата по `Escape` (как и в `FilesPanel`).
3. **`BranchSwitcher` ([BranchSwitcher.tsx](../apps/desktop/src/renderer/src/components/BranchSwitcher.tsx)):** не закрывается по `Escape`; не имеет поиска по веткам; показывает `No local branches`, пока `branches === null`; не показывает, какие ветки уже заняты другими worktree проекта (`git worktree list`), и при ошибке переключения на грязном дереве кидает мимолётный тост вместо inline `panelNote`.
4. **Плотность строк `.change-row` на 300–390 px:** текстовые кнопки `Stage`/`Unstage` и `Discard` съедают ~115 px в каждой строке. Лучше использовать компактные иконки с сохранением `aria-label="Stage"` / `"Unstage"` / `"Discard"`.
5. **WAI-ARIA Tabs и дерево:** в `.right-tabs` добавить переключение стрелками `ArrowLeft`/`ArrowRight`/`Home`/`End`; в `ChangeList` в режиме `Tree` включить `.tree-dir` в обход стрелками `ArrowUp`/`ArrowDown`.

---

## 4. Готовые решения под Electron / React 19: что использовать, а что не тянуть

Все пакеты ниже проверены на совместимость с текущим стеком Nest (`Electron 45`, `React 19.3`, `electron-vite` / `Vite 7`, `Shiki 4.6`) и правилом `AGENTS.md` по отсутствию лишних нативных модулей (`asarUnpack` не требуется ни одному из перечисленных UI-пакетов).

### 4.1 Сводная матрица решений

| Задача | Готовые пакеты | Совместимость со стеком Nest | Рекомендация для реализации |
|---|---|---|---|
| **Граф коммитов и веток (`Git Graph`)** | [`@tomplum/react-git-log`](https://github.com/TomPlum/react-git-log) (`3.5.1`, Apache-2.0, ~228 KB unpacked)<br>*(Устаревший `@gitgraph/react@1.6.0` под React 16 — **не использовать**)* | Pure ESM, `react >= 19.0.0`, `GraphHTMLGrid` (DOM-сетка, удобная для Playwright), кастомные строки и темы | **Два допустимых пути (см. §4.2):**<br>• **Вариант А (готовый пакет):** `@tomplum/react-git-log` в режиме `<GitLog paging={...}><GitLog.GraphHTMLGrid /></GitLog>` (требует добавить `%S` в `LOG_FORMAT` для поля `branch`).<br>• **Вариант Б (рекомендуемый по умолчанию без зависимостей):** ~150 строк `gitGraph.ts` + уже установленный `@tanstack/react-virtual` (поддерживает виртуализацию 5000+ строк и серверную пагинацию всех веток без ограничений пакета). |
| **Просмотр Diff и кода (Unified + Split side-by-side)** | [`@pierre/diffs`](https://github.com/pierrecomputer/pierre/tree/main/packages/diffs) (`1.7.2`, Apache-2.0)<br>или [`@git-diff-view/react`](https://github.com/MrWangJustToDo/git-diff-view) (`0.1.8`, MIT) + `@git-diff-view/shiki`<br>*(Тяжёлый `monaco-editor` — **не использовать**)* | Оба поддерживают `React 19`, **Split (side-by-side) + Unified**, word-level diff, `CodeView` и инжекцию inline-аннотаций/виджетов. `@pierre/diffs` использует `shiki ^4.0.0` (JS regex engine без WASM — ровно как в Nest!) | **В два шага без риска регрессий:**<br>1. Сначала в **Этапе 3** перенести в `CenterPane` **уже готовый и отлаженный** `DiffPanel.tsx` (сохранив рабочие re-anchor комментарии и `Outside this patch`).<br>2. Для добавления **Split (side-by-side) diff** и внутристрочной подсветки (бывший этап P1) подключить **`@pierre/diffs`** (`FileDiff` + `CodeView` с переиспользованием Shiki и его annotation API для `CommentThread`), либо `@git-diff-view/react` (`renderWidgetLine` / `onAddWidgetClick`). |
| **Вкладки и сплит-панели центральной области** | [`dockview-react`](https://github.com/dockview/dockview) (`8.10.0`, MIT, 0 зависимостей) | `React 19`, умеет держать вкладки в DOM без размонтирования (`renderer: 'always'`, критично для `xterm`), поддерживает сплиты (Терминал и Diff бок о бок в центре) | Для **базовой полосы вкладок** (`[сессии] | [Diff] [Graph]`) достаточно лёгкого собственного `CenterPane.tsx` (~80 строк, не ломает текущие стили и E2E). Если потребуется **split-view внутри центра** (одновременно видеть и живой терминал агента, и открытый Diff/Graph рядом), брать **`dockview-react`** с `renderer: 'always'`. |
| **Git-движок в `packages/core`** | `dugite`, `simple-git`, `isomorphic-git` | `isomorphic-git` не поддерживает `git worktree`; `dugite` тащит ~60 МБ бинарников Git в `asarUnpack` | **Оставить текущий `GitService` на `execFile('git', ...)`** — он уже безопасен, быстр и покрыт тестами на Windows-путях и кириллице. |

### 4.2 Нюансы интеграции `@tomplum/react-git-log`, если выбран готовый пакет для графа

Если модель-исполнитель или команда выбирает готовый `@tomplum/react-git-log@3.5.1` вместо собственного `gitGraph.ts`, нужно учесть три особенности из документации пакета:

1. **Использовать `<GitLog>`, а не `<GitLogPaged>`:** серверно-пагинируемый вариант `GitLogPaged` в этой библиотеке поддерживает только одну ветку. Для отображения **всех веток сразу** нужно загружать окно коммитов (например, `limit: 300..500` из `git.log({ scope: 'all' })`) и передавать в `<GitLog entries={entries} currentBranch={currentBranch} paging={{ size: 100, page }}>`.
2. **Использовать `<GitLog.GraphHTMLGrid />`, а не `GraphCanvas2D`:** автор пакета явно помечает `GraphCanvas2D` как незавершённый (баги обрезки фона и тем); `GraphHTMLGrid` стабилен и прозрачен для Playwright-тестов.
3. **Формат данных `GitLogEntry`:** пакет требует поле `branch: string` у каждого коммита — для этого в `LOG_FORMAT` (`packages/core/src/git/log.ts`) достаточно добавить спецификатор `%S` (ref, через который `git log` достиг коммита).

---

## 5. Пошаговый план работ для моделей-исполнителей

Этапы разделены по чётким зонам записи (`write_scopes`), чтобы их можно было выполнять последовательно одной моделью или распараллелить между несколькими агентами:

- **Волна 1 (параллельно после фиксации схем `packages/shared`):**
  - **Этап 1** — Core / Shared / IPC (точность статуса, side-aware `discard`, очередь мутаций, `git.log` для всего дерева/веток, межветочный diff, `FilesService` по `ref`).
  - **Этап 2** — Чистые модули в Renderer (`gitSnapshot` ref-count, `sourceControl`, алгоритм раскладки графа `gitGraph.ts`, модель вкладок центра `centerTabs.ts`).
- **Волна 2:**
  - **Этап 3** — Перенос `DiffPanel` и добавление `GitGraphPanel` (полное дерево Git + инспекция веток) в центральную область `CenterPane`.
- **Волна 3:**
  - **Этап 4** — Доработка правой панели (`FilesPanel` по любой ветке, `ComparePanel` с кликабельным diff, `BranchSwitcher`, `CommitBox`, клавиатура и плотность).
  - **Этап 5** — Обновление и расширение E2E-тестов + синхронизация документации в `docs/`.

---

### Этап 1. Расширение и исправление Core / Shared / IPC

**Зона записи (`write_scopes`):**
- `packages/shared/src/git.ts`
- `packages/shared/src/files.ts` *(или где описаны `WorkspaceFilesSchema` / `FileContentSchema`)*
- `packages/shared/src/rpc.ts`
- `packages/core/src/git/status.ts`
- `packages/core/src/git/numstat.ts`
- `packages/core/src/git/branches.ts`
- `packages/core/src/services/git.ts`
- `packages/core/src/services/files.ts`
- `packages/core/test/*`
- `apps/desktop/src/main/ipc.ts`
- `apps/desktop/src/renderer/src/rpc/mock.ts`

**Задачи:**
1. **`unborn` и раздельный `numstat` в `GitStatus` (`D1`, `D4`):**
   - В `parseStatus` (`packages/core/src/git/status.ts`) добавить `unborn: boolean`.
   - В `readNumstat(cwd)` параллельно читать `--cached` (staged) и рабочий diff (unstaged); добавить в `GitFileSchema` поля `stagedAdditions`, `stagedDeletions`, `unstagedAdditions`, `unstagedDeletions` (`number | null`). Для untracked заполнять `unstagedAdditions` / `unstagedDeletions: 0`.
2. **Side-aware `Discard` и очередь мутаций (`D1`, `D5.2`, `D6`):**
   - В `git.discard` добавить опциональный `side?: 'staged' | 'unstaged'`. Для `side: 'unstaged'` при наличии staged-части выполнять `git restore --worktree -- <targets>` (работает и без `HEAD`, сохраняя индекс). Для `untracked` выполнять `git clean -f` независимо от `HEAD`.
   - В `GitService` сериализовать мутации (`stage`, `unstage`, `discard`, `commit`, `checkout`, `pull`, `push`, `fetch`) через промис-очередь по `workspacePath` / общему git-dir проекта.
3. **Полное дерево коммитов и фильтрация по веткам в `git.log` (§2.2):**
   - Расширить параметры `git.log` в `rpc.ts` и `GitService.log`:
     - `scope?: 'head' | 'all' | 'branches'` (по умолчанию `'head'`; `'all'` передаёт `['--topo-order', '--branches', '--remotes', '--tags']`; `'branches'` — `['--topo-order', '--branches', '--tags']` без удалённых веток); если передан конкретный `ref`, используется `--topo-order <ref>` (проверенный через `assertRef` + `assertRevision`);
     - `search?: string` — при наличии непустой строки добавлять `--regexp-ignore-case`, `--fixed-strings`, `--grep=<search>` (безопасно через элемент массива аргументов, до `--`);
     - увеличить `MAX_LOG_LIMIT` до `300` (при `DEFAULT_LOG_LIMIT = 100` для графа).
   - В `git.branches` (`GitBranchSchema`) добавить опциональное поле `worktreePath: string | null` (из `git worktree list --porcelain` или `%(worktreepath)` в `git for-each-ref`), чтобы UI знал, какая ветка уже открыта в другом worktree! *(Примечание: `%(worktreepath)` встроен в `git for-each-ref` начиная с Git 2.23 — даёт путь worktree вообще без лишнего процесса!)*
4. **Межветочный diff файла для просмотра чужих веток и `Compare` (§2.3):**
   - Расширить `git.diff` (или добавить метод `git.compareDiff`: `{ taskId, base, head, path? }`), возвращающий `DiffFile[]` для `git diff --no-color -M --unified=3 <mergeBase> <head> [-- <path>]` (после `assertRef` и `assertRevision` для `base` и `head`), чтобы клик по файлу при сравнении любой ветки открывал полноценный подсвеченный патч в центре.
5. **Чтение дерева и содержимого файлов любой ветки/ревизии в `FilesService` (§2.3):**
   - Расширить `files.list` параметром `ref?: string`: если `ref` задан (`assertRef` + `assertRevision`), выполнять `git ls-tree -r -z --name-only <ref> --` (лимит `MAX_FILES = 5000`).
   - Расширить `files.read` параметром `ref?: string`: если `ref` задан, проверять путь (запрет пустых, абсолютных, `..` сегментов), получать размер через `git cat-file -s <ref>:<normalizedPath>` (если объект не найден или это `tree` — `file_missing` / `not_a_file`) и читать содержимое через `git show <ref>:<normalizedPath>` с `maxBuffer` / обрезкой до `MAX_PREVIEW_BYTES` (`512 KB`) и определением `binary` по первым `8000` байтам. Рабочее дерево на диске не затрагивается.

**Критерий приёмки Этапа 1:**
- Unit/integration тесты в `packages/core/test/` покрывают:
  - `git.log({ scope: 'all' })` и `git.log({ scope: 'branches' })` на репозитории с расходящимися ветками, merge-коммитом, тегом и `origin/*`;
  - `%(worktreepath)` / `worktreePath` в `git.branches`;
  - `files.list({ taskId, ref: 'other-branch' })` и `files.read({ taskId, ref: 'other-branch', path })` читают файлы другой ветки, которых нет в текущей рабочей директории;
  - межветочный diff файла (`compareDiff`), раздельный `numstat`, side-aware `discard` и сериализацию параллельных мутаций.

---

### Этап 2. Чистые модели Renderer: `gitSnapshot`, `sourceControl`, `gitGraph`, `centerTabs`

**Зона записи (`write_scopes`):**
- `apps/desktop/src/renderer/src/state/gitSnapshot.ts` + `gitSnapshot.test.ts`
- `apps/desktop/src/renderer/src/state/GitSnapshotProvider.tsx`
- `apps/desktop/src/renderer/src/sourceControl.ts` + `sourceControl.test.ts`
- `apps/desktop/src/renderer/src/gitGraph.ts` + `gitGraph.test.ts` *(новый)*
- `apps/desktop/src/renderer/src/state/centerTabs.ts` + `centerTabs.test.ts` *(новый)*

**Задачи:**
1. **`gitSnapshot.ts` (`D2`, `D5.4`):**
   - Заменить `visible: Set<string>` на ref-count `Map<string, number>`, чтобы размонтирование `SourceControlPanel` не отключало автообновление снимка, пока `AppShell` подписан на ту же задачу.
   - В `reloadSlices` перезапрашивать `branches`, если `data != null || error != null`.
2. **`sourceControl.ts` (`D1`, `D4`, `D6`):**
   - Исправить порядок проверок в `discardConfirmation`: `isUntrackedRow` проверяется до `!options.hasHead`; добавить `canDiscardRow(row, { hasHead, hasStagedSide })`; поддержать текст подтверждения для unstaged-стороны частично staged файла; использовать по-сторонние `stagedAdditions`/`unstagedAdditions`.
3. **Чистый расчёт DAG-графа `gitGraph.ts` (§2.2):**
   - Вход: `buildGitGraph(commits: readonly GitCommit[], options?: { headHash?: string | null }): GraphNode[]`.
   - Алгоритм активных дорожек (`lanes: Array<string | null>`):
     - если хеш текущего коммита уже ожидается в одной или нескольких дорожках, узел ставится в самую левую из них, а дублирующиеся дорожки схлопываются (сходящиеся линии в этот узел); если не ожидается (новая верхушка ветки) — занимает первую свободную дорожку (или добавляется справа);
     - первый родитель `parents[0]` продолжает дорожку узла; остальные родители `parents[1..k]` (merge) либо подключаются к уже существующей дорожке этого родителя, либо открывают свободную дорожку;
     - если у коммита нет родителей (root commit), дорожка освобождается; если в конце загруженной страницы остались незакрытые дорожки (`hasMore`), они помечаются продолжением вниз;
     - вычисляется множество `headAncestry` (обход родителей от `headHash`), чтобы подсвечивать коммиты текущей ветки.
   - Покрыть `gitGraph.test.ts` случаями: линейная история, две параллельные ветки, обычный merge, octopus merge (3 родителя), несколько независимых верхушек веток (`nest/a`, `nest/b`, `origin/main`), обрезанная пагинацией страница.
4. **Модель центральной области `state/centerTabs.ts` (§1.3):**
   - На каждую `taskId` хранить:
     ```ts
     export type CenterSurface = 'terminal' | 'diff' | 'graph';
     export interface CompareDiffTarget {
       base: string;
       head: string;
       path: string | null;
     }
     export interface TaskCenterState {
       active: CenterSurface;
       diffOpen: boolean;
       /** null = рабочий diff задачи (из gitStore.selection); иначе межветочный diff. */
       compareTarget: CompareDiffTarget | null;
       graphOpen: boolean;
       graphScope: 'all' | 'branches' | 'head' | 'ref';
       graphRef: string | null;
       selectedCommitHash: string | null;
     }
     ```
   - Чистые функции переходов: `openWorkingDiff`, `openCompareDiff`, `openGraph` (с опциональным фокусом на `ref` или `commitHash`), `closeCenterTab('diff' | 'graph')`, `activateCenterSurface`, `forgetTaskCenter`.

**Критерий приёмки Этапа 2:**
- 100% прохождение unit-тестов `gitSnapshot.test.ts`, `sourceControl.test.ts`, `gitGraph.test.ts`, `centerTabs.test.ts`.

---

### Этап 3. Центральная область `CenterPane`: `DiffPanel` + `GitGraphPanel` и инспекция веток

**Зона записи (`write_scopes`):**
- `apps/desktop/src/renderer/src/components/CenterPane.tsx` *(новый)*
- `apps/desktop/src/renderer/src/components/GitGraphPanel.tsx` *(новый)*
- `apps/desktop/src/renderer/src/components/TerminalPane.tsx`
- `apps/desktop/src/renderer/src/components/DiffPanel.tsx`
- `apps/desktop/src/renderer/src/components/CommitDetail.tsx`
- `apps/desktop/src/renderer/src/components/RightPanel.tsx`
- `apps/desktop/src/renderer/src/rightPanelLayout.ts` + `rightPanelLayout.test.ts`
- `apps/desktop/src/renderer/src/App.tsx`
- `apps/desktop/src/renderer/src/styles.css`
- `apps/desktop/src/renderer/src/diffTarget.css`

**Задачи:**
1. **`CenterPane.tsx` и сохранение живых терминалов:**
   - В шапке `.terminal-tabs`: слева вкладки сессий и `+`, справа (при открытии или через быстрые вкладки) — вкладки `Diff` (`data-testid="center-diff-tab"`) и `Graph` (`data-testid="center-graph-tab"`) с кнопками закрытия `×` и закрытием по среднему клику.
   - Контейнер терминалов из `TerminalPane` **всегда смонтирован** и скрывается только CSS-классом (`display: none`), когда `active !== 'terminal'`. При переключении обратно на `'terminal'` вызывается `applyFit()` активного `xterm`.
2. **`DiffPanel` в центре:**
   - Убрать дублирующую кнопку `← Source Control`, добавить `Show all files` (`data-testid="diff-show-all"`) в `.diff-target-bar` для сброса single-file фильтра к полному списку изменённых файлов.
   - Поддержать режим `compareTarget` (read-only просмотр межветочного диффа из `Compare` или инспектора ветки с понятной плашкой `Comparing <base> → <head>`).
3. **`GitGraphPanel.tsx` (полное дерево Git + просмотр других веток):**
   - Верхняя панель управления графом:
     - переключатель охвата: `All branches` (`scope: 'all'`), `Local branches` (`scope: 'branches'`), `Current (HEAD)` (`scope: 'head'`) + поисковый пикер конкретной ветки/тега (`local` и `remote` из `gitStore.branches`, с отображением `↑ahead ↓behind` и бейджа `worktree`, если ветка открыта в другой задаче);
     - поле быстрого поиска коммитов (`Filter by message, author or hash`) и кнопки `Fetch` / `Refresh`.
   - При выборе другой ветки (в пикере или кликом по бейджу ветки на узле графа) показывается компактная полоса **Branch Inspector**:
     - имя ветки, последний коммит, статус относительно текущей ветки;
     - кнопки: `Compare with HEAD`, `Browse files` (открывает ветку в `FilesPanel` справа без `checkout`!), `New task from branch` (открывает `NewTaskDialog` с этим `baseRef`), и `Switch here` (если ветка не занята другим worktree).
   - Виртуализированный список коммитов с SVG-отрисовкой дорожек из `gitGraph.ts`, цветными ref-бейджами и кнопкой `Load older commits`.
   - Split-область деталей коммита: клик по любой строке коммита показывает `CommitDetailView` (с подсветкой синтаксиса патчей через `highlightHunk` из `highlight.ts` и кнопкой `Browse files at this commit`).
4. **Обновление `RightPanel`, `rightPanelLayout` и `App.tsx`:**
   - Убрать `'diff'` и `'history'` из `RightTab` (история и дерево теперь открываются в просторном `Graph` в центре; в правой панели остаются верхние разделы `Files`, `Source Control`, `Sessions` и подрежим `Compare`, либо `Compare` также открывает файловые патчи в центре).
   - Удалить `widen()` из `rightPanelLayout.ts`.
   - В узком окне (`rightLayout.drawer === true`) открытие `Diff` или `Graph` автоматически закрывает drawer.
   - В `App.tsx`: добавить команды палитры `Show Git graph (all branches)` и `Inspect branch…`; вызывать `gitStore.forgetTask` и `forgetTaskCenter` при удалении задач/проектов; поддержать передачу `initialBaseRef` при открытии `NewTaskDialog` из инспектора ветки.

**Критерий приёмки Этапа 3:**
- Открытие файла, полного `Diff` и `Git Graph` происходит в центральной колонке, не меняя ширину правой панели и не размонтируя `xterm`.
- В `Git Graph` видны все ветки репозитория с SVG-линиями ветвлений и слияний; можно выбрать другую ветку без `checkout`, посмотреть её коммиты и патчи, запустить создание новой задачи от неё.

---

### Этап 4. Правая панель: просмотр файлов других веток, `Compare`, `CommitBox`, `BranchSwitcher` и UX-полировка

**Зона записи (`write_scopes`):**
- `apps/desktop/src/renderer/src/components/FilesPanel.tsx`
- `apps/desktop/src/renderer/src/components/ComparePanel.tsx`
- `apps/desktop/src/renderer/src/components/SourceControlPanel.tsx`
- `apps/desktop/src/renderer/src/components/SourceControlHeader.tsx`
- `apps/desktop/src/renderer/src/components/ChangeSections.tsx`
- `apps/desktop/src/renderer/src/components/CommitBox.tsx`
- `apps/desktop/src/renderer/src/components/BranchSwitcher.tsx`
- `apps/desktop/src/renderer/src/components/NewTaskDialog.tsx` *(только приём опционального `initialBaseRef`)*
- `apps/desktop/src/renderer/src/styles.css`

**Задачи:**
1. **`FilesPanel` — просмотр файлов любой ветки или коммита без `checkout` (§2.3):**
   - В шапке `FilesPanel` добавить компактный селектор ревизии: `Working tree` (по умолчанию) + список локальных и удалённых веток с поиском (и приём внешнего `inspectedRef`, когда пользователь нажал `Browse files` в `Git Graph`).
   - При `ref !== null` передавать `ref` в `files.list` и `files.read`, показывать плашку `Viewing <ref> (read-only)` и кнопку сброса к `Working tree`. Поддержать клавишу `Escape` для выхода из превью файла к дереву.
2. **`ComparePanel` — межветочный diff по клику и общие ветки (`D7.6`, §2.3):**
   - Брать список веток из `gitStore` вместо дублирующего вызова RPC.
   - Сделать `CompareFileRow` кнопкой: клик по файлу вызывает `openCompareDiff({ base: selection.base, head: selection.head, path: file.path })`, открывая межветочный патч в центральной области `Diff`. Клик по коммиту открывает его в центральной вкладке `Graph`.
3. **`SourceControlPanel` и тулбар:**
   - Добавить кнопку `Graph` рядом с `Open diff` в тулбаре `Source Control` и в меню `SourceControlHeader`.
   - Сделать `Open diff` всегда активным при выбранной задаче (даже без выбранного файла).
   - Убрать лишний `useEffect([refreshKey])` (`D5.1`), брать `hasHead = !status.unborn` из `GitStatus` (`D1`), передавать `{ side }` в `discard` (`D6`).
4. **`CommitBox` (`D3`) и `BranchSwitcher` (`D7.3`):**
   - Сбрасывать `amend: false` после успешного коммита; подставлять сообщение `HEAD` при включении `Amend` с пустым черновиком; добавить отправку по `Ctrl/Cmd+Enter`.
   - В `BranchSwitcher`: добавить закрытие по `Escape`, фильтр поиска веток, состояние `Loading branches…`, пометку веток, занятых в других worktree (`worktreePath`), и вывод ошибки переключения на грязном дереве в `panelNote`, а также быструю кнопку `Inspect` (открыть ветку в `Graph` без переключения!).
5. **Клавиатура и плотность строк (`D7.1`, `D7.4`, `D7.5`):**
   - В `ChangeSections`: перехватывать `Escape` только при `selection !== null`; добавить навигацию по `.tree-dir` стрелками; сделать кнопки `Stage`/`Unstage`/`Discard` в строке компактными (сохранив `aria-label="Stage"` / `"Unstage"` / `"Discard"`).
   - В `.right-tabs` поддержать `ArrowLeft` / `ArrowRight` / `Home` / `End`.

**Критерий приёмки Этапа 4:**
- Пользователь может выбрать любую локальную или удалённую ветку в `FilesPanel` или через `Inspect` в `BranchSwitcher` / `Graph` и просмотреть её файлы и коммиты при грязном рабочем дереве без `git checkout`.
- Клик по файлу в `ComparePanel` открывает его патч в центре.
- Устранён баг с залипающим `Amend`, ложным подтверждением `Discard` на unborn-ветке и заблокированным `Escape` в drawer.

---

### Этап 5. Обновление и расширение E2E-тестов + документация

**Зона записи (`write_scopes`):**
- `apps/desktop/e2e/right-panel.spec.ts`
- `apps/desktop/e2e/layout.spec.ts`
- `apps/desktop/e2e/diff.spec.ts`
- `apps/desktop/e2e/git-history.spec.ts`
- `apps/desktop/e2e/palette.spec.ts`
- `apps/desktop/e2e/helpers.ts`
- `docs/right-panel-plan.md`
- `docs/architecture.md`
- `docs/product.md`

**Задачи:**
1. **Адаптировать существующие селекторы под `CenterPane`:**
   - `diff.spec.ts` и `palette.spec.ts`: `Show diff` открывает вкладку `Diff` в `.center` (`[data-testid="center-diff-tab"]`), а не `.right-subhead-title`.
   - `git-history.spec.ts`: проверить открытие `Graph` в `.center`, отображение всех веток (создать во временном репо `main` + ветку `feature` с расхождением и merge-коммитом), фильтрацию по другой ветке без `checkout` и чтение файла из `feature` в `FilesPanel`, пока checked out остаётся `main`.
   - `right-panel.spec.ts`: проверить одновременную видимость `SourceControlPanel` справа и `DiffPanel` в центре, переключение файла A → B в один клик, кнопку `Show all files`, неизменность ширины правой панели, сброс `Amend`, side-aware `Discard` и обновление рейла при свёрнутой панели (`D2`).
   - `layout.spec.ts`: проверить закрытие drawer при открытии `Diff`/`Graph` на `1100×700`, закрытие drawer по `Escape` и выживание PTY (`FakeHarness`) при переключениях `Terminal ↔ Diff ↔ Graph`.
2. **Обновить документацию (`docs/`):**
   - Актуализировать [docs/architecture.md](../docs/architecture.md) (§7.2.1–7.2.2), [docs/product.md](../docs/product.md) (§5.4, §6.1) и статус в [docs/right-panel-plan.md](../docs/right-panel-plan.md).

**Финальный проверочный гейт:**
```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm --filter @nest/desktop exec playwright test e2e/right-panel.spec.ts e2e/layout.spec.ts e2e/diff.spec.ts e2e/git-history.spec.ts e2e/palette.spec.ts
```
