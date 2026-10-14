'use strict';

// Drive an isolated, real Electron client over CDP. No global keyboard/mouse input.
// See specs/bugfixes/openclaw-plugin-degraded-startup/2026-09-23-plugin-degraded-startup-design.md.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: 'string', default: '19533' },
    output: { type: 'string' },
    name: { type: 'string', default: 'acceptance' },
    marker: { type: 'string' },
    session: { type: 'string' },
    timeout: { type: 'string', default: '600000' },
  },
});
const command = positionals[0];
const timeout = Number(values.timeout);
const port = Number(values.port);
assert(Number.isSafeInteger(port) && port > 0 && port <= 65535, 'Invalid CDP port');
assert(Number.isSafeInteger(timeout) && timeout > 0, 'Invalid timeout');
assert(/^[a-z0-9-]+$/.test(values.name), 'Use a simple evidence name');
assert(['status', 'capture', 'send', 'restart', 'stop'].includes(command),
  'Usage: node scripts/e2e-openclaw-plugin-degraded.cjs status|capture|send|restart|stop --port 19533 --output <evidence> --name <case> [--marker UPPERCASE-MARKER] [--session <id>]');

async function connect() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(10000),
  })).json();
  const target = targets.find(t => t.type === (command === 'stop' ? 'node' : 'page')
    && !t.url.startsWith('devtools:'));
  assert(target, 'Electron debugging target unavailable');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const pending = new Map();
  let nextId = 0;
  socket.onmessage = event => {
    const reply = JSON.parse(event.data);
    const item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id);
    clearTimeout(item.timer);
    if (reply.error) item.reject(new Error(reply.error.message));
    else item.resolve(reply.result);
  };
  socket.onclose = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Electron debugging connection closed'));
    }
    pending.clear();
  };
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true, userGesture: true,
    });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description || 'Renderer evaluation failed');
    return result.result.value;
  };
  return { socket, call, evaluate };
}

async function waitFor(read, description) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(1000);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function run() {
  const cdp = await connect();
  try {
    if (command === 'stop') {
      // The app's real termination handler cleans up Gateway and SQLite.
      await cdp.evaluate("setTimeout(() => process.emit('SIGTERM'), 100); true");
      console.log('Electron cleanup requested');
      return;
    }
    const getStatus = () => cdp.evaluate('window.electron.openclaw.engine.getStatus()');
    if (command === 'restart') {
      const result = await cdp.evaluate('window.electron.openclaw.engine.restartGateway()');
      assert(result.success, result.error || 'Gateway restart failed');
    }
    let result = { name: values.name, status: await getStatus() };
    if (command === 'send' || command === 'restart') {
      await waitFor(async () => (await getStatus()).status?.phase === 'running', 'Gateway readiness');
    }
    if (command === 'send') {
      assert(/^[A-Z0-9-]+$/.test(values.marker || ''), 'Provide an uppercase test marker');
      const before = await cdp.evaluate('window.electron.cowork.listSessions()');
      assert(before.success);
      if (values.session) {
        const session = before.sessions.find(s => s.id === values.session);
        assert(session, 'Requested session does not exist');
        await cdp.evaluate(`(() => {
          const item = Array.from(document.querySelectorAll('*')).find(e => e.children.length === 0 && e.textContent === ${JSON.stringify(session.title)});
          if (!item) throw new Error('Session is not visible in the sidebar');
          item.click();
        })()`);
      } else {
        await cdp.evaluate("document.querySelector('[data-onboarding-target=new-task]').click()");
      }
      await waitFor(() => cdp.evaluate("Boolean(document.querySelector('textarea:not(:disabled)'))"), 'prompt input');
      const prior = values.session
        ? await cdp.evaluate(`window.electron.cowork.getSessionMessages({sessionId:${JSON.stringify(values.session)},limit:100})`)
        : { messages: [] };
      const priorIds = new Set(prior.messages.map(m => m.id));
      const prompt = `客户端插件降级验收。请只回复 ${values.marker}，不要调用工具。`;
      await cdp.evaluate(`(() => {
        const input = document.querySelector('textarea');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(prompt)});
        input.dispatchEvent(new Event('input', {bubbles:true}));
        input.focus();
      })()`);
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      const sessionId = values.session || await waitFor(async () => {
        const current = await cdp.evaluate('window.electron.cowork.listSessions()');
        return current.sessions.find(s => !before.sessions.some(old => old.id === s.id))?.id;
      }, 'new persisted session');
      const message = await waitFor(async () => {
        const messages = await cdp.evaluate(`window.electron.cowork.getSessionMessages({sessionId:${JSON.stringify(sessionId)},limit:100})`);
        assert(messages.success);
        return messages.messages.find(m => !priorIds.has(m.id) && m.type === 'assistant'
          && !m.metadata?.isThinking && m.metadata?.isFinal === true
          && m.content.trim() === values.marker);
      }, 'real model response persisted through IPC');
      await waitFor(async () => {
        const sessions = await cdp.evaluate('window.electron.cowork.listSessions()');
        return sessions.sessions.find(s => s.id === sessionId)?.status === 'completed';
      }, 'session completion');
      const finalMessages = await cdp.evaluate(`window.electron.cowork.getSessionMessages({sessionId:${JSON.stringify(sessionId)},limit:100})`);
      const finalMessage = finalMessages.messages.find(m => m.id === message.id);
      assert(finalMessage, 'Completed response must remain persisted');
      result = { ...result, sessionId, response: finalMessage.content, model: finalMessage.metadata?.model ?? null };
    }
    result.status = await getStatus();
    result.at = new Date().toISOString();
    if (values.output) {
      fs.mkdirSync(values.output, { recursive: true });
      const screenshot = await cdp.call('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(values.output, `${values.name}.png`), Buffer.from(screenshot.data, 'base64'));
      fs.writeFileSync(path.join(values.output, `${values.name}.json`), JSON.stringify(result, null, 2));
    }
    console.log(JSON.stringify(result));
  } finally {
    cdp.socket.close();
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
