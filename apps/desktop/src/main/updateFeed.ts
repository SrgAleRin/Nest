import { DEFAULT_UPDATE_FEED_URL } from '@nest/shared';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The built-in GitHub Releases feed keeps auto-update useful without manual
 * settings; a saved URL or NEST_UPDATE_URL overrides it.
 */
export function resolveUpdateFeedUrl(envValue: string | undefined, settingsValue: string): string {
  return envValue?.trim() || settingsValue.trim() || DEFAULT_UPDATE_FEED_URL;
}

/**
 * Updates execute the downloaded installer, so the feed must be HTTPS. Plain
 * HTTP is tolerated only for local experiments against a loopback server.
 */
export function parseUpdateFeedUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The update feed must be an absolute URL.');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url;
  throw new Error('The update feed must use HTTPS (HTTP is allowed for localhost only).');
}
