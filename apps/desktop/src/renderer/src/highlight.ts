import type { DiffHunk } from '@nest/shared';
import { createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/**
 * Syntax highlighting for the diff viewer. Only the grammars for file types
 * that actually show up are loaded, each through its own dynamic import, and
 * the highlighter uses Shiki's JavaScript regex engine so no WASM is needed in
 * the renderer.
 */
const GRAMMARS = {
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  json: () => import('@shikijs/langs/json'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  html: () => import('@shikijs/langs/html'),
  markdown: () => import('@shikijs/langs/markdown'),
  yaml: () => import('@shikijs/langs/yaml'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  powershell: () => import('@shikijs/langs/powershell'),
  python: () => import('@shikijs/langs/python'),
  go: () => import('@shikijs/langs/go'),
  rust: () => import('@shikijs/langs/rust'),
  java: () => import('@shikijs/langs/java'),
  c: () => import('@shikijs/langs/c'),
  csharp: () => import('@shikijs/langs/csharp'),
  sql: () => import('@shikijs/langs/sql'),
  dockerfile: () => import('@shikijs/langs/dockerfile'),
  ini: () => import('@shikijs/langs/ini'),
  toml: () => import('@shikijs/langs/toml'),
};

type GrammarId = keyof typeof GRAMMARS;

interface LanguageSpec {
  lang: string;
  modules: GrammarId[];
}

const BY_EXTENSION: Record<string, LanguageSpec> = {
  ts: { lang: 'typescript', modules: ['typescript'] },
  mts: { lang: 'typescript', modules: ['typescript'] },
  cts: { lang: 'typescript', modules: ['typescript'] },
  tsx: { lang: 'tsx', modules: ['tsx'] },
  js: { lang: 'javascript', modules: ['javascript'] },
  mjs: { lang: 'javascript', modules: ['javascript'] },
  cjs: { lang: 'javascript', modules: ['javascript'] },
  jsx: { lang: 'jsx', modules: ['jsx'] },
  json: { lang: 'json', modules: ['json'] },
  jsonc: { lang: 'json', modules: ['json'] },
  css: { lang: 'css', modules: ['css'] },
  scss: { lang: 'scss', modules: ['css', 'scss'] },
  html: { lang: 'html', modules: ['javascript', 'css', 'html'] },
  htm: { lang: 'html', modules: ['javascript', 'css', 'html'] },
  md: { lang: 'markdown', modules: ['markdown'] },
  mdx: { lang: 'markdown', modules: ['markdown'] },
  yml: { lang: 'yaml', modules: ['yaml'] },
  yaml: { lang: 'yaml', modules: ['yaml'] },
  sh: { lang: 'shellscript', modules: ['shellscript'] },
  bash: { lang: 'shellscript', modules: ['shellscript'] },
  zsh: { lang: 'shellscript', modules: ['shellscript'] },
  ps1: { lang: 'powershell', modules: ['powershell'] },
  py: { lang: 'python', modules: ['python'] },
  go: { lang: 'go', modules: ['go'] },
  rs: { lang: 'rust', modules: ['rust'] },
  java: { lang: 'java', modules: ['java'] },
  c: { lang: 'c', modules: ['c'] },
  h: { lang: 'c', modules: ['c'] },
  cs: { lang: 'csharp', modules: ['csharp'] },
  sql: { lang: 'sql', modules: ['sql'] },
  toml: { lang: 'toml', modules: ['toml'] },
  ini: { lang: 'ini', modules: ['ini'] },
  cfg: { lang: 'ini', modules: ['ini'] },
  conf: { lang: 'ini', modules: ['ini'] },
};

const BY_FILENAME: Record<string, LanguageSpec> = {
  dockerfile: { lang: 'docker', modules: ['dockerfile'] },
};

export function languageForPath(filePath: string): LanguageSpec | null {
  const name = filePath.split('/').pop()?.toLowerCase() ?? '';
  const byName = BY_FILENAME[name];
  if (byName) return byName;
  const extension = name.includes('.') ? (name.split('.').pop() ?? '') : '';
  return BY_EXTENSION[extension] ?? null;
}

export interface HunkHighlight {
  /** One token list per hunk line; null for meta lines (`\ No newline ...`). */
  lines: Array<ThemedToken[] | null>;
}

interface HighlighterHandle {
  highlighter: HighlighterCore;
  theme: string;
}

const loadedGrammars = new Set<GrammarId>();
const loadingGrammars = new Map<GrammarId, Promise<void>>();
let highlighterPromise: Promise<HighlighterHandle> | null = null;

function getHighlighter(): Promise<HighlighterHandle> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const theme = await import('@shikijs/themes/vitesse-dark');
      const highlighter = await createHighlighterCore({
        themes: [theme.default],
        langs: [],
        engine: createJavaScriptRegexEngine(),
      });
      return { highlighter, theme: theme.default.name ?? 'vitesse-dark' };
    })();
  }
  return highlighterPromise;
}

