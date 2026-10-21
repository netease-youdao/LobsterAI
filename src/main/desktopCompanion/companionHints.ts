import {
  categorizeCompanionApp,
  CompanionAppCategory as Category,
  type CompanionAppCategory,
} from '../../shared/desktopCompanion/appCategories';
import { DesktopCompanionStoreKey } from '../../shared/desktopCompanion/constants';
import {
  canShowCompanionHint,
  COMPANION_WELCOME_TOPIC,
  companionHintDay,
  type CompanionHintLedger,
  type CompanionHintOutcome,
  CompanionHintRule,
  type CompanionHintTopic,
  companionHintVariant,
  hasCompanionHint,
  markCompanionHintOutcome,
  markCompanionHintShown,
  normalizeCompanionHintLedger,
} from '../../shared/desktopCompanion/hintPolicy';

const WELCOME_DELAY_MS = 1_600;

export interface HintsStore {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
}

export interface HintsDeps {
  store: HintsStore;
  /** Companion on, tips on, and not snoozed. */
  isEnabled(): boolean;
  /** Something else has the user's attention right now. */
  isQuiet(category: CompanionAppCategory): boolean;
  showHint(topic: CompanionHintTopic, variant: number): boolean;
  now?: () => number;
}

/** Decides when a habit hint for the frontmost app may appear, and remembers how it went. */
export class CompanionHintsController {
  private ledger: CompanionHintLedger;
  private focus: { category: CompanionAppCategory; since: number } | null = null;
  private dwellTimer: ReturnType<typeof setTimeout> | undefined;
  private welcomeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly launchedAt: number;
  private readonly now: () => number;

  constructor(private readonly deps: HintsDeps) {
    this.now = deps.now ?? Date.now;
    this.launchedAt = this.now();
    this.ledger = normalizeCompanionHintLedger(deps.store.get(DesktopCompanionStoreKey.HintLedger), companionHintDay(this.launchedAt));
  }

  get foregroundCategory(): CompanionAppCategory | null {
    return this.focus?.category ?? null;
  }

  onForegroundChange(appId: string): void {
    const category = categorizeCompanionApp(appId);
    clearTimeout(this.dwellTimer);
    // Switching into LobsterAI itself means the user is already with us.
    if (category === Category.Self) { this.focus = null; return; }
    this.focus = { category, since: this.now() };
    if (!hasCompanionHint(category)) return;
    this.dwellTimer = setTimeout(() => this.evaluate(), CompanionHintRule.DwellMs + 250);
  }

  evaluate(): boolean {
    const focus = this.focus;
    if (!focus || !this.deps.isEnabled()) return false;
    const now = this.now();
    const day = companionHintDay(now);
    const allowed = canShowCompanionHint({
      category: focus.category,
      dwellMs: now - focus.since,
      now,
      day,
      launchedAt: this.launchedAt,
      quiet: this.deps.isQuiet(focus.category),
      ledger: this.ledger,
    });
    if (!allowed) return false;
    if (!this.deps.showHint(focus.category, companionHintVariant(this.ledger, focus.category))) return false;
    this.ledger = markCompanionHintShown(this.ledger, focus.category, now, day);
    this.save();
    return true;
  }

  /** The first time the companion appears it introduces itself once. */
  scheduleWelcome(): void {
    if (this.deps.store.get(DesktopCompanionStoreKey.Greeted) === true || this.welcomeTimer) return;
    // The greeting belongs to the first appearance, so it ignores the tips setting.
    this.welcomeTimer = setTimeout(() => {
      this.welcomeTimer = undefined;
      if (this.deps.showHint(COMPANION_WELCOME_TOPIC, 0)) this.deps.store.set(DesktopCompanionStoreKey.Greeted, true);
    }, WELCOME_DELAY_MS);
  }

  recordOutcome(topic: CompanionHintTopic, outcome: CompanionHintOutcome): void {
    if (topic === COMPANION_WELCOME_TOPIC) return;
    this.ledger = markCompanionHintOutcome(this.ledger, topic, outcome, this.now());
    this.save();
  }

  dispose(): void {
    clearTimeout(this.dwellTimer);
    clearTimeout(this.welcomeTimer);
  }

  private save(): void {
    this.deps.store.set(DesktopCompanionStoreKey.HintLedger, this.ledger);
  }
}
