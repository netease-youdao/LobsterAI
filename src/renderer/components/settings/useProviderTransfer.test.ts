import type { ChangeEvent } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { ApiFormat, ProviderName } from '../../../shared/providers';
import { ProviderTransferError, ProviderTransferErrorCode, ProviderTransferLimits, ProviderTransferMode } from '../../services/providerTransferTypes';
import type { ProvidersConfig } from './modelProviderUtils';

const harness = vi.hoisted(() => {
  let cursor = 0;
  let values: unknown[] = [];
  let cleanup: (() => void) | undefined;
  return {
    reset: () => { cursor = 0; values = []; cleanup = undefined; },
    render: () => { cursor = 0; },
    unmount: () => cleanup?.(),
    useEffect: (effect: () => () => void) => { cleanup = effect(); },
    useRef: <T,>(initial: T) => {
      const index = cursor++;
      values[index] ??= { current: initial };
      return values[index] as { current: T };
    },
    useState: <T,>(initial: T) => {
      const index = cursor++;
      if (index >= values.length) values[index] = initial;
      return [values[index] as T, (value: T) => { values[index] = value; }] as const;
    },
  };
});
const transfer = vi.hoisted(() => ({ buildProvidersExport: vi.fn(), importProviders: vi.fn(), parseProvidersImport: vi.fn() }));
vi.mock('react', () => ({ useState: harness.useState, useRef: harness.useRef, useEffect: harness.useEffect }));
vi.mock('../../services/providerTransfer', () => transfer);
vi.mock('../../services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

import { useProviderTransfer } from './useProviderTransfer';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

const createController = () => {
  const imported = vi.fn();
  const error = vi.fn();
  let providers: ProvidersConfig = { [ProviderName.OpenAI]: { enabled: true, apiKey: 'test-only', baseUrl: 'https://example.test', apiFormat: ApiFormat.OpenAI } };
  return {
    imported, error,
    changeConfiguration: () => { providers = { ...providers }; },
    render: () => {
      harness.render();
      // A deterministic hook dispatcher exercises asynchronous lifecycle boundaries.
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useProviderTransfer({ providers, onImport: imported, onError: error });
    },
  };
};

const fileEvent = (file: { size: number; text: () => Promise<string> }) => ({
  target: { files: [file], value: 'selected.json' },
}) as unknown as ChangeEvent<HTMLInputElement>;

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  transfer.parseProvidersImport.mockReturnValue({ mode: ProviderTransferMode.Encrypted, legacy: false, file: {} });
});

describe('provider transfer lifecycle', () => {
  test('opening and cancelling export never builds a credential file', async () => {
    const controller = createController();
    controller.render().openExport();
    controller.render().close();
    expect(controller.render().dialog).toBeNull();
    expect(transfer.buildProvidersExport).not.toHaveBeenCalled();
  });

  test('cancelling encryption prevents a late download', async () => {
    const encryption = deferred<string>();
    transfer.buildProvidersExport.mockReturnValue(encryption.promise);
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    try {
      const controller = createController();
      controller.render().openExport();
      const pending = controller.render().submit(true, 'a private test password');
      controller.render().close();
      encryption.resolve('{}');
      await pending;
      expect(createUrl).not.toHaveBeenCalled();
      expect(controller.render().dialog).toBeNull();
    } finally { createUrl.mockRestore(); }
  });

  test.each(['cancel', 'unmount'])('%s during decryption cannot apply late configuration', async action => {
    const decryption = deferred<ProvidersConfig>();
    transfer.importProviders.mockReturnValue(decryption.promise);
    const controller = createController();
    await controller.render().readImport(fileEvent({ size: 10, text: async () => '{}' }));
    const pending = controller.render().submit(false, 'test password');
    if (action === 'cancel') controller.render().close();
    else harness.unmount();
    decryption.resolve({});
    await pending;
    expect(controller.imported).not.toHaveBeenCalled();
  });

  test('a failed password leaves the dialog open and permits a retry, without applying configuration', async () => {
    const controller = createController();
    await controller.render().readImport(fileEvent({ size: 10, text: async () => '{}' }));
    transfer.importProviders.mockRejectedValueOnce(new ProviderTransferError(ProviderTransferErrorCode.DecryptFailed));
    await expect(controller.render().submit(false, 'wrong')).rejects.toMatchObject({ code: ProviderTransferErrorCode.DecryptFailed });
    expect(controller.render().busy).toBe(false);
    expect(controller.render().dialog).not.toBeNull();
    expect(controller.imported).not.toHaveBeenCalled();
    transfer.importProviders.mockResolvedValueOnce({});
    await controller.render().submit(false, 'correct');
    expect(controller.imported).toHaveBeenCalledExactlyOnceWith({}, false);
    expect(controller.render().dialog).toBeNull();
  });

  test('rejects an oversized file before reading it and clears the file input for retries', async () => {
    const controller = createController();
    const read = vi.fn();
    const event = fileEvent({ size: ProviderTransferLimits.FileBytes + 1, text: read });
    await controller.render().readImport(event);
    expect(event.target.value).toBe('');
    expect(read).not.toHaveBeenCalled();
    expect(controller.error).toHaveBeenLastCalledWith(ProviderTransferErrorCode.TooLarge);
    expect(controller.imported).not.toHaveBeenCalled();
  });

  test('does not overwrite configuration edited while a decryption was in flight', async () => {
    const decryption = deferred<ProvidersConfig>();
    transfer.importProviders.mockReturnValue(decryption.promise);
    const controller = createController();
    await controller.render().readImport(fileEvent({ size: 10, text: async () => '{}' }));
    const pending = controller.render().submit(false, 'test password');
    controller.changeConfiguration();
    controller.render();
    decryption.resolve({});
    await expect(pending).rejects.toMatchObject({ code: ProviderTransferErrorCode.ConfigurationChanged });
    expect(controller.imported).not.toHaveBeenCalled();
  });

  test('deduplicates repeated submits while crypto is running', async () => {
    const decryption = deferred<ProvidersConfig>();
    transfer.importProviders.mockReturnValue(decryption.promise);
    const controller = createController();
    await controller.render().readImport(fileEvent({ size: 10, text: async () => '{}' }));
    const current = controller.render();
    const pending = current.submit(false, 'test password');
    await current.submit(false, 'test password');
    expect(transfer.importProviders).toHaveBeenCalledTimes(1);
    decryption.resolve({});
    await pending;
    expect(controller.imported).toHaveBeenCalledTimes(1);
  });
});
