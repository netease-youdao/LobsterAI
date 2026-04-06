const baseUrl = (process.env.LOBSTER_AGENT_BASE_URL || 'http://127.0.0.1:19888').replace(/\/$/, '');
const apiKey = process.env.LOBSTER_AGENT_API_KEY || 'lobsterai-agent-default-key';
const model = process.env.LOBSTER_AGENT_MODEL || 'claude-agent';
const airiSessionId = process.env.LOBSTER_AIRI_SESSION_ID || `airi-smoke-${Date.now()}`;
const prompt = process.env.LOBSTER_AGENT_PROMPT || '请回复 bridge-smoke-ok，并简要说明你已收到会话化 bridge 请求。';
const smokeImageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY/jPwPAfAAUAAf+mXJtdAAAAAElFTkSuQmCC';
const permissionPrompt = process.env.LOBSTER_AGENT_PERMISSION_PROMPT || '';
const permissionDecision = (process.env.LOBSTER_AGENT_PERMISSION_DECISION || 'allow').trim() === 'deny' ? 'deny' : 'allow';
const enablePermissionSmoke = process.env.LOBSTER_AGENT_PERMISSION_SMOKE === '1';
const optionalSkillIds = (process.env.LOBSTER_AGENT_SKILL_IDS || '')
  .split(',')
  .map(item => item.trim())
  .filter(Boolean);

async function requestJson(path, body, method = 'POST') {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function respondPermission(permission) {
  return requestJson('/api/agent/bridge/permission', {
    airiSessionId,
    requestId: permission.requestId,
    capabilityToken: permission.capabilityToken,
    decision: permissionDecision,
  });
}

async function requestSse(body, options = {}) {
  const response = await fetch(`${baseUrl}/api/agent/bridge/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => null);
    throw new Error(`/api/agent/bridge/chat failed: ${JSON.stringify(data)}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const seen = new Set();
  let finalText = '';
  const permissionRequests = [];

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      const event = JSON.parse(payload);
      seen.add(event.type);
      if (event.type === 'assistant.final') {
        finalText = event.text || '';
      }
      if (event.type === 'permission.request') {
        permissionRequests.push(event);
        if (options.autoRespondPermission) {
          await respondPermission(event);
        }
      }
      if (event.type === 'error') {
        throw new Error(`bridge error event: ${event.message}`);
      }
    }
  }

  return { seen, finalText, permissionRequests };
}

