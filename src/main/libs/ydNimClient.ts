/**
 * YD Hidden NIM Client
 *
 * A silent, user-transparent NIM SDK instance initialized automatically
 * after YID login. Handles structured RPC messages from iOS via serverExtension
 * and sends auto-replies. Completely independent from the user-configured IM gateway.
 */

import { BrowserWindow, net } from 'electron';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const NIM = require('nim-web-sdk-ng/dist/nodejs/nim.js').default;
import type { V2NIM } from 'nim-web-sdk-ng/dist/nodejs/nim';

// ── Constants ──────────────────────────────────────────────────────────────

const YD_NIM_APP_KEY = 'ae614a09937403821bbddb19b3d61d97';

// Lobster server base URL — TODO: switch to prod URL when leaving test mode
const LOBSTER_API_BASE = 'https://hardware-earphone-test.youdao.com';

// Hardware server base URL (hardware-earphone service — separate from Lobster)
// TODO: switch to prod URL when leaving test mode
const HARDWARE_API_BASE = 'https://hardware-earphone-test.youdao.com';
const HARDWARE_NIM_AUTH_PATH = '/lobster/yunxin/auth';


// ── Server context (injected from main.ts) ────────────────────────────────────

type GetTokensFn = () => { accessToken: string; refreshToken?: string } | null;

let getTokensFn: GetTokensFn | null = null;

export function setYdNimServerContext(fn1: GetTokensFn): void {
  getTokensFn = fn1;
  console.log('[YdNimClient] Server context set');
}

// ── Internal state ─────────────────────────────────────────────────────────

let v2Client: V2NIM | null = null;
let currentAccid: string | null = null;
let initialized = false;

/**
 * Local cache: taskId → {electronTaskId}
 * Populated after every successful GET or create. Avoids repeated server
 * round-trips for the same conversation.
 */
const taskIdCache = new Map<string, { electronTaskId: string }>();

/** Reverse lookup: electronTaskId (= CoworkSession.id) → iOS taskId */
const electronTaskIdToTaskId = new Map<string, string>();

/**
 * In-flight create handlers register a promise here so concurrent
 * handleNormalMessage calls can wait for the electronTaskId instead of
 * racing against the server update.  keyed by iOS taskId.
 */
const pendingCreates = new Map<string, Promise<{ electronTaskId: string } | null>>();

interface IosCoworkCallbacks {
  createSession: (taskId: string, title: string) => Promise<{ sessionId: string }>;
  continueSession: (sessionId: string, text: string) => Promise<void>;
  setPinned: (sessionId: string, pinned: boolean) => void;
  rename: (sessionId: string, title: string) => void;
  deleteSession: (sessionId: string) => void;
  persistIosMapping?: (electronTaskId: string, iosTaskId: string) => void;
  deleteIosMapping?: (electronTaskId: string) => void;
}

let coworkCallbacks: IosCoworkCallbacks | null = null;

/** Serializes concurrent init/destroy calls so only one runs at a time. */
let lifecyclePromise: Promise<void> = Promise.resolve();

// ── Renderer broadcast ─────────────────────────────────────────────────────

// Ring buffer of recent NIM events for IosCommView catch-up on mount.
// Stores the last 200 events across all debug channels.
const NIM_HISTORY_MAX = 200;
const nimEventHistory: Array<{ channel: string; data: unknown }> = [];

function broadcastToRenderer(channel: string, data: unknown): void {
  // Record in history ring buffer (only debug-relevant channels)
  if (
    channel === 'yd-nim:message-received' ||
    channel === 'yd-nim:message-sent' ||
    channel === 'yd-nim:log' ||
    channel === 'yd-nim:action'
  ) {
    nimEventHistory.push({ channel, data });
    if (nimEventHistory.length > NIM_HISTORY_MAX) {
      nimEventHistory.splice(0, nimEventHistory.length - NIM_HISTORY_MAX);
    }
  }
  const wins = BrowserWindow.getAllWindows();
  wins.forEach(win => {
    if (!win.isDestroyed()) win.webContents.send(channel, data);
  });
}

export function getNimEventHistory(): Array<{ channel: string; data: unknown }> {
  return nimEventHistory.slice();
}

// ── Lobster server API ──────────────────────────────────────────────────────

