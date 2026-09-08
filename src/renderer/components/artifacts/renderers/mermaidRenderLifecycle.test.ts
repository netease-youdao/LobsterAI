import { describe, expect, test, vi } from 'vitest';

import { startMermaidRender } from './mermaidRenderLifecycle';

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createFixture = () => {
  const remove = vi.fn();
  const container = { remove } as unknown as HTMLDivElement;
  return {
    source: 'flowchart TB\nA --> B',
    api: {
      parse: vi.fn<(source: string) => Promise<unknown>>().mockResolvedValue(undefined),
      render: vi.fn<(id: string, source: string, element: HTMLDivElement) => Promise<{ svg: string }>>()
        .mockResolvedValue({ svg: '<svg>diagram</svg>' }),
    },
    createContainer: vi.fn(() => container),
    onSuccess: vi.fn(),
    onError: vi.fn(),
    container,
    remove,
  };
};

const deferRendering = (fixture: ReturnType<typeof createFixture>) => {
  const started = createDeferred<void>();
  const result = createDeferred<{ svg: string }>();
  fixture.api.render.mockImplementation(() => {
    started.resolve(undefined);
    return result.promise;
  });
  return { started: started.promise, result };
};

describe('startMermaidRender', () => {
  test('parses and renders in its own container, then publishes the result and cleans up', async () => {
    const fixture = createFixture();
    const task = startMermaidRender(fixture);

    await expect(task.done).resolves.toBeUndefined();

    expect(fixture.api.parse).toHaveBeenCalledExactlyOnceWith(fixture.source);
    expect(fixture.createContainer).toHaveBeenCalledTimes(1);
    expect(fixture.api.render).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^mermaid-[a-zA-Z0-9-]+$/),
      fixture.source,
      fixture.container,
    );
    expect(fixture.onSuccess).toHaveBeenCalledExactlyOnceWith('<svg>diagram</svg>');
    expect(fixture.onError).not.toHaveBeenCalled();
    expect(fixture.remove).toHaveBeenCalledTimes(1);
    task.cancel();
    task.cancel();
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });

  test('does not create a container or render when canceled during parsing', async () => {
    const fixture = createFixture();
    const parsing = createDeferred<unknown>();
    fixture.api.parse.mockReturnValue(parsing.promise);
    const task = startMermaidRender(fixture);

    task.cancel();
    parsing.resolve(undefined);
    await task.done;

    expect(fixture.createContainer).not.toHaveBeenCalled();
    expect(fixture.api.render).not.toHaveBeenCalled();
    expect(fixture.onSuccess).not.toHaveBeenCalled();
    expect(fixture.onError).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  test('supports a StrictMode-style canceled setup followed by a fresh setup for the same source', async () => {
    const oldFixture = createFixture();
    const newFixture = createFixture();
    const oldParsing = createDeferred<unknown>();
    oldFixture.api.parse.mockReturnValue(oldParsing.promise);
    const oldTask = startMermaidRender(oldFixture);

    oldTask.cancel();
    const newTask = startMermaidRender(newFixture);
    await newTask.done;
    oldParsing.resolve(undefined);
    await oldTask.done;

    expect(oldFixture.api.render).not.toHaveBeenCalled();
    expect(oldFixture.onSuccess).not.toHaveBeenCalled();
    expect(oldFixture.onError).not.toHaveBeenCalled();
    expect(newFixture.api.render).toHaveBeenCalledTimes(1);
    expect(newFixture.onSuccess).toHaveBeenCalledExactlyOnceWith('<svg>diagram</svg>');
    expect(newFixture.onError).not.toHaveBeenCalled();
    expect(newFixture.remove).toHaveBeenCalledTimes(1);
  });

  test('does not remove an in-flight render container when canceled', async () => {
    const fixture = createFixture();
    const rendering = deferRendering(fixture);
    const task = startMermaidRender(fixture);
    await rendering.started;

    task.cancel();
    task.cancel();
    expect(fixture.remove).not.toHaveBeenCalled();
    rendering.result.resolve({ svg: '<svg>stale</svg>' });
    await task.done;

    expect(fixture.onSuccess).not.toHaveBeenCalled();
    expect(fixture.onError).not.toHaveBeenCalled();
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });

  test('uses distinct safe DOM ids for consecutive renders of identical content', async () => {
    const fixtures = Array.from({ length: 5 }, () => createFixture());
    for (const fixture of fixtures) {
      await startMermaidRender(fixture).done;
    }
    const ids = fixtures.map(fixture => fixture.api.render.mock.calls[0][0]);

    expect(new Set(ids).size).toBe(fixtures.length);
    for (const id of ids) expect(id).toMatch(/^mermaid-[a-zA-Z0-9-]+$/);
  });

  test('finishing an old render never removes a newer task container or publishes its old result', async () => {
    const oldFixture = createFixture();
    const newFixture = createFixture();
    const oldRendering = deferRendering(oldFixture);
    const newRendering = deferRendering(newFixture);
    const oldTask = startMermaidRender(oldFixture);
    await oldRendering.started;
    oldTask.cancel();
    const newTask = startMermaidRender(newFixture);
    await newRendering.started;

    const oldId = oldFixture.api.render.mock.calls[0][0];
    const newId = newFixture.api.render.mock.calls[0][0];
    expect(oldId).not.toBe(newId);
    oldRendering.result.resolve({ svg: '<svg>old</svg>' });
    await oldTask.done;

    expect(oldFixture.remove).toHaveBeenCalledTimes(1);
    expect(oldFixture.onSuccess).not.toHaveBeenCalled();
    expect(newFixture.remove).not.toHaveBeenCalled();
    expect(newFixture.onSuccess).not.toHaveBeenCalled();
    newRendering.result.resolve({ svg: '<svg>new</svg>' });
    await newTask.done;
    expect(newFixture.onSuccess).toHaveBeenCalledExactlyOnceWith('<svg>new</svg>');
    expect(newFixture.remove).toHaveBeenCalledTimes(1);
  });

  test('keeps multiple noncanceled task results and cleanup isolated', async () => {
    const firstFixture = createFixture();
    const secondFixture = createFixture();
    const firstRendering = deferRendering(firstFixture);
    const secondRendering = deferRendering(secondFixture);
    const firstTask = startMermaidRender(firstFixture);
    const secondTask = startMermaidRender(secondFixture);
    await Promise.all([firstRendering.started, secondRendering.started]);

    secondRendering.result.resolve({ svg: '<svg>second</svg>' });
    await secondTask.done;
    expect(secondFixture.onSuccess).toHaveBeenCalledExactlyOnceWith('<svg>second</svg>');
    expect(secondFixture.remove).toHaveBeenCalledTimes(1);
    expect(firstFixture.remove).not.toHaveBeenCalled();
    expect(firstFixture.onSuccess).not.toHaveBeenCalled();

    firstRendering.result.resolve({ svg: '<svg>first</svg>' });
    await firstTask.done;
    expect(firstFixture.onSuccess).toHaveBeenCalledExactlyOnceWith('<svg>first</svg>');
    expect(firstFixture.remove).toHaveBeenCalledTimes(1);
  });

  test('suppresses a canceled parse rejection without leaking an unhandled rejection', async () => {
    const fixture = createFixture();
    const parsing = createDeferred<unknown>();
    fixture.api.parse.mockReturnValue(parsing.promise);
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const task = startMermaidRender(fixture);
      task.cancel();
      parsing.reject(new Error('Old parse failed'));
      await expect(task.done).resolves.toBeUndefined();
      await new Promise<void>(resolve => setImmediate(resolve));

      expect(fixture.onError).not.toHaveBeenCalled();
      expect(fixture.onSuccess).not.toHaveBeenCalled();
      expect(fixture.createContainer).not.toHaveBeenCalled();
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('suppresses a canceled render rejection but still cleans up its own container', async () => {
    const fixture = createFixture();
    const rendering = deferRendering(fixture);
    const task = startMermaidRender(fixture);
    await rendering.started;
    task.cancel();
    rendering.result.reject(new Error('Old render failed'));

    await expect(task.done).resolves.toBeUndefined();
    expect(fixture.onSuccess).not.toHaveBeenCalled();
    expect(fixture.onError).not.toHaveBeenCalled();
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });

  test('reports an active parse rejection without creating a render container', async () => {
    const fixture = createFixture();
    const error = new Error('Invalid diagram syntax');
    fixture.api.parse.mockRejectedValue(error);

    await expect(startMermaidRender(fixture).done).resolves.toBeUndefined();

    expect(fixture.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(fixture.onSuccess).not.toHaveBeenCalled();
    expect(fixture.createContainer).not.toHaveBeenCalled();
    expect(fixture.api.render).not.toHaveBeenCalled();
  });

  test('reports an active render rejection and cleans up the container', async () => {
    const fixture = createFixture();
    const error = new Error('Diagram layout failed');
    fixture.api.render.mockRejectedValue(error);

    await expect(startMermaidRender(fixture).done).resolves.toBeUndefined();

    expect(fixture.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(fixture.onSuccess).not.toHaveBeenCalled();
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });

  test('reports synchronous parse exceptions through the same error callback', async () => {
    const fixture = createFixture();
    const error = new Error('Parser initialization failed');
    fixture.api.parse.mockImplementation(() => { throw error; });

    await expect(startMermaidRender(fixture).done).resolves.toBeUndefined();

    expect(fixture.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(fixture.onSuccess).not.toHaveBeenCalled();
    expect(fixture.createContainer).not.toHaveBeenCalled();
  });

  test('reports container creation exceptions without calling render', async () => {
    const fixture = createFixture();
    const error = new Error('Cannot create render container');
    fixture.createContainer.mockImplementation(() => { throw error; });

    await expect(startMermaidRender(fixture).done).resolves.toBeUndefined();

    expect(fixture.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(fixture.onSuccess).not.toHaveBeenCalled();
    expect(fixture.api.render).not.toHaveBeenCalled();
    expect(fixture.remove).not.toHaveBeenCalled();
  });

  test('reports synchronous render exceptions and removes the allocated container', async () => {
    const fixture = createFixture();
    const error = new Error('Renderer initialization failed');
    fixture.api.render.mockImplementation(() => { throw error; });

    await expect(startMermaidRender(fixture).done).resolves.toBeUndefined();

    expect(fixture.onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(fixture.onSuccess).not.toHaveBeenCalled();
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });
});
