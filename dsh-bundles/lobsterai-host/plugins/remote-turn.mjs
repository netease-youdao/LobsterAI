// Session-local durable evidence. Inherited input belongs to the original request's session.
const UNKNOWN = 'unknown';
const CANCELLED = 'cancelled';

export function inspectRemoteTurn(events, inheritedCount, requestId, afterSeq, interaction) {
  const replay = Number.isSafeInteger(afterSeq) && afterSeq >= -1;
  const records = [];
  let turnRecords = [];
  let hasMore = false;
  const queues = { 'next-turn': [], 'next-step': [] };
  const inheritedIds = new Set();
  const pendingChildren = new Set();
  const pendingCalls = new Map();
  const claimedMessages = new Set();
  let accepted = false;
  let openTurn = null;
  let ownedTurn = null;
  let sharedTurn = false;
  let status = UNKNOWN;
  const sourceId = message => ['user', 'retry'].includes(message?.source?.kind) ? message.source.rpcId : undefined;
  const owns = message => !inheritedIds.has(message.id) && sourceId(message) === requestId;
  const claim = message => {
    if (openTurn === null || claimedMessages.has(message.id)) return;
    claimedMessages.add(message.id);
    if (owns(message)) {
      ownedTurn = openTurn;
      status = 'running';
    } else if (message.source?.kind === 'subagent-settled' && pendingChildren.has(message.source.senderSessionId)) {
      ownedTurn = openTurn;
      status = 'running';
      pendingChildren.delete(message.source.senderSessionId);
    } else if (['user', 'retry', 'subagent-settled'].includes(message.source?.kind)) {
      sharedTurn = true;
    }
  };
  for (const event of events) {
    const { type, seq, data } = event;
    const inherited = seq < inheritedCount;
    if (type === 'turn/start') pendingCalls.clear();
    if (!inherited && openTurn !== null && ownedTurn === openTurn && type === 'tool/call') pendingCalls.set(data.callId, data.name);
    if (type === 'tool/result') pendingCalls.delete(data.callId ?? data.message?.toolCallId ?? data.message?.callId);
    if (type === 'agent/inbox/spliced') {
      const queue = queues[data.target];
      const count = data.removedCount ?? 0;
      if (!queue || !Array.isArray(data.inserted) || !Number.isSafeInteger(data.start)
        || !Number.isSafeInteger(count) || count < 0 || data.start < 0
        || data.start + count > queue.length) return { status: UNKNOWN };
      const removed = queue.splice(data.start, count, ...data.inserted);
      if (inherited) { for (const message of data.inserted) inheritedIds.add(message.id); continue; }
      if (data.outcome === 'canceled' && removed.some(owns)) status = CANCELLED;
      else if (!data.outcome) for (const message of removed) claim(message);
      if (data.inserted.some(owns)) { accepted = true; status = 'queued'; }
    } else if (type === 'user/message') {
      if (inherited) inheritedIds.add(data.id);
      else { if (owns(data)) accepted = true; claim(data); }
    } else if (!inherited && type === 'turn/start') {
      if (!Number.isSafeInteger(data.turn)) return { status: UNKNOWN };
      turnRecords = [];
      openTurn = data.turn;
      sharedTurn = false;
    } else if (replay && !inherited && openTurn !== null && ownedTurn === openTurn
      && seq > afterSeq && ['assistant/message', 'tool/call', 'tool/result'].includes(type)) {
      if (turnRecords.length <= 32) turnRecords.push(event);
      if (type === 'tool/result' && data.meta?.kind === 'activation' && data.meta.childId) pendingChildren.add(data.meta.childId);
    } else if (!inherited && openTurn !== null && ownedTurn === openTurn
      && (type === 'subagent/catalog' || type === 'tool/result' && data.meta?.kind === 'activation')) {
      const childId = data.childId ?? data.meta?.childId;
      if (typeof childId === 'string' && childId) pendingChildren.add(childId);
      else return { status: UNKNOWN };
    } else if (!inherited && type === 'turn/end' && openTurn !== null) {
      if (data.turn !== openTurn) return { status: UNKNOWN };
      if (ownedTurn === openTurn) {
        if (replay && !sharedTurn) {
          for (const row of turnRecords) {
            if (records.length === 32) { hasMore = true; break; }
            records.push(row);
          }
        }
        const reason = data.reason?.kind;
        if (sharedTurn) status = UNKNOWN;
        else if (reason === 'completed') status = pendingChildren.size ? 'running' : 'succeeded';
        else if (reason === 'error' || reason === 'blocked') status = 'failed';
        else if (reason === 'aborted' && data.reason?.reason?.kind === 'user') status = CANCELLED;
        else status = UNKNOWN;
      }
      openTurn = null;
    }
  }
  const queued = [...queues['next-turn'], ...queues['next-step']];
  const pending = queued.filter(owns);
  const interactionOwned = !!interaction && (interaction.childId
    ? pendingChildren.has(interaction.childId) && status === 'running'
    : openTurn !== null && ownedTurn === openTurn && !sharedTurn && (interaction.callId
      ? pendingCalls.get(interaction.callId) === interaction.toolName
      : interaction.toolName === 'ask_user_question' && [...pendingCalls.values()].filter(name => name === interaction.toolName).length === 1));
  return { status, accepted, ...(interaction ? { interactionOwned } : {}), ...(replay ? { records, hasMore } : {}), pendingItem: pending.length === 1 ? pending[0].id : undefined, turn: ownedTurn,
    hasActiveRun: openTurn !== null || queued.length > 0 || pendingChildren.size > 0,
    canCancel: ownedTurn !== null && ownedTurn === openTurn && !sharedTurn && !pendingChildren.size };
}

