import { formatExpiry, loadOAuthProfile } from './_antigravity_common.mjs';

const main = async () => {
  const profile = await loadOAuthProfile();
  const now = Date.now();
  const expired = Number.isFinite(profile.expiresAtMs) && profile.expiresAtMs > 0 && profile.expiresAtMs <= now;

  console.log('[testcase_01] OAuth profile loaded');
  console.log(`  dbPath: ${profile.dbPath}`);
  console.log(`  email: ${profile.email || '-'}`);
  console.log(`  projectId: ${profile.projectId}`);
  console.log(`  expiresAt: ${formatExpiry(profile.expiresAtMs)}`);
  if (profile.refreshError) {
    console.log(`  refreshWarning: ${profile.refreshError}`);
  }
  if (expired) {
    console.log('  warning: OAuth access_token 可能已过期，后续接口测试可能失败。');
  }
};

main().catch((error) => {
  console.error(`[testcase_01] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
