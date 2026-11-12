import type { MessageSpeechBridge } from '../../shared/cowork/messageSpeech';
import {
  isSpeechActive,
  LanguageToolCode,
  type LanguageToolEvent,
  LanguageToolEventType,
  SpeechStatus,
} from '../../shared/desktopCompanion/languageTools';
import { type SpeechPlayback, SpeechQueue } from '../components/desktopCompanion/speechQueue';

export interface MessageSpeechSnapshot {
  messageId: string | null;
  status: SpeechStatus;
}

type SpeechPlayer = Pick<SpeechQueue, 'begin' | 'append' | 'finish' | 'resume' | 'stop'>;
interface MessageSpeechDeps {
  getBridge(): MessageSpeechBridge;
  createPlayer(changed: (playback: SpeechPlayback) => void): SpeechPlayer;
}

const EMPTY_SNAPSHOT: MessageSpeechSnapshot = { messageId: null, status: SpeechStatus.Idle };

/** One player survives virtualized message rows, but never a change of session or account. */
export class MessageSpeechService {
  private snapshot = EMPTY_SNAPSHOT;
  private readonly listeners = new Set<() => void>();
  private player: SpeechPlayer | null = null;
  private sessionId: string | null = null;
  private requestId: string | null = null;
  private text = '';
  private connection = 0;
  private onError?: (code: number) => void;

  constructor(private readonly deps: MessageSpeechDeps) {}

  getSnapshot = (): MessageSpeechSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(snapshot: MessageSpeechSnapshot): void {
    if (this.snapshot.messageId === snapshot.messageId && this.snapshot.status === snapshot.status) return;
    this.snapshot = snapshot;
    this.listeners.forEach(listener => listener());
  }

  connect(sessionId: string, onError: (code: number) => void): () => void {
    const connection = ++this.connection;
    this.stop();
    this.sessionId = sessionId;
    this.onError = onError;
    this.player = this.deps.createPlayer(playback => {
      if (connection !== this.connection) return;
      if (playback.status === SpeechStatus.Error) this.fail(LanguageToolCode.Upstream);
      else this.publish({ ...this.snapshot, status: playback.status });
    });
    const bridge = this.deps.getBridge();
    const offEvent = bridge.onEvent(event => this.receive(event));
    const offReset = bridge.onReset(requestId => {
      if (this.requestId === requestId) this.stop();
    });
    return () => {
      offEvent();
      offReset();
      if (connection !== this.connection) return;
      this.stop();
      this.connection += 1;
      this.player = null;
      this.sessionId = null;
      this.onError = undefined;
    };
  }

  requestLogin(): void { this.onError?.(LanguageToolCode.Unauthorized); }

  toggle(messageId: string, text: string): void {
    if (!this.sessionId || !this.player || !text.trim()) return;
    if (this.snapshot.messageId === messageId && isSpeechActive(this.snapshot.status)) {
      this.stop();
      return;
    }
    if (this.snapshot.messageId === messageId && this.snapshot.status === SpeechStatus.Ended
      && this.requestId && this.text === text) {
      this.player.resume();
      return;
    }

    this.stop();
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    this.text = text;
    this.publish({ messageId, status: SpeechStatus.Loading });
    this.player.begin();
    const reject = (code: number) => {
      if (this.requestId === requestId) this.fail(code);
    };
    void this.deps.getBridge().start({ requestId, sessionId: this.sessionId, messageId, text })
      .then(result => { if (!result.success) reject(result.code ?? LanguageToolCode.Unavailable); })
      .catch(() => reject(LanguageToolCode.Unavailable));
  }

  stop(): void {
    const requestId = this.requestId;
    this.requestId = null;
    this.text = '';
    this.publish(EMPTY_SNAPSHOT);
    this.player?.stop();
    if (requestId) void this.deps.getBridge().stop(requestId).catch(() => undefined);
  }

  private fail(code: number): void {
    this.stop();
    this.onError?.(code);
  }

  private receive(event: LanguageToolEvent): void {
    if (!this.requestId || event.requestId !== this.requestId) return;
    if (event.type === LanguageToolEventType.Error) this.fail(event.code);
    else if (event.type === LanguageToolEventType.Done) this.player?.finish();
    else if (event.type === LanguageToolEventType.Audio) {
      try { this.player?.append(event.index, event.audioBase64, event.mimeType); }
      catch { this.fail(LanguageToolCode.Upstream); }
    }
  }
}

export const messageSpeechService = new MessageSpeechService({
  getBridge: () => window.electron.messageSpeech,
  createPlayer: changed => new SpeechQueue(new Audio(), changed),
});
