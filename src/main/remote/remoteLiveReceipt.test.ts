import { describe, expect, it } from 'vitest';

import { assertLiveReceipt } from './remoteLiveReceipt';

const body = Object.freeze({ publicationId: 'publication', sessionId: 'session', writerGeneration: 'writer',
  objectKind: 'message', objectId: 'message', sourceObjectRevision: '57' });
const receipt = (state = 'accepted'): Record<string, any> => ({ ...body, state, projectionRevision: '104', committedSeq: '210' });
const invalid = 'REMOTE_LIVE_RECEIPT_INVALID';

describe('live publication receipt validation', () => {
  it.each(['accepted', 'superseded'])('accepts a complete strict %s receipt without changing it', state => {
    const result = Object.freeze(receipt(state));
    expect(() => assertLiveReceipt(body, result, true)).not.toThrow();
    expect(result).toEqual(receipt(state));
  });

  it('accepts strict tool repair receipts using the original object and source identity', () => {
    const request = { ...body, objectKind: 'tool', objectId: 'call', representation: 'repair', expectedProjectionRevision: '103' };
    expect(() => assertLiveReceipt(request, { ...receipt(), objectKind: 'tool', objectId: 'call' }, true)).not.toThrow();
  });

  it.each(['accepted', 'superseded', 'rejected'])('preserves legacy minimal %s receipts when strict is omitted or false', state => {
    const result = { publicationId: body.publicationId, state };
    expect(() => assertLiveReceipt(body, result)).not.toThrow();
    expect(() => assertLiveReceipt(body, result, false)).not.toThrow();
  });

  it('accepts matching partial legacy echoes, including versions above JavaScript safe integer precision', () => {
    const result = { publicationId: body.publicationId, state: 'accepted', sessionId: body.sessionId,
      projectionRevision: '9223372036854775807', committedSeq: '9007199254740993' };
    expect(() => assertLiveReceipt(body, result, false)).not.toThrow();
  });

  it('preserves the actual strict server rejection shape without requiring absent projection fields', () => {
    const result = { publicationId: body.publicationId, sessionId: body.sessionId, writerGeneration: body.writerGeneration,
      objectId: body.objectId, state: 'rejected', reason: 'INVALID_REMOTE_REQUEST', message: 'Display rejected', committedSeq: '0' };
    expect(() => assertLiveReceipt(body, result, true)).not.toThrow();
    expect(() => assertLiveReceipt(body, { ...receipt('rejected'), projectionRevision: '0', committedSeq: '0' }, true)).not.toThrow();
  });

  it.each(['sessionId', 'writerGeneration', 'objectKind', 'objectId', 'sourceObjectRevision'])('rejects mismatched %s even for legacy receipts', field => {
    for (const strict of [false, true]) for (const state of ['accepted', 'superseded', 'rejected']) {
      expect(() => assertLiveReceipt(body, { ...receipt(state), [field]: 'different-context' }, strict)).toThrow(invalid);
      expect(() => assertLiveReceipt(body, { ...receipt(state), [field]: null }, strict)).toThrow(invalid);
      expect(() => assertLiveReceipt(body, { ...receipt(state), [field]: undefined }, strict)).toThrow(invalid);
    }
  });

  it.each(['sessionId', 'writerGeneration', 'objectKind', 'objectId', 'sourceObjectRevision', 'projectionRevision', 'committedSeq'])('requires strict successful receipt field %s', field => {
    for (const state of ['accepted', 'superseded']) {
      const result = receipt(state); delete result[field];
      expect(() => assertLiveReceipt(body, result, true)).toThrow(invalid);
      expect(() => assertLiveReceipt(body, result, false)).not.toThrow();
    }
  });

  it.each(['sessionId', 'writerGeneration', 'objectId', 'committedSeq'])('requires strict rejected receipt field %s', field => {
    const result = receipt('rejected'); delete result[field];
    expect(() => assertLiveReceipt(body, result, true)).toThrow(invalid);
  });

  it.each([null, undefined, 1, -1, '', '-1', '+1', '1.5', '1e3', ' 1', '1 ', '9223372036854775808', '1'.repeat(1000)])('rejects malformed supplied version %s in both modes', value => {
    for (const strict of [false, true]) for (const state of ['accepted', 'superseded', 'rejected']) {
      expect(() => assertLiveReceipt(body, { ...receipt(state), projectionRevision: value }, strict)).toThrow(invalid);
      expect(() => assertLiveReceipt(body, { ...receipt(state), committedSeq: value }, strict)).toThrow(invalid);
    }
  });

  it.each(['accepted', 'superseded'])('requires a positive projection revision for %s while allowing committedSeq zero', state => {
    for (const strict of [false, true]) {
      expect(() => assertLiveReceipt(body, { ...receipt(state), projectionRevision: '0' }, strict)).toThrow(invalid);
      expect(() => assertLiveReceipt(body, { ...receipt(state), projectionRevision: '000' }, strict)).toThrow(invalid);
      expect(() => assertLiveReceipt(body, { ...receipt(state), committedSeq: '0' }, strict)).not.toThrow();
    }
  });

  it('always rejects absent/mismatched publication identity, unknown states and non-object receipts with a fixed error', () => {
    for (const result of [null, undefined, [], 'accepted', 1, {}, { state: 'accepted' },
      { publicationId: 'other', state: 'accepted' }, { publicationId: body.publicationId, state: 'retryable' },
      { publicationId: body.publicationId, state: 'accepted-private-value' }]) {
      for (const strict of [false, true]) expect(() => assertLiveReceipt(body, result, strict)).toThrow(new Error(invalid));
    }
  });

  it('does not treat inherited fields as a complete strict receipt', () => {
    const result = Object.assign(Object.create({ sessionId: body.sessionId }), receipt());
    delete result.sessionId;
    expect(() => assertLiveReceipt(body, result, true)).toThrow(invalid);
  });

  it('rejects invalid source revision types even when both request and response contain the same value', () => {
    for (const value of [0, '0', '-1', 'not-a-version', null])
      expect(() => assertLiveReceipt({ ...body, sourceObjectRevision: value }, { ...receipt(), sourceObjectRevision: value }, true)).toThrow(invalid);
  });
});
