export const SkillChangeSource = {
  OpenClawImport: 'openclaw-import',
  Enabled: 'enabled-setting',
  Delete: 'delete',
  Install: 'install',
  Upgrade: 'upgrade',
  ConfirmInstall: 'confirm-install',
  WorkingDirectory: 'working-directory',
  Watcher: 'watcher',
} as const;
export type SkillChangeSource = typeof SkillChangeSource[keyof typeof SkillChangeSource];

export const SkillWatchScope = { Root: 'root', Definition: 'definition' } as const;
export type SkillWatchScope = typeof SkillWatchScope[keyof typeof SkillWatchScope];

export type SkillChangeBatch = {
  batchId: number;
  source: SkillChangeSource;
  eventCount: number;
  rootEvents: number;
  definitionEvents: number;
  renameEvents: number;
};

let batchSequence = 0;
export function createSkillChangeBatch(source: SkillChangeSource): SkillChangeBatch {
  return { batchId: ++batchSequence, source, eventCount: 1, rootEvents: 0, definitionEvents: 0, renameEvents: 0 };
}

/** Fixed-size counters only; never retain filenames or file contents. */
export class SkillWatchDiagnostics {
  private eventCount = 0;
  private rootEvents = 0;
  private definitionEvents = 0;
  private renameEvents = 0;

  record(scope: SkillWatchScope, event: string): void {
    this.eventCount += 1;
    if (scope === SkillWatchScope.Root) this.rootEvents += 1;
    else this.definitionEvents += 1;
    if (event === 'rename') this.renameEvents += 1;
  }

  take(): SkillChangeBatch {
    const batch = {
      ...createSkillChangeBatch(SkillChangeSource.Watcher),
      eventCount: this.eventCount, rootEvents: this.rootEvents,
      definitionEvents: this.definitionEvents, renameEvents: this.renameEvents,
    };
    this.clear();
    return batch;
  }

  clear(): void {
    this.eventCount = this.rootEvents = this.definitionEvents = this.renameEvents = 0;
  }
}
