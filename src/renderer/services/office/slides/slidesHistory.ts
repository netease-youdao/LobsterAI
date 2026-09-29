import type { PackageChange, SlidesPackage } from './slidesPackage';

/**
 * Undo and redo for a presentation: each step is one package change, with what was shown before
 * and after it. Consecutive steps with the same key (typing into one shape, nudging one shape)
 * are one step.
 */

export interface HistoryEntry<TView> {
  change: PackageChange;
  before: TView;
  after: TView;
  key?: string;
}

/** Whether a change leaves every part as it was. */
const changesNothing = (change: PackageChange): boolean => [...change.before].every(([part, content]) => content === change.after.get(part));

/** Fold a later change of the same step into an earlier one. */
function mergeChange(into: PackageChange, next: PackageChange): void {
  for (const [part, content] of next.before) if (!into.before.has(part)) into.before.set(part, content);
  for (const [part, content] of next.after) into.after.set(part, content);
}

export class SlidesHistory<TView> {
  private undoStack: HistoryEntry<TView>[] = [];
  private redoStack: HistoryEntry<TView>[] = [];

  constructor(private readonly limit = 100) {}

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Keep a change as a step; returns its step, or undefined when it changed nothing. */
  record(change: PackageChange, before: TView, after: TView, key?: string): HistoryEntry<TView> | undefined {
    if (changesNothing(change)) return undefined;
    this.redoStack = [];
    const top = this.undoStack[this.undoStack.length - 1];
    if (key && top?.key === key) {
      mergeChange(top.change, change);
      top.after = after;
      return top;
    }
    const entry: HistoryEntry<TView> = { change, before, after, ...(key ? { key } : {}) };
    this.undoStack.push(entry);
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    return entry;
  }

  undo(pkg: SlidesPackage): HistoryEntry<TView> | undefined {
    const entry = this.undoStack.pop();
    if (!entry) return undefined;
    pkg.undo(entry.change);
    this.redoStack.push(entry);
    return entry;
  }

  redo(pkg: SlidesPackage): HistoryEntry<TView> | undefined {
    const entry = this.redoStack.pop();
    if (!entry) return undefined;
    pkg.redo(entry.change);
    this.undoStack.push(entry);
    return entry;
  }

  /** Undo every step back to and including `entry` and forget them, as if they never happened. */
  revertTo(pkg: SlidesPackage, entry: HistoryEntry<TView>): boolean {
    if (!this.undoStack.includes(entry)) return false;
    while (this.undoStack.length) {
      const top = this.undoStack.pop()!;
      pkg.undo(top.change);
      if (top === entry) break;
    }
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