async function callLobsterApi(path: string, body: object): Promise<any> {
  const url = `${LOBSTER_API_BASE}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tokens = getTokensFn?.();
  if (tokens?.accessToken) {
    headers['Authorization'] = `Bearer ${tokens.accessToken}`;
  }
  console.log('[YdNimClient] callLobsterApi →', path, body);
  console.log('[YdNimClient] callLobsterApi headers:', JSON.stringify({
    ...headers,
    Authorization: headers['Authorization']
      ? headers['Authorization'].slice(0, 20) + '…(len=' + headers['Authorization'].length + ')'
      : '(none)',
  }));
  const resp = await net.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await resp.json() as { code: number; msg?: string; data?: any };
  console.log('[YdNimClient] callLobsterApi ←', path, 'code:', result.code);
  // Server uses code=0 for success (some endpoints may use 200)
  if (result.code !== 0 && result.code !== 200) {
    throw new Error(`Lobster API ${path} error ${result.code}: ${result.msg}`);
  }
  return result.data;
}

// ── HardEar server API ──────────────────────────────────────────────────────

async function callHardwareApi(path: string, body: object): Promise<any> {
  const url = `${HARDWARE_API_BASE}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const tokens = getTokensFn?.();
  if (tokens?.accessToken) {
    headers['X-Lobster-Token'] = tokens.accessToken;
  }
  console.log('[YdNimClient] callHardwareApi →', path, body);
  const resp = await net.fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const result = await resp.json() as { code: number; msg?: string; data?: any };
  console.log('[YdNimClient] callHardwareApi ←', path, 'code:', result.code);
  if (result.code !== 0 && result.code !== 200) {
    throw new Error(`HardEar API ${path} error ${result.code}: ${result.msg}`);
  }
  return result.data;
}

// ── Credentials ────────────────────────────────────────────────────────────

async function fetchNimCredentials(_ydUserId: string): Promise<{ accid: string; token: string }> {
  console.log('[YdNimClient] fetchNimCredentials — calling yunxin/auth');
  const data = await callHardwareApi(HARDWARE_NIM_AUTH_PATH, {});
  const { accid, token } = data ?? {};
  if (!accid || !token) throw new Error('yunxin/auth returned no credentials');
  console.log('[YdNimClient] fetchNimCredentials ✓ accid:', accid, 'token:', token.slice(0, 8) + '…');
  return { accid, token };
}


// ── Send ───────────────────────────────────────────────────────────────────

async function doSendMessage(text: string, ext?: object): Promise<string | undefined> {
  console.log('[YdNimClient] doSendMessage — initialized:', initialized, 'accid:', currentAccid, 'text:', text, 'ext:', ext);
  if (!initialized || !v2Client || !currentAccid) {
    throw new Error(`NIM client not ready (initialized=${initialized} v2Client=${!!v2Client} accid=${currentAccid})`);
  }
  const conversationId = `${currentAccid}|1|${currentAccid}`;
  const message = v2Client.V2NIMMessageCreator.createTextMessage(text);
  if (!message) throw new Error('createTextMessage returned null');

  // Attach serverExtension if provided
  if (ext) {
    (message as any).serverExtension = JSON.stringify(ext);
  }

  const result = await v2Client.V2NIMMessageService.sendMessage(message, conversationId, {}, () => {});
  const serverId = (result as any)?.message?.messageServerId ?? (result as any)?.messageServerId;
  console.log('[YdNimClient] sendMessage ✓ serverId:', serverId ?? 'n/a');
  return serverId;
}

// ── iOS cowork integration ─────────────────────────────────────────────────

/**
 * Resolve electronTaskId (= CoworkSession.id) for a given iOS taskId.
 * Checks the local cache first; falls back to a server GET and populates the cache.
 */
async function resolveElectronTaskId(taskId: string): Promise<string | undefined> {
  const cached = taskIdCache.get(taskId);
  if (cached) return cached.electronTaskId;
  const data = await callLobsterApi('/lobster/conversation/get', { taskId });
  const electronTaskId: string | undefined = data.conversation?.electronTaskId;
  if (electronTaskId) {
    taskIdCache.set(taskId, { electronTaskId });
    electronTaskIdToTaskId.set(electronTaskId, taskId);
    coworkCallbacks?.persistIosMapping?.(electronTaskId, taskId);
  }
  return electronTaskId;
}

// ── Action handlers ────────────────────────────────────────────────────────

