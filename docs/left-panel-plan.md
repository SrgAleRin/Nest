# Левая панель Nest — план переработки под модель Orca

Статус: реализован (этапы P0.1–P1 из §4) вместе с [правой панелью](right-panel-plan.md). Итог, отклонения и подтверждения — в §6.
База осмотра: исходники Nest (`D:\GIT\Nest`), сравнение с левой панелью Orca 1.4.x на Windows.
Связанные документы: сценарии — в [продукте](product.md#611-левая-панель-цель-переработки), архитектурные границы и контракты — в [архитектуре](architecture.md#651-левая-панель-рабочих-пространств-adr-012).

Соблюдать правила репозитория из [AGENTS.md](../AGENTS.md):

- код, идентификаторы, комментарии в коде и строки UI — **только на английском**; документация в `docs/` — **на русском**;
- `packages/core` остаётся чистым Node без `electron` и нативных модулей; новых внешних npm-зависимостей не добавляем (`@tanstack/react-virtual` уже установлен);
- каждый новый или изменённый метод RPC проходит через три точки: `packages/shared/src/rpc.ts` (+ схемы в `packages/shared/src/schemas.ts`), `apps/desktop/src/main/ipc.ts`, вызовы в renderer и стабы в `apps/desktop/src/renderer/src/rpc/mock.ts`;
- основная рабочая копия (`kind === 'checkout'`) никогда не удаляется и не архивируется отдельно от проекта;
- критерий завершения каждого этапа кода: зелёные `pnpm typecheck`, `pnpm lint`, `pnpm test` (и целевые Playwright-спеки для UI-этапов).

---

## 1. Почему текущей левой панелью неудобно пользоваться

Сейчас вся левая колонка реализована одним плоским компонентом [Sidebar.tsx](../apps/desktop/src/renderer/src/components/Sidebar.tsx) на жёсткой сетке `270px` ([App.tsx](../apps/desktop/src/renderer/src/App.tsx#L1338), [styles.css](../apps/desktop/src/renderer/src/styles.css#L186)). При реальной работе с 2–4 репозиториями и несколькими параллельными задачами возникают системные проблемы:

| Проблема в Nest | Где в коде и почему | Как решено в Orca и что меняем |
|---|---|---|
| **Три уровня дерева и двойное дублирование сессий.** Панель рисует `Project → Task → все Session rows`, а сверху ещё и секцию `Activity` | [Sidebar.tsx](../apps/desktop/src/renderer/src/components/Sidebar.tsx#L85-L98), [строки 217–236](../apps/desktop/src/renderer/src/components/Sidebar.tsx#L217-L236). Одни и те же сессии показаны в четырёх местах (`Activity`, дерево проектов, `TerminalTabs` в центре, `SessionsPanel` справа). Завершённые сессии раздувают дерево, а появление/исчезновение строк в `Activity` сдвигает проекты под курсором | Единица левой панели — **карточка рабочего пространства (`WorkspaceCard`)**, а не россыпь всех PTY-строк. Внимание решается **агрегированным статусом на карточке** и **умной сортировкой `Agent Activity`**, без прыгающего блока `Activity` сверху. Живые агенты видны компактной сводкой на карточке (с опциональным раскрытием) |
| **Баг индикации `Idle` в `Activity`.** Тихие живые агенты рисуются серой точкой вместо янтарной | [Sidebar.tsx](../apps/desktop/src/renderer/src/components/Sidebar.tsx#L35) формирует класс `.activity-dot-idle`, а в [styles.css](../apps/desktop/src/renderer/src/styles.css#L302-L305) остался старый `.activity-dot-waiting` | Единый компонент слота статуса `WorkspaceStatusSlot` с общими токенами и покрытием тестами |
| **Панель прибита к `270 px`: не ресайзится, не сворачивается и не уходит в drawer на узком окне** | [App.tsx](../apps/desktop/src/renderer/src/App.tsx#L1338) хардкодит `270px`, хотя правая панель уже использует [rightPanelLayout.ts](../apps/desktop/src/renderer/src/rightPanelLayout.ts), а [product.md](product.md#L379) обещает сворачивание обоих сайдбаров | Симметричный контроллер `leftPanelLayout.ts`: ресайз мышью и с клавиатуры (`220…440 px`), сворачивание в компактный рейл (`28 px`) и автоматический overlay-drawer на узком окне |
| **Несворачиваемые проекты, нет `Pinned`, нет поиска, группировки, сортировки и фильтров** | В [Sidebar.tsx](../apps/desktop/src/renderer/src/components/Sidebar.tsx#L114-L143) нет ни шевронов у проектов, ни строки фильтра, ни настроек вида (`FR-03` выполнен лишь частично). Неактивные репозитории и спящие задачи нельзя скрыть | Сворачиваемые секции (с показом точки активности и суммы `unread` в свёрнутом заголовке), секция `Pinned` сверху, быстрый поиск и меню **`Workspace options`**: группировка (`Project` / `Status` / `None`), сортировка (`Agent Activity` / `Recent` / `Name` / `Manual`), плотность карточек (`Detailed` / `Compact`) и фильтры с бейджем активных правил |
| **Задачу нельзя переименовать, пометить статусом этапа или оставить заметку** | В [rpc.ts](../packages/shared/src/rpc.ts#L81-L120) и [TaskService](../packages/core/src/services/tasks.ts) нет `tasks.update` / `tasks.rename`. Опечатка в названии лечится только пересозданием worktree | Inline-переименование карточки (`F2`, двойной клик или контекстное меню) без изменения пути worktree на диске, чтобы не рвать живые PTY; переключаемый статус этапа (`Todo` / `In progress` / `In review` / `Done`) и короткие заметки (`notes`) |
| **Нет архивации задач: завершённую задачу можно только навсегда снести вместе с worktree** | В [migrations.ts](../packages/core/src/db/migrations.ts#L27) уже есть `status IN ('active', 'archived')`, но ни core, ни UI его не используют | Разделение **Archive** (останавливает PTY, снимает watcher и убирает карточку из основного списка в нижний раздел `Archived (N)`, сохраняя worktree, ветку, историю и комментарии) и **Delete worktree** (полное удаление с диска и опциональное удаление локальной ветки) |
| **Опасные кнопки урны на каждой строке и блокирующий `window.confirm()`** | В [Sidebar.tsx](../apps/desktop/src/renderer/src/components/Sidebar.tsx#L135-L141) и [строках 207–213](../apps/desktop/src/renderer/src/components/Sidebar.tsx#L207-L213) `<TrashIcon>` стоит вплотную к выбору строки; в [App.tsx](../apps/desktop/src/renderer/src/App.tsx#L459) и [строке 703](../apps/desktop/src/renderer/src/App.tsx#L703) вызывается системный `window.confirm()` | Никаких голых кнопок удаления на карточках. Все вторичные и деструктивные операции живут в контекстном меню (правый клик и `⋯`), а удаление открывает неблокирующий `DeleteTaskDialog` / `RemoveProjectDialog` с явным списком незакоммиченных файлов и чекбоксом удаления ветки |
| **Нет отмены создания прямо в дереве, нет клавиатурной навигации, случайный подвал** | Pending-строка ([Sidebar.tsx](../apps/desktop/src/renderer/src/components/Sidebar.tsx#L146-L159)) не даёт нажать `Cancel`, если модалка закрыта; нет навигации стрелками; подвал тратит место на `profile: default profile` ([Sidebar.tsx](../apps/desktop/src/renderer/src/components/Sidebar.tsx#L250-L254)) | Кнопка `×` (`Cancel`) на строке создающейся задачи, полноценный roving-focus по списку (`↑`/`↓`/`←`/`→`/`Home`/`End`/`Enter`/`F2`), drag-and-drop папки репозитория и полезный подвал: `Add project`, `Archived (N)`, `Hidden projects (N)` |

---

## 2. Целевая панель (вид и функционал по образцу Orca)

### 2.1 Макет в режиме `Detailed` (по умолчанию) и в свёрнутом рейле

```text
Широкая колонка (272 px, ресайз 220..440 px)           Рейл (28 px)
┌────────────────────────────────────────────────────┐ ┌────┐
│ [◧]  [ 🔍 Search workspaces…        ] [⚙·1] [ +▾ ] │ │[◨] │
├────────────────────────────────────────────────────┤ │    │
│ ▾ 📌 Pinned                                     1  │ │[+] │
│   ┌──────────────────────────────────────────────┐ │ │    │
│   │ ● auth-refactor · nest           ⟳ 1   [⋯]  │ │ │ ●  │
│   │   ⎇ nest/auth-refactor   +42 −11   claude    │ │ │ 2  │
│   └──────────────────────────────────────────────┘ │ │    │
│                                                    │ │    │
│ ▾ 📁 nest                                  3  [+⋯] │ │    │
│   ▌ ◉ main                          [main]   [⋯]   │ │    │
│   ▌   ⎇ main · clean                pwsh           │ │    │
│     ◐ left-panel-plan               ● 2    [+][⋯]  │ │    │
│       ⎇ nest/left-panel   +18 −3    codex · idle   │ │    │
│     ◌ ⟳ api-cleanup        Creating worktree… [×]  │ │    │
│                                                    │ │    │
│ ▸ 📁 billing-service                    ● 1 · 4    │ │    │
├────────────────────────────────────────────────────┤ │    │
│ [+ Add project]                   [🗄 Archived · 5] │ │[🗄]│
└────────────────────────────────────────────────────┘ └────┘
```

Что мы сознательно **не** переносим из Orca (согласно фильтрам [product.md](product.md#10-что-сознательно-не-делаем)):

- привязки карточек к GitHub PR / Checks, Linear, Jira, GitLab MR;
- удалённые хосты SSH / WSL / paired servers и переключатели хостов;
- разделы Bots, Automations, Skills, Artifacts, Mobile;
- отдельную полноэкранную Kanban-доску (группировка `Group by: Status` прямо в сайдбаре закрывает сценарий без утяжеления UI).

### 2.2 Верхняя полоса управления (`SidebarToolbar`)

1. **Кнопка сворачивания панели (`[◧]`, `Collapse sidebar`):** сворачивает левую колонку в узкий рейл `28 px` (или закрывает `.left-drawer` в узком окне). В правом верхнем углу `.titlebar` дублирующая кнопка `New task` убирается, чтобы шапка окна оставалась чистой и не спорила с сайдбаром.
2. **Поле быстрого фильтра (`Search workspaces…`):** мгновенно фильтрует карточки по названию задачи (`title`), ветке (`branch`), имени проекта (`project.name`), заметке (`notes`) и именам запущенных профилей (`claude`, `codex`…). `Escape` в непустом поле очищает запрос; при активном поиске свёрнутые группы с совпадениями временно раскрываются.
3. **Кнопка `Workspace options` (иконка слайдеров + угловой бейдж `1..9+` при ненулевых фильтрах):** открывает поповер настроек представления (по образцу `SidebarWorkspaceOptionsMenu` в Orca):
   - **`Group by`:**
     - `Project` *(по умолчанию)* — группировка по репозиториям, `main checkout` всегда первый внутри проекта;
     - `Status` — группировка по этапам работы (`In progress`, `In review`, `Todo`, `Done`); на карточке показывается имя проекта;
     - `None` — единый плоский список по выбранной сортировке с бейджем проекта на каждой карточке.
   - **`Sort by`:**
     - `Agent Activity` *(по умолчанию, аналог `Smart` в Orca)* — ранжирование по классам внимания: (1) сбой старта/сессии (`failed`) или завершение с непрочитанным выводом (`unread`), (2) живой работающий агент (`starting`/`running`), (3) живой ожидающий агент (`idle`), (4) остальные по `effectiveRecentActivity` с окном защиты новых задач `CREATE_GRACE_MS = 5 мин` (чтобы фоновый лог в старой задаче не утаскивал только что созданную задачу вниз);
     - `Recent` — по времени последней активности задачи/сессий (с тем же `CREATE_GRACE_MS`);
     - `Name` — алфавитно без учёта регистра (`Intl.Collator` с `numeric: true`);
     - `Manual` — ручной порядок внутри группы (`sortOrder`).
   - **`Project order`** *(виден при `Group by: Project`)*: `Manual` · `Recent`.
   - **`Card layout`:**
     - `Detailed` *(по умолчанию)* — двухстрочная карточка (название + строка ветки, изменений, агентов и заметок);
     - `Compact` — плотная однострочная карточка высотой ~28 px (ветка, агенты и заметка доступны по наведению и в контекстном меню).
   - **`Show properties`** *(для `Detailed`)*: чекбоксы `Branch name`, `Git changes`, `Agent activity`, `Notes`.
   - **`Filters`:**
     - `Projects` *(если проектов > 1)* — мультивыбор репозиториев;
     - `Hide inactive workspaces` — скрывать задачи без живых сессий и без `unread`, с вложенным тогглом `Except main checkout` *(по умолчанию включён, как `alwaysShowDefaultBranchWorkspace` в Orca, чтобы единственная точка входа в проект не пропадала)*;
     - `Hide main checkout` — для тех, кто работает исключительно в изолированных worktree;
     - кнопка `Reset filters` (видна, когда активен хотя бы один фильтр).
4. **Кнопка создания (`+` со стрелкой `▾`):**
   - клик по `+` открывает `NewTaskDialog` для проекта выбранной задачи (или первого видимого проекта; если проектов нет — сразу запускает `Add project`);
   - клик по `▾` открывает короткое меню: `New task… (Ctrl+N)`, список проектов для быстрого создания задачи в конкретном репо, `Add project…`.

### 2.3 Карточка рабочего пространства (`WorkspaceCard`)

Каждая задача (`worktree` или `checkout`) рендерится самодостаточной карточкой:

1. **Левый слот статуса (`WorkspaceStatusSlot`):**
   - показывает агрегированный статус всех сессий задачи по приоритету:
     1. `failed` (красное кольцо/точка — последняя сессия упала с ненулевым кодом или упал автостарт/setup);
     2. `working` (зелёный пульсирующий индикатор — хотя бы одна сессия в `starting` или `running`);
     3. `idle` (янтарная точка — живой агентский процесс затих, не считая простого `shell`);
     4. `unread` (синяя яркая точка — процесс завершился в фоне или карточка помечена непрочитанной вручную);
     5. `inactive` (спокойная иконка этапа workflow: `Todo` / `In progress` / `In review` / `Done`);
   - клик непосредственно по точке `unread` (или команда меню) переключает прочитанность задачи без смены выбранного workspace.
2. **Заголовок и бейджи (первая строка):**
   - название задачи (`task.title`, а у `kind === 'checkout'` — бейдж `main` + название или `main checkout`); в режимах `Pinned`, `Group by: Status` и `Group by: None` перед названием приглушённо пишется `project.name /`;
   - при `F2`, двойном клике по заголовку уже выбранной карточки или команде `Rename` заголовок превращается в inline `<input>`: `Enter` / `Blur` сохраняет новое имя через `tasks.update`, `Escape` отменяет без запроса;
   - справа в покое видны компактные чипы внимания: сумма `unread`, предупреждение `setup` / `retry`, иконка текущего workflow-статуса (клик открывает мини-поповер быстрой смены этапа `Todo` / `In progress` / `In review` / `Done`);
   - при наведении или `:focus-within` справа появляются только две безопасные кнопки: `+` (`Start session in workspace`) и `⋯` (`Workspace actions`).
3. **Мета-строка (вторая строка в режиме `Detailed`):**
   - ветка `⎇ <branch>` (урезается по середине/концу с полным именем в `title`);
   - компактная сводка локальных правок Git (`+18 −3` или `• 2`, если снимок `gitSnapshot` уже загружен для задачи; чтение ленивое с низким приоритетом, чтобы старт приложения оставался `< 1.5 с`);
   - **сводка агентов (`InlineAgents`):** если есть живые сессии — лаконичная подпись вроде `claude · working` или `2 working · 1 idle`. Если у задачи > 1 живой сессии, маленький шеврон на чипе позволяет развернуть под карточкой только живые вкладки для прямого прыжка в нужный терминал. Завершённые вкладки дерево больше не захламляют (они остаются в полосе вкладок задачи и в правой панели `Sessions`);
   - иконка заметки `📝`, если у задачи заполнено поле `notes` (текст виден в тултипе и редактируется из меню).
4. **Выделение активной карточки:** левая акцентная полоса `2px solid var(--blue)` и мягкий фон `var(--panel-2)`, чётко различимые и при системном масштабировании 150%, и при `prefers-reduced-motion`.
5. **Ожидающая карточка (`PendingTaskRow`):** строится в начале своего проекта, показывает спиннер, введённое имя, текущий шаг (`Fetching…` / `Creating worktree…` / `Running setup…`) и кнопку `×` (`Cancel creation`), вызывающую `tasks.abort`.
6. **Скрытая фильтрами активная задача (`Reveal banner`):** если выбранная задача скрыта текущими фильтрами или поиском, вверху списка показывается ненавязчивая плашка `Current workspace is hidden by filters · [Reveal]` (аналог `revealFiltered` в Orca), сбрасывающая только мешающий фильтр и прокручивающая список к карточке.

### 2.4 Контекстные меню (правый клик и `⋯`)

**Меню карточки рабочего пространства (`WorkspaceContextMenu`):**

- `New session ▸` (список доступных профилей: `Terminal`, `Claude Code`, `Codex`, `DSH`…);
- `Pin` / `Unpin`;
- `Status ▸` (`Todo`, `In progress`, `In review`, `Done`);
- `Mark as unread` / `Mark as read`;
- `Rename…` (`F2`, для `worktree`-задач);
- `Edit notes…` (открывает компактный поповер заметки к задаче);
- `New task from this branch…` (открывает `NewTaskDialog` с `baseRef = task.branch`);
- `Stop running sessions` (доступно при наличии живых PTY — аналог «усыпления» задачи в Orca для освобождения памяти и CPU без закрытия вкладок и без удаления worktree);
- `Reveal in Explorer`;
- `Copy ▸` (`Workspace path`, `Branch name`, `Task name`);
- `Archive workspace` *(недоступно для `main checkout` с пояснением в `detail`)*;
- `Delete worktree…` *(деструктивный пункт в самом низу; для `main checkout` заблокирован с подсказкой «Main checkout cannot be deleted — remove the project instead»)*.

**Меню заголовка проекта (`ProjectContextMenu`):**

- `New task…` (`Ctrl+N`);
- `Open main checkout`;
- `Project settings…` (редактирование отображаемого имени, `defaultBaseRef` и `setupScript` без необходимости создавать фейковую задачу ради смены setup-скрипта!);
- `Reveal in Explorer`;
- `Copy path`;
- `Hide project from sidebar` (скрывает проект и его карточки из панели, не останавливая живые PTY; возвращается из футера `Hidden projects`);
- `Remove project from Nest…` (деструктивный пункт с неблокирующим диалогом подтверждения).

### 2.5 Архив (`ArchivedDrawer`) и удаление (`DeleteTaskDialog`)

1. **Архивация в один клик (`Archive`):**
   - завершённую задачу больше не нужно удалять с диска, если её ветка или scrollback ещё могут понадобиться;
   - `tasks.archive` мягко останавливает живые PTY этой задачи (`stop_requested = 1`), снимает `pinned`, ставит `status = 'archived'` и `archivedAt`, отключает для этого пути `WorkspaceWatcher` (чтобы десятки архивных worktree не тратили дескрипторы `@parcel/watcher`);
   - если архивируется текущая выбранная задача, фокус автоматически переходит на соседнюю активную задачу проекта (или `main checkout`).
2. **Просмотр архива (`Archived · N` в подвале сайдбара):**
   - клик по кнопке в подвале открывает встроенный экран/шторку архива поверх списка сайдбара (с кнопкой `← Back to workspaces` и `Escape`), с поиском по архивным задачам, датой архивации, именем проекта и веткой;
   - действия на архивной строке: `Restore` (возвращает задачу в активный список и включает watcher) и `Delete worktree…` (удаляет с диска); плюс кнопка `Clean up all archived…` для пакетного удаления чистых архивных worktree.
3. **Неблокирующий `DeleteTaskDialog` (вместо `window.confirm`):**
   - асинхронно проверяет `git.status` удаляемого worktree и показывает:
     - список незакоммиченных файлов (если дерево грязное, кнопка меняется на деструктивную `Force delete worktree`);
     - предупреждение о неотправленных коммитах (`ahead > 0` или отсутствие upstream при коммитах сверх `baseRef`);
     - чекбокс **`Also delete local branch <branch>`** *(по умолчанию выключен, чтобы случайно не потерять коммиты; недоступен, если ветка занята другим worktree)*.

### 2.6 Геометрия, свёрнутый рейл, узкое окно и клавиатура

- **Ресайз и рейл (`leftPanelLayout.ts`):** полная симметрия с `rightPanelLayout.ts`. Ширина по умолчанию `272 px`, диапазон `220 px … min(440 px, 38 vw)`, шаг с клавиатуры `24 px`, рейл `28 px`. Состояние `{ width, collapsed }` живёт в `localStorage` (`nest.leftPanel`).
- **Адаптивность на узком окне (`<= 1180 px`):**
  - при ширине окна `<= 1180 px` правая панель уже уходит в рейл (`RIGHT_PANEL_NARROW_WIDTH = 1180`); на совсем компактной ширине (`<= 980 px` или при `1100×700` с масштабом `150%`, где эффективная CSS-ширина `~733 px`!) левая панель **также** автоматически складывается в рейл `28 px` и открывается по клику как `.left-drawer` поверх центра с подложкой;
  - выбор задачи в `.left-drawer` или нажатие `Escape` закрывает drawer и возвращает фокус терминалу; смонтированные `xterm` в центре никогда не размонтируются.
- **Горячие клавиши (с защитой шелла в `shortcuts.ts`):**
  - `Ctrl+B` — свернуть/развернуть левую панель **только когда фокус вне терминала** (`!terminalFocused`, так как внутри bash/zsh/readline/tmux `Ctrl+B` — это `backward-char` / префикс); глобальный хоткей, работающий и из терминала, — `Ctrl+Shift+B`;
  - внутри списка сайдбара: `ArrowDown` / `ArrowUp` — следующая/предыдущая видимая строка (включая заголовки групп), `ArrowLeft` — свернуть открытую группу (или перейти к заголовку группы с карточки), `ArrowRight` — развернуть свёрнутую группу, `Home` / `End` — в начало/конец списка, `Enter` — открыть задачу, `F2` — переименовать выбранную worktree-карточку, `Delete` — открыть `DeleteTaskDialog` для worktree-карточки.

---

## 3. Изменения в архитектуре, БД и контрактах

### 3.1 Схема SQLite (миграция 13 `sidebar_workspace_metadata`)

Настройки представления UI (ширина панели, свёрнутые группы, активная группировка/сортировка/фильтры, `Compact`/`Detailed`) хранятся в **`localStorage`**, так как это локальная раскладка окна. В **SQLite** хранятся только свойства самих сущностей проекта и задачи, которые должны переживать перенос/перезапуск и синхронизироваться между компонентами:

```sql
-- Migration 13: sidebar_workspace_metadata
ALTER TABLE projects ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

ALTER TABLE tasks ADD COLUMN workflow_status TEXT NOT NULL DEFAULT 'in_progress'
  CHECK (workflow_status IN ('todo', 'in_progress', 'in_review', 'done'));
ALTER TABLE tasks ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN sort_order REAL NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN notes TEXT;
ALTER TABLE tasks ADD COLUMN archived_at TEXT;
ALTER TABLE tasks ADD COLUMN unread INTEGER NOT NULL DEFAULT 0;

CREATE INDEX tasks_project_status ON tasks (project_id, status);
```

Инварианты данных в `packages/core`:

- `tasks.status` (`'active' | 'archived'`) отвечает за жизненный цикл workspace (в работе vs в архиве), а `tasks.workflow_status` (`'todo' | 'in_progress' | 'in_review' | 'done'`) — за пользовательский этап задачи;
- у `kind === 'checkout'` всегда `status = 'active'` и `archived_at = NULL`; попытка вызвать `tasks.archive` на `checkout` бросает `NestError('cannot_archive_checkout', 'Main checkout cannot be archived')`;
- `tasks.update` при смене `title` **не переименовывает** каталог worktree на диске и не меняет `slug`/`workspace_path`, поэтому запущенные в этом каталоге PTY, открытые дескрипторы файлов и пути в истории агента остаются валидными.

### 3.2 Расширение схем и RPC (`packages/shared`)

В `packages/shared/src/schemas.ts`:

- `TaskWorkflowStatusSchema = z.enum(['todo', 'in_progress', 'in_review', 'done'])`;
- в `ProjectSchema` добавляются: `sortOrder: z.number()`, `hidden: z.boolean()`;
- в `TaskSchema` добавляются: `workflowStatus: TaskWorkflowStatusSchema`, `pinned: z.boolean()`, `sortOrder: z.number()`, `notes: z.string().nullable()`, `archivedAt: z.string().nullable()`, `unread: z.boolean()`.

В `packages/shared/src/rpc.ts`:

- `projects.update`: `{ projectId, name?, setupScript?, defaultBaseRef?, hidden? } → Project`;
- `projects.reorder`: `{ projectIds: z.array(id) } → z.void()`;
- `tasks.list`: `{ projectId?: id, includeArchived?: z.boolean() } → z.array(TaskSchema)` *(по умолчанию возвращает все или с флагом `includeArchived: true`, чтобы счётчик `Archived · N` в футере всегда был точен)*;
- `tasks.update`: `{ taskId, title?, workflowStatus?, pinned?, notes?, unread?, sortOrder? } → TaskSchema`;
- `tasks.archive`: `{ taskId } → TaskSchema`;
- `tasks.restore`: `{ taskId } → TaskSchema`;
- `tasks.reorder`: `{ taskIds: z.array(id) } → z.void()`;
- `tasks.remove`: расширяется полем `deleteBranch?: z.boolean()`.

События `NestEvent`:

- существующее `{ type: 'task:updated'; task: Task }` покрывает `update`, `archive` и `restore`;
- добавляется `{ type: 'project:updated'; project: Project }` (или обновление из ответа RPC) для консистентности шапки, палитры и сайдбара.

### 3.3 Чистая архитектура планирования строк в Renderer (`sidebarPlan.ts`)

По образцу `planSidebarRows` в Orca вся логика построения списка выносится из JSX в чистый детерминированный модуль `apps/desktop/src/renderer/src/sidebarPlan.ts`:

1. **Агрегация фактов по задаче (`buildTaskActivitySummary`):** сводит сессии задачи, счётчик непрочитанных событий и ручной флаг `task.unread` в единый `TaskCardStatus` (`'failed' | 'working' | 'idle' | 'unread' | 'inactive'`), список живых агентов и метку последней активности `lastActivityAt`.
2. **Сортировка (`sortWorkspaceItems`):** реализует `smart` (`Agent Activity`), `recent` (с `CREATE_GRACE_MS = 5 * 60_000`), `name` и `manual`; в режиме `Group by: Project` гарантирует, что `main checkout` остаётся первой строкой своего репозитория (`orderMainCheckoutFirst`).
3. **Фильтрация и поиск (`filterWorkspaceItems`):** отсекает `status === 'archived'` и задачи скрытых проектов (`project.hidden`), применяет выбранные фильтры из `Workspace options` и поисковый запрос, считает `activeFilterCount` и определяет, скрыта ли текущая активная задача (`isSelectedTaskHidden`).
4. **Проекция в плоский массив строк (`planSidebarRows`):** выдаёт готовые элементы рендера (`pinned-header`, `group-header` со сводкой скрытых под коллапсом активных/непрочитанных задач, `pending-task`, `workspace-card`), пригодные как для прямого рендера, так и для виртуализации через `@tanstack/react-virtual`, а также для плоской клавиатурной навигации по индексу строки.

---

## 4. Поэтапный план реализации

Этапы разделены по зонам записи (`write_scopes`), чтобы изменения можно было вносить последовательно короткими PR/коммитами или распараллелить между воркерами после фиксации `packages/shared`.

### Этап 1 (P0.1) — Миграция БД, сервисы Core и RPC-контракт

**Зона записи (`write_scopes`):**
- `packages/shared/src/schemas.ts`, `packages/shared/src/rpc.ts`, `packages/shared/src/events.ts`
- `packages/core/src/db/migrations.ts`, `packages/core/src/services/rows.ts`
- `packages/core/src/services/projects.ts`, `packages/core/src/services/tasks.ts`
- `packages/core/test/*`
- `apps/desktop/src/main/ipc.ts`, `apps/desktop/src/main/index.ts` (фильтрация архивных задач в `WorkspaceWatcher.sync`)
- `apps/desktop/src/renderer/src/rpc/mock.ts`

**Задачи:**
1. Добавить миграцию 13 (`sidebar_workspace_metadata`) и обновить мапперы `toProject` / `toTask` в `rows.ts`.
2. Реализовать `TaskService.update`, `TaskService.archive`, `TaskService.restore`, `TaskService.reorder` и опцию `deleteBranch` в `TaskService.remove` (безопасное `git branch -D <branch>` только после подтверждённого удаления worktree, только если ветка не является текущей в основном checkout, не совпадает с `defaultBaseRef` и не открыта в другом worktree).
3. В `TaskService.archive` вызывать `beforeArchive` (остановка живых PTY задачи с `stop_requested = 1`), а в `main` исключать задачи со `status === 'archived'` из `WorkspaceWatcher.sync`, возвращая наблюдение при `tasks.restore`.
4. Расширить `ProjectService.update` (`name`, `defaultBaseRef`, `setupScript`, `hidden`) и добавить `ProjectService.reorder`.
5. Покрыть миграцию, переименование, архив/восстановление, запрет архивации `main checkout` и `deleteBranch` интеграционными тестами в `packages/core/test/`.

### Этап 2 (P0.2) — Чистые модели левой панели в Renderer

**Зона записи (`write_scopes`):**
- `apps/desktop/src/renderer/src/leftPanelLayout.ts` + `leftPanelLayout.test.ts` *(новый)*
- `apps/desktop/src/renderer/src/sidebarView.ts` + `sidebarView.test.ts` *(новый)*
- `apps/desktop/src/renderer/src/sidebarPlan.ts` + `sidebarPlan.test.ts` *(новый)*
- `apps/desktop/src/renderer/src/shortcuts.ts` + `shortcuts.test.ts`

**Задачи:**
1. Реализовать `leftPanelLayout.ts` по образцу `rightPanelLayout.ts`: хранение `{ width, collapsed }` в `localStorage` (`nest.leftPanel`), drag-вычисление ширины от левого края окна, клавиши `ArrowLeft`/`ArrowRight`/`Home`/`End` на разделителе, коллапс в рейл `28 px` и переход в `.left-drawer` при дефиците ширины (`<= 980 px`).
2. Реализовать `sidebarView.ts` — валидацию и персистентность настроек вида (`groupBy`, `sortBy`, `projectOrderBy`, `cardLayout`, `shownProperties`, `collapsedGroups`, `filters`) в `localStorage` (`nest.sidebarView`), подсчёт `activeFilterCount` и функцию минимального раскрытия фильтров `revealTaskFilters` для скрытой активной задачи.
3. Реализовать `sidebarPlan.ts` — агрегацию статуса сессий задачи (`rankTaskStatus`), сортировку `Agent Activity` / `Recent` (с `CREATE_GRACE_MS`) / `Name` / `Manual`, секцию `Pinned`, сводки свёрнутых групп и построение плоского плана строк.
4. Добавить в `shortcuts.ts` действие `'toggle-left-panel'`: `Ctrl+Shift+B` всегда и `Ctrl+B` только при `!context.terminalFocused` (с unit-тестами на сохранение `Ctrl+B` за терминалом).

### Этап 3 (P0.3) — Новые компоненты UI левой панели, меню и диалоги

**Зона записи (`write_scopes`):**
- `apps/desktop/src/renderer/src/components/Sidebar.tsx` *(переработка)*
- `apps/desktop/src/renderer/src/components/sidebar/*` *(новые модульные компоненты: `SidebarToolbar.tsx`, `SidebarOptionsMenu.tsx`, `WorkspaceCard.tsx`, `ProjectGroupHeader.tsx`, `WorkspaceContextMenu.tsx`, `ArchivedTasksDrawer.tsx`, `DeleteTaskDialog.tsx`, `ProjectSettingsDialog.tsx`)*
- `apps/desktop/src/renderer/src/components/Icons.tsx`, `Boot.tsx`
- `apps/desktop/src/renderer/src/App.tsx`, `styles.css`

**Задачи:**
1. Собрать новую оболочку левой панели: ресайзер на правой границе, свёрнутый рейл `28 px` (с кнопкой разворачивания, `+` и индикатором активных/непрочитанных задач), `.left-drawer` с подложкой для узких окон, шапка с поиском, `Workspace options` и кнопкой создания `+▾`.
2. Реализовать `WorkspaceCard` в режимах `Detailed` и `Compact`: `WorkspaceStatusSlot`, inline-переименование (`F2` / двойной клик), быстрый пикер этапа workflow, сводка живых агентов с раскрытием списка вкладок, отображение ошибок `setup`/`start failed`, строка `PendingTaskRow` с кнопкой отмены `×`. Убрать старую секцию `Activity` и россыпь завершённых сессий из дерева.
3. Подключить контекстные меню по правому клику и кнопке `⋯` для карточек и заголовков проектов (`Pin/Unpin`, `Status`, `Mark unread/read`, `Rename`, `Notes`, `New task from branch`, `Stop running sessions`, `Archive`, `Delete worktree…`, `Project settings…`, `Hide project`).
4. Заменить оба нативных `window.confirm` в `App.tsx` (`removeTask` и `removeProject`) на неблокирующие модальные диалоги `DeleteTaskDialog` (со списком dirty-файлов и чекбоксом `Also delete local branch`) и `RemoveProjectDialog`.
5. Реализовать подвал сайдбара (`Add project`, `Archived · N`, `Hidden projects · N`), шторку `ArchivedTasksDrawer` (`Restore`, `Delete`, пакетная очистка) и drag-and-drop папки с диска для добавления репозитория.
6. Обновить `BootSkeleton` под новую структуру карточек, убрать дублирующую кнопку `New task` из `.titlebar` и добавить команды в `CommandPalette` (`Toggle left sidebar`, `Pin / Unpin workspace`, `Archive workspace`, `Rename workspace`, `Set workspace status…`, `Show archived workspaces`, `Reveal current workspace in sidebar`).

### Этап 4 (P1) — Полировка, индикаторы Git, DnD и E2E-приёмка

**Зона записи (`write_scopes`):**
- `apps/desktop/src/renderer/src/components/sidebar/*`
- `apps/desktop/e2e/helpers.ts`, `apps/desktop/e2e/layout.spec.ts`, `apps/desktop/e2e/smoke.spec.ts`, `apps/desktop/e2e/workflow.spec.ts`, `apps/desktop/e2e/notifications.spec.ts`
- `apps/desktop/e2e/left-panel.spec.ts` *(новый)*

**Задачи:**
1. Подключить лёгкие индикаторы локальных изменений Git (`+N −M`) на карточки из `gitSnapshot` без блокировки холодного старта (фоновая подгрузка батчами для видимых карточек).
2. Добавить pointer drag-and-drop для ручной перестановки проектов (`Project order: Manual`) и карточек внутри группы (`Sort by: Manual`).
3. Адаптировать существующие Playwright-хелперы и спеки к карточной разметке (`[data-testid="workspace-card"]`, меню действий и `DeleteTaskDialog` вместо `page.on('dialog')`).
4. Написать `apps/desktop/e2e/left-panel.spec.ts` и прогнать `layout.spec.ts` на `1100×700` и `1440×900` при `100%` и `150%` масштабировании Windows.

---

## 5. Критерии приёмки и проверки

- **Unit (`vitest`):**
  - `sidebarPlan.test.ts`: приоритет статусов `failed > working > idle > unread > inactive`; сортировка `Agent Activity` ставит упавшие и непрочитанные выше работающих, а новую задачу внутри 5-минутного окна `CREATE_GRACE_MS` не утаскивает вниз от фонового вывода в старой; `main checkout` всегда первый в своём проекте; группировки `Project` / `Status` / `None`; `Pinned` без дублей; подсчёт `activeFilterCount`; свёрнутый проект показывает агрегированный индикатор работающих/непрочитанных задач; `isSelectedTaskHidden` и `revealTaskFilters` точечно снимают только мешающий фильтр.
  - `leftPanelLayout.test.ts`: границы ширины, клавиатурный ресайз, сериализация в `localStorage`, коллапс в рейл и переход в narrow drawer.
  - `shortcuts.test.ts`: `Ctrl+B` в терминале уходит в PTY, вне терминала сворачивает сайдбар; `Ctrl+Shift+B` работает везде, кроме открытых модалок.
  - `packages/core/test/`: миграция 13 на существующей БД с данными; `tasks.update` (переименование без смены `workspacePath`, пин, статус, заметки); `tasks.archive` останавливает живые сессии и запрещён для `main checkout`; `tasks.restore` возвращает задачу; `tasks.remove({ deleteBranch: true })` удаляет ветку задачи и не трогает чужие/основную ветки.
- **E2E (`Playwright` на временных репозиториях):**
  - создание задачи → отображение `PendingTaskRow` с рабочей кнопкой отмены `×`;
  - переключение карточек `main` ↔ `worktree`, сводка живого `FakeHarness` на карточке, завершение в фоне → синяя точка `unread` на карточке и в заголовке свёрнутого проекта → снятие точки;
  - inline-переименование карточки по `F2` + `Enter` и отмена по `Escape` (живой терминал продолжает печатать в том же `cwd`);
  - `Pin` поднимает задачу в секцию `Pinned`; смена `Status` группирует карточки в режиме `Group by: Status`; фильтр `Hide inactive workspaces` скрывает неактивную worktree-задачу, но оставляет `main checkout`;
  - `Archive` убирает задачу в `Archived · 1`, а `Restore` возвращает её со всем scrollback;
  - `Delete worktree…` на грязном worktree открывает `DeleteTaskDialog` со списком изменённых файлов и удаляет локальную ветку при включённом чекбоксе;
  - ресайз, сворачивание в рейл `28 px` и `.left-drawer` на `1100×700` (100% и 150% DPI) без горизонтального скролла оболочки и без потери размера/ввода активного `xterm`.

---

## 6. Статус реализации

Все четыре этапа закрыты одним потоком: `packages/shared` и `packages/core` первыми, затем чистые модели renderer, затем компоненты и подключение в `App.tsx`/`styles.css`, затем E2E. Порядок и содержание этапов §4 не менялись.

| Этап | Что в коде | Чем подтверждено |
|---|---|---|
| P0.1 | Миграция 13 (`sidebar_workspace_metadata`): `tasks.workflow_status`, `pinned`, `sort_order`, `notes`, `unread`, `archived_at`; `projects.sort_order`, `hidden`. `tasks.update/archive/restore/reorder/remove({ deleteBranch })`, `projects.update/reorder`, `project:updated`. Архивация останавливает живые PTY (`stop_requested = 1`), снимает `pinned` и исключается из `WorkspaceWatcher.sync`; `tasks.remove` удаляет локальную ветку только если она не `defaultBaseRef` и не открыта в другом worktree | `packages/core/test/sidebar-metadata.test.ts` (17 тестов) |
| P0.2 | `leftPanelLayout.ts` (`220…440 px`, клавиатурный ресайз, рейл `28 px`, drawer `<= 980 px`, `nest.leftPanel`), `sidebarView.ts` (`nest.sidebarView`, `activeFilterCount`, `revealTaskFilters`), `sidebarPlan.ts` (`buildTaskActivitySummary`, `sortWorkspaceItems` с `CREATE_GRACE_MS`, `planSidebarRows`), `toggle-left-panel` в `shortcuts.ts` | `leftPanelLayout.test.ts` (9), `sidebarView.test.ts` (13), `sidebarPlan.test.ts` (49), `shortcuts.test.ts` (6) |
| P0.3 | Новая оболочка `Sidebar.tsx` на `@tanstack/react-virtual`: шапка с поиском, `Workspace options`, `+▾`; `WorkspaceCard` (`Detailed`/`Compact`), `WorkspaceStatusSlot`, `GroupHeaderRow`, `PendingTaskRow` с отменой `×`, `TaskNotesPopover`; контекстные меню карточек и проектов; `DeleteTaskDialog`, `RemoveProjectDialog`, `ProjectSettingsDialog`, `ArchivedTasksDrawer`; подвал `Add project` / `Archived · N` / `Hidden projects · N`; убраны секция `Activity`, кнопки урны на строках и оба `window.confirm`; `BootSkeleton` под новую разметку | `dialogs.test.ts` (15), `cards.test.ts` (9), `commands.test.ts`, `CenterPane.test.tsx` |
| P1 | Индикаторы `+N −M` из `gitSnapshot` с фоновой батчевой подгрузкой только видимых карточек, pointer drag-and-drop проектов и карточек, drop папки репозитория, клавиатурная навигация по строкам, `aria-activedescendant`-список | `apps/desktop/e2e/left-panel.spec.ts` (один сквозной сценарий), `layout.spec.ts`, обновлённые `smoke`, `workflow`, `notifications`, `right-panel` |

Отклонения и уточнения, принятые по ходу:

- **`minWidth` окна снижен с 1040 до 720 px.** При пороге drawer `<= 980 px` узкий режим был недостижим: окно не могло стать уже 1040 px. Это та же причина, по которой правая панель получила порог 1180 px, только решённая с другой стороны — здесь важен сам drawer, поэтому расширен диапазон окна.
- **Кнопка разворачивания рейла — `.left-rail-toggle`, а не `.rail-toggle`.** Общий класс уже занят правой панелью; одинаковый селектор ломал обе кнопки в E2E и в стилях.
- **`F2`/стрелки работают сразу после клика по карточке.** Клик по карточке выставляет `focusedKey` (и берёт его из `selectedTaskId`, если фокуса ещё нет): иначе первое нажатие `F2` уходило в никуда, пока список не получит фокус клавиатурой.
- **Сводка группы уехала вправо от счётчика.** `.ws-group-count { margin-right: auto }`: при `margin-left: auto` на `.ws-group-summary` кнопки `⋯`/`+` перекрывали клик по свёрнутому заголовку.
- **Экран `Archived` — шторка, а не отдельная страница.** `ArchivedTasksDrawer` открывается из подвала и закрывается кликом по подложке; пакетная очистка живёт в ней же, чтобы не добавлять пятый модал.
- **Архивация не удаляет данные.** Worktree, ветка, scrollback и комментарии остаются; удаление с диска — отдельное действие `Delete worktree…` с проверкой dirty-файлов и чекбоксом `Also delete local branch`.
- **E2E-инфраструктура.** `electronArgs()` добавляет `--no-sandbox` только при `NEST_E2E_NO_SANDBOX=1`, а в среде без прав на `%TEMP%` тесты просят `TEMP`/`TMP`/`TMPDIR` внутри рабочей копии. На обычном Windows-раннере CI переменная не нужна.

Проверки: `pnpm typecheck`, `pnpm lint`, `pnpm test` (shared 5, core 276 + 2 skipped, desktop 397) и Playwright `layout`, `left-panel`, `smoke`, `workflow`, `notifications`, `right-panel` — 20 passed, 2 skipped (два Windows-сценария bare remote в `right-panel.spec.ts`).

Вне этого выпуска остались пункты §4, требующие отдельного решения: раскрытие списка живых вкладок прямо под карточкой сделано в упрощённом виде (сводка + переход в `Sessions`), а `New task from branch` из контекстного меню проекта использует уже существующий путь создания задачи с подставленным `baseRef`, без отдельного диалога предпросмотра.
