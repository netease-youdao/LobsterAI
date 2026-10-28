import { describe, expect, test } from 'vitest';

import { isHostnameOnDomain, isUrlOnDomain } from './hostname';

describe('isHostnameOnDomain', () => {
  test('matches the domain and its subdomains', () => {
    expect(isHostnameOnDomain('github.com', 'github.com')).toBe(true);
    expect(isHostnameOnDomain('gist.github.com', 'github.com')).toBe(true);
    expect(isHostnameOnDomain('Owner.GitHub.io', 'github.io')).toBe(true);
    expect(isHostnameOnDomain('github.com.', 'github.com')).toBe(true);
  });

  test('rejects hosts that only contain the domain as a substring', () => {
    expect(isHostnameOnDomain('github.com.evil.example', 'github.com')).toBe(false);
    expect(isHostnameOnDomain('notgithub.com', 'github.com')).toBe(false);
    expect(isHostnameOnDomain('example.com', 'github.com')).toBe(false);
  });
});

describe('isUrlOnDomain', () => {
  test('matches URLs whose host is on the domain', () => {
    expect(isUrlOnDomain('https://api.githubcopilot.com/chat/completions', 'githubcopilot.com')).toBe(true);
    expect(isUrlOnDomain('https://generativelanguage.googleapis.com/v1beta', 'generativelanguage.googleapis.com')).toBe(true);
  });

  test('rejects the domain in the path, query or a longer host', () => {
    expect(isUrlOnDomain('https://evil.example/?u=githubcopilot.com', 'githubcopilot.com')).toBe(false);
    expect(isUrlOnDomain('https://evil.example/githubcopilot.com', 'githubcopilot.com')).toBe(false);
    expect(isUrlOnDomain('https://githubcopilot.com.evil.example', 'githubcopilot.com')).toBe(false);
  });

  test('rejects values that are not absolute URLs', () => {
    expect(isUrlOnDomain('githubcopilot.com', 'githubcopilot.com')).toBe(false);
    expect(isUrlOnDomain('', 'githubcopilot.com')).toBe(false);
  });
});
