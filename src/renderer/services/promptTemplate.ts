import { store } from '../store';
import {
  setTemplates,
  setLoading,
  setError,
} from '../store/slices/promptTemplateSlice';
import type {
  PromptTemplate,
  TemplateVariable,
  CreateTemplateInput,
  UpdateTemplateInput,
  TemplateListQuery,
} from '../components/prompt-templates/types';
import type {
  RawPromptTemplate,
  RawCreateInput,
  RawUpdateInput,
} from '../../prompt-template/constants';
import { i18nService } from './i18n';

interface SystemVariable {
  name: string;
  resolver: () => string;
}

const SYSTEM_VARIABLES: SystemVariable[] = [
  {
    name: 'DATE',
    resolver: () => new Date().toLocaleDateString(),
  },
  {
    name: 'TIME',
    resolver: () => new Date().toLocaleTimeString(),
  },
  {
    name: 'LANGUAGE',
    resolver: () => i18nService.getLanguage(),
  },
];

/**
 * Extract all unique variable names from template content.
 * Matches `{{VariableName}}` patterns.
 */
export function extractVariableNames(content: string): string[] {
  const regex = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
  const names: string[] = [];
  const seen = new Set<string>();
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      names.push(match[1]);
    }
  }
  return names;
}

/**
 * Check whether a variable name refers to a system variable.
 * System variables use ALL_CAPS naming (e.g. DATE, TIME, LANGUAGE)
 * and are resolved automatically during template rendering.
 */
export function isSystemVariable(name: string): boolean {
  return /^[A-Z_]+$/.test(name);
}

/**
 * Resolve template by replacing `{{var}}` placeholders with values.
 * System variables (ALL_CAPS) are resolved automatically;
 * user variables fall back to the provided map.
 */
export function resolveTemplate(content: string, userValues: Record<string, string>): string {
  const systemVarMap = new Map(
    SYSTEM_VARIABLES.map((sv) => [sv.name, sv.resolver])
  );

  return content.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (match, name: string) => {
    if (isSystemVariable(name)) {
      const resolver = systemVarMap.get(name);
      if (resolver) {
        return resolver();
      }
      return match;
    }
    if (name in userValues) {
      return userValues[name];
    }
    return match;
  });
}

function deserializeTemplate(raw: RawPromptTemplate): PromptTemplate {
  let variables: TemplateVariable[] = [];
  try {
    variables = JSON.parse(raw.variables);
  } catch {
    // Invalid JSON, use empty array
  }
  return {
    id: raw.id,
    title: raw.title,
    content: raw.content,
    description: raw.description ?? undefined,
    category: raw.category ?? undefined,
    variables,
    isStarred: raw.is_starred === 1,
    usedCount: raw.used_count,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

class PromptTemplateService {
  async loadTemplates(query?: TemplateListQuery): Promise<void> {
    store.dispatch(setLoading(true));
    try {
      const rawList = await window.electron.promptTemplates.list(query);
      const templates = rawList.map(deserializeTemplate);
      store.dispatch(setTemplates(templates));
    } catch (error) {
      store.dispatch(setError(error instanceof Error ? error.message : 'Failed to load templates'));
    } finally {
      store.dispatch(setLoading(false));
    }
  }

  async getById(id: string): Promise<PromptTemplate | null> {
    const raw = await window.electron.promptTemplates.get(id);
    if (!raw) return null;
    return deserializeTemplate(raw);
  }

  async create(input: CreateTemplateInput): Promise<PromptTemplate> {
    const rawInput: RawCreateInput = {
      title: input.title,
      content: input.content,
      description: input.description,
      category: input.category,
      variables: JSON.stringify(input.variables),
    };
    const raw = await window.electron.promptTemplates.create(rawInput);
    const template = deserializeTemplate(raw);
    await this.loadTemplates();
    return template;
  }

  async update(id: string, input: UpdateTemplateInput): Promise<PromptTemplate | null> {
    const updates: RawUpdateInput = {};
    if (input.title !== undefined) updates.title = input.title;
    if (input.content !== undefined) updates.content = input.content;
    if (input.description !== undefined) updates.description = input.description;
    if (input.category !== undefined) updates.category = input.category;
    if (input.variables !== undefined) updates.variables = JSON.stringify(input.variables);
    if (input.isStarred !== undefined) updates.is_starred = input.isStarred ? 1 : 0;

    const raw = await window.electron.promptTemplates.update(id, updates);
    if (!raw) return null;
    const template = deserializeTemplate(raw);
    await this.loadTemplates();
    return template;
  }

  async delete(id: string): Promise<void> {
    await window.electron.promptTemplates.delete(id);
    await this.loadTemplates();
  }

  async incrementUsedCount(id: string): Promise<void> {
    window.electron.promptTemplates.incrementUsedCount(id).catch(() => {
      // Silently ignore background counter errors
    });
  }
}

export const promptTemplateService = new PromptTemplateService();
