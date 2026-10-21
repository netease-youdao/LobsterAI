import { CompanionAppCategory } from './appCategories';

/** The one-time greeting shown the first time the companion appears. */
export const COMPANION_WELCOME_TOPIC = 'welcome' as const;
export type CompanionHintTopic = CompanionAppCategory | typeof COMPANION_WELCOME_TOPIC;

/** App categories that have a habit hint, with the number of copy variants per category. */
export const COMPANION_HINT_VARIANTS: Partial<Record<CompanionAppCategory, number>> = {
  [CompanionAppCategory.Document]: 2,
  [CompanionAppCategory.Spreadsheet]: 2,
  [CompanionAppCategory.Presentation]: 1,
  [CompanionAppCategory.Mail]: 2,
  [CompanionAppCategory.Browser]: 2,
  [CompanionAppCategory.Chat]: 1,
  [CompanionAppCategory.Files]: 1,
  [CompanionAppCategory.Pdf]: 1,
  [CompanionAppCategory.Calendar]: 1,
  [CompanionAppCategory.Notes]: 1,
};

export const CompanionHintRule = {
  DwellMs: 8_000,
  GlobalGapMs: 20 * 60_000,
  DailyLimit: 3,
  CategoryGapMs: 24 * 60 * 60_000,
  IgnoreLimit: 3,
  LearnedQuietMs: 7 * 24 * 60 * 60_000,
  LaunchQuietMs: 2 * 60_000,
} as const;

export const CompanionHintOutcome = {
  Accepted: 'accepted',
  Dismissed: 'dismissed',
  Ignored: 'ignored',
  Muted: 'muted',
} as const;
export type CompanionHintOutcome = typeof CompanionHintOutcome[keyof typeof CompanionHintOutcome];

export interface CompanionHintCategoryRecord {
  shown: number;
  ignored: number;
  lastShownAt: number;
  acceptedAt: number;
  muted: boolean;
}

export interface CompanionHintLedger {
  day: string;
  shownToday: number;
  lastShownAt: number;
  categories: Partial<Record<CompanionAppCategory, CompanionHintCategoryRecord>>;
}

export interface CompanionHintCandidate {
  category: CompanionAppCategory;
  /** How long the app has been frontmost. */
  dwellMs: number;
  now: number;
  day: string;
  launchedAt: number;
  /** Fullscreen, meeting, snoozed, or another companion surface is open. */
  quiet: boolean;
  ledger: CompanionHintLedger;
}

const EMPTY_RECORD: CompanionHintCategoryRecord = { shown: 0, ignored: 0, lastShownAt: 0, acceptedAt: 0, muted: false };

export function companionHintDay(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function hasCompanionHint(category: CompanionAppCategory | null | undefined): category is CompanionAppCategory {
  return !!category && (COMPANION_HINT_VARIANTS[category] ?? 0) > 0;
}

export function normalizeCompanionHintLedger(value: unknown, day: string): CompanionHintLedger {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<CompanionHintLedger>;
  const categories: CompanionHintLedger['categories'] = {};
  if (raw.categories && typeof raw.categories === 'object') {
    for (const [key, record] of Object.entries(raw.categories)) {
      if (!hasCompanionHint(key as CompanionAppCategory) || !record || typeof record !== 'object') continue;
      const item = record as Partial<CompanionHintCategoryRecord>;
      categories[key as CompanionAppCategory] = {
        shown: finite(item.shown),
        ignored: finite(item.ignored),
        lastShownAt: finite(item.lastShownAt),
        acceptedAt: finite(item.acceptedAt),
        muted: item.muted === true,
      };
    }
  }
  const sameDay = raw.day === day;
  return {
    day,
    shownToday: sameDay ? finite(raw.shownToday) : 0,
    lastShownAt: finite(raw.lastShownAt),
    categories,
  };
}

export function canShowCompanionHint(candidate: CompanionHintCandidate): boolean {
  const { category, now, ledger } = candidate;
  if (!hasCompanionHint(category) || candidate.quiet) return false;
  if (candidate.dwellMs < CompanionHintRule.DwellMs) return false;
  if (now - candidate.launchedAt < CompanionHintRule.LaunchQuietMs) return false;
  const shownToday = ledger.day === candidate.day ? ledger.shownToday : 0;
  if (shownToday >= CompanionHintRule.DailyLimit) return false;
  if (ledger.lastShownAt && now - ledger.lastShownAt < CompanionHintRule.GlobalGapMs) return false;
  const record = ledger.categories[category] ?? EMPTY_RECORD;
  if (record.muted || record.ignored >= CompanionHintRule.IgnoreLimit) return false;
  if (record.lastShownAt && now - record.lastShownAt < CompanionHintRule.CategoryGapMs) return false;
  if (record.acceptedAt && now - record.acceptedAt < CompanionHintRule.LearnedQuietMs) return false;
  return true;
}

export function companionHintVariant(ledger: CompanionHintLedger, category: CompanionAppCategory): number {
  const variants = COMPANION_HINT_VARIANTS[category] ?? 1;
  return (ledger.categories[category]?.shown ?? 0) % variants;
}

export function markCompanionHintShown(
  ledger: CompanionHintLedger,
  category: CompanionAppCategory,
  now: number,
  day: string,
): CompanionHintLedger {
  const record = ledger.categories[category] ?? EMPTY_RECORD;
  return {
    day,
    shownToday: (ledger.day === day ? ledger.shownToday : 0) + 1,
    lastShownAt: now,
    categories: { ...ledger.categories, [category]: { ...record, shown: record.shown + 1, lastShownAt: now } },
  };
}

export function markCompanionHintOutcome(
  ledger: CompanionHintLedger,
  category: CompanionAppCategory,
  outcome: CompanionHintOutcome,
  now: number,
): CompanionHintLedger {
  const record = ledger.categories[category] ?? EMPTY_RECORD;
  let next: CompanionHintCategoryRecord;
  switch (outcome) {
    case CompanionHintOutcome.Accepted:
      // Acting on a hint means the habit landed; stop counting ignores.
      next = { ...record, acceptedAt: now, ignored: 0 };
      break;
    case CompanionHintOutcome.Muted:
      next = { ...record, muted: true };
      break;
    default:
      next = { ...record, ignored: record.ignored + 1 };
  }
  return { ...ledger, categories: { ...ledger.categories, [category]: next } };
}

/** i18n keys for a hint: message, action button, and the prompt the action pre-fills. */
export function companionHintCopyKeys(topic: CompanionHintTopic, variant: number) {
  const name = topic.charAt(0).toUpperCase() + topic.slice(1);
  const action = topic === CompanionAppCategory.Mail
    ? 'desktopCompanionHintActionMail'
    : topic === CompanionAppCategory.Calendar ? 'desktopCompanionHintActionCalendar' : 'desktopCompanionHintActionTry';
  return {
    message: `desktopCompanionHint${name}${variant}`,
    action,
    prompt: topic === COMPANION_WELCOME_TOPIC ? '' : `desktopCompanionPrompt${name}`,
  };
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
