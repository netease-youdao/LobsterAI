import type { Agent, CreateAgentRequest } from '../types/agent';

export const AGENT_TEMPLATE_SCHEMA_VERSION = 1;

export interface AgentTemplate {
  schemaVersion: number;
  name: string;
  description: string;
  icon: string;
  systemPrompt: string;
  identity: string;
  model: string;
  skillIds: string[];
}

/** Serialize an Agent to a portable template object. */
export function agentToTemplate(agent: Agent): AgentTemplate {
  return {
    schemaVersion: AGENT_TEMPLATE_SCHEMA_VERSION,
    name: agent.name,
    description: agent.description,
    icon: agent.icon,
    systemPrompt: agent.systemPrompt,
    identity: agent.identity,
    model: agent.model,
    skillIds: agent.skillIds ?? [],
  };
}

/** Validate and parse a plain object as an AgentTemplate. */
export function parseAgentTemplate(raw: unknown): AgentTemplate {
  if (!raw || typeof raw !== 'object') throw new Error('invalid');
  const obj = raw as Record<string, unknown>;
  if (typeof obj['name'] !== 'string' || !obj['name']) throw new Error('invalid');
  return {
    schemaVersion: typeof obj['schemaVersion'] === 'number' ? obj['schemaVersion'] : 1,
    name: obj['name'] as string,
    description: typeof obj['description'] === 'string' ? obj['description'] : '',
    icon: typeof obj['icon'] === 'string' ? obj['icon'] : '🤖',
    systemPrompt: typeof obj['systemPrompt'] === 'string' ? obj['systemPrompt'] : '',
    identity: typeof obj['identity'] === 'string' ? obj['identity'] : '',
    model: typeof obj['model'] === 'string' ? obj['model'] : '',
    skillIds: Array.isArray(obj['skillIds']) ? (obj['skillIds'] as string[]).filter(s => typeof s === 'string') : [],
  };
}

/** Convert a template to a CreateAgentRequest (ready to send to agentService). */
export function templateToCreateRequest(tpl: AgentTemplate, nameSuffix = ''): CreateAgentRequest {
  return {
    name: tpl.name + nameSuffix,
    description: tpl.description,
    icon: tpl.icon,
    systemPrompt: tpl.systemPrompt,
    identity: tpl.identity,
    model: tpl.model,
    skillIds: tpl.skillIds,
    source: 'custom',
  };
}

/** Trigger a JSON file download in the browser/renderer. */
export function downloadTemplate(tpl: AgentTemplate): void {
  const json = JSON.stringify(tpl, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${tpl.name.replace(/[^\w\u4e00-\u9fa5-]/g, '_')}.agent.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Read a File object and parse it as AgentTemplate */
export async function readTemplateFromFile(file: File): Promise<AgentTemplate> {
  const text = await file.text();
  const raw = JSON.parse(text);
  return parseAgentTemplate(raw);
}

/** Fetch a URL and parse it as AgentTemplate */
export async function fetchTemplateFromUrl(url: string): Promise<AgentTemplate> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const raw = await resp.json();
  return parseAgentTemplate(raw);
}
