// A WeCom AI bot accepts one active WebSocket subscription per Bot ID.
export function activeWecomBotId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  const config = value as Record<string, unknown>;
  const text = (field: unknown) => typeof field === 'string' ? field.trim() : '';
  if (config.enabled !== true || text(config.webhookUrl) || text(config.corpId)) return;
  if (!text(config.secret || config.corpSecret)) return;
  return text(config.botId) || undefined;
}

export function wecomDuplicateOwners(instances: readonly unknown[]): Map<string, string> {
  const owners = new Map<string, string>();
  const duplicates = new Map<string, string>();
  for (const instance of instances) {
    const botId = activeWecomBotId(instance);
    if (!botId) continue;
    const { instanceId, instanceName } = instance as { instanceId?: string; instanceName?: string };
    if (!instanceId) continue;
    const owner = owners.get(botId);
    if (owner) duplicates.set(instanceId, owner);
    else owners.set(botId, instanceName || instanceId);
  }
  return duplicates;
}
