'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = {
  description: 'allow the desktop owner to verify acceptance of a forwarded decision',
  apply(runtimeRoot) {
    const file = path.join(runtimeRoot, 'node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js');
    let source = fs.readFileSync(file, 'utf8');
    if (source.includes('plugin:lobsterai/remote-decision')) return 'receipt endpoint already installed';
    function replace(from, to) {
      if (source.split(from).length !== 2) throw new Error('DSH waterfall receipt patch does not match pinned gateway');
      source = source.replace(from, () => to);
    }
    replace('import { randomUUID } from "node:crypto";', 'import { appendPluginRecord } from "@deepseek-ai/dsh-session";\nimport { createHash, randomUUID } from "node:crypto";');
    for (const suffix of [' return true;', ' try {']) {
      replace('if (endpoint === "$events/result")' + suffix,
        'if (["$events/result","$events/lobster-result","$events/lobster-capabilities"].includes(endpoint))' + suffix);
    }
    replace('const result = parseRemoteEventResultPayload(payload);',
      'if (endpoint === "$events/lobster-capabilities") return { ok: true, value: { receipts: 1 } };\n\t\t\tconst result = parseRemoteEventResultPayload(payload);');
    replace('this.receiveRemoteEventResult(client, result);', `if (endpoint === "$events/lobster-result") {
        const pending = this.pendingRemoteEvents.get(result.eventId);
        if (!pending || !pending.deliveries.has(client)) return { ok: true, value: { eventId: result.eventId, applied: false } };
        const agent = this.ctx.get("agents")?.get(pending.frame.agentId);
        const outcomeHash = createHash("sha256").update(JSON.stringify(result.outcome)).digest("hex");
        this.receiveRemoteEventResult(client, result);
        // The correlated affirmative receipt follows actual synchronous settlement.
        // Only a digest is recorded, never a question answer, credential or command.
        if (agent) appendPluginRecord(agent.session, "plugin:lobsterai/remote-decision", {eventId: result.eventId, outcomeHash});
        return { ok: true, value: { eventId: result.eventId, applied: true } };
      }
      this.receiveRemoteEventResult(client, result);`);
    fs.writeFileSync(file, source);
    return 'installed owner decision receipt';
  },
};
