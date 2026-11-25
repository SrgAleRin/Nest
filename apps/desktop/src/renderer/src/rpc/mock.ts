import type {
  AppInfo,
  GitDiff,
  GitStatus,
  HarnessProfile,
  NestClient,
  NestEvent,
  Project,
  ReviewComment,
  RpcMethod,
  RpcParams,
  RpcResult,
  Session,
  Task,
} from '@nest/shared';

const now = '2026-11-20T10:00:00.000Z';

const GREETING =
  '\u001b[36mFakeHarness\u001b[0m ready.\r\nCommands: help, echo <text>, exit\r\n\u001b[32m>\u001b[0m ';

export function createMockClient(): NestClient {
  const projects: Project[] = [
    { id: 'project-nest', name: 'nest-demo', path: 'D:\\dev\\nest-demo', setupScript: 'pnpm install', createdAt: now },
  ];
  const tasks: Task[] = [
    {
      id: 'task-checkout',
      projectId: 'project-nest',
      kind: 'checkout',
      slug: '@main',
      title: 'main checkout',
      branch: 'main',
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
      harnessId: 'fake',
      title: 'Fake harness 1',
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
      harnessId: 'fake',
      title: 'Fake harness 1',
      status: 'exited',
      cwd: 'D:\\dev\\nest-worktrees\\nest-demo\\terminal-reconnect',
      exitCode: 0,
      harnessSessionId: null,
      resumeMode: 'latest',
      createdAt: now,
      updatedAt: now,
    },
  ];
  let comments: ReviewComment[] = [
    {
      id: 'comment-1',
      taskId: 'task-checkout',
      filePath: 'src/App.tsx',
      line: 12,
      side: 'new',
      body: 'This effect subscribes twice in StrictMode. Unsubscribe on cleanup.',
      status: 'open',
      createdAt: now,
      updatedAt: now,
    },
  ];

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
      id: 'fake',
      label: 'Fake harness',
      description: 'Built-in deterministic harness for development and e2e',
      command: 'node',
      args: ['scripts/fake-harness.mjs'],
      resumeArgs: ['--continue'],
      available: true,
      source: 'builtin',
    },
  ];

  const status: GitStatus = {
    branch: 'main',
    upstream: 'origin/main',
    ahead: 1,
    behind: 0,
    files: [
      {
        path: 'src/App.tsx',
        indexStatus: ' ',
        worktreeStatus: 'M',
        staged: false,
        untracked: false,
      },
      {
        path: 'src/terminal/bus.ts',
        indexStatus: 'A',
        worktreeStatus: ' ',
        staged: true,
        untracked: false,
      },
      {
        path: 'docs/notes.md',
        indexStatus: '?',
        worktreeStatus: '?',
        staged: false,
        untracked: true,
      },
    ],
  };

  const diff: GitDiff = {
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
              { type: 'context', oldLine: 9, newLine: 9, text: '  const client = useMemo(createClient, []);' },
              { type: 'context', oldLine: 10, newLine: 10, text: '' },
              { type: 'context', oldLine: 11, newLine: 11, text: '  useEffect(() => {' },
              { type: 'del', oldLine: 12, newLine: null, text: '    return client.on(handleEvent);' },
              { type: 'add', oldLine: null, newLine: 12, text: '    const unsubscribe = client.on(handleEvent);' },
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
              { type: 'add', oldLine: null, newLine: 1, text: 'const listeners = new Map<string, Set<Listener>>();' },
              { type: 'add', oldLine: null, newLine: 2, text: 'export function onSessionData(...)' },
            ],
          },
        ],
      },
    ],
  };

  const handlers = new Set<(event: NestEvent) => void>();
  const emit = (event: NestEvent): void => {
    for (const handler of handlers) handler(event);
  };

  let clipboardText = '';

  const info: AppInfo = {
    version: '0.1.0-mock',
    electron: 'mock',
    platform: 'browser',
    profile: 'mock',
    userData: 'C:\\Users\\mock\\AppData\\Roaming\\Nest',
    dbPath: 'C:\\Users\\mock\\AppData\\Roaming\\Nest\\nest.db',
    worktreesRoot: 'C:\\Users\\mock\\AppData\\Roaming\\Nest\\worktrees',
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
        return harnesses;
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
        const index = projects.findIndex((project) => project.id === params.projectId);
        if (index >= 0) projects.splice(index, 1);
        return undefined;
      }
      case 'projects.reveal':
      case 'tasks.reveal':
        return undefined;
      case 'tasks.list':
        return tasks;
      case 'tasks.openCheckout': {
        const checkout = tasks.find(
          (candidate) =>
            candidate.projectId === params.projectId && candidate.kind === 'checkout',
        );
        if (!checkout) throw new Error('checkout not found');
        return { ...checkout };
      }
      case 'tasks.create': {
        const id = `task-${tasks.length + 1}`;
        const title = String(params.title ?? 'new task');
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const project = projects.find((candidate) => candidate.id === params.projectId);
        if (project && params.setupScript !== undefined) {
          project.setupScript = params.setupScript ? String(params.setupScript) : null;
        }
        const progressProjectId = String(params.projectId);
        emit({ type: 'task:progress', projectId: progressProjectId, step: 'fetch' });
        await new Promise((resolve) => setTimeout(resolve, 120));
        emit({ type: 'task:progress', projectId: progressProjectId, step: 'worktree' });
        await new Promise((resolve) => setTimeout(resolve, 120));
        emit({ type: 'task:progress', projectId: progressProjectId, step: 'setup' });
        await new Promise((resolve) => setTimeout(resolve, 120));
        const task: Task = {
          id,
          projectId: String(params.projectId),
          kind: 'worktree',
          slug,
          title,
          branch: `nest/${slug}`,
          workspacePath: `D:\\dev\\nest-worktrees\\nest-demo\\${slug}`,
          status: 'active',
          setupError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        tasks.push(task);
        return task;
      }
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
          harnessId: harness?.id ?? 'fake',
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
        setTimeout(() => emit({ type: 'session:data', sessionId: session.id, data: GREETING }), 80);
        return session;
      }
      case 'sessions.write': {
        const data = String(params.data ?? '');
        const sessionId = String(params.sessionId);
        const reply = data.includes('\r') || data.includes('\n') ? 'you said: hello\r\n\u001b[32m>\u001b[0m ' : '';
        if (reply) {
          setTimeout(() => emit({ type: 'session:data', sessionId, data: reply }), 60);
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
          emit({
            type: 'session:data',
            sessionId: session.id,
            data: `\r\n── resume ${harness?.label ?? session.harnessId} ──\r\n${GREETING}`,
          });
        }, 80);
        return updated;
      }
      case 'sessions.resize':
        return undefined;
      case 'sessions.scrollback':
        return { data: params.sessionId === 'session-fake' ? GREETING : '' };
      case 'git.status':
        return status;
      case 'git.diff':
        return diff;
      case 'git.stage':
      case 'git.unstage':
        return status;
      case 'git.commit': {
        status.files = status.files.filter((file) => !file.staged);
        emit({ type: 'git:changed', taskId: String(params.taskId) });
        return { hash: 'abc1234', summary: String(params.message ?? '') };
      }
      case 'git.push':
        return { output: 'Everything up-to-date (mock)' };
      case 'comments.list':
        return comments;
      case 'comments.create': {
        const comment: ReviewComment = {
          id: `comment-${comments.length + 1}`,
          taskId: String(params.taskId),
          filePath: String(params.filePath),
          line: Number(params.line),
          side: params.side === 'old' ? 'old' : 'new',
          body: String(params.body),
          status: 'open',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        comments = [...comments, comment];
        return comment;
      }
      case 'comments.update': {
        const comment = comments.find((candidate) => candidate.id === params.commentId);
        if (!comment) return undefined;
        if (typeof params.body === 'string') comment.body = params.body;
        if (params.status === 'open' || params.status === 'resolved') comment.status = params.status;
        comment.updatedAt = new Date().toISOString();
        return { ...comment };
      }
      case 'comments.remove': {
        comments = comments.filter((comment) => comment.id !== params.commentId);
        return undefined;
      }
      case 'comments.send': {
        const session = sessions.find(
          (candidate) =>
            candidate.id === params.sessionId &&
            (candidate.status === 'running' || candidate.status === 'idle'),
        );
        return session ? { sent: true } : { sent: false, reason: 'no_active_session' };
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
