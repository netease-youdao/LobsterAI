import { expect, test } from 'vitest';

import { getTruncatedTitleState } from './truncatedTitle';

test('getTruncatedTitleState falls back to the default title when the name is blank', () => {
  expect(getTruncatedTitleState('', 'Create Agent')).toEqual({
    displayTitle: 'Create Agent',
    tooltipContent: null,
  });
});

test('getTruncatedTitleState trims the custom name and uses it for the tooltip', () => {
  expect(getTruncatedTitleState('  A very long custom agent name  ', 'Create Agent')).toEqual({
    displayTitle: 'A very long custom agent name',
    tooltipContent: 'A very long custom agent name',
  });
});
