/**
 * Splits a user-entered argument string into an argument array.
 *
 * Only quotes group words: backslashes are kept verbatim so Windows paths such
 * as `C:\Tools\agent.cmd` survive. A quoted segment may be empty, which lets a
 * user pass an empty argument (`--flag ""`).
 */
export function splitArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of input) {
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      started = true;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += char;
    started = true;
  }

  if (started) args.push(current);
  return args;
}
