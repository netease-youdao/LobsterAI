import { expect, test } from 'vitest';

import {
  isPreviousManagedPluginPath,
  isRuntimeThirdPartyExtensionsDir,
  rebaseRuntimeExtensionLoadPaths,
} from './openclawPluginRepairPaths';

const stateDir = 'C:\\Users\\admin\\AppData\\Roaming\\LobsterAI\\openclaw\\state';
const oldState = 'C:\\Users\\shixw\\AppData\\Roaming\\LobsterAI\\openclaw\\state';

test.each([
  [`${oldState}\\npm\\projects\\tencent-weixin-openclaw-weixin-7783ac86ba\\node_modules\\@tencent-weixin\\openclaw-weixin`, true],
  [`${oldState}\\npm\\node_modules\\@tencent-weixin\\openclaw-weixin`, true],
  [`${oldState}\\extensions\\openclaw-weixin`, true],
  [`${oldState}\\extensions\\other`, false],
  ['D:\\custom\\openclaw-weixin', false],
  [`${oldState}\\npm\\projects\\project\\node_modules\\@someone\\openclaw-weixin`, false],
  [`${oldState}\\npm\\projects\\project\\..\\project\\node_modules\\@tencent-weixin\\openclaw-weixin`, false],
  ['relative\\LobsterAI\\openclaw\\state\\extensions\\openclaw-weixin', false],
])('recognizes only migrated Windows managed layouts: %s', (installPath, expected) => {
  expect(isPreviousManagedPluginPath({ stateDir, installPath, pluginId: 'openclaw-weixin', packageName: '@tencent-weixin/openclaw-weixin' })).toBe(expected);
});

test.each([
  ['C:\\Users\\dev\\AppData\\Local\\Programs\\LobsterAI\\resources\\cfmind\\third-party-extensions', true],
  ['/Applications/LobsterAI.app/Contents/Resources/cfmind/third-party-extensions/', true],
  ['D:\\dev\\LobsterAI\\vendor\\openclaw-runtime\\current\\third-party-extensions', true],
  ['/home/dev/LobsterAI/vendor/openclaw-runtime/linux-x64/third-party-extensions', true],
  ['D:\\plugins\\third-party-extensions', false],
  ['C:\\Users\\dev\\AppData\\Roaming\\LobsterAI\\third-party-extensions', false],
  ['C:\\Program Files\\LobsterAI\\resources\\cfmind\\third-party-extensions\\some-plugin', false],
])('recognizes runtime-bundled third-party extension directories: %s', (loadPath, expected) => {
  expect(isRuntimeThirdPartyExtensionsDir(loadPath)).toBe(expected);
});

const installed = 'C:\\Program Files\\LobsterAI\\resources\\cfmind\\third-party-extensions';
const dev = 'D:\\dev\\LobsterAI\\vendor\\openclaw-runtime\\current\\third-party-extensions';
const linked = 'D:\\plugins\\third-party-extensions';

test.each([
  { paths: [installed, linked], current: dev, expected: [dev, linked] },
  { paths: [linked, installed, dev], current: dev, expected: [linked, dev] },
  { paths: [dev, linked], current: dev, expected: [dev, linked] },
  { paths: [installed, linked, 42], current: null, expected: [linked, 42] },
  { paths: [linked], current: dev, expected: [linked] },
])('rebases only runtime extension load paths: $paths -> $current', ({ paths, current, expected }) => {
  expect(rebaseRuntimeExtensionLoadPaths(paths, current)).toEqual(expected);
});
