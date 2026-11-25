import { describe, expect, it } from 'vitest';
import { parseUpdateFeedUrl } from './updateFeed';

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
