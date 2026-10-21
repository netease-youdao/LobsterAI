import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CoworkSessionsChangedPayload } from '../../../shared/cowork/constants';
import type { RootState } from '../../store';
import type { CoworkSessionSummary } from '../../types/cowork';
import { useAgentSidebarState } from './useAgentSidebarState';

// The repository has no DOM/test-renderer dependency. Exercise the production
// hook with deterministic React scheduling, including effect cleanup and deps.
const hooks = vi.hoisted(() => {
  type Effect = { deps?: readonly unknown[]; cleanup?: () => void };
  let stateCursor = 0, refCursor = 0, memoCursor = 0, effectCursor = 0;
  let states: Array<{ value: unknown; set: (value: unknown) => void }> = [];
  let refs: Array<{ current: unknown }> = [];
  let memos: Array<{ value: unknown; deps?: readonly unknown[] }> = [];
  let effects: Effect[] = [];
  let pendingEffects: Array<() => void> = [];
  let mounted = true, dirty = false;
  const sameDeps = (left?: readonly unknown[], right?: readonly unknown[]) => (
    !!left && !!right && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]))
  );
  const memo = <T,>(factory: () => T, deps?: readonly unknown[]): T => {
    const index = memoCursor++;
    if (!memos[index] || !sameDeps(memos[index].deps, deps)) {
      memos[index] = { value: factory(), deps };
    }
    return memos[index].value as T;
  };
  return {
    reset: () => {
      states = []; refs = []; memos = []; effects = []; pendingEffects = [];
      mounted = true; dirty = false;
    },
    begin: () => {
      stateCursor = 0; refCursor = 0; memoCursor = 0; effectCursor = 0; dirty = false;
    },
    effects: () => {
      const pending = pendingEffects; pendingEffects = [];
      pending.forEach(effect => effect());
      return dirty;
    },
    unmount: () => {
      if (!mounted) return;
      mounted = false; effects.forEach(effect => effect.cleanup?.());
    },
    useState: <T,>(initial: T | (() => T)) => {
      const index = stateCursor++;
      if (!states[index]) {
        states[index] = {
          value: typeof initial === 'function' ? (initial as () => T)() : initial,
          set: (next: unknown) => {
            if (!mounted) return;
            const previous = states[index].value;
            const value = typeof next === 'function' ? next(previous) : next;
            if (!Object.is(value, previous)) { states[index].value = value; dirty = true; }
          },
        };
      }
      return [states[index].value as T, states[index].set] as const;
    },
    useRef: <T,>(initial: T) => {
      const index = refCursor++;
      refs[index] ??= { current: initial };
      return refs[index] as { current: T };
    },
    useMemo: memo,
    useCallback: <T,>(callback: T, deps?: readonly unknown[]) => memo(() => callback, deps),
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const index = effectCursor++;
      const previous = effects[index];
      if (previous && sameDeps(previous.deps, deps)) return;
      effects[index] = { deps };
      pendingEffects.push(() => {
        previous?.cleanup?.();
        effects[index].cleanup = effect() || undefined;
      });
    },
  };
});

const environment = vi.hoisted(() => ({
  state: {} as RootState,
  dispatch: vi.fn(),
  list: vi.fn(),
  getPreference: vi.fn(),
  setPreference: vi.fn(),
}));

vi.mock('react', () => ({
  useState: hooks.useState, useRef: hooks.useRef, useMemo: hooks.useMemo,
  useCallback: hooks.useCallback, useEffect: hooks.useEffect,
}));
vi.mock('react-redux', () => ({
  useDispatch: () => environment.dispatch,
  useSelector: (selector: (state: RootState) => unknown) => selector(environment.state),
}));
vi.mock('../../services/cowork', () => ({
  coworkService: { listSessionsForAgentPreview: environment.list },
}));
vi.mock('../../services/store', () => ({
  localStore: { getItem: environment.getPreference, setItem: environment.setPreference },
}));

type PreviewResult = { success: boolean; sessions: CoworkSessionSummary[]; hasMore: boolean };
type Controller = ReturnType<typeof useAgentSidebarState>;
let controller: Controller;
const listeners = new Set<(payload?: CoworkSessionsChangedPayload) => void>();
const unsubscribed = vi.fn();
const task = (id: string, agentId = 'main'): CoworkSessionSummary => ({
  id, agentId, title: id, scheduledTaskId: null, status: 'completed', pinned: false, pinOrder: null,
  createdAt: 1, updatedAt: 1,
});
const page = (sessions: CoworkSessionSummary[], hasMore = false): PreviewResult => ({ success: true, sessions, hasMore });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
const render = () => {
  for (let count = 0; count < 20; count++) {
    hooks.begin();
    // Deliberate invocation through the deterministic React dispatcher above.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    controller = useAgentSidebarState({ includeActivityTasks: true });
    if (!hooks.effects()) return;
  }
  throw new Error('Hook render did not settle');
};
const settle = async () => {
  for (let count = 0; count < 8; count++) { await Promise.resolve(); render(); }
};
const emit = (payload?: CoworkSessionsChangedPayload) => listeners.forEach(listener => listener(payload));
const visible = (agentId = 'main') => controller.agentNodes.find(agent => agent.id === agentId)?.tasks.map(item => item.id);
const activity = () => controller.activityAgentNodes.flatMap(agent => agent.tasks.map(item => item.id));

