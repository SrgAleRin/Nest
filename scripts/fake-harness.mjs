#!/usr/bin/env node
// Deterministic harness used by e2e tests and by developers without a real agent CLI.
// Speaks plain text over a PTY, echoes what it receives, and exits on `exit`.

let buffer = '';

const write = (text) => process.stdout.write(text);

write('\x1b[36mFakeHarness\x1b[0m ready.\r\n');
write('Commands: help, echo <text>, exit\r\n');
write('\x1b[32m>\x1b[0m ');

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
