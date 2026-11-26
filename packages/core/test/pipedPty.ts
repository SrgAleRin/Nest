import { spawn } from 'node:child_process';
import type { SpawnPty } from '../src/services/sessions.js';

/**
 * PTY stand-in for the unit suite: the harness runs as a plain child process
 * with piped stdio.
 *
 * `node-pty` cannot be used here. Its ConPTY `kill()` forks
 * `conpty_console_list_agent`, which attaches to the console of the shell it is
 * handed and then `process.kill`s every pid it finds there. On a CI runner that
 * console is the runner's own, so the sweep kills the vitest worker and the
 * step's parent processes: the run dies with `AttachConsole failed` noise,
 * `Unhandled Rejection: Channel closed` and exit code 1 (microsoft/node-pty#952).
 * Pipes keep the service contract — data in, data out, one exit — without any
 * console sweep. Real PTYs stay covered by the packaged e2e specs.
 */
export const spawnPipedPty: SpawnPty = (command, args, cwd, input) => {
  const child = spawn(command, args, {
    cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const dataListeners: Array<(data: string) => void> = [];
  const exitListeners: Array<(event: { exitCode: number }) => void> = [];
  let exited = false;

  const emitData = (chunk: Buffer | string): void => {
    const text = chunk.toString();
    for (const listener of dataListeners) listener(text);
  };
  const emitExit = (exitCode: number): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener({ exitCode });
  };

  // A PTY merges stdout and stderr into the single stream the terminal shows.
  child.stdout?.on('data', emitData);
  child.stderr?.on('data', emitData);
  // Writing to the stdin of an already dead process must not crash the run.
  child.stdin?.on('error', () => {});
  child.on('error', () => emitExit(1));
  child.on('exit', (code) => emitExit(code ?? 0));

  return {
    onData: (listener) => dataListeners.push(listener),
    onExit: (listener) => exitListeners.push(listener),
    // A terminal turns the carriage return of Enter into a newline (ICRNL);
    // a pipe does not, and the harnesses read lines by `\n`.
    write: (data) => child.stdin?.write(data.replace(/\r(?!\n)/g, '\n')),
    resize: () => {},
    kill: () => {
      child.kill();
    },
  };
};