beforeEach(() => {
  hooks.reset(); listeners.clear(); vi.clearAllMocks();
  environment.getPreference.mockResolvedValue(null);
  environment.setPreference.mockResolvedValue(undefined);
  environment.list.mockResolvedValue(page([]));
  environment.state = {
    agent: {
      agents: ['main', 'other'].map(id => ({ id, name: id, icon: '', enabled: true })),
      currentAgentId: 'main', sidebarRevealAgentId: null,
    },
    cowork: {
      sessions: [], currentSessionId: null, currentSession: null,
      completedUnreadSessionIds: [], pendingPermissions: [],
    },
  } as unknown as RootState;
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  vi.stubGlobal('window', {
    electron: {
      cowork: {
        onSessionsChanged: (listener: (payload?: CoworkSessionsChangedPayload) => void) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); unsubscribed(); };
        },
      },
    },
  });
});

afterEach(() => {
  hooks.unmount(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

test('remote deletion removes a preview that was never loaded into the current Agent Redux list', async () => {
  environment.list.mockImplementation(async (agentId: string) => page([task(`${agentId}-task`, agentId)]));
  render(); await settle();
  expect(environment.state.cowork.sessions).toEqual([]);
  expect(visible('other')).toEqual(['other-task']);
  emit({ sessionIds: ['other-task'], deletedSessionIds: ['other-task'] });
  await settle();
  expect(visible('other')).toEqual([]);
  expect(visible()).toEqual(['main-task']);
});

test('batch deletion removes previews and activity entries across Agents, and repeating it is harmless', async () => {
  environment.list.mockImplementation(async (agentId: string) => page([
    task(`${agentId}-delete`, agentId), task(`${agentId}-keep`, agentId),
  ]));
  render(); await settle();
  const payload = { sessionIds: ['main-delete', 'other-delete'], deletedSessionIds: ['main-delete', 'other-delete'] };
  emit(payload); emit(payload); await settle();
  expect(visible()).toEqual(['main-keep']);
  expect(visible('other')).toEqual(['other-keep']);
  expect(activity().sort()).toEqual(['main-keep', 'other-keep']);
});

test('an initial preview response captured before deletion cannot restore the task', async () => {
  const loading = deferred<PreviewResult>();
  environment.list.mockImplementation((agentId: string) => agentId === 'main' ? loading.promise : Promise.resolve(page([])));
  render();
  emit({ sessionIds: ['deleted-before-first-page'], deletedSessionIds: ['deleted-before-first-page'] });
  loading.resolve(page([task('deleted-before-first-page'), task('survivor')]));
  await settle();
  expect(visible()).toEqual(['survivor']);
});

test('a late load-more response keeps unaffected tasks without resurrecting deleted IDs', async () => {
  const loading = deferred<PreviewResult>();
  const initial = Array.from({ length: 6 }, (_, index) => task(`initial-${index}`));
  environment.list.mockImplementation((agentId: string, _limit: number, offset: number) => {
    if (agentId !== 'main') return Promise.resolve(page([]));
    return offset === 0 ? Promise.resolve(page(initial, true)) : loading.promise;
  });
  render(); await settle();
  const pending = controller.loadMoreTasks('main');
  emit({ sessionIds: ['initial-0', 'late-deleted'], deletedSessionIds: ['initial-0', 'late-deleted'] });
  render();
  loading.resolve(page([task('late-deleted'), task('late-survivor')], true));
  await pending; await settle();
  expect(activity()).not.toContain('initial-0');
  expect(activity()).not.toContain('late-deleted');
  expect(activity()).toContain('late-survivor');
  expect(environment.list).toHaveBeenCalledWith('main', expect.any(Number), 6);
});

test('stale Redux summaries cannot reinsert a deleted preview while new summaries still merge', async () => {
  environment.list.mockImplementation(async (agentId: string) => page(agentId === 'main' ? [task('deleted')] : []));
  render(); await settle();
  emit({ sessionIds: ['deleted'], deletedSessionIds: ['deleted'] }); await settle();
  environment.state.cowork.sessions = [task('deleted'), task('new-task')];
  render(); await settle();
  expect(visible()).toEqual(['new-task']);
});

test('ordinary change notices and absent Redux entries are not evidence of deletion', async () => {
  environment.list.mockImplementation(async (agentId: string) => page([task(`${agentId}-task`, agentId)]));
  render(); await settle();
  emit({ sessionIds: ['other-task'] }); emit(undefined);
  environment.state.cowork.sessions = [task('main-task')];
  render(); await settle();
  expect(visible('other')).toEqual(['other-task']);
});

test('explicit desktop removal also survives later refresh and permits new tasks', async () => {
  environment.list.mockImplementation(async (agentId: string) => page(agentId === 'main' ? [task('removed'), task('kept')] : []));
  render(); await settle();
  controller.removeTaskPreview('removed'); await settle();
  environment.list.mockResolvedValue(page([task('removed'), task('kept'), task('new')]));
  await controller.retryLoadTasks('main'); await settle();
  expect(visible()).toEqual(['kept', 'new']);
});

test('unmount detaches the deletion listener', async () => {
  render(); await settle();
  expect(listeners.size).toBe(1);
  hooks.unmount();
  expect(listeners.size).toBe(0);
  expect(unsubscribed).toHaveBeenCalledTimes(1);
});
