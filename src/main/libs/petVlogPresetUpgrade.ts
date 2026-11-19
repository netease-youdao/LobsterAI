import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { AgentSource } from '../../shared/agent/constants';
import type { PresetAgent } from '../../shared/agent/presets';
import type { Agent, CoworkStore, UpdateAgentRequest } from '../coworkStore';
import { type AgentPersona, AgentPersonaFile, writeAgentPersonaFiles } from './agentPersonaFiles';

// Old clients did not record which defaults they installed. These shipped hashes
// are in release order so a stale catalog cannot downgrade an untracked instance.
export const PET_VLOG_PRESET_ID = 'xiaokui-vlog';
const fields = ['name', 'description', 'identity', 'systemPrompt'] as const;
const languages = ['zh', 'en'] as const;
type Field = typeof fields[number];
type Language = typeof languages[number];

interface PresetDefaults {
  version: string;
  fields: Partial<Record<Field, { language: Language; hash: string }>>;
}

const legacy: Record<Language, Record<Field, string[]>> = {
  zh: {
    name: [
      'd9927517a580424cf50f4ac515565c00f15f9d7e4b89181212dda1467d877729',
      'f3ecb4234020d2cfb9c878969905ee1d2193bb4e24d794557f8ff2cb8b46e3dd',
    ],
    description: [
      '0d25066988160aacd630aaa440ac6a69b85c5fc29320651bf643990409c5f71c',
      'f6a1e1e5d963b4d62d511cda1107b49449d2cfcd1964fd9f6a90405637d875c6',
      '0bb148c09edc6c28aaaccb83b7ae6356e5a8b5f31f9b680dbae69b986d9c0d74',
      '055f6b2c3fc1dacd8734e4aa260e13f83bc47e44c48444efdbf88a318efdc582',
    ],
    identity: [
      'e17de6ae63f72708f7ffa54b051c15a75dea9ca7f73cd77397b17f192613a4d7',
      '601a20756d5d2c854dd6dfba0bd54510d1a088e9d7c5ef14a4309320c38d6252',
      'e7b324133e3608501f8c95f5ff805ce92bfd9d453df38a54cb5e45817750615b',
    ],
    systemPrompt: [
      '375c36b94a7bce6902e6eef4c4a0fdb096ef901dc467b3168d72c8a4b81eb0b5',
      'd31df08ff3fd8f40495d018436a37f84ed5330e2f5064abc281ee595f7ccbcf0',
      '0eaad21f1b507c596ec4f9ea61e26389da20b600ba8ae24068e849a98d643502',
      'f6a920af2a1299d0b077c94576e6407b815ff631d7d9c826cfbf612e01cf9c33',
      '52959912b4280557ee39d10ee84fd110866d16054f636013627fef0edab94e36',
      '2d481ff0ef995531b07353cf7784d310c87b012c683c88e9a79d5c7e66a4e44c',
      '81420faeabb52debf78bbbded637a75abde7ce739565a8b3bb5ae48d6875a454',
      'efccd39e2f8e93a15803f031740d476677a6faa641c46e16bcdc513afb6d7ee4',
      '5bf7f452518253c4872a4dca3184bf0cd28e03df7e0a33827e97e35577b46387',
      '6d6351b1a1e0317cbe5ed8611f11da9785ec55beefe0b5bc33154e72d26dcf07',
    ],
  },
  en: {
    name: [
      'a85d2da2b690ddfc7c48a0da1e549ea2862d2dd1fd046e3494e64bcdd6add574',
      '17bfddb7bef52a4d7ee5beb98bef3b4e74ee5c3d4de9d71ca15bd748db7ec0a9',
    ],
    description: [
      '3bcf75f5c021250f601eb2c288fd7b2605b1575183cacea9ee61a45030c7d1ed',
      '77b559c23f3d280352e6e3122140efa0dc8599094af3a0ad1cd0c3d6c158441e',
      '9a6737c5d4adfb038cd92b709ae7ca0e988fab96c814b58d53cc12e84374644d',
      'fd9292b5dc65b2fab00e4bfe0d573566b4ff00807b5ad5d8884d5aedd639d68e',
    ],
    identity: [
      '70b45b4f6a71d3ab6107f63721cd74bc70393ce3154313e2009f40e015ec8c12',
      '593941e26b5f92909c77f6ceb505415eb14c6088cf70a0d57e890483dabd7363',
      '05e051ada60923d971452206fecf0abf30031aa13ef359f4c45a0180d8b98b31',
    ],
    systemPrompt: [
      'f65dcedc8776f8f4f1fc36f7fea485f73cad65b63f783abcc3906e7efe3fb081',
      '56ac7527530cc44ac7b1963a5080467942f095edc79187f2b9ccbcf5a5918d21',
      'e34c72ec711bf62294caf8e04526f68d255e3d7ffafc5abe6772aec02ae7c7b8',
      '8b934bf213a21fd4eede0c1a24d2e0018e81909d15960135b62ce05c56173836',
      '69a31fc9732ccfcbb436179bb3646a2f5b1d39eb53e5870863790c1fdc189290',
      '973793384b9fd5bfdd418165598a57b9531ad441a10c9d7f5cc586803e639f3f',
      'b1d441e4b67a421ed7186b869b269acf284f549622d84fc225a1f7890e078a4c',
      'c3acc99743d1e8cf67829bcaa1b0b8c16bc350c4441193ff4c4b92ec651c5a13',
      '8eeab855fa97171ff9f6c17c3a7fe9425df9261d52dc0191fe9c9df86d89281a',
      'fba824d94ecb9d9e7f47854299e9550118c90838211c813ad13909419a8d5be8',
    ],
  },
};

