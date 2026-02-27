import { fetchAntigravityModels, loadOAuthProfile } from './_antigravity_common.mjs';

const main = async () => {
  const profile = await loadOAuthProfile();
  const models = await fetchAntigravityModels({
    token: profile.accessToken,
    projectId: profile.projectId,
  });

  if (!models.length) {
    throw new Error('fetchAvailableModels 返回空列表。');
  }

  console.log('[testcase_02] fetchAvailableModels success');
  console.log(`  modelCount: ${models.length}`);
  console.log(`  sample: ${models.slice(0, 5).map((m) => m.id).join(', ')}`);
};

main().catch((error) => {
  console.error(`[testcase_02] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
