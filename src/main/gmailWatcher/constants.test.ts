/**
 * Unit tests for the Gmail Watcher module.
 *
 * Tests cover:
 * - GmailWatchService.buildAgentPrompt (via exported constants validation)
 * - Config defaults and storage key constants
 * - OAuth endpoint constants
 */
import { test, expect } from 'vitest';
import {
  GmailIpcChannel,
  GmailStorageKey,
  GoogleOAuthEndpoint,
  GMAIL_SCOPES,
  GMAIL_API_BASE,
  DEFAULT_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  WATCH_RENEWAL_INTERVAL_MS,
  DEFAULT_GMAIL_WATCHER_CONFIG,
} from './constants';

// ---------------------------------------------------------------------------
// Constants integrity
// ---------------------------------------------------------------------------

test('IPC channels are unique and prefixed with gmail:', () => {
  const channels = Object.values(GmailIpcChannel);
  expect(channels.length).toBeGreaterThan(0);
  for (const ch of channels) {
    expect(ch).toMatch(/^gmail:/);
  }
  expect(new Set(channels).size).toBe(channels.length);
});

test('storage keys are unique and prefixed with gmail_', () => {
  const keys = Object.values(GmailStorageKey);
  expect(keys.length).toBeGreaterThan(0);
  for (const key of keys) {
    expect(key).toMatch(/^gmail_/);
  }
  expect(new Set(keys).size).toBe(keys.length);
});

test('Google OAuth endpoints use HTTPS', () => {
  expect(GoogleOAuthEndpoint.AuthUrl).toMatch(/^https:\/\//);
  expect(GoogleOAuthEndpoint.TokenUrl).toMatch(/^https:\/\//);
  expect(GoogleOAuthEndpoint.RevokeUrl).toMatch(/^https:\/\//);
});

test('Gmail API base URL is correct', () => {
  expect(GMAIL_API_BASE).toBe('https://gmail.googleapis.com/gmail/v1');
});

test('Gmail scopes include readonly access', () => {
  expect(GMAIL_SCOPES).toContain('https://www.googleapis.com/auth/gmail.readonly');
});

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

test('default config has expected shape', () => {
  expect(DEFAULT_GMAIL_WATCHER_CONFIG.enabled).toBe(false);
  expect(DEFAULT_GMAIL_WATCHER_CONFIG.clientId).toBe('');
  expect(DEFAULT_GMAIL_WATCHER_CONFIG.clientSecret).toBe('');
  expect(DEFAULT_GMAIL_WATCHER_CONFIG.labelFilter).toBe('INBOX');
  expect(DEFAULT_GMAIL_WATCHER_CONFIG.pollIntervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
});

test('default prompt template contains expected placeholders', () => {
  const template = DEFAULT_GMAIL_WATCHER_CONFIG.agentPromptTemplate;
  expect(template).toContain('{{from}}');
  expect(template).toContain('{{subject}}');
  expect(template).toContain('{{date}}');
  expect(template).toContain('{{snippet}}');
});

// ---------------------------------------------------------------------------
// Polling intervals
// ---------------------------------------------------------------------------

test('default poll interval is 30 seconds', () => {
  expect(DEFAULT_POLL_INTERVAL_MS).toBe(30_000);
});

test('max poll interval is 5 minutes', () => {
  expect(MAX_POLL_INTERVAL_MS).toBe(5 * 60_000);
});

test('watch renewal interval is 6 days', () => {
  expect(WATCH_RENEWAL_INTERVAL_MS).toBe(6 * 24 * 60 * 60_000);
});

// ---------------------------------------------------------------------------
// Prompt template rendering
// ---------------------------------------------------------------------------

test('prompt template can be rendered with simple string replacement', () => {
  const template = DEFAULT_GMAIL_WATCHER_CONFIG.agentPromptTemplate;
  const rendered = template
    .replace(/\{\{from\}\}/g, 'alice@example.com')
    .replace(/\{\{subject\}\}/g, 'Meeting Tomorrow')
    .replace(/\{\{date\}\}/g, '2026-04-05T10:00:00Z')
    .replace(/\{\{snippet\}\}/g, 'Hi, can we reschedule...');

  expect(rendered).toContain('alice@example.com');
  expect(rendered).toContain('Meeting Tomorrow');
  expect(rendered).toContain('2026-04-05T10:00:00Z');
  expect(rendered).toContain('Hi, can we reschedule...');
  expect(rendered).not.toContain('{{');
});

test('prompt template renders cleanly with empty fields', () => {
  const template = DEFAULT_GMAIL_WATCHER_CONFIG.agentPromptTemplate;
  const rendered = template
    .replace(/\{\{from\}\}/g, 'Unknown')
    .replace(/\{\{subject\}\}/g, '(no subject)')
    .replace(/\{\{date\}\}/g, '')
    .replace(/\{\{snippet\}\}/g, '');

  expect(rendered).toContain('Unknown');
  expect(rendered).toContain('(no subject)');
  expect(rendered).not.toContain('{{');
});