async function main() {
  const mixedTurnId = 'turn-mixed';
  const reattachTurnId = 'turn-reattach';
  const permissionSetupTurnId = 'turn-permission-setup';
  const permissionTurnId = 'turn-permission';
  console.log('[bridge-smoke] binding session', airiSessionId);
  const bindData = await requestJson('/api/agent/bridge/bind', { airiSessionId });
  console.log('[bridge-smoke] bound', bindData.session);

  if (optionalSkillIds.length > 0) {
    const skillData = await requestJson('/api/agent/skills', undefined, 'GET');
    const availableSkillIds = new Set((skillData.skills || []).map(skill => skill.id));
    const missingSkillIds = optionalSkillIds.filter(skillId => !availableSkillIds.has(skillId));
    if (missingSkillIds.length > 0) {
      throw new Error(`missing skills: ${missingSkillIds.join(', ')}`);
    }
    console.log('[bridge-smoke] validated skills', optionalSkillIds);
  }

  const firstTurn = await requestSse({
    airiSessionId,
    model,
    sessionMode: 'auto',
    stream: true,
    messages: [{ role: 'user', content: '请回复 text-fast-ok。' }],
  });
  console.log('[bridge-smoke] first turn events', Array.from(firstTurn.seen).join(', '));

  const uploadData = await requestJson('/api/agent/files/upload', {
    airiSessionId,
    clientTurnId: mixedTurnId,
    name: 'bridge-smoke.txt',
    mimeType: 'text/plain',
    base64Data: Buffer.from('bridge smoke file').toString('base64'),
  });
  console.log('[bridge-smoke] uploaded file', uploadData.file);

  const mixedTurn = await requestSse({
    airiSessionId,
    clientTurnId: mixedTurnId,
    sessionMode: 'agent',
    model,
    stream: true,
    fileIds: [uploadData.file.id],
    skillIds: optionalSkillIds.length > 0 ? optionalSkillIds : undefined,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: prompt },
        {
          type: 'image_url',
          image_url: {
            url: smokeImageDataUrl,
          },
        },
      ],
    }],
  });
  console.log('[bridge-smoke] mixed turn events', Array.from(mixedTurn.seen).join(', '));
  console.log('[bridge-smoke] mixed final text', mixedTurn.finalText);

  const reattach = await requestJson('/api/agent/files/reattach', {
    airiSessionId,
    clientTurnId: reattachTurnId,
    historyFileIds: [uploadData.file.id],
  });
  console.log('[bridge-smoke] reattached files', reattach.files);

  const reattachTurn = await requestSse({
    airiSessionId,
    clientTurnId: reattachTurnId,
    sessionMode: 'agent',
    model,
    stream: true,
    fileIds: reattach.files.map(file => file.id),
    messages: [{ role: 'user', content: '请确认你仍然可以访问重新附加的文件。' }],
  });
  console.log('[bridge-smoke] reattach events', Array.from(reattachTurn.seen).join(', '));
  console.log('[bridge-smoke] reattach final text', reattachTurn.finalText);

  if (enablePermissionSmoke) {
    const permissionSetupTurn = await requestSse({
      airiSessionId,
      clientTurnId: permissionSetupTurnId,
      sessionMode: 'agent',
      model,
      stream: true,
      messages: [{ role: 'user', content: '请在当前工作区创建一个名为 permission-smoke.txt 的文本文件，内容是 permission smoke。' }],
    }, { autoRespondPermission: true });
    console.log('[bridge-smoke] permission setup events', Array.from(permissionSetupTurn.seen).join(', '));
    console.log('[bridge-smoke] permission setup final text', permissionSetupTurn.finalText);
  }

  if (permissionPrompt || enablePermissionSmoke) {
    const permissionTurn = await requestSse({
      airiSessionId,
      clientTurnId: permissionTurnId,
      sessionMode: 'agent',
      model,
      stream: true,
      skillIds: optionalSkillIds.length > 0 ? optionalSkillIds : undefined,
      messages: [{
        role: 'user',
        content: permissionPrompt || '请删除当前工作区中的 permission-smoke.txt 文件，并在删除前先询问我是否允许继续。',
      }],
    }, { autoRespondPermission: true });
    console.log('[bridge-smoke] permission events', Array.from(permissionTurn.seen).join(', '));
    console.log('[bridge-smoke] permission requests', permissionTurn.permissionRequests.map(item => item.toolName));
    console.log('[bridge-smoke] permission final text', permissionTurn.finalText);
    if (permissionTurn.permissionRequests.length === 0) {
      throw new Error('permission prompt did not trigger permission.request');
    }
    if (permissionDecision === 'allow' && /未收到确认|取消|denied/i.test(permissionTurn.finalText)) {
      throw new Error(`permission allow did not continue as expected: ${permissionTurn.finalText}`);
    }
    if (permissionDecision === 'deny' && !/未收到确认|取消|denied/i.test(permissionTurn.finalText)) {
      throw new Error(`permission deny did not stop as expected: ${permissionTurn.finalText}`);
    }
  }

  if (!mixedTurn.seen.has('session.bound')) {
    throw new Error('missing session.bound');
  }
  if (!mixedTurn.seen.has('done')) {
    throw new Error('missing done');
  }
  if (!mixedTurn.seen.has('assistant.final') && !mixedTurn.seen.has('assistant.delta')) {
    throw new Error('missing assistant output event');
  }
  if (/^API Error:/i.test(mixedTurn.finalText)) {
    throw new Error(`mixed turn returned API error text: ${mixedTurn.finalText}`);
  }
  if (!reattachTurn.seen.has('done')) {
    throw new Error('missing done for reattach turn');
  }

  console.log('[bridge-smoke] ok');
}

main().catch((error) => {
  console.error('[bridge-smoke] failed', error);
  process.exitCode = 1;
});
