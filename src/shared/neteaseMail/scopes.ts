import { NeteaseMailDefaultScopes, NeteaseMailReadTools, NeteaseMailScope, NeteaseMailTool } from './constants';

/** Profiles created before scope persistence were strictly read-only. */
export function getNeteaseMailScopes(scope?: string): NeteaseMailScope[] {
  if (scope === undefined) return [NeteaseMailScope.Read];
  const known = new Set<string>(Object.values(NeteaseMailScope));
  return [...new Set(scope.trim().split(/\s+/))].filter((value): value is NeteaseMailScope => known.has(value));
}

export function getNeteaseMailRequestedScopes(allowDelete = false): NeteaseMailScope[] {
  return [...NeteaseMailDefaultScopes, ...(allowDelete ? [NeteaseMailScope.Delete] : [])];
}

/** Protected writes are supplied by the desktop confirmation adapter, never raw MCP tools. */
export function getNeteaseMailNativeTools(scopes: readonly string[]): NeteaseMailTool[] {
  return [
    ...(scopes.includes(NeteaseMailScope.Read) ? NeteaseMailReadTools : []),
    ...(scopes.includes(NeteaseMailScope.Profile) ? [NeteaseMailTool.GetProfile] : []),
    ...(scopes.includes(NeteaseMailScope.Compose) ? [NeteaseMailTool.CreateDraft, NeteaseMailTool.UpdateDraft] : []),
  ];
}
