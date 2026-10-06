import { expect, test } from 'vitest';

import {
  beginLatestAsyncRequest,
  invalidateLatestAsyncRequest,
  isLatestAsyncRequest,
} from './latestAsyncRequest';

const createDeferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(next => {
    resolve = next;
  });
  return { promise, resolve };
};

test('a timed-out older response cannot overwrite a newer startup gate response', async () => {
  const gate = { current: 0 };
  const older = createDeferred<string>();
  const newer = createDeferred<string>();
  let committed = '';
  const run = async (promise: Promise<string>) => {
    const requestId = beginLatestAsyncRequest(gate);
    const value = await promise;
    if (isLatestAsyncRequest(gate, requestId)) {
      committed = value;
    }
  };

  const olderRun = run(older.promise);
  const newerRun = run(newer.promise);
  newer.resolve('strict-new-policy');
  await newerRun;
  older.resolve('stale-old-policy');
  await olderRun;

  expect(committed).toBe('strict-new-policy');
});

test('a user action invalidates a pending startup gate read', async () => {
  const gate = { current: 0 };
  const pending = createDeferred<boolean>();
  let committed = true;
  const requestId = beginLatestAsyncRequest(gate);
  const read = pending.promise.then(value => {
    if (isLatestAsyncRequest(gate, requestId)) {
      committed = value;
    }
  });

  invalidateLatestAsyncRequest(gate);
  pending.resolve(false);
  await read;

  expect(committed).toBe(true);
});
