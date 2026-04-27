import { classicDark }  from './classic-dark';
import { classicLight } from './classic-light';
import { cyber } from './cyber';
import { dawn } from './dawn';
import { daylight } from './daylight';
import { emerald } from './emerald';
import { midnight } from './midnight';
import { mocha } from './mocha';
import { nord } from './nord';
import { ocean } from './ocean';
import { paper } from './paper';
import { rose } from './rose';
import { sakura } from './sakura';
import { sunset } from './sunset';
import type { ThemeDefinition } from './types';

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
