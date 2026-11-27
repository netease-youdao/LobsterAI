import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test, vi } from 'vitest';

import { ASK_USER_QUESTION_TOOL_NAME } from '../../../../shared/cowork/constants';
import {
  MediaConfirmationKind,
  MediaConfirmationPolicy,
  MediaConfirmationStatus,
  VideoReferenceKind,
} from '../../../../shared/media/confirmation';
import MediaConfirmationCard, { buildReferencePreviewGallery } from './MediaConfirmationCard';
import { permissionDockRequest } from './questionDockModel';

vi.mock('../../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

test.each([MediaConfirmationKind.Video, MediaConfirmationKind.Image])('a %s request without structured details falls back to its prose and price line', kind => {
  const request = permissionDockRequest({
    sessionId: 'session',
    requestId: 'request',
    toolName: ASK_USER_QUESTION_TOOL_NAME,
    toolInput: {
      mediaConfirmation: {
        kind,
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

test.each([true, undefined])('offers approving the rest of the turn only when allowed: %s', turnGrant => {
  const request = permissionDockRequest({
    sessionId: 'session',
    requestId: 'request',
    toolName: ASK_USER_QUESTION_TOOL_NAME,
    toolInput: {
      mediaConfirmation: {
        kind: MediaConfirmationKind.Image,
        revision: 0,
        sequence: 1,
        status: MediaConfirmationStatus.Visible,
        retainedUntil: Date.now() + 600_000,
        ...(turnGrant ? { turnGrant } : {}),
      },
      questions: [{ title: 'Image', question: 'Another image?', options: [{ label: 'Generate' }, { label: 'Cancel' }] }],
    },
  })!;
  const html = renderToStaticMarkup(createElement(MediaConfirmationCard, { request }));
  expect(html.includes('mediaImageConfirmTurn<')).toBe(turnGrant === true);
  expect(html.includes('mediaImageConfirmTurnHint')).toBe(turnGrant === true);
});

test('maps only previewable image references into the gallery and keeps video indices non-previewable', () => {
  const { previewImages, previewIndexByReferenceIndex } = buildReferencePreviewGallery([
    { kind: VideoReferenceKind.Image, thumbnail: 'data:image/jpeg;base64,AA', previewUrl: 'localfile://local/first.png', name: 'first.png' },
    { kind: VideoReferenceKind.Video },
    { kind: VideoReferenceKind.Image },
    { kind: VideoReferenceKind.Image, thumbnail: 'https://example.invalid/second.png' },
  ], 'Reference image');

  expect(previewIndexByReferenceIndex).toEqual([0, -1, -1, 1]);
  expect(previewImages).toEqual([
    {
      src: 'localfile://local/first.png',
      fallbackSrc: 'data:image/jpeg;base64,AA',
      thumbSrc: 'data:image/jpeg;base64,AA',
      name: 'first.png',
      alt: 'first.png',
    },
    {
      src: 'https://example.invalid/second.png',
      fallbackSrc: undefined,
      thumbSrc: 'https://example.invalid/second.png',
      name: undefined,
      alt: 'Reference image',
    },
  ]);
});

test('renders previewable reference thumbnails as clickable buttons and non-previewable references as static badges', () => {
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
      },
      questions: [
        {
          title: 'Video',
          question: 'Prose',
          options: [{ label: 'Generate' }],
          video: {
            model: 'seedance-fast',
            prompt: 'A scenic journey',
            portalUrl: 'https://example.invalid/tasks',
            references: [
              { kind: 'image', thumbnail: 'data:image/jpeg;base64,AA', previewUrl: 'localfile://local/a.png', name: 'a.png' },
              { kind: 'image', thumbnail: 'https://example.invalid/b.png' },
              { kind: 'video' },
            ],
          },
        },
      ],
    },
  })!;
  const html = renderToStaticMarkup(createElement(MediaConfirmationCard, { request }));
  expect(html).toContain('aria-label="a.png - mediaVideoConfirmPreviewReference"');
  expect(html).toContain('aria-label="mediaVideoConfirmReferenceImage - mediaVideoConfirmPreviewReference"');
  expect(html).toContain('role="img" aria-label="mediaVideoConfirmReferenceVideo"');
});
