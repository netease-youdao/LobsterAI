import { expect, test, vi } from 'vitest';

import { parseStoredMessageMetadata } from './storedMessageMetadata';

test.each([undefined, null, ''])('returns undefined without reporting absent metadata: %j', (metadata) => {
  const onCorrupt = vi.fn();

  expect(parseStoredMessageMetadata(metadata, onCorrupt)).toBeUndefined();
  expect(onCorrupt).not.toHaveBeenCalled();
});

test.each([
  { json: '{}', value: {} },
  { json: '{"nested":{"keep":true},"futureField":[1,null]}', value: { nested: { keep: true }, futureField: [1, null] } },
  { json: 'null', value: null },
  { json: '[]', value: [] },
  { json: '"legacy"', value: 'legacy' },
  { json: '42', value: 42 },
  { json: 'false', value: false },
])('preserves valid stored JSON without schema normalization: $json', ({ json, value }) => {
  const onCorrupt = vi.fn();

  expect(parseStoredMessageMetadata(json, onCorrupt)).toEqual(value);
  expect(onCorrupt).not.toHaveBeenCalled();
});

test.each(['{broken', '{"toolName":', '  ', 'undefined'])('discards corrupt metadata and reports once: %j', (metadata) => {
  const onCorrupt = vi.fn();

  expect(parseStoredMessageMetadata(metadata, onCorrupt)).toBeUndefined();
  expect(onCorrupt).toHaveBeenCalledExactlyOnceWith();
});
