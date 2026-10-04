import type { Model } from '../../store/slices/modelSlice';
import { getModelIdentityKey } from '../../store/slices/modelSlice';

const FAMILIES = [
  ['DeepSeek', /deepseek/i],
  ['Qwen', /qwen|qwq|qvq/i],
  ['GPT', /gpt|openai|^o[134](?:\b|-)/i],
  ['Claude', /claude|anthropic/i],
  ['Gemini', /gemini/i],
  ['Kimi', /kimi|moonshot/i],
  ['GLM', /glm|zhipu/i],
  ['MiniMax', /minimax/i],
  ['Grok', /grok/i],
  ['Doubao', /doubao|豆包/i],
  ['HY', /hy3|hunyuan/i],
] as const;

export function modelFamily(model: Model): string {
  return (
    FAMILIES.find(([, pattern]) => pattern.test(`${model.name} ${model.id}`))?.[0] ??
    model.provider ??
    model.providerKey ??
    model.name
  );
}

export interface ModelChoice {
  key: string;
  name: string;
  routes: Model[];
}

export interface ModelFamilyGroup {
  name: string;
  choices: ModelChoice[];
}

/** Merge display duplicates, retaining every provider/model identity and route order. */
export function groupModelChoices(models: readonly Model[], query = ''): ModelFamilyGroup[] {
  const families = new Map<string, ModelFamilyGroup>();
  const choices = new Map<string, ModelChoice>();
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const model of models) {
    const family = modelFamily(model);
    const name = model.name.trim();
    // Custom providers may intentionally assign the same label to different models.
    // Keep them separate; server aliases can share a row with explicit routes.
    const key = JSON.stringify([
      family,
      model.isServerModel === true,
      model.providerKey ?? '',
      name.toLowerCase().replace(/\s+/g, ' '),
    ]);
    let choice = choices.get(key);
    if (!choice) {
      choice = { key, name, routes: [] };
      choices.set(key, choice);
      if (!families.has(family)) families.set(family, { name: family, choices: [] });
      families.get(family)!.choices.push(choice);
    }
    if (!choice.routes.some(route => getModelIdentityKey(route) === getModelIdentityKey(model))) {
      choice.routes.push(model);
    }
  }
  return [...families.values()]
    .map(group => ({
      ...group,
      choices: group.choices
        .filter(choice =>
          choice.routes.some(model => {
            const searchable =
              `${group.name} ${model.name} ${model.id} ${model.provider ?? ''} ${model.providerKey ?? ''}`.toLowerCase();
            return terms.every(term => searchable.includes(term));
          }),
        )
        .sort(
          (left, right) =>
            Number(left.routes.every(route => route.accessible === false)) -
            Number(right.routes.every(route => route.accessible === false)),
        ),
    }))
    .filter(group => group.choices.length > 0);
}
