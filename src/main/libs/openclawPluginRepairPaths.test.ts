import { expect, test } from 'vitest';

import { isPreviousManagedPluginPath } from './openclawPluginRepairPaths';

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
