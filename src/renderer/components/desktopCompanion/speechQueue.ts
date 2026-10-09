import { SpeechStatus } from '../../../shared/desktopCompanion/languageTools';

export interface SpeechPlayback { status: SpeechStatus; index: number; total: number }
export interface SpeechAudio {
  src: string;
  playbackRate: number;
  onended: ((event: Event) => unknown) | null;
  onerror: OnErrorEventHandler;
  play(): Promise<void>;
  pause(): void;
}
interface SpeechQueueDeps { createUrl(base64: string, mime: string): string; revokeUrl(url: string): void }
const defaultDeps: SpeechQueueDeps = {
  createUrl: (base64, mime) => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  },
  revokeUrl: url => URL.revokeObjectURL(url),
};

/** A single audio element, with an ordered queue that survives panel visibility changes. */
export class SpeechQueue {
  private urls: string[] = [];
  private index = 0;
  private generation = 0;
  private hasSource = false;
  private paused = false;
  private done = false;
  private status: SpeechStatus = SpeechStatus.Idle;
  constructor(private readonly audio: SpeechAudio, private readonly changed: (state: SpeechPlayback) => void,
    private readonly deps: SpeechQueueDeps = defaultDeps) {
    audio.onended = () => { if (!this.hasSource) return; this.hasSource = false; this.index += 1; this.pump(); };
    audio.onerror = () => { if (this.hasSource) this.setStatus(SpeechStatus.Error); };
  }
  begin(): void { this.stop(); this.setStatus(SpeechStatus.Loading); }
  append(index: number, base64: string, mime: string): void {
    if (index < this.urls.length) return;
    if (index !== this.urls.length || !mime.startsWith('audio/') || base64.length > 12 * 1024 * 1024) {
      throw new Error('Invalid read-aloud audio segment');
    }
    this.urls.push(this.deps.createUrl(base64, mime));
    this.pump();
  }
  finish(): void { this.done = true; this.pump(); }
  pause(): void { this.paused = true; this.audio.pause(); this.setStatus(SpeechStatus.Paused); }
  resume(): void {
    this.paused = false;
    if (this.status === SpeechStatus.Ended) { this.index = 0; this.hasSource = false; }
    if (this.hasSource) this.play();
    else this.pump();
  }
  setRate(rate: number): void { this.audio.playbackRate = rate; }
  stop(): void {
    this.generation += 1;
    this.hasSource = false;
    this.audio.pause();
    this.audio.src = '';
    for (const url of this.urls) this.deps.revokeUrl(url);
    this.urls = [];
    this.index = 0;
    this.hasSource = false;
    this.paused = false;
    this.done = false;
    this.setStatus(SpeechStatus.Idle);
  }
  private pump(): void {
    if (this.paused) { this.setStatus(SpeechStatus.Paused); return; }
    if (this.hasSource) { this.setStatus(this.status); return; }
    if (this.index >= this.urls.length) {
      this.setStatus(this.done ? SpeechStatus.Ended : SpeechStatus.Loading);
      return;
    }
    this.audio.src = this.urls[this.index];
    this.hasSource = true;
    this.play();
  }
  private play(): void {
    const generation = this.generation;
    void this.audio.play().then(() => {
      if (generation === this.generation && !this.paused) this.setStatus(SpeechStatus.Playing);
    }).catch(() => { if (generation === this.generation && !this.paused) this.setStatus(SpeechStatus.Error); });
  }
  private setStatus(status: SpeechStatus): void {
    this.status = status;
    this.changed({ status, index: Math.min(this.index + 1, this.urls.length), total: this.urls.length });
  }
}
