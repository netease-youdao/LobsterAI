import { describe, expect, test, vi } from 'vitest';

import { createMermaidRenderId, executeMermaidRender } from './mermaidRenderTask';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createRenderContainer() {
  return {
    remove: vi.fn(),
  };
}

describe('mermaid render task', () => {
  test('creates a unique render id for each invocation', () => {
    const first = createMermaidRenderId('artifact-same-id');
    const second = createMermaidRenderId('artifact-same-id');

    expect(first).toMatch(/^mermaid-artifactsameid-[0-9a-f-]+$/);
    expect(second).toMatch(/^mermaid-artifactsameid-[0-9a-f-]+$/);
    expect(second).not.toBe(first);
  });

  test('does not render a task cancelled before its scheduled start', async () => {
    const controller = new AbortController();
    const createContainer = vi.fn(createRenderContainer);
    const render = vi.fn(async () => ({ svg: '<svg />' }));
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const task = executeMermaidRender({
      artifactId: 'artifact-1',
      content: 'graph TD; A-->B',
      signal: controller.signal,
      createContainer,
      render,
      onSuccess,
      onError,
    });

    controller.abort();
    await task;

    expect(createContainer).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  test('keeps overlapping render containers isolated', async () => {
    const firstRender = createDeferred<{ svg: string }>();
    const secondRender = createDeferred<{ svg: string }>();
    const firstRenderStarted = createDeferred<void>();
    const secondRenderStarted = createDeferred<void>();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstContainer = createRenderContainer();
    const secondContainer = createRenderContainer();
    const renderIds: string[] = [];
    const firstSuccess = vi.fn();
    const secondSuccess = vi.fn();

    const firstTask = executeMermaidRender({
      artifactId: 'artifact-same-id',
      content: 'graph TD; A-->B',
      signal: firstController.signal,
      createContainer: () => firstContainer,
      render: (id, _content, container) => {
        renderIds.push(id);
        expect(container).toBe(firstContainer);
        firstRenderStarted.resolve();
        return firstRender.promise;
      },
      onSuccess: firstSuccess,
      onError: vi.fn(),
    });
    await firstRenderStarted.promise;

    firstController.abort();
    const secondTask = executeMermaidRender({
      artifactId: 'artifact-same-id',
      content: 'graph TD; A-->C',
      signal: secondController.signal,
      createContainer: () => secondContainer,
      render: (id, _content, container) => {
        renderIds.push(id);
        expect(container).toBe(secondContainer);
        secondRenderStarted.resolve();
        return secondRender.promise;
      },
      onSuccess: secondSuccess,
      onError: vi.fn(),
    });
    await secondRenderStarted.promise;

    expect(firstContainer.remove).not.toHaveBeenCalled();
    expect(secondContainer.remove).not.toHaveBeenCalled();
    expect(renderIds[0]).not.toBe(renderIds[1]);

    firstRender.resolve({ svg: '<svg id="first" />' });
    await firstTask;

    expect(firstContainer.remove).toHaveBeenCalledTimes(1);
    expect(secondContainer.remove).not.toHaveBeenCalled();
    expect(firstSuccess).not.toHaveBeenCalled();

    secondRender.resolve({ svg: '<svg id="second" />' });
    await secondTask;

    expect(secondContainer.remove).toHaveBeenCalledTimes(1);
    expect(secondSuccess).toHaveBeenCalledWith('<svg id="second" />');
  });

  test('removes its own container and reports a render error', async () => {
    const controller = new AbortController();
    const container = createRenderContainer();
    const failure = new Error('render failed');
    const onSuccess = vi.fn();
    const onError = vi.fn();

    await executeMermaidRender({
      artifactId: 'artifact-1',
      content: 'graph TD; A-->B',
      signal: controller.signal,
      createContainer: () => container,
      render: async () => {
        throw failure;
      },
      onSuccess,
      onError,
    });

    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  test('suppresses errors from a cancelled render after cleaning its container', async () => {
    const renderResult = createDeferred<{ svg: string }>();
    const renderStarted = createDeferred<void>();
    const controller = new AbortController();
    const container = createRenderContainer();
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const task = executeMermaidRender({
      artifactId: 'artifact-1',
      content: 'graph TD; A-->B',
      signal: controller.signal,
      createContainer: () => container,
      render: () => {
        renderStarted.resolve();
        return renderResult.promise;
      },
      onSuccess,
      onError,
    });
    await renderStarted.promise;

    controller.abort();
    renderResult.reject(new Error('stale render failed'));
    await task;

    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
