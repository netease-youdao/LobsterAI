import type { ThemeDefinition } from './types';

import { classicLight } from './classic-light';
import { classicDark }  from './classic-dark';
import { dawn } from './dawn';
import { daylight } from './daylight';
import { paper } from './paper';
import { sakura } from './sakura';
import { midnight } from './midnight';
import { ocean } from './ocean';
import { emerald } from './emerald';
import { rose } from './rose';
import { mocha } from './mocha';
import { sunset } from './sunset';
import { nord } from './nord';
import { cyber } from './cyber';

/** All built-in themes. First entry is the default. */
export const allThemes: ThemeDefinition[] = [
  classicLight,
  classicDark,
  dawn,
  daylight,
  paper,
  sakura,
  midnight,
  ocean,
  emerald,
  rose,
  mocha,
  sunset,
  nord,
  cyber,
];

/** Quick lookup by theme ID */
export const themeMap = new Map(allThemes.map((t) => [t.meta.id, t]));
