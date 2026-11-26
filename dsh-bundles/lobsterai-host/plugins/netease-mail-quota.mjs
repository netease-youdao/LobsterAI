export const name = 'lobster-netease-mail-quota';
export const inject = ['tools', 'systemPrompt'];

const RATE_LIMITED = '42901';
const nativeToolPrefix = 'mcp__netease-mail__netease_mail_';
const confirmationTools = new Set([
  'netease_mail_send_message', 'netease_mail_reply_message',
  'netease_mail_forward_message', 'netease_mail_trash_message',
]);
const quotaInstruction = 'NetEase Mail has reached its request or sending limit. Tell the user now which mail work remains. Further mail calls are disabled until a new user request. Do not wait, schedule a retry, or use another tool to complete the mail operation.';
const quotaDenial = JSON.stringify({ error: { code: RATE_LIMITED, message: quotaInstruction } });

function isMailTool(tool) {
  return typeof tool === 'string' && (tool.startsWith(nativeToolPrefix) || confirmationTools.has(tool));
}

function isQuotaResult(tool, result) {
  if (confirmationTools.has(tool)) {
    const receipt = result.meta?.lobsterToolResult;
    return receipt?.isError === true && String(receipt.details?.code) === RATE_LIMITED;
  }
  if (!result.isError || typeof result.error?.message !== 'string') return false;
  // DSH's native MCP client throws the provider's JSON error text.
  try { return String(JSON.parse(result.error.message)?.error?.code) === RATE_LIMITED; }
  catch { return false; }
}

export function apply(ctx) {
  const limited = new WeakSet();
  ctx.on('tools/result', (exec, result) => {
    if (exec.agent?.session && isMailTool(exec.name) && isQuotaResult(exec.name, result)) {
      limited.add(exec.agent.session);
    }
  });
  // Runtime context, background job completions and later model steps cannot reopen the gate.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message?.source?.kind === 'user' && agent?.session) limited.delete(agent.session);
  });
  const dispose = ctx.tools.guard(exec => {
    if (limited.has(exec.agent?.session) && isMailTool(exec.name)) return quotaDenial;
  });
  ctx.effect(() => dispose, 'NetEase Mail quota guard');
  ctx.systemPrompt.context({
    name: 'lobsterai:netease-mail-quota',
    order: ctx.systemPrompt.getContextOrder('APPROVAL_POLICY'),
    interpolate: false,
    text: ({ agent }) => limited.has(agent?.session) ? quotaInstruction : '',
  });
}
