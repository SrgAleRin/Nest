import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  appUrlFrom,
  decideExternalLink,
  decideNavigation,
  isAppUrl,
  isTrustedSenderFrame,
} from './boundaries';

const rendererDir = path.resolve('out', 'renderer');
const rendererFile = path.join(rendererDir, 'index.html');
const packagedApp = appUrlFrom({ rendererFile });
const devApp = appUrlFrom({ devUrl: 'http://localhost:5173', rendererFile });

describe('decideExternalLink', () => {
  it('allows web and mail links', () => {
    expect(decideExternalLink('https://example.com/docs?q=1')).toEqual({
      allowed: true,
      url: 'https://example.com/docs?q=1',
    });
    expect(decideExternalLink('http://example.com')).toMatchObject({ allowed: true });
    expect(decideExternalLink('mailto:team@example.com')).toMatchObject({ allowed: true });
  });

  it('refuses every other protocol', () => {
    expect(decideExternalLink('file:///C:/Windows/System32/calc.exe')).toEqual({
      allowed: false,
      code: 'unsupported_url',
      message: 'Refusing to open file: links',
    });
    expect(decideExternalLink('javascript:alert(1)')).toMatchObject({ code: 'unsupported_url' });
    expect(decideExternalLink('data:text/html,<script>alert(1)</script>')).toMatchObject({
      code: 'unsupported_url',
    });
    expect(decideExternalLink('vbscript:msgbox(1)')).toMatchObject({ code: 'unsupported_url' });
    expect(decideExternalLink('app://nest/steal')).toMatchObject({ code: 'unsupported_url' });
  });

  it('refuses values that are not URLs', () => {
    expect(decideExternalLink('example.com/docs')).toMatchObject({ code: 'invalid_url' });
    expect(decideExternalLink('')).toMatchObject({ code: 'invalid_url' });
  });
});

describe('appUrlFrom', () => {
  it('uses the renderer entry for a packaged run', () => {
    expect(packagedApp.protocol).toBe('file:');
    expect(packagedApp.href).toBe(pathToFileURL(rendererFile).href);
  });

  it('uses the dev server for an unpackaged run', () => {
    expect(devApp.origin).toBe('http://localhost:5173');
  });

  it('falls back to the file when the dev URL is malformed', () => {
    expect(appUrlFrom({ devUrl: 'not a url', rendererFile }).protocol).toBe('file:');
  });
});

describe('isAppUrl', () => {
  it('accepts the document Nest loaded', () => {
    expect(isAppUrl(packagedApp.href, packagedApp)).toBe(true);
    expect(isAppUrl('http://localhost:5173/', devApp)).toBe(true);
    expect(isAppUrl('http://localhost:5173/settings?tab=git', devApp)).toBe(true);
  });

  it('refuses a foreign origin on the same protocol', () => {
    expect(isAppUrl('http://localhost:5174/', devApp)).toBe(false);
    expect(isAppUrl('https://localhost:5173/', devApp)).toBe(false);
    expect(isAppUrl('http://evil.example/', devApp)).toBe(false);
    expect(isAppUrl('http://localhost:5173.evil.example/', devApp)).toBe(false);
  });

  it('refuses another file on disk', () => {
    // Any document inside the emitted renderer directory is app-owned.
    expect(isAppUrl(pathToFileURL(path.join(rendererDir, 'other.html')).href, packagedApp)).toBe(
      true,
    );
    expect(
      isAppUrl(pathToFileURL(path.join(rendererDir, '..', 'evil.html')).href, packagedApp),
    ).toBe(false);
    expect(
      isAppUrl(pathToFileURL(path.resolve('out', 'renderer-evil', 'index.html')).href, packagedApp),
    ).toBe(false);
    expect(isAppUrl(pathToFileURL(path.resolve('Windows', 'evil.html')).href, packagedApp)).toBe(
      false,
    );
  });

  it('refuses protocols the app never loads', () => {
    expect(isAppUrl('about:blank', packagedApp)).toBe(false);
    expect(isAppUrl('javascript:alert(1)', packagedApp)).toBe(false);
    expect(isAppUrl('not a url', packagedApp)).toBe(false);
  });
});

describe('decideNavigation', () => {
  it('keeps the app document and dev server paths inside the window', () => {
    expect(decideNavigation(packagedApp.href, packagedApp)).toBe('allow');
    expect(decideNavigation('http://localhost:5173/settings', devApp)).toBe('allow');
  });

  it('sends an allowed external link to the browser', () => {
    expect(decideNavigation('https://example.com/docs', packagedApp)).toBe('external');
    expect(decideNavigation('http://localhost:5173/', packagedApp)).toBe('external');
  });

  it('blocks what the link policy refuses', () => {
    expect(decideNavigation('file:///C:/Windows/System32/calc.exe', packagedApp)).toBe('block');
    expect(decideNavigation('javascript:alert(1)', packagedApp)).toBe('block');
    expect(decideNavigation('about:blank', packagedApp)).toBe('block');
  });
});

describe('isTrustedSenderFrame', () => {
  const topFrame = { url: packagedApp.href, origin: packagedApp.origin, isTopFrame: true };

  it('accepts the top frame of the app document', () => {
    expect(isTrustedSenderFrame(topFrame, packagedApp)).toBe(true);
    expect(
      isTrustedSenderFrame(
        {
          url: 'http://localhost:5173/settings',
          origin: 'http://localhost:5173',
          isTopFrame: true,
        },
        devApp,
      ),
    ).toBe(true);
  });

  it('refuses a missing frame', () => {
    expect(isTrustedSenderFrame(null, packagedApp)).toBe(false);
  });

  it('refuses a subframe, even inside the app document', () => {
    expect(isTrustedSenderFrame({ ...topFrame, isTopFrame: false }, packagedApp)).toBe(false);
  });

  it('refuses a frame loaded from another origin', () => {
    expect(
      isTrustedSenderFrame(
        { url: 'http://evil.example/', origin: 'http://evil.example', isTopFrame: true },
        devApp,
      ),
    ).toBe(false);
    expect(
      isTrustedSenderFrame(
        { url: 'http://localhost:5174/', origin: 'http://localhost:5174', isTopFrame: true },
        devApp,
      ),
    ).toBe(false);
    expect(
      isTrustedSenderFrame(
        {
          url: pathToFileURL(path.resolve('out', 'renderer-evil', 'index.html')).href,
          origin: 'null',
          isTopFrame: true,
        },
        packagedApp,
      ),
    ).toBe(false);
  });

  it('refuses a dev frame whose url and origin disagree', () => {
    expect(
      isTrustedSenderFrame(
        { url: 'http://localhost:5173/', origin: 'http://evil.example', isTopFrame: true },
        devApp,
      ),
    ).toBe(false);
    expect(
      isTrustedSenderFrame({ url: 'about:blank', origin: 'null', isTopFrame: true }, packagedApp),
    ).toBe(false);
  });

  it('bounds a file document by its directory, not by its opaque origin', () => {
    // `file:` documents report either "null" or "file://" depending on the
    // Chromium build, so only the path separates the app from other documents.
    for (const origin of ['null', 'file://']) {
      expect(
        isTrustedSenderFrame({ url: packagedApp.href, origin, isTopFrame: true }, packagedApp),
      ).toBe(true);
      expect(
        isTrustedSenderFrame(
          {
            url: pathToFileURL(path.resolve('Windows', 'evil.html')).href,
            origin,
            isTopFrame: true,
          },
          packagedApp,
        ),
      ).toBe(false);
    }
  });
});
