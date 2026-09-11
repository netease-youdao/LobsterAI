import { expect, test } from 'vitest';

import { ownershipCardPosition } from './position';

test('hover detail is placed to the right, flips left, then below without viewport overflow', () => {
  expect(ownershipCardPosition({ left: 20, right: 270, top: 100, bottom: 130 }, { width: 1200, height: 800 })).toEqual({ left: 280, top: 100, width: 300 });
  expect(ownershipCardPosition({ left: 850, right: 1100, top: 100, bottom: 130 }, { width: 1200, height: 800 })).toEqual({ left: 540, top: 100, width: 300 });
  expect(ownershipCardPosition({ left: 10, right: 270, top: 100, bottom: 130 }, { width: 320, height: 800 })).toEqual({ left: 10, top: 140, width: 300 });
  expect(ownershipCardPosition({ left: 10, right: 270, top: 750, bottom: 780 }, { width: 280, height: 800 })).toEqual({ left: 8, top: 480, width: 264 });
});
