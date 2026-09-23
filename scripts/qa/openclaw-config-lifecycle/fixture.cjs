'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { qaDir: root, fixturePort } = require('./config.cjs');
fs.mkdirSync(root, { recursive: true });
const user = { yid: 'config-qa', nickname: '配置生命周期验收', userId: '900001', id: 900001, status: 1, avatarUrl: null, accountMode: 'personal' };
const quota = { planName: '验收套餐', subscriptionStatus: 'active', creditsLimit: 10000, creditsUsed: 0, creditsRemaining: 10000, hasPaidCredits: true, accountMode: 'personal' };
const models = ['deepseek-flash', 'deepseek-v4-pro', 'glm-5.3-flash'].map(modelId => ({
  modelId, modelName: modelId, provider: modelId.startsWith('glm') ? 'zhipu' : 'deepseek',
  apiFormat: 'openai-completions', supportsToolCalling: true, agenticReady: true,
  contextWindow: 128000, maxTokens: 8192, accessible: true, supportsImage: false,
}));
let sequence = 0;
const heldResponses = new Map();
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let raw = ''; for await (const chunk of req) raw += chunk;
  const json = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 0, data })); };
  if (url.pathname === '/__qa/release') {
    const count = heldResponses.size;
    for (const finish of heldResponses.values()) finish();
    heldResponses.clear();
    return json({ released: count });
  }
  if (url.pathname.endsWith('/chat/completions')) {
    const body = JSON.parse(raw || '{}');
    const recent = [...(body.messages || [])].reverse().find(m => m.role === 'user');
    const marker = JSON.stringify(recent?.content ?? '').match(/CONFIG_QA_[A-Z0-9_]+/)?.[0] || 'CONFIG_QA_UNMARKED';
    const content = `${marker} 已完成：当前模型 ${body.model}，本地验收端点已收到请求。`;
    const record = { time: new Date().toISOString(), sequence: ++sequence, path: url.pathname, model: body.model, marker, stream: body.stream === true };
    fs.appendFileSync(path.join(root, 'model-requests.jsonl'), JSON.stringify(record) + '\n');
    const id = 'chatcmpl-config-qa-' + sequence;
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (delta, finish_reason = null, usage) => 'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) }) + '\n\n';
      res.write(chunk({ role: 'assistant', content: '' }));
      const finish = () => {
        res.write(chunk({ content }));
        res.write(chunk({}, 'stop', { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 }));
        res.end('data: [DONE]\n\n');
      };
      if (marker.includes('_HOLD')) {
        heldResponses.set(id, finish);
        res.once('close', () => heldResponses.delete(id));
      }
      else finish();
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 24, total_tokens: 144 } }));
    }
    return;
  }
  fs.appendFileSync(path.join(root, 'fixture-http.jsonl'), JSON.stringify({ time: new Date().toISOString(), method: req.method, path: url.pathname }) + '\n');
  if (url.pathname === '/api/auth/exchange') return json({ accessToken: 'qa-synthetic-access', refreshToken: 'qa-synthetic-refresh', user, quota });
  if (url.pathname === '/api/user/profile') return json(user);
  if (url.pathname === '/api/user/quota') return json(quota);
  if (url.pathname === '/api/models/available') return json(models);
  if (url.pathname === '/api/models/pricing-catalog') return json({ textModels: models, imageModels: [], videoModels: [] });
  if (url.pathname === '/api/enterprise/context') return json(null);
  if (url.pathname === '/api/enterprise/identities') return json([]);
  return json(null);
}).listen(fixturePort, '127.0.0.1', () => console.log(`Synthetic auth/model fixture listening on 127.0.0.1:${fixturePort}`));
