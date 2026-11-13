import { createHash } from 'node:crypto';

import { SettingsRuntime, SettingsWriterCoordinator, type ToolIdentity } from './coordinator';

interface SharedSettingsState {
  scope: string;
  coordinator: SettingsWriterCoordinator;
  calls: Map<string, ToolIdentity>;
  untrackedWriter: boolean;
}
const stateKey = Symbol.for(SettingsRuntime.SharedState);
interface SharedSettingsRuntime { current: SharedSettingsState; retiring: SharedSettingsState | null }
const runtime = globalThis as unknown as Record<symbol, SharedSettingsRuntime | undefined>;
const idle = (state: SharedSettingsState): boolean => !state.untrackedWriter && state.coordinator.idle();

/** Gateway activation and per-workspace discovery can load separate copies of this module. */
export function settingsRuntimeState(callbackUrl: string, secret: string, activate: boolean): SharedSettingsState | null {
  const scope = createHash('sha256').update(JSON.stringify([callbackUrl, secret])).digest('hex');
  const holder = runtime[stateKey];
  if (holder?.current.scope === scope) return holder.current;
  // Discovery cannot initialize authority or revive an old configuration after a secret rotation.
  if (!activate) return null;
  const state = { scope, coordinator: new SettingsWriterCoordinator(), calls: new Map<string, ToolIdentity>(), untrackedWriter: false };
  // Keep at most one draining generation. A blocked replacement cannot admit any new writer,
  // so repeated rotations may replace it without discarding the older physical writer gate.
  const retiring = holder?.retiring && !idle(holder.retiring) ? holder.retiring
    : holder?.current && !idle(holder.current) ? holder.current : null;
  runtime[stateKey] = { current: state, retiring };
  return state;
}
export function settingsRuntimeCurrent(state: SharedSettingsState): boolean {
  const holder = runtime[stateKey];
  if (holder?.current !== state) return false;
  if (holder.retiring && !idle(holder.retiring)) return false;
  holder.retiring = null;
  return true;
}
