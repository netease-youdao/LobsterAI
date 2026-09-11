'use strict';

const { createOpenClawRuntimePayload, OpenClawPayloadTarget } = require('./openclaw-runtime-payload.cjs');

function createOpenClawWindowsPayload(runtimeRoot, targetId) {
  if (targetId !== OpenClawPayloadTarget.WindowsX64) return { filter: () => true };
  return createOpenClawRuntimePayload(runtimeRoot, targetId);
}

module.exports = { createOpenClawWindowsPayload };