async function ensureGrammar(id: GrammarId): Promise<void> {
  if (loadedGrammars.has(id)) return;
  const pending = loadingGrammars.get(id);
  if (pending) return pending;

  const loading = (async () => {
    const { highlighter } = await getHighlighter();
    const module = await GRAMMARS[id]();
    await highlighter.loadLanguage(module.default);
    loadedGrammars.add(id);
  })();
  loadingGrammars.set(id, loading);
  try {
    await loading;
  } finally {
    loadingGrammars.delete(id);
  }
}

/** Highlighting caches by hunk text, so a watcher refresh does not re-tokenize. */
const MAX_CACHED_HUNKS = 500;
const cache = new Map<string, Promise<HunkHighlight | null>>();

function cacheKey(hunk: DiffHunk, spec: LanguageSpec): string {
  return `${spec.lang}\u0000${hunk.header}\u0000${hunk.lines.map((line) => line.text).join('\n')}`;
}

export function highlightHunk(hunk: DiffHunk, filePath: string): Promise<HunkHighlight | null> {
  const spec = languageForPath(filePath);
  if (!spec) return Promise.resolve(null);

  const key = cacheKey(hunk, spec);
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = run(hunk, spec).catch(() => null);
  cache.set(key, pending);
  if (cache.size > MAX_CACHED_HUNKS) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return pending;
}

async function run(hunk: DiffHunk, spec: LanguageSpec): Promise<HunkHighlight | null> {
  await Promise.all(spec.modules.map(ensureGrammar));
  const { highlighter, theme } = await getHighlighter();

  // A hunk is tokenized on both sides: removed lines only exist on the old
  // side, everything else on the new one. Grammar state therefore spans the
  // whole hunk instead of restarting on every line.
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const anchors: Array<{ old?: number; new?: number }> = [];

  for (const line of hunk.lines) {
    if (line.type === 'context') {
      anchors.push({ old: oldLines.length, new: newLines.length });
      oldLines.push(line.text);
      newLines.push(line.text);
    } else if (line.type === 'del') {
      anchors.push({ old: oldLines.length });
      oldLines.push(line.text);
    } else if (line.type === 'add') {
      anchors.push({ new: newLines.length });
      newLines.push(line.text);
    } else {
      anchors.push({});
    }
  }

  const tokenize = (text: string): ThemedToken[][] =>
    highlighter.codeToTokensBase(text, { lang: spec.lang, theme });

  const oldTokens = oldLines.length > 0 ? tokenize(oldLines.join('\n')) : [];
  const newTokens = newLines.length > 0 ? tokenize(newLines.join('\n')) : [];

  return {
    lines: hunk.lines.map((line, index) => {
      if (line.type === 'meta') return null;
      const anchor = anchors[index] ?? {};
      if (line.type === 'del') return oldTokens[anchor.old ?? -1] ?? null;
      return newTokens[anchor.new ?? -1] ?? oldTokens[anchor.old ?? -1] ?? null;
    }),
  };
}

export function tokenStyle(token: ThemedToken): {
  color?: string;
  fontStyle?: string;
  fontWeight?: string;
  textDecoration?: string;
} {
  const style: {
    color?: string;
    fontStyle?: string;
    fontWeight?: string;
    textDecoration?: string;
  } = {};
  if (token.color) style.color = token.color;
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & 1) style.fontStyle = 'italic';
  if (fontStyle & 2) style.fontWeight = '600';
  if (fontStyle & 4) style.textDecoration = 'underline';
  return style;
}