const fingerprint = (value: string) => createHash('sha256').update(value.trim().replace(/\r\n/g, '\n')).digest('hex');

export function isPetVlogPreset(agent: Agent): boolean {
  return agent.source === AgentSource.Preset && agent.presetId === PET_VLOG_PRESET_ID;
}

const datedRevision = /^\d{4}-\d{2}-\d{2}\.\d+$/;

export function upgradePetVlogPreset(
  agent: Agent, preset: PresetAgent, version: string, workspace: string,
  store: Pick<CoworkStore, 'getPresetDefaultsSnapshot' | 'savePresetDefaults'>,
): void {
  if (!isPetVlogPreset(agent) || preset.id !== PET_VLOG_PRESET_ID) return;
  const raw = store.getPresetDefaultsSnapshot(agent.id);
  const saved: PresetDefaults | null = raw ? JSON.parse(raw) : null;
  if (saved && datedRevision.test(version) && datedRevision.test(saved.version)
    && version.localeCompare(saved.version, 'en', { numeric: true }) < 0) return;

  const next: PresetDefaults = { version, fields: { ...saved?.fields } };
  const changes: UpdateAgentRequest = {};
  const persona: AgentPersona = {};
  for (const field of fields) {
    const hash = fingerprint(agent[field] || '');
    const values = { zh: preset[field], en: preset[`${field}En` as const] };
    const managed = saved?.fields[field];
    const language = managed?.language ?? languages.find(lang =>
      fingerprint(values[lang]) === hash || (!saved && legacy[lang][field].includes(hash)));
    if (!language || !values[language]) continue;

    const after = values[language];
    const targetHash = fingerprint(after);
    if (managed && hash !== managed.hash && hash !== targetHash) continue;
    const history = legacy[language][field];
    const targetIndex = history.indexOf(targetHash);
    // Wait for a current catalog before recording the first snapshot.
    if (!saved && targetIndex >= 0 && history.indexOf(hash) > targetIndex) return;
    next.fields[field] = { language, hash: targetHash };
    if (hash === targetHash) continue;
    changes[field] = after;
    if (field !== 'identity' && field !== 'systemPrompt') continue;
    const file = path.join(workspace, field === 'identity' ? AgentPersonaFile.Identity : AgentPersonaFile.Soul);
    if (!fs.existsSync(file) || fingerprint(fs.readFileSync(file, 'utf8')) === hash) persona[field] = after;
  }

  // Write files first. If SQLite fails, the old snapshot still permits a retry.
  const snapshot = JSON.stringify(next);
  if (Object.keys(persona).length) writeAgentPersonaFiles(workspace, persona);
  if (snapshot !== raw || Object.keys(changes).length) store.savePresetDefaults(agent.id, changes, snapshot);
}
