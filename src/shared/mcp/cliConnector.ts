export const cliConnectorIds = ['connector-wecom', 'connector-feishu', 'connector-dingtalk', 'connector-github', 'baidu-drive'] as const;
export type CliConnectorId = typeof cliConnectorIds[number];

export function isCliConnectorId(id: unknown): id is CliConnectorId {
  return cliConnectorIds.some(supported => supported === id);
}
