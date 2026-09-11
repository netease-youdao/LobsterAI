import type { OwnershipResources } from '../shared/ownership/types';

/** Normal operations share reservations; an ownership commit needs exclusive access. */
export class OwnershipOperationGate {
  private readonly readers = new Map<string, number>();
  private readonly writers = new Set<string>();
  isAssociating(resources: OwnershipResources): boolean { return this.keys(resources).some(key => this.writers.has(key)); }

  private keys(resources: OwnershipResources): string[] {
    return [...new Set([
      ...resources.agentIds.map(id => `agent:${id}`),
      ...resources.sessionIds.map(id => `session:${id}`),
    ])].sort();
  }

  isBusy(resources: OwnershipResources): boolean {
    return this.keys(resources).some(key => this.writers.has(key) || this.readers.has(key));
  }

  tryAcquire(resources: OwnershipResources): (() => void) | null {
    const keys = this.keys(resources);
    if (keys.some(key => this.writers.has(key) || this.readers.has(key))) return null;
    keys.forEach(key => this.writers.add(key));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      keys.forEach(key => this.writers.delete(key));
    };
  }

  beginOperation(resources: OwnershipResources): (() => void) | null {
    const keys = this.keys(resources);
    if (keys.some(key => this.writers.has(key))) return null;
    keys.forEach(key => this.readers.set(key, (this.readers.get(key) || 0) + 1));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      keys.forEach(key => {
        const remaining = (this.readers.get(key) || 1) - 1;
        if (remaining) this.readers.set(key, remaining);
        else this.readers.delete(key);
      });
    };
  }
}

export const ownershipOperationGate = new OwnershipOperationGate();
