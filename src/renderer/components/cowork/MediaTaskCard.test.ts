import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test, vi } from 'vitest';

import { MediaBillingStatus, MediaDeliveryStatus, MediaTaskPhase, MediaTaskStatus, MediaTaskWarning } from '../../../shared/media/constants';
import MediaTaskCard, { isMediaTaskSettled, mediaTaskAspectRatio } from './MediaTaskCard';

vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

describe('media task placeholder', () => {
  test.each([
    [{ aspectRatio: '3:4' }, false, 0.75],
    [{ size: '1536x1024' }, false, 1.5],
    [{ aspectRatio: 'adaptive', size: '1024 × 1024' }, false, 1],
    [{}, false, 1],
    [undefined, true, 16 / 9],
    [{ aspectRatio: '1:9' }, false, 0.4],
  ])('takes the requested shape %j', (input, isVideo, ratio) => {
    expect(mediaTaskAspectRatio(input, isVideo)).toBeCloseTo(ratio);
  });

  test('a running task renders a placeholder in the requested shape with its elapsed time', () => {
    const html = renderToStaticMarkup(createElement(MediaTaskCard, {
      details: { taskId: 9351, model: 'seedream', mediaType: 'image', status: MediaTaskStatus.Processing, phase: MediaTaskPhase.Generating },
      startedAt: Date.now() - 17_000,
      input: { aspectRatio: '3:4' },
    }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aspect-ratio:0.75');
    expect(html).toContain('mediaTaskProcessing');
    expect(html).toContain('0:17');
    expect(html).toContain('media-task-aurora');
  });

  test('a finished image collapses to one line; a pending download keeps the placeholder', () => {
    const saved = { taskId: 1, status: MediaTaskStatus.Succeeded, deliveryStatus: MediaDeliveryStatus.Saved };
    expect(isMediaTaskSettled(saved)).toBe(true);
    expect(renderToStaticMarkup(createElement(MediaTaskCard, { details: saved }))).not.toContain('aria-busy');
    const downloading = { ...saved, deliveryStatus: MediaDeliveryStatus.Pending };
    expect(isMediaTaskSettled(downloading)).toBe(false);
    expect(renderToStaticMarkup(createElement(MediaTaskCard, { details: downloading }))).toContain('mediaTaskFetching');
  });

  test('a failed task explains why and whether credits came back', () => {
    const html = renderToStaticMarkup(createElement(MediaTaskCard, {
      details: { taskId: 1, status: MediaTaskStatus.Failed, errorMessage: 'Prompt rejected', billingStatus: MediaBillingStatus.Refunded },
    }));
    expect(html).toContain('mediaTaskFailed');
    expect(html).toContain('Prompt rejected');
    expect(html).toContain('mediaTaskRefunded');
  });

  test('a recovered image is complete and tells the user its location changed', () => {
    const details = { taskId: 1, status: MediaTaskStatus.Succeeded, deliveryStatus: MediaDeliveryStatus.Saved,
      assets: [{ savedToRecoveryDirectory: true }] };
    expect(isMediaTaskSettled(details)).toBe(true);
    const html = renderToStaticMarkup(createElement(MediaTaskCard, { details }));
    expect(html).toContain('mediaImageSavedToRecovery');
    expect(html).not.toContain('aria-busy');
  });

  test('incomplete layers warn without reopening the settled task or claiming a refund', () => {
    const details = { taskId: 617, status: MediaTaskStatus.Succeeded, deliveryStatus: MediaDeliveryStatus.Saved,
      billingStatus: MediaBillingStatus.Settled, warnings: [MediaTaskWarning.LayerDecompositionIncomplete] };
    expect(isMediaTaskSettled(details)).toBe(true);
    const html = renderToStaticMarkup(createElement(MediaTaskCard, { details }));
    expect(html).toContain('mediaLayerDecompositionWarning');
    expect(html).toContain('text-amber-500');
    expect(html).not.toContain('mediaTaskSaved');
    expect(html).not.toContain('mediaTaskRefunded');
    expect(html).not.toContain('aria-busy');
  });
});