async function handleCreateConversation(_msg: any, ext: any): Promise<void> {
  const { taskId, title } = ext;
  console.log('[YdNimClient] handleCreate — taskId:', taskId, 'title:', title);
  broadcastToRenderer('yd-nim:log', { text: `处理 create: taskId=${taskId}`, time: Date.now() });

  // Register before first await so concurrent handleNormalMessage can wait on it
  let resolveCreate!: (v: { electronTaskId: string } | null) => void;
  pendingCreates.set(taskId, new Promise(r => { resolveCreate = r; }));

  try {
    let electronTaskId!: string;

    try {
      // Step 1: create real CoworkSession (or fall back to a generated ID)
      if (coworkCallbacks) {
        const { sessionId } = await coworkCallbacks.createSession(taskId, title ?? 'iOS Task');
        electronTaskId = sessionId;
      } else {
        electronTaskId = `electron-task-${Date.now()}`;
      }

      // Step 2: register mapping on server
      await callLobsterApi('/lobster/conversation/electron-task-id/update', { taskId, electronTaskId });

      // Cache the mapping for subsequent messages
      taskIdCache.set(taskId, { electronTaskId });
      electronTaskIdToTaskId.set(electronTaskId, taskId);
      coworkCallbacks?.persistIosMapping?.(electronTaskId, taskId);
    } catch (serverErr: any) {
      // Conversation not yet on server (simulation mode) — generate local ID and cache
      if (serverErr?.message?.includes('4009')) {
        if (!electronTaskId) electronTaskId = `electron-task-${Date.now()}`;
        taskIdCache.set(taskId, { electronTaskId });
        electronTaskIdToTaskId.set(electronTaskId, taskId);
        coworkCallbacks?.persistIosMapping?.(electronTaskId, taskId);
        broadcastToRenderer('yd-nim:log', {
          text: `[模拟模式] 服务器无此会话，本地生成 electronTaskId=${electronTaskId}`,
          time: Date.now(),
        });
      } else {
        throw serverErr;
      }
    }

    // Unblock any concurrent normal-message handlers waiting for this taskId
    resolveCreate({ electronTaskId });

    broadcastToRenderer('yd-nim:action', { action: 'create', taskId, electronTaskId, title });
    broadcastToRenderer('yd-nim:log', { text: `✓ create处理完成，electronTaskId=${electronTaskId}`, time: Date.now() });
  } catch (e: any) {
    resolveCreate(null);
    const errMsg = e?.message ?? String(e);
    console.error('[YdNimClient] handleCreate failed:', errMsg);
    broadcastToRenderer('yd-nim:log', { text: `✗ create处理失败: ${errMsg}`, time: Date.now() });
  } finally {
    pendingCreates.delete(taskId);
  }
}

async function handleNormalMessage(msg: any, ext: any): Promise<void> {
  const taskId = ext?.taskId;
  console.log('[YdNimClient] handleNormal — taskId:', taskId, 'text:', msg.text);
  broadcastToRenderer('yd-nim:log', { text: `处理普通消息: taskId=${taskId ?? 'none'}`, time: Date.now() });
  try {
    let electronTaskId: string | undefined;

    if (taskId) {
      const cached = taskIdCache.get(taskId);
      if (cached) {
        electronTaskId = cached.electronTaskId;
        broadcastToRenderer('yd-nim:log', {
          text: `[本地缓存] electronTaskId=${electronTaskId}`,
          time: Date.now(),
        });
      } else {
        const data = await callLobsterApi('/lobster/conversation/get', { taskId });
        electronTaskId = data.conversation?.electronTaskId;
        if (electronTaskId) {
          electronTaskIdToTaskId.set(electronTaskId, taskId);
          taskIdCache.set(taskId, { electronTaskId });
          coworkCallbacks?.persistIosMapping?.(electronTaskId, taskId);
        }
      }

      // create and normal messages arrive nearly simultaneously; if electronTaskId
      // is still missing, the create handler may still be in-flight — wait for it
      if (!electronTaskId && pendingCreates.has(taskId)) {
        broadcastToRenderer('yd-nim:log', { text: `等待 create 完成: taskId=${taskId}`, time: Date.now() });
        const createResult = await Promise.race([
          pendingCreates.get(taskId)!,
          new Promise<null>(r => setTimeout(() => r(null), 5000)),
        ]);
        if (createResult) {
          electronTaskId = createResult.electronTaskId;
        }
      }
    }

    broadcastToRenderer('yd-nim:action', {
      action: 'normal',
      taskId,
      electronTaskId,
      text: msg.text,
    });

    // User message is fixed on receipt — save it now.
    // autoReply (NIM) and save (HTTP) are independent, run in parallel.
    // Assistant message is saved later by the iOS complete hook after agent finishes.
    await Promise.all([
      (async () => {
        if (electronTaskId && coworkCallbacks) {
          // Real flow: hand off to agent; reply comes via runtime complete hook
          await coworkCallbacks.continueSession(electronTaskId, msg.text ?? '');
        }
      })(),
      (async () => {
        if (!taskId || !msg.text) return;
        try {
          await saveConversationMessages(taskId, [{
            messageId: msg.messageClientId ?? `user-${Date.now()}`,
            role: 'user',
            content: msg.text,
            timestamp: msg.createTime ?? Date.now(),
          }]);
          broadcastToRenderer('yd-nim:log', { text: `✓ 用户消息已上报: taskId=${taskId}`, time: Date.now() });
        } catch (saveErr: any) {
          console.error('[YdNimClient] saveConversationMessages failed:', saveErr?.message);
          broadcastToRenderer('yd-nim:log', { text: `✗ 消息上报失败: ${saveErr?.message}`, time: Date.now() });
        }
      })(),
    ]);
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    console.error('[YdNimClient] handleNormal failed:', errMsg);
    broadcastToRenderer('yd-nim:log', { text: `✗ 普通消息处理失败: ${errMsg}`, time: Date.now() });
  }
}