export async function remoteTurnOperation(ctx, payload, cancel) {
  const { sessionId, requestId } = payload ?? {};
  if (typeof sessionId !== 'string' || !sessionId || typeof requestId !== 'string' || !requestId) return { status: UNKNOWN };
  const agent = ctx.get('agents')?.get(sessionId);
  if (agent) {
    const inspect = () => {
      const evidence = inspectRemoteTurn(agent.session.snapshotEvents(0), agent.session.inheritedEventCount,
        requestId, cancel ? undefined : payload.afterSeq, payload.interaction);
      return agent.status === 'running' || agent.inbox?.hasPending ? { ...evidence, hasActiveRun: true } : evidence;
    };
    const evidence = inspect();
    if (cancel && evidence.status === 'queued' && evidence.pendingItem) {
      const item = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(message => message.id === evidence.pendingItem);
      if (item?.source?.rpcId === requestId) agent.inbox.remove(item.id);
      return inspect();
    }
    if (cancel && evidence.canCancel && evidence.status === 'running') {
      // No await between the conditional proof and cancellation on the host event loop.
      agent.cancel({ kind: 'user' }, { keepInbox: true });
    }
    return evidence;
  }
  const persistence = ctx.get('sessionPersistence');
  if (!persistence) return { status: UNKNOWN };
  // Read durable data directly. The standard cold presentation adds synthetic interruption events.
  const handle = await persistence.open(sessionId, 'read');
  try {
    const { events } = await handle.read(0);
    const evidence = inspectRemoteTurn(events, handle.inheritedEventCount, requestId, cancel ? undefined : payload.afterSeq, payload.interaction);
    if (evidence.status === 'running' || evidence.status === 'queued') {
      // A cold original log can prove earlier acceptance, but has no live owner to observe or cancel.
      return { ...evidence, status: UNKNOWN, canCancel: false, interactionOwned: false };
    }
    return { ...evidence, canCancel: false };
  } finally {
    await handle.close();
  }
}

export async function inspectDecisionReceipt(ctx, payload) {
  const { sessionId, eventId, outcomeHash } = payload ?? {};
  if (!sessionId || !eventId || !/^[0-9a-f]{64}$/u.test(outcomeHash)) return { matched: false };
  const check = events => events.some(event => event.type === 'plugin:lobsterai/remote-decision' && event.ignorable === true
    && event.data.eventId === eventId && event.data.outcomeHash === outcomeHash);
  const live = ctx.get('sessions')?.get(sessionId);
  if (live) return { matched: check(live.snapshotEvents(live.inheritedEventCount)) };
  const store = ctx.get('sessionPersistence');
  if (!store) return { matched: false };
  const handle = await store.open(sessionId, 'read');
  try {
    const { events } = await handle.read(handle.inheritedEventCount);
    return { matched: check(events) };
  } finally {
    await handle.close();
  }
}
