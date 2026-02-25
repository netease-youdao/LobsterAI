import { callGemini3Chat, fetchAntigravityModels, loadOAuthProfile } from './_antigravity_common.mjs';

const main = async () => {
  const profile = await loadOAuthProfile();
  const models = await fetchAntigravityModels({
    token: profile.accessToken,
    projectId: profile.projectId,
  });

  const result = await callGemini3Chat({
    token: profile.accessToken,
    projectId: profile.projectId,
    models,
  });

  console.log('[testcase_03] Gemini3 chat success');
  console.log(`  endpoint: ${result.endpoint}${result.route}`);
  console.log(`  model: ${result.model}`);
  console.log(`  reply: ${result.content}`);
};

main().catch((error) => {
  console.error(`[testcase_03] FAIL: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