async function handleUpdateConversation(_msg: any, ext: any): Promise<void> {
  const { taskId, title } = ext;
  console.log('[YdNimClient] handleUpdate — taskId:', taskId, 'title:', title);
  try {
    const electronTaskId = await resolveElectronTaskId(taskId);
    await callLobsterApi('/lobster/conversation/update', { taskId, title });
    if (electronTaskId) coworkCallbacks?.rename(electronTaskId, title);
    broadcastToRenderer('yd-nim:action', { action: 'update', taskId, electronTaskId, title });
    broadcastToRenderer('yd-nim:log', { text: `✓ update处理完成: taskId=${taskId}`, time: Date.now() });
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    console.error('[YdNimClient] handleUpdate failed:', errMsg);
    broadcastToRenderer('yd-nim:log', { text: `✗ update处理失败: ${errMsg}`, time: Date.now() });
  }
}

async function handlePinConversation(_msg: any, ext: any): Promise<void> {
  const { taskId } = ext;
  console.log('[YdNimClient] handlePin — taskId:', taskId);
  try {
    const electronTaskId = await resolveElectronTaskId(taskId);
    await Promise.all([
      callLobsterApi('/lobster/conversation/pin', { taskId }),
      electronTaskId ? Promise.resolve(coworkCallbacks?.setPinned(electronTaskId, true)) : Promise.resolve(),
    ]);
    broadcastToRenderer('yd-nim:action', { action: 'pin', taskId, electronTaskId });
    broadcastToRenderer('yd-nim:log', { text: `✓ pin处理完成: taskId=${taskId}`, time: Date.now() });
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    console.error('[YdNimClient] handlePin failed:', errMsg);
    broadcastToRenderer('yd-nim:log', { text: `✗ pin处理失败: ${errMsg}`, time: Date.now() });
  }
}

async function handleUnpinConversation(_msg: any, ext: any): Promise<void> {
  const { taskId } = ext;
  console.log('[YdNimClient] handleUnpin — taskId:', taskId);
  try {
    const electronTaskId = await resolveElectronTaskId(taskId);
    await Promise.all([
      callLobsterApi('/lobster/conversation/unpin', { taskId }),
      electronTaskId ? Promise.resolve(coworkCallbacks?.setPinned(electronTaskId, false)) : Promise.resolve(),
    ]);
    broadcastToRenderer('yd-nim:action', { action: 'unpin', taskId, electronTaskId });
    broadcastToRenderer('yd-nim:log', { text: `✓ unpin处理完成: taskId=${taskId}`, time: Date.now() });
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    console.error('[YdNimClient] handleUnpin failed:', errMsg);
    broadcastToRenderer('yd-nim:log', { text: `✗ unpin处理失败: ${errMsg}`, time: Date.now() });
  }
}

async function handleDeleteConversation(_msg: any, ext: any): Promise<void> {
  const { taskId } = ext;
  console.log('[YdNimClient] handleDelete — taskId:', taskId);
  try {
    const electronTaskId = taskIdCache.get(taskId)?.electronTaskId;
    await callLobsterApi('/lobster/conversation/delete', { taskId });
    taskIdCache.delete(taskId);
    if (electronTaskId) {
      electronTaskIdToTaskId.delete(electronTaskId);
      coworkCallbacks?.deleteIosMapping?.(electronTaskId);
      coworkCallbacks?.deleteSession(electronTaskId);
    }
    broadcastToRenderer('yd-nim:action', { action: 'delete', taskId, electronTaskId });
    broadcastToRenderer('yd-nim:log', { text: `✓ delete处理完成: taskId=${taskId}`, time: Date.now() });
  } catch (e: any) {
    const errMsg = e?.message ?? String(e);
    console.error('[YdNimClient] handleDelete failed:', errMsg);
    broadcastToRenderer('yd-nim:log', { text: `✗ delete处理失败: ${errMsg}`, time: Date.now() });
  }
}

