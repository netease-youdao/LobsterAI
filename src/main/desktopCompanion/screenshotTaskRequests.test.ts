import { describe, expect, test } from 'vitest';

import { CompanionScreenshotAction } from '../../shared/desktopCompanion/screenshot';
import { ScreenshotTaskRequests } from './screenshotTaskRequests';

const request = { id: 'first', action: CompanionScreenshotAction.ExtractText, attachment: { path: '/shot.png', name: 'shot.png', isImage: true } };
describe('screenshot task handoff', () => {
  test('a request can be claimed once while task admission remains valid', () => {
    const tasks = new ScreenshotTaskRequests(); tasks.offer(request);
    expect(tasks.consume('other')).toBeNull();
    expect(tasks.consume(request.id)).toEqual(request);
    expect(tasks.consume(request.id)).toBeNull();
    expect(tasks.isCurrent(request.id)).toBe(true);
    tasks.finish(request.id, 'session');
    expect(tasks.isCurrent(request.id)).toBe(false);
    expect(tasks.matches(request.id, 'session')).toBe(true);
    expect(tasks.matches(request.id, 'foreign')).toBe(false);
  });
  test('replacing an unclaimed request revokes it, while account reset revokes all requests', () => {
    const tasks = new ScreenshotTaskRequests(); tasks.offer(request);
    tasks.offer({ ...request, id: 'second' });
    expect(tasks.isCurrent(request.id)).toBe(false);
    tasks.consume('second'); tasks.finish('second', 'session');
    tasks.offer({ ...request, id: 'third' }); tasks.consume('third');
    tasks.reset();
    expect(tasks.pending).toBeUndefined();
    expect(tasks.isCurrent('third')).toBe(false);
    expect(tasks.matches('second', 'session')).toBe(false);
  });
});
