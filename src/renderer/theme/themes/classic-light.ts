import { SHARED_TOKENS } from '../tokens/shared';
import type { ThemeDefinition } from './types';

export const classicLight: ThemeDefinition = {
  meta: {
    id: 'classic-light',
    name: '经典浅色',
    description: '原生默认浅色主题，中性灰白',
    appearance: 'light',
    preview: ['#F5F5F5', '#3B82F6', '#60A5FA', '#808080'],
  },
  tokens: {
    ...SHARED_TOKENS,
    'primary':            '#3B82F6',
    'primary-foreground': '#ffffff',
    'primary-hover':      '#2563EB',
    'primary-muted':      'rgba(59,130,246,0.10)',
    'accent':             '#3B82F6',
    'accent-foreground':  '#ffffff',
    // Neutral grays with no blue cast: a pure white canvas framed by a light
    // gray shell, soft near-black text, and alpha borders that read the same
    // on both surfaces.
    'background':         '#FFFFFF',
    'foreground':         '#1A1A1A',
    'surface':            '#FFFFFF',
    'surface-foreground': '#1A1A1A',
    'surface-raised':     '#F5F5F5',
    'surface-overlay':    'rgba(245,245,245,0.92)',
    // The canvas is white, so the user bubble needs its own fill instead of
    // the surface color it uses in themes with a tinted canvas.
    'chat-user':          '#F4F4F4',
    'chat-user-foreground': '#1A1A1A',
    'chat-bot':           '#F5F5F5',
    'chat-bot-foreground': '#1A1A1A',
    'text-primary':       '#1A1A1A',
    'text-secondary':     '#808080',
    'text-muted':         '#A3A3A3',
    'border':             'rgba(0,0,0,0.06)',
    'border-subtle':      'rgba(0,0,0,0.04)',
    'input-border':       'rgba(0,0,0,0.08)',
    'scroll-thumb':       '#D4D4D4',
    'scroll-thumb-hover': '#A3A3A3',
    'gradient-1':         'rgba(59,130,246,0.06)',
    'gradient-2':         'rgba(59,130,246,0.02)',
    'gray-1':  '#FAFAFA',
    'gray-2':  '#F5F5F5',
    'gray-3':  '#EEEEEE',
    'gray-4':  '#E5E5E5',
    'gray-5':  '#A3A3A3',
    'gray-6':  '#808080',
    'gray-7':  '#525252',
    'gray-8':  '#404040',
    'gray-9':  '#262626',
    'gray-10': '#1A1A1A',
    'gray-11': '#111111',
  },
};
