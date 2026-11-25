#!/usr/bin/env node
// Deterministic harness used by e2e tests and by developers without a real agent CLI.
// Speaks plain text over a PTY, echoes what it receives, and exits on `exit`.
// When NEST_FAKE_SESSION_DIR is set it records conversations on disk so the app
// can exercise the same session-id discovery path as real harnesses.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const sessionFlag = argv.indexOf('--session-id');
const continueFlag = argv.includes('--continue');

const sessionDir = process.env.NEST_FAKE_SESSION_DIR;
const cwd = path.resolve(process.cwd());

let sessionId = sessionFlag >= 0 ? argv[sessionFlag + 1] : undefined;
let resumeMode = sessionId ? 'exact' : 'fresh';

if (!sessionId && continueFlag) {
  resumeMode = 'continue';
  sessionId = latestSessionId(sessionDir, cwd) ?? undefined;
}

if (!sessionId) sessionId = randomUUID();

if (sessionDir) {
  try {
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, `${sessionId}.json`),
      `${JSON.stringify({ id: sessionId, cwd, created: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // discovery is optional; never break the harness
  }
}

let buffer = '';

const write = (text) => process.stdout.write(text);

write('\x1b[36mFakeHarness\x1b[0m ready. ');
write(`session ${sessionId} (${resumeMode})\r\n`);
write('Commands: help, echo <text>, exit\r\n');
write('\x1b[32m>\x1b[0m ');

function latestSessionId(dir, directory) {
  if (!dir) return null;
  try {
    let best = null;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const full = path.join(dir, file);
      try {
        const data = JSON.parse(readFileSync(full, 'utf8'));
        if (typeof data.id !== 'string' || data.cwd !== directory) continue;
        const mtime = statSync(full).mtimeMs;
        if (!best || mtime > best.mtime) best = { mtime, id: data.id };
      } catch {
        // ignore malformed records
      }
    }
    return best?.id ?? null;
  } catch {
    return null;
  }
}

function handleLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return;
  if (trimmed === 'exit' || trimmed === 'quit') {
    write('bye\r\n');
    process.exit(0);
  }
  if (trimmed === 'help') {
    write('help | echo <text> | exit\r\n');
  } else if (trimmed.startsWith('echo ')) {
    write(`${trimmed.slice(5)}\r\n`);
  } else {
    write(`you said: ${trimmed}\r\n`);
  }
  write('\x1b[32m>\x1b[0m ');
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const parts = buffer.split(/\r?\n/);
  buffer = parts.pop() ?? '';
  for (const part of parts) handleLine(part);
});

process.on('SIGINT', () => {
  write('\r\nbye\r\n');
  process.exit(0);
});
