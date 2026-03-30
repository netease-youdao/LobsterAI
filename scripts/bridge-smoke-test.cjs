const baseUrl = (process.env.LOBSTER_AGENT_BASE_URL || 'http://127.0.0.1:19888').replace(/\/$/, '');
const apiKey = process.env.LOBSTER_AGENT_API_KEY || 'lobsterai-agent-default-key';
const model = process.env.LOBSTER_AGENT_MODEL || 'claude-agent';
const airiSessionId = process.env.LOBSTER_AIRI_SESSION_ID || `airi-smoke-${Date.now()}`;
const prompt = process.env.LOBSTER_AGENT_PROMPT || '请回复 bridge-smoke-ok，并简要说明你已收到会话化 bridge 请求。';

async function requestJson(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

async function main() {
  console.log('[bridge-smoke] binding session', airiSessionId);
  const bindData = await requestJson('/api/agent/bridge/bind', { airiSessionId });
  console.log('[bridge-smoke] bound', bindData.session);

  const uploadData = await requestJson('/api/agent/files/upload', {
    airiSessionId,
    name: 'bridge-smoke.txt',
    mimeType: 'text/plain',
    base64Data: Buffer.from('bridge smoke file').toString('base64'),
  });
  console.log('[bridge-smoke] uploaded file', uploadData.file);

  const response = await fetch(`${baseUrl}/api/agent/bridge/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      airiSessionId,
      model,
      stream: true,
      fileIds: [uploadData.file.id],
      messages: [{ role: 'user', content: prompt }],
    }),
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
      if (event.type === 'error') {
        throw new Error(`bridge error event: ${event.message}`);
      }
    }
  }

  console.log('[bridge-smoke] seen events', Array.from(seen).join(', '));
  console.log('[bridge-smoke] final text', finalText);

  if (!seen.has('session.bound')) {
    throw new Error('missing session.bound');
  }
  if (!seen.has('done')) {
    throw new Error('missing done');
  }
  if (!seen.has('assistant.final') && !seen.has('assistant.delta')) {
    throw new Error('missing assistant output event');
  }

  console.log('[bridge-smoke] ok');
}

main().catch((error) => {
  console.error('[bridge-smoke] failed', error);
  process.exitCode = 1;
});
