import { describe, expect, it } from 'vitest';
import { DEFAULT_UPDATE_FEED_URL } from '@nest/shared';
import { parseUpdateFeedUrl, resolveUpdateFeedUrl } from './updateFeed';

describe('resolveUpdateFeedUrl', () => {
  it('prefers the environment override', () => {
    expect(
      resolveUpdateFeedUrl('https://env.example/nest/', 'https://settings.example/nest/'),
    ).toBe('https://env.example/nest/');
  });

  it('uses a configured feed when the environment is empty', () => {
    expect(resolveUpdateFeedUrl(undefined, 'https://settings.example/nest/')).toBe(
      'https://settings.example/nest/',
    );
    expect(resolveUpdateFeedUrl('  ', '  ')).toBe(DEFAULT_UPDATE_FEED_URL);
  });

  it('falls back to the built-in GitHub Releases feed', () => {
    expect(resolveUpdateFeedUrl(undefined, '')).toBe(DEFAULT_UPDATE_FEED_URL);
    expect(parseUpdateFeedUrl(DEFAULT_UPDATE_FEED_URL).hostname).toBe('github.com');
  });
});

describe('parseUpdateFeedUrl', () => {
  it('accepts HTTPS feeds', () => {
    expect(parseUpdateFeedUrl('https://updates.example.com/nest/').protocol).toBe('https:');
  });

  it('accepts HTTP only on loopback hosts', () => {
    expect(parseUpdateFeedUrl('http://localhost:3000/').hostname).toBe('localhost');
    expect(parseUpdateFeedUrl('http://127.0.0.1:3000/').hostname).toBe('127.0.0.1');
    expect(parseUpdateFeedUrl('http://[::1]:3000/').hostname).toBe('[::1]');
  });

  it('rejects plain HTTP for a remote host', () => {
    expect(() => parseUpdateFeedUrl('http://updates.example.com/nest/')).toThrow(/HTTPS/);
    expect(() => parseUpdateFeedUrl('http://192.168.1.10/nest/')).toThrow(/HTTPS/);
  });

  it('rejects non-http protocols and invalid values', () => {
    expect(() => parseUpdateFeedUrl('file:///C:/updates')).toThrow(/HTTPS/);
    expect(() => parseUpdateFeedUrl('not a url')).toThrow(/absolute URL/);
  });
});
