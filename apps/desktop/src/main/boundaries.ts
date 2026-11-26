import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Trust boundary of the Electron shell, in one place:
 *
 * - which links may leave the app (`decideExternalLink`), used by the RPC
 *   handler and by the window open handler;
 * - which documents may stay inside the app window (`isAppUrl`), used to block
 *   unexpected navigation;
 * - which renderer frames may call the RPC router (`isTrustedSenderFrame`).
 *
 * The functions are pure so the negative cases are unit-testable without
 * Electron; the thin Electron wrapper that knows the app URL lives in
 * `appUrl.ts`.
 */

export type ExternalLinkDecision =
  | { allowed: true; url: string }
  | { allowed: false; code: 'invalid_url' | 'unsupported_url'; message: string };

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** The only allowlist for URLs that leave Nest. */
export function decideExternalLink(raw: string): ExternalLinkDecision {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { allowed: false, code: 'invalid_url', message: 'Not a valid URL' };
  }
  if (!EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    return {
      allowed: false,
      code: 'unsupported_url',
      message: `Refusing to open ${parsed.protocol || raw} links`,
    };
  }
  return { allowed: true, url: parsed.href };
}

export interface AppUrlSource {
  /** Dev server URL from `ELECTRON_RENDERER_URL`, when an unpackaged run sets it. */
  devUrl?: string | undefined;
  /** Absolute path of the renderer entry the main process loads. */
  rendererFile: string;
}

/** The one document Nest owns; everything else is foreign. */
export function appUrlFrom(source: AppUrlSource): URL {
  if (source.devUrl) {
    try {
      return new URL(source.devUrl);
    } catch {
      // A malformed dev URL must not widen the boundary: fall back to the file.
    }
  }
  return pathToFileURL(source.rendererFile);
}

/**
 * True when `target` is the document Nest loaded (or, for a dev server, any
 * path on its origin so the dev tooling keeps working).
 */
export function isAppUrl(target: string, appUrl: URL): boolean {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  if (parsed.protocol !== appUrl.protocol) return false;
  if (appUrl.protocol === 'file:') {
    // `file:` URLs all share the opaque "null" origin, so a whole disk of
    // foreign documents would pass an origin check. Compare directories.
    const root = fileDirectory(appUrl);
    const document = fileDirectory(parsed);
    return root !== null && document !== null && isInsideDirectory(root, document);
  }
  return parsed.origin === appUrl.origin;
}

export type NavigationDecision = 'allow' | 'external' | 'block';

/**
 * What to do when a frame navigates on its own. Staying inside the app is
 * allowed, an allowed external link goes to the system browser, and anything
 * else (a `file:`, `javascript:` or malformed target) is blocked outright.
 */
export function decideNavigation(target: string, appUrl: URL): NavigationDecision {
  if (isAppUrl(target, appUrl)) return 'allow';
  return decideExternalLink(target).allowed ? 'external' : 'block';
}

export interface SenderFrame {
  url: string;
  /** Serialized origin of the frame, as reported by `WebFrameMain.origin`. */
  origin: string;
  /** The top frame of a window has no parent frame. */
  isTopFrame: boolean;
}

/** Only the top frame of Nest's own document may call the RPC router. */
export function isTrustedSenderFrame(frame: SenderFrame | null, appUrl: URL): boolean {
  if (!frame) return false;
  if (!frame.isTopFrame) return false;
  // A `file:` document has no host, so its origin is opaque (`null`) or the
  // shared `file://`; either way it does not separate the app from another
  // file on disk, so a built app is checked by the URL path instead. A dev
  // server keeps both checks.
  if (appUrl.protocol !== 'file:' && frame.origin !== appUrl.origin) return false;
  return isAppUrl(frame.url, appUrl);
}

function fileDirectory(url: URL): string | null {
  if (url.protocol !== 'file:') return null;
  try {
    return path.dirname(fileURLToPath(url));
  } catch {
    return null;
  }
}

function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
