/** Shares an in-flight download between foreground status queries and background delivery. */
export class MediaDownloadCoordinator<T> {
  private readonly pending = new Map<string, Promise<T>>();

  run(key: string, download: () => Promise<T>): Promise<T> {
    const current = this.pending.get(key);
    if (current) return current;
    const result = download().finally(() => this.pending.delete(key));
    this.pending.set(key, result);
    return result;
  }
}
