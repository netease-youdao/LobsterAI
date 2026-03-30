const baseUrl = (process.env.LOBSTER_AGENT_BASE_URL || 'http://127.0.0.1:19888').replace(/\/$/, '');
const apiKey = process.env.LOBSTER_AGENT_API_KEY || 'lobsterai-agent-default-key';
const targetSkillId = process.env.LOBSTER_SKILL_ID || '';

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  const skillsData = await request('/api/agent/skills', { method: 'GET' });
  const skills = Array.isArray(skillsData.skills) ? skillsData.skills : [];
  console.log('[skill-smoke] skills', skills.length);

  if (skills.length === 0) {
    console.log('[skill-smoke] no skills installed, stop here');
    return;
  }

  const skillId = targetSkillId || String(skills[0].id || '');
  if (!skillId) {
    throw new Error('No valid skill id found');
  }

  const configData = await request('/api/agent/skills/get-config', {
    method: 'POST',
    body: JSON.stringify({ id: skillId }),
  });

  console.log('[skill-smoke] target skill', skillId);
  console.log('[skill-smoke] config keys', Object.keys(configData.config || {}));
  console.log('[skill-smoke] ok');
}

main().catch((error) => {
  console.error('[skill-smoke] failed', error);
  process.exitCode = 1;
});
