import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

import { ASK_USER_QUESTION_TOOL_NAME } from '../../../../shared/cowork/constants';
import {
  MediaConfirmationPolicy,
  MediaConfirmationStatus,
} from '../../../../shared/media/confirmation';
import MediaConfirmationCard from './MediaConfirmationCard';
import { permissionDockRequest } from './questionDockModel';

vi.mock('../../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

test('a request without structured details falls back to its prose and price line', () => {
  const request = permissionDockRequest({
    sessionId: 'session',
    requestId: 'request',
    toolName: ASK_USER_QUESTION_TOOL_NAME,
    toolInput: {
      mediaConfirmation: {
        kind: MediaConfirmationPolicy.Kind,
        revision: 0,
        sequence: 1,
        status: MediaConfirmationStatus.Refreshing,
        retainedUntil: Date.now() + 10000,
      },
      questions: [
        {
          title: 'Video',
          question: 'Retained scene',
          subtitle: 'Updated price',
          options: [{ label: 'Generate paid video' }],
        },
      ],
    },
  })!;
  const html = renderToStaticMarkup(createElement(MediaConfirmationCard, { request }));
  expect(html).toContain('Retained scene');
  expect(html).toContain('Updated price');
  expect(html).toContain('mediaVideoConfirmRepricing');
  expect(html).not.toContain('Generate paid video');
  expect(html).not.toContain('<textarea');
});

test('lays out structured video details with the cost beside the primary action', () => {
  const request = permissionDockRequest({
    sessionId: 'session',
    requestId: 'request',
    toolName: ASK_USER_QUESTION_TOOL_NAME,
    toolInput: {
      mediaConfirmation: {
        kind: MediaConfirmationPolicy.Kind,
        revision: 0,
        sequence: 1,
        status: MediaConfirmationStatus.Visible,
        retainedUntil: Date.now() + 600_000,
        repriced: { previousCredits: 350 },
      },
      questions: [
        {
          title: 'Video',
          question: 'Prose with [profile](https://example.invalid)',
          subtitle: 'Legacy price line',
          options: [{ label: 'Generate paid video' }],
          video: {
            model: 'seedance-fast',
            prompt: 'Two puppies race on a sunny playground',
            portalUrl: 'https://example.invalid/tasks',
            resolution: '720p',
            durationSeconds: 5,
            estimatedCredits: 399.6,
            references: [{ kind: 'image', thumbnail: 'data:image/jpeg;base64,AA' }, { kind: 'video' }],
          },
        },
      ],
    },
  })!;
  const html = renderToStaticMarkup(createElement(MediaConfirmationCard, { request }));
  expect(html).toContain('Two puppies race on a sunny playground');
  expect(html).toContain('seedance-fast');
  expect(html).toContain('720p');
  expect(html).toContain('mediaVideoConfirmCredits');
  expect(html).toContain('Generate paid video');
  expect(html).toContain('src="data:image/jpeg;base64,AA"');
  expect(html).not.toContain('[profile]');
  expect(html).not.toContain('Legacy price line');
  expect(html).toContain('mediaVideoConfirmRepriced');
  expect(html).toContain('<s class="text-xs tabular-nums text-secondary">350</s>');
  expect(html).not.toContain('role="timer"');
});
