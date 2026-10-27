import React, { type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '../../services/i18n';
import { store } from '../../store';
import { setLoggedIn, setLoggedOut } from '../../store/slices/authSlice';
import Modal from '../common/Modal';
import AgentTaskDeleteDialog from './AgentTaskDeleteDialog';

// Exercise the real component callbacks and effect cleanup without adding a DOM dependency.
const hooks = vi.hoisted(() => {
  type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
  let stateCursor = 0, refCursor = 0, effectCursor = 0;
  let states: unknown[] = [], refs: Array<{ current: unknown }> = [], effects: Effect[] = [];
  let pendingEffects: Array<() => void> = [];
  let mounted = true;
  return {
    reset: () => { states = []; refs = []; effects = []; pendingEffects = []; mounted = true; },
    begin: () => { stateCursor = 0; refCursor = 0; effectCursor = 0; },
    flushEffects: () => { const pending = pendingEffects; pendingEffects = []; pending.forEach(effect => effect()); },
    unmount: () => { mounted = false; effects.forEach(effect => effect.cleanup?.()); },
    useState: <T,>(initial: T) => {
      const index = stateCursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index] as T, (value: T) => { if (mounted) states[index] = value; }] as const;
    },
    useRef: <T,>(initial: T) => {
      const index = refCursor++;
      refs[index] ??= { current: initial };
      return refs[index] as { current: T };
    },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = effectCursor++, previous = effects[index];
      if (previous?.deps && deps && previous.deps.length === deps.length
        && previous.deps.every((value, offset) => Object.is(value, deps[offset]))) return;
      effects[index] = { deps };
      pendingEffects.push(() => { previous?.cleanup?.(); effects[index].cleanup = effect() || undefined; });
    },
  };
});
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect };
});

const onDelete = vi.fn<() => Promise<void>>(), onClose = vi.fn(), onSubmit = vi.fn(), onCancel = vi.fn();
let tree: ReactNode;
const render = () => {
  hooks.begin(); tree = AgentTaskDeleteDialog({ onDelete, onClose, onSubmit, onCancel }); hooks.flushEffects();
};
const elements = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...elements(node.props.children)];
};
const button = (label: string) => {
  const element = elements(tree).find(node => node.type === 'button' && node.props.children === i18nService.t(label));
  if (!element) throw new Error(`Button missing: ${label}`);
  return element.props as React.ButtonHTMLAttributes<HTMLButtonElement>;
};
const click = (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => props.onClick?.({} as React.MouseEvent<HTMLButtonElement>);
const alert = () => elements(tree).find(node => node.props.role === 'alert')?.props.children;
const deferred = () => {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let index = 0; index < 4; index++) await Promise.resolve(); render(); };
const signIn = (owner = 'delete-owner') => store.dispatch(setLoggedIn({
  user: { yid: owner, nickname: 'Test', avatarUrl: null }, quota: null, ownerAccountKey: owner,
}));

beforeEach(() => { hooks.reset(); vi.clearAllMocks(); signIn(); onDelete.mockResolvedValue(); });
afterEach(() => { hooks.unmount(); vi.restoreAllMocks(); });

test('waits for deletion, rejects duplicate clicks and backdrop dismissal, and closes only after success', async () => {
  const request = deferred(); onDelete.mockReturnValue(request.promise); render();
  const confirm = button('deleteSession');
  click(confirm); click(confirm); render();
  expect(onDelete).toHaveBeenCalledOnce(); expect(onSubmit).toHaveBeenCalledOnce();
  expect(onClose).not.toHaveBeenCalled(); expect(button('deletingTask').disabled).toBe(true);
  expect(button('cancel').disabled).toBe(true);
  click(button('cancel'));
  const modal = elements(tree).find(node => node.type === Modal)!;
  (modal.props.onClose as () => void)(); (modal.props.onEscape as () => void)();
  expect(onClose).not.toHaveBeenCalled(); expect(onCancel).not.toHaveBeenCalled();
  request.resolve(); await settle();
  expect(onClose).toHaveBeenCalledOnce();
});

test('keeps the dialog open with the concrete failure and allows retry', async () => {
  const request = deferred(); onDelete.mockReturnValueOnce(request.promise); render();
  click(button('deleteSession'));
  request.reject(new Error('The task has not been confirmed stopped.'));
  await settle();
  expect(onClose).not.toHaveBeenCalled();
  expect(alert()).toBe('The task has not been confirmed stopped.');
  expect(button('deleteSession').disabled).toBe(false); expect(button('cancel').disabled).toBe(false);
  const retry = deferred(); onDelete.mockReturnValueOnce(retry.promise);
  click(button('deleteSession')); render();
  expect(alert()).toBeUndefined(); expect(onDelete).toHaveBeenCalledTimes(2);
  retry.resolve(); await settle(); expect(onClose).toHaveBeenCalledOnce();
});

test('uses a localized fallback for an unstructured rejection and permits dismissal after failure', async () => {
  onDelete.mockRejectedValueOnce(undefined); render(); click(button('deleteSession')); await settle();
  expect(alert()).toBe(i18nService.t('deleteTaskFailed'));
  click(button('cancel'));
  expect(onCancel).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
});

test.each(['account', 'ABA', 'unmount'] as const)('does not show a stale failure after %s', async mode => {
  const request = deferred(); onDelete.mockReturnValueOnce(request.promise); render();
  const oldConfirm = button('deleteSession'); click(oldConfirm);
  if (mode === 'unmount') hooks.unmount();
  else if (mode === 'account') signIn('another-owner');
  else { store.dispatch(setLoggedOut()); signIn(); }
  const closes = onClose.mock.calls.length;
  expect(closes).toBe(mode === 'unmount' ? 0 : 1);
  click(oldConfirm);
  request.reject(new Error('Private old account error'));
  await settle();
  expect(alert()).toBeUndefined(); expect(onDelete).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledTimes(closes);
});

test('an account change invalidates a confirmation before any deletion is dispatched', () => {
  render(); const oldConfirm = button('deleteSession'); signIn('another-owner'); click(oldConfirm);
  expect(onClose).toHaveBeenCalledOnce(); expect(onDelete).not.toHaveBeenCalled();
});
