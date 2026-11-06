import React from 'react';

import typeSafeDarkSrc from '../../../assets/brands/typesafe-dark.png';
import typeSafeLightSrc from '../../../assets/brands/typesafe-light.png';

// TypeSafe ships no SVG mark, so these are the official docs.typesafe.ai
// favicons: black for light themes, white for dark ones. The theme manager
// sets the `dark` class for every dark theme, so `dark:` picks the right one.
const TypeSafeIcon: React.FC<{ className?: string }> = ({ className = 'h-5 w-5' }) => (
  <>
    <img
      src={typeSafeLightSrc}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`${className} object-contain dark:hidden`}
    />
    <img
      src={typeSafeDarkSrc}
      alt=""
      aria-hidden="true"
      draggable={false}
      className={`${className} hidden object-contain dark:block`}
    />
  </>
);

export default TypeSafeIcon;
