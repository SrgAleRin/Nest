import { DEFAULT_TERMINAL_PREFERENCES, DEFAULT_UPDATE_FEED_URL } from '@nest/shared';
import type {
  AppInfo,
  AppSettings,
  DiffDescriptor,
  DiffMode,
  GitBranches,
  GitCommit,
  GitDiff,
  GitStatus,
  HarnessProfile,
  NestClient,
  NestEvent,
  Project,
  CommentView,
  ReviewComment,
  RpcMethod,
  RpcParams,
  RpcResult,
  Session,
  Task,
  UpdateStatus,
} from '@nest/shared';

const now = '2026-11-20T10:00:00.000Z';

const GREETING =
  '\u001b[36mFakeHarness\u001b[0m ready.\r\nCommands: help, echo <text>, exit\r\n\u001b[32m>\u001b[0m ';

export function createMockClient(): NestClient {
  const projects: Project[] = [
    {
      id: 'project-nest',
      name: 'nest-demo',
      path: 'D:\\dev\\nest-demo',
      setupScript: 'pnpm install',
      defaultBaseRef: 'origin/main',
      createdAt: now,
    },
  ];
  let tasks: Task[] = [
    {
      id: 'task-checkout',
      projectId: 'project-nest',
      kind: 'checkout',
      slug: '@main',
      title: 'main checkout',
      branch: 'main',
      baseRef: null,
      workspacePath: 'D:\\dev\\nest-demo',
      status: 'active',
      setupError: null,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'task-term',
      projectId: 'project-nest',
      kind: 'worktree',
      slug: 'terminal-reconnect',
      title: 'terminal reconnect',
      branch: 'nest/terminal-reconnect',
      baseRef: 'origin/main',
      workspacePath: 'D:\\dev\\nest-worktrees\\nest-demo\\terminal-reconnect',
      status: 'active',
      setupError: null,
      createdAt: now,
      updatedAt: now,
    },
  ];
  let sessions: Session[] = [
    {
      id: 'session-fake',
      taskId: 'task-checkout',
      harnessId: 'claude',
      title: 'Claude Code',
      status: 'idle',
      cwd: 'D:\\dev\\nest-demo',
      exitCode: null,
      harnessSessionId: 'ses_demo_fake_1',
      resumeMode: 'exact',
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'session-old',
      taskId: 'task-term',
      harnessId: 'claude',
      title: 'Claude Code',
      status: 'exited',
      cwd: 'D:\\dev\\nest-worktrees\\nest-demo\\terminal-reconnect',
      exitCode: 0,
      harnessSessionId: null,
      resumeMode: 'latest',
      createdAt: now,
      updatedAt: now,
    },
  ];
  let comments: CommentView[] = [
    {
      id: 'comment-1',
      taskId: 'task-checkout',
      filePath: 'src/App.tsx',
      line: 12,
      endLine: 13,
      side: 'new',
      body: 'This effect subscribes twice in StrictMode. Unsubscribe on cleanup.',
      status: 'open',
      stale: false,
      excerpt: 'useEffect(() => { subscribe();',
      anchorMode: 'unstaged',
      createdAt: now,
      updatedAt: now,
      placement: { kind: 'inline' },
    },
    {
      // Kept reachable after its hunk was committed: real, just off-patch.
      id: 'comment-2',
      taskId: 'task-checkout',
      filePath: 'src/terminal/bus.ts',
      line: 4,
      endLine: 4,
      side: 'new',
      body: 'This buffer is flushed on unmount only; do we need a timer?',
      status: 'open',
      stale: false,
      excerpt: 'const pending = new Map<string, string>();',
      anchorMode: 'both',
      createdAt: now,
      updatedAt: now,
      placement: { kind: 'outside', reason: 'committed' },
    },
  ];

  const mockFiles = [
    { path: '.gitignore' },
    { path: 'README.md' },
    { path: 'docs/notes.md' },
    { path: 'package.json' },
    { path: 'src/App.tsx' },
    { path: 'src/terminal/bus.ts' },
  ];

  const mockFileContent: Record<string, string> = {
    '.gitignore': 'node_modules\ndist\n.env\n',
    'README.md': '# nest-demo\n\nA mock project for the browser preview.\n',
    'docs/notes.md': '# Notes\n\n- the mock client has no filesystem\n',
    'package.json': '{\n  "name": "nest-demo",\n  "private": true\n}\n',
    'src/App.tsx':
      "export function App() {\n  const client = useMemo(createClient, []);\n  return <main>{client ? 'ready' : 'loading'}</main>;\n}\n",
    'src/terminal/bus.ts':
      'const listeners = new Map<string, Set<Listener>>();\n\nexport function onSessionData(sessionId: string, listener: Listener) {\n  const set = listeners.get(sessionId) ?? new Set();\n  set.add(listener);\n  listeners.set(sessionId, set);\n}\n',
  };

  const harnesses: HarnessProfile[] = [
    {
      id: 'claude',
      label: 'Claude Code',
      description: 'Anthropic Claude Code CLI',
      command: 'claude',
      args: [],
      resumeArgs: ['--continue'],
      available: false,
      source: 'builtin',
    },
    {
      id: 'codex',
      label: 'Codex',
      description: 'OpenAI Codex CLI',
      command: 'codex',
      args: [],
      resumeArgs: ['resume', '--last'],
      available: false,
      source: 'builtin',
    },
    {
      id: 'shell',
      label: 'Terminal',
      description: 'Plain shell in the task workspace',
      command: 'bash',
      args: [],
      resumeArgs: [],
      available: true,
      source: 'builtin',
    },
    {
      id: 'zcode',
      label: 'ZCode',
      description: 'Z.ai ZCode CLI',
      command: 'zcode',
      args: [],
      resumeArgs: ['--continue'],
      available: false,
      source: 'builtin',
    },
    {
      id: 'qwen',
      label: 'Qwen Code',
      description: 'Qwen Code CLI',
      command: 'qwen',
      args: [],
      resumeArgs: ['--continue'],
      available: false,
      source: 'builtin',
    },
  ];

  let settings: AppSettings = {
    disabledHarnesses: [],
    customCommand: '',
    harnessArgs: {},
    shellCommand: '',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
    worktreeRoot: '',
    copyEnvFiles: false,
    updateFeedUrl: '',
    updatesEnabled: true,
    newSessionDefault: 'ask',
  };

  const updateStatus = (): UpdateStatus => ({
    state: 'disabled',
    currentVersion: '0.1.2',
    enabled: false,
    feedUrl: settings.updateFeedUrl || DEFAULT_UPDATE_FEED_URL,
    availableVersion: null,
    percent: null,
    message: settings.updatesEnabled
      ? 'Updates are available in packaged builds only.'
      : 'Update checks are turned off in Settings.',
    checkedAt: null,
  });

  const profiles = (includeDisabled: boolean): HarnessProfile[] => {
    const all: HarnessProfile[] = settings.customCommand
      ? [
          ...harnesses,
          {
            id: 'custom',
            label: 'Custom command',
            description: settings.customCommand,
            command: settings.customCommand,
            args: [],
            resumeArgs: [],
            available: true,
            source: 'custom',
          },
        ]
      : harnesses;
    return includeDisabled
      ? all
      : all.filter((harness) => !settings.disabledHarnesses.includes(harness.id));
  };

  const status: GitStatus = {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    unborn: false,
    files: [
      {
        path: 'src/App.tsx',
        oldPath: null,
        copied: false,
        indexStatus: ' ',
        worktreeStatus: 'M',
        conflict: false,
        staged: false,
        unstaged: true,
        untracked: false,
        additions: 12,
        deletions: 4,
        stagedAdditions: null,
        stagedDeletions: null,
        unstagedAdditions: 12,
        unstagedDeletions: 4,
      },
      {
        path: 'src/terminal/bus.ts',
        oldPath: 'src/terminal/legacy.ts',
        copied: false,
        indexStatus: 'R',
        worktreeStatus: ' ',
        conflict: false,
        staged: true,
        unstaged: false,
        untracked: false,
        additions: 48,
        deletions: 0,
        stagedAdditions: 48,
        stagedDeletions: 0,
        unstagedAdditions: null,
        unstagedDeletions: null,
      },
      {
        path: 'docs/notes.md',
        oldPath: null,
        copied: false,
        indexStatus: '?',
        worktreeStatus: '?',
        conflict: false,
        staged: false,
        unstaged: true,
        untracked: true,
        additions: 9,
        deletions: 0,
        stagedAdditions: null,
        stagedDeletions: null,
        unstagedAdditions: 9,
        unstagedDeletions: 0,
      },
    ],
  };

  const diff: GitDiff = {
    descriptor: {
      mode: 'both',
      baseRef: null,
      workspaceIncludesIndex: false,
      anchorSide: 'mixed',
    },
    files: [
      {
        path: 'src/App.tsx',
        oldPath: 'src/App.tsx',
        status: 'modified',
        staged: false,
        additions: 3,
        deletions: 1,
        raw: '',
        hunks: [
          {
            header: '@@ -9,7 +9,9 @@ export function App() {',
            section: 'export function App() {',
            lines: [
              {
                type: 'context',
                oldLine: 9,
                newLine: 9,
                text: '  const client = useMemo(createClient, []);',
              },
              { type: 'context', oldLine: 10, newLine: 10, text: '' },
              { type: 'context', oldLine: 11, newLine: 11, text: '  useEffect(() => {' },
              {
                type: 'del',
                oldLine: 12,
                newLine: null,
                text: '    return client.on(handleEvent);',
              },
              {
                type: 'add',
                oldLine: null,
                newLine: 12,
                text: '    const unsubscribe = client.on(handleEvent);',
              },
              { type: 'add', oldLine: null, newLine: 13, text: '    return () => unsubscribe();' },
              { type: 'context', oldLine: 13, newLine: 14, text: '  }, [client]);' },
            ],
          },
        ],
      },
      {
        path: 'src/terminal/bus.ts',
        oldPath: null,
        status: 'added',
        staged: true,
        additions: 2,
        deletions: 0,
        raw: '',
        hunks: [
          {
            header: '@@ -0,0 +1,2 @@',
            section: '',
            lines: [
              {
                type: 'add',
                oldLine: null,
                newLine: 1,
                text: 'const listeners = new Map<string, Set<Listener>>();',
              },
              {
                type: 'add',
                oldLine: null,
                newLine: 2,
                text: 'export function onSessionData(...)',
              },
            ],
          },
        ],
      },
    ],
  };

  const commits: GitCommit[] = [
    {
      hash: 'f1e2d3c4b5a6978877665544332211ffeeddccbb',
      parents: ['a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'],
      authorName: 'Nest Dev',
      authorEmail: 'dev@example.com',
      authoredAt: '2026-11-20T09:40:00.000Z',
      committedAt: '2026-11-20T09:40:00.000Z',
      subject: 'feat: git history and branch compare',
      body: 'Adds the commit log, commit detail view and a three-dot comparison\nagainst the base branch.',
      refs: ['HEAD -> main', 'origin/main'],
    },
    {
      hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      parents: ['b2c3d4e5f60718293a4b5c6d7e8f901234567890'],
      authorName: 'Nest Dev',
      authorEmail: 'dev@example.com',
      authoredAt: '2026-11-19T15:10:00.000Z',
      committedAt: '2026-11-19T15:10:00.000Z',
      subject: 'fix: keep terminal scrollback on resume',
      body: '',
      refs: [],
    },
    {
      hash: 'b2c3d4e5f60718293a4b5c6d7e8f901234567890',
      parents: ['c3d4e5f60718293a4b5c6d7e8f9012345678a1'],
      authorName: 'Nest Dev',
      authorEmail: 'dev@example.com',
      authoredAt: '2026-11-18T11:02:00.000Z',
      committedAt: '2026-11-18T11:02:00.000Z',
      subject: 'feat: workspace tabs',
      body: '',
      refs: ['tag: v0.2.0'],
    },
    {
      hash: 'c3d4e5f60718293a4b5c6d7e8f9012345678a1b2',
      parents: [],
      authorName: 'Nest Dev',
      authorEmail: 'dev@example.com',
      authoredAt: '2026-11-16T08:30:00.000Z',
      committedAt: '2026-11-16T08:30:00.000Z',
      subject: 'init: project skeleton',
      body: '',
      refs: [],
    },
  ];

  const branches: GitBranches = {
    current: status.branch,
    detached: false,
    unborn: false,
    baseRef: 'origin/main',
    remotes: [
      {
        name: 'origin',
        fetchUrl: 'https://github.com/acme/nest-demo.git',
        pushUrl: 'https://github.com/acme/nest-demo.git',
      },
    ],
    local: [
      {
        name: 'main',
        remote: false,
        current: true,
        upstream: 'origin/main',
        ahead: status.ahead,
        behind: status.behind,
        gone: false,
        tip: commits[0]!.hash,
        subject: commits[0]!.subject,
        committedAt: commits[0]!.committedAt,
        worktreePath: null,
      },
      {
        name: 'nest/terminal-reconnect',
        remote: false,
        current: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        gone: false,
        tip: commits[1]!.hash,
        subject: commits[1]!.subject,
        committedAt: commits[1]!.committedAt,
        worktreePath: null,
      },
    ],
    remote: [
      {
        name: 'origin/main',
        remote: true,
        current: false,
        upstream: null,
        ahead: 0,
        behind: 0,
        gone: false,
        tip: commits[0]!.hash,
        subject: commits[0]!.subject,
        committedAt: commits[0]!.committedAt,
        worktreePath: null,
      },
    ],
  };

  const handlers = new Set<(event: NestEvent) => void>();
  const emit = (event: NestEvent): void => {
    for (const handler of handlers) handler(event);
  };

  // Mock output stream positions, so the renderer's snapshot/live join behaves
  // like the real main process.
  const streamPositions = new Map<string, number>();
  const emitData = (sessionId: string, data: string): void => {
    const start = streamPositions.get(sessionId) ?? 0;
    const end = start + data.length;
    streamPositions.set(sessionId, end);
    emit({ type: 'session:data', sessionId, data, start, end });
  };

  let clipboardText = '';

  const info: AppInfo = {
    version: '0.1.2-mock',
    electron: 'mock',
    platform: 'browser',
    profile: 'mock',
    userData: 'C:\\Users\\mock\\AppData\\Roaming\\Nest',
    dbPath: 'C:\\Users\\mock\\AppData\\Roaming\\Nest\\nest.db',
    worktreesRoot: 'C:\\Users\\mock\\AppData\\Roaming\\Nest\\worktrees',
    defaultWorktreesRoot: 'C:\\Users\\mock\\AppData\\Roaming\\Nest\\worktrees',
  };

  async function handle(method: RpcMethod, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'app.info':
        return info;
      case 'app.openExternal':
        return undefined;
      case 'clipboard.read':
        return { text: clipboardText };
      case 'clipboard.write':
        clipboardText = String(params.text ?? '');
        return undefined;
      case 'harness.list':
        return profiles(Boolean(params.includeDisabled));
      case 'settings.get':
        return settings;
      case 'settings.update': {
        const disabled = params.disabledHarnesses;
        settings = {
          disabledHarnesses: Array.isArray(disabled)
            ? (disabled.map(String) as AppSettings['disabledHarnesses'])
            : settings.disabledHarnesses,
          customCommand:
            typeof params.customCommand === 'string'
              ? params.customCommand.trim()
              : settings.customCommand,
          harnessArgs:
            params.harnessArgs === undefined
              ? settings.harnessArgs
              : (params.harnessArgs as AppSettings['harnessArgs']),
          shellCommand:
            typeof params.shellCommand === 'string'
              ? params.shellCommand.trim()
              : settings.shellCommand,
          terminal:
            params.terminal === undefined
              ? settings.terminal
              : (params.terminal as AppSettings['terminal']),
          worktreeRoot:
            typeof params.worktreeRoot === 'string'
              ? params.worktreeRoot.trim()
              : settings.worktreeRoot,
          copyEnvFiles:
            params.copyEnvFiles === undefined
              ? settings.copyEnvFiles
              : Boolean(params.copyEnvFiles),
          updateFeedUrl:
            typeof params.updateFeedUrl === 'string'
              ? params.updateFeedUrl.trim()
              : settings.updateFeedUrl,
          updatesEnabled:
            params.updatesEnabled === undefined
              ? settings.updatesEnabled
              : Boolean(params.updatesEnabled),
          newSessionDefault:
            params.newSessionDefault === undefined
              ? settings.newSessionDefault
              : (params.newSessionDefault as AppSettings['newSessionDefault']),
        };
        return settings;
      }
      case 'updates.status':
      case 'updates.check':
        return updateStatus();
      case 'updates.install':
        throw new Error('No downloaded update is ready to install');
      case 'notifications.show':
        return { shown: false };
      case 'notifications.badge':
        return undefined;
      case 'dialog.pickDirectory':
        return null;
      case 'projects.list':
        return projects;
      case 'projects.add': {
        const path = String(params.path ?? 'D:\\dev\\new-project');
        const project: Project = {
          id: `project-${projects.length + 1}`,
          name: path.split(/[\\/]/).pop() ?? 'project',
          path,
          setupScript: null,
          defaultBaseRef: 'origin/main',
          createdAt: new Date().toISOString(),
        };
        projects.push(project);
        const checkout: Task = {
          id: `task-${tasks.length + 1}`,
          projectId: project.id,
          kind: 'checkout',
          slug: '@main',
          title: 'main checkout',
          branch: 'main',
          baseRef: null,
          workspacePath: path,
          status: 'active',
          setupError: null,
          createdAt: now,
          updatedAt: now,
        };
        tasks.push(checkout);
        return { project, checkout };
      }
      case 'projects.remove': {
        const projectId = String(params.projectId);
        const removed = new Set(
          tasks.filter((task) => task.projectId === projectId).map((task) => task.id),
        );
        const index = projects.findIndex((project) => project.id === projectId);
        if (index >= 0) projects.splice(index, 1);
        tasks = tasks.filter((task) => task.projectId !== projectId);
        sessions = sessions.filter((session) => !removed.has(session.taskId));
        return undefined;
      }
      case 'projects.reveal':
      case 'tasks.reveal':
        return undefined;
      case 'tasks.list':
        return tasks;
      case 'tasks.openCheckout': {
        const checkout = tasks.find(
          (candidate) => candidate.projectId === params.projectId && candidate.kind === 'checkout',
        );
        if (!checkout) throw new Error('checkout not found');
        return { ...checkout };
      }
      case 'tasks.preview': {
        const project = projects.find((candidate) => candidate.id === params.projectId);
        if (!project) throw new Error('project not found');
        const title = String(params.title ?? '').trim();
        const slug = title ? title.toLowerCase().replace(/[^a-z0-9]+/g, '-') : '';
        const explicit = params.baseRef ? String(params.baseRef) : null;
        return {
          branch: slug ? `nest/${slug}` : null,
          slug: slug || null,
          workspacePath: slug ? `D:\\dev\\nest-worktrees\\nest-demo\\${slug}` : null,
          baseRef: explicit ?? project.defaultBaseRef,
          baseSource: explicit ? ('explicit' as const) : ('project' as const),
          baseAvailable: true,
        };
      }
      case 'tasks.create': {
        const id = `task-${tasks.length + 1}`;
        const title = String(params.title ?? 'new task');
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const operationId = String(params.operationId);
        const project = projects.find((candidate) => candidate.id === params.projectId);
        if (project && params.setupScript !== undefined) {
          project.setupScript = params.setupScript ? String(params.setupScript) : null;
        }
        const progressProjectId = String(params.projectId);
        emit({ type: 'task:progress', operationId, projectId: progressProjectId, step: 'fetch' });
        await new Promise((resolve) => setTimeout(resolve, 120));
        emit({
          type: 'task:progress',
          operationId,
          projectId: progressProjectId,
          step: 'worktree',
        });
        await new Promise((resolve) => setTimeout(resolve, 120));
        emit({ type: 'task:progress', operationId, projectId: progressProjectId, step: 'setup' });
        await new Promise((resolve) => setTimeout(resolve, 120));
        const task: Task = {
          id,
          projectId: String(params.projectId),
          kind: 'worktree',
          slug,
          title,
          branch: `nest/${slug}`,
          baseRef: params.baseRef ? String(params.baseRef) : 'origin/main',
          workspacePath: `D:\\dev\\nest-worktrees\\nest-demo\\${slug}`,
          status: 'active',
          setupError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        tasks.push(task);
        emit({
          type: 'task:operation',
          operationId,
          projectId: progressProjectId,
          state: 'done',
          taskId: id,
        });
        return task;
      }
      case 'tasks.abort':
        return { aborted: false };
      case 'tasks.remove': {
        const index = tasks.findIndex((task) => task.id === params.taskId);
        if (index >= 0) tasks.splice(index, 1);
        return undefined;
      }
      case 'sessions.list':
        return sessions;
      case 'sessions.start': {
        const task = tasks.find((candidate) => candidate.id === params.taskId);
        const harness = harnesses.find((candidate) => candidate.id === params.harnessId);
        const session: Session = {
          id: `session-${sessions.length + 1}`,
          taskId: String(params.taskId),
          harnessId: harness?.id ?? 'shell',
          title: `${harness?.label ?? 'Harness'} ${sessions.length + 1}`,
          status: 'running',
          cwd: task?.workspacePath ?? '',
          exitCode: null,
          harnessSessionId: `ses_mock_${sessions.length + 1}`,
          resumeMode: 'exact',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        sessions = [...sessions, session];
        setTimeout(() => emitData(session.id, GREETING), 80);
        return session;
      }
      case 'sessions.write': {
        const data = String(params.data ?? '');
        const sessionId = String(params.sessionId);
        const reply =
          data.includes('\r') || data.includes('\n')
            ? 'you said: hello\r\n\u001b[32m>\u001b[0m '
            : '';
        if (reply) {
          setTimeout(() => emitData(sessionId, reply), 60);
        }
        return undefined;
      }
      case 'sessions.stop': {
        const session = sessions.find((candidate) => candidate.id === params.sessionId);
        if (session) {
          session.status = 'exited';
          session.updatedAt = new Date().toISOString();
          emit({ type: 'session:status', session: { ...session } });
        }
        return undefined;
      }
      case 'sessions.close': {
        sessions = sessions.filter((candidate) => candidate.id !== params.sessionId);
        return undefined;
      }
      case 'sessions.resume': {
        const session = sessions.find((candidate) => candidate.id === params.sessionId);
        if (!session) throw new Error('session not found');
        const harness = harnesses.find((candidate) => candidate.id === session.harnessId);
        session.status = 'running';
        session.exitCode = null;
        session.updatedAt = new Date().toISOString();
        const updated = { ...session };
        emit({ type: 'session:status', session: updated });
        setTimeout(() => {
          emitData(
            session.id,
            `\r\n── resume ${harness?.label ?? session.harnessId} ──\r\n${GREETING}`,
          );
        }, 80);
        return updated;
      }
      case 'sessions.resize':
        return undefined;
      case 'sessions.scrollback': {
        const sessionId = String(params.sessionId);
        const position = streamPositions.get(sessionId) ?? 0;
        return {
          data: sessionId === 'session-fake' ? GREETING : '',
          position: sessionId === 'session-fake' ? position : 0,
        };
      }
      case 'git.status':
        return status;
      case 'git.diff': {
        const mode = (params.mode as DiffMode | undefined) ?? 'both';
        const descriptor: DiffDescriptor = {
          mode,
          baseRef: mode === 'base' ? 'origin/main' : null,
          workspaceIncludesIndex: mode === 'base',
          anchorSide: mode === 'staged' ? 'index' : mode === 'both' ? 'mixed' : 'worktree',
        };
        if (mode === 'both' || mode === 'base') return { descriptor, files: diff.files };
        const staged = mode === 'staged';
        return { descriptor, files: diff.files.filter((file) => file.staged === staged) };
      }
      case 'git.stage':
      case 'git.unstage': {
        // The mock keeps one side per path: staging folds the counts into the
        // index, unstaging puts them back into the worktree.
        const paths = new Set((params.paths as string[] | undefined) ?? []);
        const staging = method === 'git.stage';
        status.files = status.files.map((file) => {
          if (!paths.has(file.path)) return file;
          const additions = file.additions ?? 0;
          const deletions = file.deletions ?? 0;
          return staging
            ? {
                ...file,
                indexStatus: file.untracked ? 'A' : 'M',
                worktreeStatus: ' ',
                staged: true,
                unstaged: false,
                untracked: false,
                stagedAdditions: additions,
                stagedDeletions: deletions,
                unstagedAdditions: null,
                unstagedDeletions: null,
              }
            : {
                ...file,
                indexStatus: ' ',
                worktreeStatus: 'M',
                staged: false,
                unstaged: true,
                untracked: false,
                stagedAdditions: null,
                stagedDeletions: null,
                unstagedAdditions: additions,
                unstagedDeletions: deletions,
              };
        });
        return status;
      }
      case 'git.commit': {
        status.files = status.files.filter((file) => !file.staged);
        emit({ type: 'git:changed', taskId: String(params.taskId) });
        return { hash: 'abc1234', summary: String(params.message ?? '') };
      }
      case 'git.push':
        return { output: 'Everything up-to-date (mock)' };
      case 'git.log': {
        const limit = Number(params.limit ?? 50);
        const skip = Number(params.skip ?? 0);
        const ref = params.ref ? String(params.ref) : 'HEAD';
        const list = ref === 'HEAD' || ref === 'main' ? commits : commits.slice(1);
        return {
          commits: list.slice(skip, skip + limit),
          hasMore: list.length > skip + limit,
        };
      }
      case 'git.commitDetail': {
        const hash = String(params.hash);
        const commit = commits.find((candidate) => candidate.hash === hash) ?? commits[0]!;
        return { commit, files: diff.files };
      }
      case 'git.branches':
        return branches;
      case 'git.compare': {
        const base = String(params.base);
        const head = params.head ? String(params.head) : 'HEAD';
        return {
          base,
          head,
          mergeBase: commits[1]!.hash,
          ahead: 2,
          behind: 0,
          commits: commits.slice(0, 2),
          commitsTruncated: false,
          files: diff.files.map((file) => ({
            path: file.path,
            oldPath: file.oldPath,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
          })),
        };
      }
      case 'git.compareDiff': {
        const base = String(params.base);
        const head = params.head ? String(params.head) : 'HEAD';
        const path = params.path ? String(params.path) : null;
        return {
          base,
          head,
          mergeBase: commits[1]!.hash,
          files: path ? diff.files.filter((file) => file.path === path) : diff.files,
        };
      }
      case 'git.fetch':
        return { output: 'Fetched origin (mock)' };
      case 'git.pull':
        return { output: 'Already up to date (mock)' };
      case 'git.checkout': {
        const branch = String(params.branch);
        if (params.create && !branches.local.some((item) => item.name === branch)) {
          branches.local.push({
            name: branch,
            remote: false,
            current: true,
            upstream: null,
            ahead: 0,
            behind: 0,
            gone: false,
            tip: commits[0]!.hash,
            subject: 'Created in the mock client',
            committedAt: new Date().toISOString(),
            worktreePath: null,
          });
        }
        status.branch = branch;
        branches.current = branch;
        for (const item of branches.local) item.current = item.name === branch;
        return status;
      }
      case 'git.discard': {
        const paths = new Set((params.paths as string[] | undefined) ?? []);
        const side = (params.side as 'staged' | 'unstaged' | 'both' | undefined) ?? 'both';
        status.files = status.files.flatMap((file) => {
          if (!paths.has(file.path)) return [file];
          // `unstaged` restores the worktree from the index, so a staged part of
          // the same file stays in the list with its worktree counters cleared.
          if (side === 'unstaged' && file.staged) {
            return [
              {
                ...file,
                worktreeStatus: ' ',
                unstaged: false,
                additions: file.stagedAdditions,
                deletions: file.stagedDeletions,
                unstagedAdditions: null,
                unstagedDeletions: null,
              },
            ];
          }
          return [];
        });
        emit({ type: 'git:changed', taskId: String(params.taskId) });
        return status;
      }
      case 'files.list':
        return { files: mockFiles, truncated: false };
      case 'files.read': {
        const path = String(params.path ?? '');
        const text = mockFileContent[path] ?? `// ${path}\n`;
        return { path, size: text.length, text, binary: false, truncated: false };
      }
      case 'comments.list':
        return comments;
      case 'comments.create': {
        const line = Number(params.line);
        const comment: ReviewComment = {
          id: `comment-${comments.length + 1}`,
          taskId: String(params.taskId),
          filePath: String(params.filePath),
          line,
          endLine: Math.max(line, Number(params.endLine ?? line)),
          side: params.side === 'old' ? 'old' : 'new',
          body: String(params.body),
          status: 'open',
          stale: false,
          excerpt: null,
          anchorMode: (params.anchor as { mode?: DiffMode } | undefined)?.mode ?? null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        // A note is created from a row of the current view, so it starts inline.
        comments = [...comments, { ...comment, placement: { kind: 'inline' } }];
        return comment;
      }
      case 'comments.update': {
        const comment = comments.find((candidate) => candidate.id === params.commentId);
        if (!comment) return undefined;
        if (typeof params.body === 'string') comment.body = params.body;
        if (params.status === 'open' || params.status === 'resolved')
          comment.status = params.status;
        comment.updatedAt = new Date().toISOString();
        return { ...comment };
      }
      case 'comments.remove': {
        comments = comments.filter((comment) => comment.id !== params.commentId);
        return undefined;
      }
      case 'comments.send': {
        const comment = comments.find((candidate) => candidate.id === params.commentId);
        const text = `Review comment — ${comment?.filePath ?? ''}:${comment?.line ?? 0} (${comment?.side ?? 'new'})

${comment?.body ?? ''}
`;
        const session = sessions.find(
          (candidate) =>
            (params.sessionId === undefined || candidate.id === params.sessionId) &&
            (candidate.status === 'running' || candidate.status === 'idle'),
        );
        return session
          ? { sent: true, text }
          : { sent: false, reason: 'no_active_session' as const, text };
      }
      default:
        throw new Error(`Mock does not implement ${method}`);
    }
  }

  return {
    async invoke<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
      const result = await handle(method, params as Record<string, unknown>);
      return result as RpcResult<M>;
    },
    on(handler: (event: NestEvent) => void) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