// ── Message routing ────────────────────────────────────────────────────────

async function routeIncomingMessage(msg: any): Promise<void> {
  // Only process messages from iOS clients (fromClientType 2).
  // Electron's own sent messages echo back via onReceiveMessages with fromClientType 16
  // and must be ignored to avoid re-processing our own replies.
  if (msg.fromClientType !== 2) {
    return;
  }

  // Parse serverExtension
  let ext: any = null;
  if (msg.serverExtension) {
    try {
      ext = JSON.parse(msg.serverExtension);
    } catch (e) {
      console.warn('[YdNimClient] Failed to parse serverExtension:', msg.serverExtension);
    }
  }

  const action = ext?.action;
  console.log('[YdNimClient] routeMessage — action:', action ?? '(none)', 'from:', msg.senderId, 'text:', msg.text);

  // Broadcast raw received event to renderer (debug UI)
  broadcastToRenderer('yd-nim:message-received', {
    from: msg.senderId ?? 'unknown',
    text: msg.text ?? `[type=${msg.messageType}]`,
    serverId: msg.messageServerId,
    time: msg.createTime ?? Date.now(),
    ext,
  });

  // Route by action
  try {
    if (!action || action === 'normal') {
      await handleNormalMessage(msg, ext);
    } else if (action === 'create') {
      await handleCreateConversation(msg, ext);
    } else if (action === 'update') {
      await handleUpdateConversation(msg, ext);
    } else if (action === 'pin') {
      await handlePinConversation(msg, ext);
    } else if (action === 'unpin') {
      await handleUnpinConversation(msg, ext);
    } else if (action === 'delete') {
      await handleDeleteConversation(msg, ext);
    } else if (action === 'normal_right') {
      // Electron user message echoed back from iOS — just log, do not re-process
      console.log('[YdNimClient] normal_right echo received, taskId:', ext?.taskId);
      broadcastToRenderer('yd-nim:log', { text: `normal_right echo: taskId=${ext?.taskId ?? 'n/a'}`, time: Date.now() });
    } else if (action === 'ack') {
      // Ack from iOS — just log, no further action needed
      console.log('[YdNimClient] iOS ack received, taskId:', ext?.taskId);
      broadcastToRenderer('yd-nim:log', { text: `iOS ack: taskId=${ext?.taskId ?? 'n/a'}`, time: Date.now() });
    } else {
      console.warn('[YdNimClient] Unknown action:', action);
      broadcastToRenderer('yd-nim:log', { text: `未知 action: ${action}`, time: Date.now() });
    }
  } catch (err: any) {
    console.error('[YdNimClient] routeIncomingMessage error:', err?.message ?? err);
    broadcastToRenderer('yd-nim:error', { message: err?.message ?? String(err), time: Date.now() });
  }
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

async function destroyInternal(): Promise<void> {
  if (!v2Client) {
    console.log('[YdNimClient] destroyInternal: no client, skip');
    return;
  }
  console.log('[YdNimClient] destroyInternal: logging out, accid:', currentAccid);
  try {
    if (v2Client.V2NIMLoginService) {
      await v2Client.V2NIMLoginService.logout().catch((e: any) => {
        console.warn('[YdNimClient] Logout error (ignored):', e?.desc ?? e?.message ?? e);
      });
    }
  } catch { /* best-effort */ }
  v2Client = null;
  currentAccid = null;
  initialized = false;
  console.log('[YdNimClient] destroyInternal: done');
  broadcastToRenderer('yd-nim:log', { text: 'NIM 客户端已销毁', time: Date.now() });
}

async function initInternal(ydUserId: string): Promise<void> {
  console.log('[YdNimClient] initInternal start, ydUserId:', ydUserId || '(test mode)');
  await destroyInternal();

  broadcastToRenderer('yd-nim:log', { text: '正在初始化 NIM 客户端…', time: Date.now() });

  try {
    // Step 1: credentials
    console.log('[YdNimClient] Step 1: fetching credentials');
    const { accid, token } = await fetchNimCredentials(ydUserId);
    console.log('[YdNimClient] Step 1 done — accid:', accid);
    broadcastToRenderer('yd-nim:log', { text: `凭证就绪，accid: ${accid}`, time: Date.now() });

    // Step 2: create SDK instance
    console.log('[YdNimClient] Step 2: creating NIM instance, appkey:', YD_NIM_APP_KEY);
    v2Client = new NIM({
      appkey: YD_NIM_APP_KEY,
      debugLevel: 'debug',
      apiVersion: 'v2',
    }) as unknown as V2NIM;
    console.log('[YdNimClient] Step 2 done — v2Client created, services:',
      Object.keys(v2Client as any).filter(k => k.startsWith('V2NIM')));

    if (!v2Client.V2NIMLoginService) throw new Error('V2NIMLoginService not available on SDK instance');

    // Step 3: register message listener with full routing
    console.log('[YdNimClient] Step 3: registering message listener');
    if (v2Client.V2NIMMessageService) {
      v2Client.V2NIMMessageService.on('onReceiveMessages', (messages: any[]) => {
        console.log('[YdNimClient] ← onReceiveMessages fired, count:', messages.length);
        messages.forEach((msg) => {
          routeIncomingMessage(msg).catch((e: any) => {
            console.error('[YdNimClient] routeIncomingMessage unhandled error:', e?.message ?? e);
          });
        });
      });
      console.log('[YdNimClient] Step 3 done — onReceiveMessages registered');
    } else {
      console.warn('[YdNimClient] Step 3: V2NIMMessageService not available, skipping listener');
    }

    // Step 4: register login status listeners
    console.log('[YdNimClient] Step 4: registering login listeners');
    v2Client.V2NIMLoginService.on('onLoginStatus', (status: number) => {
      const statusLabel = status === 0 ? 'LOGOUT(0)' : status === 1 ? 'LOGINED(1)' : status === 2 ? 'LOGINING(2)' : `UNKNOWN(${status})`;
      console.log('[YdNimClient] onLoginStatus:', statusLabel);
      if (status === 1) {
        initialized = true;
        currentAccid = accid;
        console.log('[YdNimClient] ✓ Login successful — initialized=true, accid:', accid);
        broadcastToRenderer('yd-nim:log', { text: `✓ NIM 登录成功，accid: ${accid}`, time: Date.now() });
      } else if (status === 2) {
        console.log('[YdNimClient] Logging in…');
        broadcastToRenderer('yd-nim:log', { text: `NIM 登录中，accid: ${accid}…`, time: Date.now() });
      } else if (status === 0) {
        initialized = false;
        console.log('[YdNimClient] Logged out');
        broadcastToRenderer('yd-nim:log', { text: `NIM 已登出，accid: ${accid}`, time: Date.now() });
      }
    });

    v2Client.V2NIMLoginService.on('onLoginFailed', (error: any) => {
      const desc = error?.desc ?? JSON.stringify(error);
      const code = error?.code ?? 'n/a';
      console.error('[YdNimClient] ✗ onLoginFailed — code:', code, 'desc:', desc);
      broadcastToRenderer('yd-nim:log', { text: `✗ NIM 登录失败 code=${code}: ${desc}`, time: Date.now() });
    });

    v2Client.V2NIMLoginService.on('onDisconnected', (error: any) => {
      const desc = error?.desc ?? JSON.stringify(error);
      const code = error?.code ?? 'n/a';
      console.warn('[YdNimClient] onDisconnected — code:', code, 'desc:', desc);
      initialized = false;
      broadcastToRenderer('yd-nim:log', { text: `NIM 连接断开 code=${code}: ${desc}`, time: Date.now() });
    });

    v2Client.V2NIMLoginService.on('onKickedOffline', (reason: any) => {
      console.warn('[YdNimClient] onKickedOffline — reason:', JSON.stringify(reason));
      initialized = false;
      broadcastToRenderer('yd-nim:log', { text: `NIM 被踢下线: ${JSON.stringify(reason)}`, time: Date.now() });
    });
    console.log('[YdNimClient] Step 4 done — all login listeners registered');

    // Step 5: call login
    console.log('[YdNimClient] Step 5: calling login(), accid:', accid, 'token:', token.slice(0, 8) + '…');
    broadcastToRenderer('yd-nim:log', { text: `调用 login()，accid: ${accid}…`, time: Date.now() });
    v2Client.V2NIMLoginService.login(accid, token, {}).then(() => {
      console.log('[YdNimClient] login() promise resolved');
    }).catch((err: any) => {
      const code = err?.code;
      const desc = err?.desc ?? err?.message ?? String(err);
      if (code === 191002) {
        console.log('[YdNimClient] login() rejected with 191002 (already logged in elsewhere) — ignored');
      } else {
        console.error('[YdNimClient] login() promise rejected — code:', code, 'desc:', desc);
        broadcastToRenderer('yd-nim:log', { text: `login() 异常 code=${code}: ${desc}`, time: Date.now() });
      }
    });
    console.log('[YdNimClient] Step 5: login() called (async, awaiting status callback)');

  } catch (err: any) {
    const msg = err.message ?? String(err);
    console.error('[YdNimClient] initInternal failed:', msg, err);
    broadcastToRenderer('yd-nim:log', { text: `✗ NIM 初始化失败: ${msg}`, time: Date.now() });
    await destroyInternal();
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function initYdNimClient(ydUserId: string): Promise<void> {
  console.log('[YdNimClient] initYdNimClient called, ydUserId:', ydUserId || '(empty)');
  const previous = lifecyclePromise;
  let resolve!: () => void;
  lifecyclePromise = new Promise<void>(r => { resolve = r; });
  try {
    await previous.catch(() => {});
    await initInternal(ydUserId);
  } finally {
    resolve();
    console.log('[YdNimClient] initYdNimClient lifecycle slot released');
  }
}

export async function destroyYdNimClient(): Promise<void> {
  console.log('[YdNimClient] destroyYdNimClient called');
  const previous = lifecyclePromise;
  let resolve!: () => void;
  lifecyclePromise = new Promise<void>(r => { resolve = r; });
  try {
    await previous.catch(() => {});
    if (!v2Client) {
      console.log('[YdNimClient] destroyYdNimClient: already destroyed, skip');
      return;
    }
    await destroyInternal();
  } finally {
    resolve();
  }
}

/**
 * Send a plain text message to self (no ext). Called from the renderer via IPC.
 */
export async function sendYdNimMessage(text: string): Promise<void> {
  console.log('[YdNimClient] sendYdNimMessage called, text:', text,
    '| state: initialized=', initialized, 'accid=', currentAccid);
  try {
    const serverId = await doSendMessage(text);
    console.log('[YdNimClient] sendYdNimMessage ✓ OK, serverId:', serverId ?? 'n/a');
    broadcastToRenderer('yd-nim:message-sent', { text, time: Date.now(), serverId });
  } catch (err: any) {
    const error = err?.desc ?? err?.message ?? String(err);
    console.error('[YdNimClient] sendYdNimMessage ✗ failed:', error);
    broadcastToRenderer('yd-nim:message-sent', { text, time: Date.now(), error });
    throw err;
  }
}

/**
 * Send a structured message with serverExtension. Called from the renderer via IPC.
 */
export async function sendExtYdNimMessage(text: string, ext: object): Promise<void> {
  console.log('[YdNimClient] sendExtYdNimMessage called, text:', text, 'ext:', ext);
  try {
    const serverId = await doSendMessage(text, ext);
    console.log('[YdNimClient] sendExtYdNimMessage ✓ OK, serverId:', serverId ?? 'n/a');
    broadcastToRenderer('yd-nim:message-sent', { text, time: Date.now(), serverId, ext });
  } catch (err: any) {
    const error = err?.desc ?? err?.message ?? String(err);
    console.error('[YdNimClient] sendExtYdNimMessage ✗ failed:', error);
    broadcastToRenderer('yd-nim:message-sent', { text, time: Date.now(), error, ext });
    throw err;
  }
}

export function isYdNimClientReady(): boolean {
  return initialized;
}

export function getYdNimAccid(): string | null {
  return currentAccid;
}

export function setYdNimCoworkCallbacks(callbacks: IosCoworkCallbacks): void {
  coworkCallbacks = callbacks;
  console.log('[YdNimClient] Cowork callbacks registered');
}

export function getTaskIdForElectronSession(sessionId: string): string | undefined {
  return electronTaskIdToTaskId.get(sessionId);
}

/**
 * Like getTaskIdForElectronSession, but falls back to a server-side reverse lookup
 * (/conversation/getByElectronTaskId) when the in-memory map has no entry.
 *
 * Only performs the server call when the NIM SDK is initialized (i.e. a yid
 * session is active), so Electron-only sessions that never talked to iOS will
 * never trigger a round-trip.  Results are cached in the in-memory map and
 * persisted to SQLite via the persistIosMapping callback so future calls are
 * instant.
 */
export async function resolveIosTaskIdForElectronSession(electronTaskId: string): Promise<string | undefined> {
  const cached = electronTaskIdToTaskId.get(electronTaskId);
  if (cached) return cached;

  // Guard: only attempt server lookup when the NIM SDK is active (yid context).
  if (!initialized) return undefined;

  try {
    const data = await callLobsterApi('/lobster/conversation/getByElectronTaskId', { electronTaskId });
    // Support both { conversation: { taskId } } and { taskId } response shapes.
    const iosTaskId: string | undefined = data?.conversation?.taskId ?? data?.taskId;
    if (iosTaskId) {
      electronTaskIdToTaskId.set(electronTaskId, iosTaskId);
      taskIdCache.set(iosTaskId, { electronTaskId });
      coworkCallbacks?.persistIosMapping?.(electronTaskId, iosTaskId);
      console.log('[YdNimClient] resolveIosTaskIdForElectronSession — recovered', electronTaskId, '→', iosTaskId);
      broadcastToRenderer('yd-nim:log', { text: `[恢复映射] electronTaskId=${electronTaskId} → iosTaskId=${iosTaskId}`, time: Date.now() });
    }
    return iosTaskId;
  } catch (e: any) {
    const msg: string = e?.message ?? String(e);
    // 4009 = conversation not found on server → this is a pure Electron session, not an error.
    if (!msg.includes('4009')) {
      console.warn('[YdNimClient] resolveIosTaskIdForElectronSession failed:', msg);
    }
    return undefined;
  }
}

/**
 * Restore electronTaskId ↔ iosTaskId mappings from persistent storage (SQLite).
 * Call once on app startup before any messages can arrive.
 */
export function restoreTaskIdMappings(entries: Array<{ electronTaskId: string; iosTaskId: string }>): void {
  for (const { electronTaskId, iosTaskId } of entries) {
    electronTaskIdToTaskId.set(electronTaskId, iosTaskId);
    taskIdCache.set(iosTaskId, { electronTaskId });
  }
  console.log('[YdNimClient] restoreTaskIdMappings — restored', entries.length, 'mappings');
}

/**
 * Remap an electronTaskId after a CoworkSession is recreated for an iOS task.
 * Updates in-memory maps, triggers SQLite persist/delete via callbacks, and
 * notifies the Lobster server of the new electronTaskId.
 */
export async function remapElectronTaskId(oldElectronTaskId: string, newElectronTaskId: string): Promise<void> {
  const iosTaskId = electronTaskIdToTaskId.get(oldElectronTaskId);
  if (!iosTaskId) {
    console.warn('[YdNimClient] remapElectronTaskId — no mapping for', oldElectronTaskId);
    return;
  }
  electronTaskIdToTaskId.delete(oldElectronTaskId);
  electronTaskIdToTaskId.set(newElectronTaskId, iosTaskId);
  taskIdCache.set(iosTaskId, { electronTaskId: newElectronTaskId });
  coworkCallbacks?.persistIosMapping?.(newElectronTaskId, iosTaskId);
  coworkCallbacks?.deleteIosMapping?.(oldElectronTaskId);
  console.log('[YdNimClient] remapElectronTaskId', oldElectronTaskId, '→', newElectronTaskId, 'iosTaskId:', iosTaskId);
  await callLobsterApi('/lobster/conversation/electron-task-id/update', {
    taskId: iosTaskId,
    electronTaskId: newElectronTaskId,
  });
}

export interface NimMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

/**
 * Upload messages to the Lobster server.
 * Called directly from handlers (e.g. user message on receipt in handleNormalMessage)
 * and via IPC from the renderer (e.g. assistant messages after agent completes).
 */
export async function saveConversationMessages(taskId: string, messages: NimMessage[]): Promise<void> {
  console.log('[YdNimClient] saveConversationMessages — taskId:', taskId, 'count:', messages.length);
  await callLobsterApi('/lobster/conversation/message/save', { taskId, messages });
  console.log('[YdNimClient] saveConversationMessages ✓');
}

export interface SimulateIosParams {
  action?: string;   // create | update | pin | unpin | delete | ack | undefined (normal)
  taskId?: string;
  title?: string;
  text?: string;
}

/**
 * Simulate an incoming iOS NIM message by constructing a fake message object
 * and feeding it directly into routeIncomingMessage. Bypasses NIM SDK entirely —
 * useful for local testing without an iOS device.
 */
export async function simulateIncomingMessage(params: SimulateIosParams): Promise<void> {
  const { action, taskId, title, text = '' } = params;
  const ext: Record<string, string> = {};
  if (action) ext.action = action;
  if (taskId) ext.taskId = taskId;
  if (title) ext.title = title;

  const fakeMsg = {
    conversationType: 1,
    senderId: currentAccid ?? 'sim-sender',
    receiverId: currentAccid ?? 'sim-sender',
    fromClientType: 2,  // simulate iOS client
    createTime: Date.now(),
    messageType: 0,
    text,
    serverExtension: Object.keys(ext).length > 0 ? JSON.stringify(ext) : undefined,
    messageClientId: `sim-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    messageServerId: `sim-${Date.now()}`,
    isSelf: false,
  };

  console.log('[YdNimClient] simulateIncomingMessage —', JSON.stringify(fakeMsg));
  broadcastToRenderer('yd-nim:log', { text: `[模拟iOS] action=${action ?? 'normal'} taskId=${taskId ?? '-'}`, time: Date.now() });
  await routeIncomingMessage(fakeMsg);
}
