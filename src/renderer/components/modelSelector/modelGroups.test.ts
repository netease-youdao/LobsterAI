import { expect, test } from 'vitest';

import type { Model } from '../../store/slices/modelSlice';
import { groupModelChoices, modelFamily } from './modelGroups';

const model = (id: string, name: string, extra: Partial<Model> = {}): Model => ({
  id,
  name,
  ...extra,
});

test('groups families in catalog order without mixing versions or variants', () => {
  const models = [
    model('a', 'DeepSeek V4 Flash'),
    model('b', 'Qwen Flash'),
    model('c', 'DeepSeek V4 Pro'),
  ];
  const groups = groupModelChoices(models);
  expect(groups.map(group => group.name)).toEqual(['DeepSeek', 'Qwen']);
  expect(groups[0].choices.map(choice => choice.name)).toEqual([
    'DeepSeek V4 Flash',
    'DeepSeek V4 Pro',
  ]);
  expect(models.map(item => item.id)).toEqual(['a', 'b', 'c']);
});

test('merges display duplicates while preserving exact routing objects and capability differences', () => {
  const first = model('flash', 'DeepSeek Flash', { isServerModel: true, supportsImage: true });
  const second = model('flash-text', 'DeepSeek Flash', {
    isServerModel: true,
    supportsImage: false,
    accessible: false,
  });
  const routes = groupModelChoices([first, second, first])[0].choices[0].routes;
  expect(routes).toEqual([first, second]);
  expect(routes[0]).toBe(first);
  expect(routes[1]).toBe(second);
});

test('does not merge independently configured providers or server and user models', () => {
  const models = [
    model('same', 'GPT Test', { providerKey: 'custom-a' }),
    model('same', 'GPT Test', { providerKey: 'custom-b' }),
    model('same', 'GPT Test', { isServerModel: true }),
    model('same', 'GPT Test'),
  ];
  expect(groupModelChoices(models)[0].choices).toHaveLength(4);
});

test('searches case-insensitive family, provider, label and route IDs', () => {
  const models = [model('reasoner', 'Research', { provider: 'DeepSeek', providerKey: 'custom' })];
  expect(groupModelChoices(models, ' DEEPSEEK reasoner ')[0].choices[0].routes[0]).toBe(models[0]);
  expect(groupModelChoices(models, 'custom')).toHaveLength(1);
  expect(groupModelChoices(models, 'missing')).toEqual([]);
  expect(groupModelChoices([], 'test')).toEqual([]);
});

test('recognizes reasoning aliases and uses configured labels for unknown families', () => {
  expect(modelFamily(model('o3-mini', 'o3-mini'))).toBe('GPT');
  expect(modelFamily(model('qwq', 'Reasoner'))).toBe('Qwen');
  expect(modelFamily(model('local', 'Local', { provider: 'My server' }))).toBe('My server');
});

test('a route ID search keeps sibling routes and their numbering stable', () => {
  const first = model('primary', 'DeepSeek Flash', { isServerModel: true });
  const second = model('backup', 'DeepSeek Flash', { isServerModel: true });
  expect(groupModelChoices([first, second], 'backup')[0].choices[0].routes).toEqual([
    first,
    second,
  ]);
});
