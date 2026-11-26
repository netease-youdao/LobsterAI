import { randomUUID } from 'crypto';

import type { RemoteOwner } from '../../shared/remote/constants';
import { RemoteQuestionAction, RemoteQuestionKind,RemoteQuestionOutcome, RemoteQuestionSource, RemoteQuestionStatus } from '../../shared/remote/questions';
import { type LocalQuestionState, parseQuestionAnswers, parseRemoteQuestionItems, type QuestionAdapterOutcome, type QuestionAnswers, type QuestionDecisionOptions, type QuestionDecisionOutcome, type QuestionResponse, type QuestionStatus, type RemoteQuestionItem } from '../../shared/remote/questions';
import { t } from '../i18n';
import type { PermissionResult } from '../libs/agentEngine/types';
import { payloadHash, stableJson } from './canonical';
import type { RemoteStore } from './remoteStore';

export interface QuestionRegistration {
  requestId: string; sessionId: string; kind: 'legacy' | 'native'; createdAt: number; expiresAt: number; questions: RemoteQuestionItem[];
  resolve(response: QuestionResponse): QuestionAdapterOutcome | Promise<QuestionAdapterOutcome>;
  reconcile?(): Promise<QuestionAdapterOutcome>;
}
export interface QuestionBinding { runId: string; owner: RemoteOwner | null; agentId: string; cwd: string }
interface Entry {
  state: LocalQuestionState; kind: QuestionRegistration['kind']; binding: QuestionBinding;
  submission?: { id: string; hash: string; response: QuestionResponse; source: 'desktop' | 'mobile'; phase: 'reserved' | 'dispatched' | 'unknown' | 'finished'; process: string; outcome?: QuestionAdapterOutcome };
}
interface Submission { questionId: string; hash: string; outcome?: QuestionAdapterOutcome }
export class RemoteQuestionError extends Error { constructor(readonly outcome: QuestionDecisionOutcome) { super(outcome.reason || 'QUESTION_RESULT_UNKNOWN'); } }
const processIdentity = randomUUID();
/** Shared durable arbiter for desktop and mobile. Ordinary local answers never wait for the remote server. */
export class RemoteQuestionService {
  private readonly cache = new Map<string, unknown>();
  private volatileOnly = false;
  private read<T>(key: string): T | null {
    if (this.cache.has(key)) return structuredClone(this.cache.get(key)) as T;
    if (this.volatileOnly) return null;
    const value = this.store.get<T>(key);
    if (value !== null) this.cache.set(key, structuredClone(value));
    return value;
  }
  private write(key: string, value: unknown): void {
    if (!this.volatileOnly) this.store.put(key, value);
    this.cache.set(key, structuredClone(value));
  }
  private transaction(action: () => void): void {
    if (this.volatileOnly) { action(); return; }
    const previous = new Map(this.cache);
    try { this.store.transaction(action); }
    catch {
      // No remote sends occur inside this transaction. Preserve the live engine's local arbiter,
      // disable remote answers for this process, and never auto-replay an uncertain dispatch.
      this.cache.clear(); previous.forEach((value, key) => this.cache.set(key, value));
      this.volatileOnly = true; action();
      console.warn('[RemoteQuestion] local-only question persistence fallback');
    }
  }
  private adapters = new Map<string, QuestionRegistration>();
  private inFlight = new Map<string, Promise<QuestionDecisionOutcome>>();
  constructor(private readonly store: RemoteStore, private readonly getBinding: (sessionId: string) => QuestionBinding | null) {}
  private key(id: string): string { return `questionDecision:${id}`; }
  private entry(id: string): Entry | null {
    if (this.cache.has(this.key(id))) return this.read<Entry>(this.key(id));
    const wire = this.read<string>(`questionRequest:${id}`) || id;
    return this.read<Entry>(this.key(wire));
  }
  getState(id: string): LocalQuestionState | null {
    let state: LocalQuestionState | null;
    try { state = this.entry(id)?.state || null; }
    catch (error) {
      // Do not let an unrelated remote-state lookup capture ordinary local approvals. A known
      // registered question must retain its arbiter/evidence; it never falls through on failure.
      if (this.adapters.has(id) || [...this.adapters.values()].some(adapter => adapter.requestId === id)) throw error;
      return null;
    }
    if (state && this.volatileOnly) { state.remoteAllowed = false; state.requiresLocalAction = true; }
    return state;
  }
  register(input: QuestionRegistration): LocalQuestionState | null {
    const questions = parseRemoteQuestionItems(input.questions), binding = this.getBinding(input.sessionId);
    if (!questions || !binding || !Number.isFinite(input.expiresAt) || input.expiresAt <= Date.now()) return null;
    const id = payloadHash({ requestId: input.requestId, sessionId: input.sessionId, runId: binding.runId });
    const operationDigest = payloadHash({ kind: input.kind, questions, binding, expiresAt: input.expiresAt });
    let previous: Entry | null = null;
    try { previous = this.read<Entry>(this.key(id)); }
    catch { this.volatileOnly = true; }

    if (previous) {
      if (previous.state.operationDigest !== operationDigest) return null;
      this.adapters.set(id, input);
      // A fresh, engine-owned pending registration can only reopen an unsubmitted transport suspension.
      if (!previous.submission && previous.state.status === RemoteQuestionStatus.Pending && previous.state.resolution.phase === 'unknown'
        && previous.state.resolution.source === null) this.transaction(() => {
        previous.state.resolution.phase = 'idle'; previous.state.remoteAllowed = previous.binding.owner !== null; previous.state.requiresLocalAction = false; this.save(previous);
      });
      return previous.state;
    }
    const state: LocalQuestionState = { requestId: input.requestId, sessionId: input.sessionId, questionId: id, runId: binding.runId,
      questionVersion: '1', operationDigest, title: t('questionNotificationTitle'), status: RemoteQuestionStatus.Pending, expiresAt: new Date(input.expiresAt).toISOString(),
      remoteAllowed: binding.owner !== null, requiresLocalAction: binding.owner === null, allowCancel: true, questions,
      resolution: { phase: 'idle', source: null, answeredAt: null, answers: null } };
    this.transaction(() => {
      this.write(`questionRequest:${input.requestId}`, id);
      this.save({ state, binding, kind: input.kind }, false);
    });
    this.adapters.set(id, input); return state;
  }
  private save(entry: Entry, increment = true): void {
    if (increment) entry.state.questionVersion = String(BigInt(entry.state.questionVersion) + 1n);
    if (this.volatileOnly) { entry.state.remoteAllowed = false; entry.state.requiresLocalAction = true; }
    this.write(this.key(entry.state.questionId), entry);
    const { requestId: _requestId, sessionId, ...publicState } = entry.state;
    if (!this.volatileOnly) {
      // A projection is derived data. The core questionDecision record remains rebuildable.
      try { this.store.updateQuestion(sessionId, publicState); }
      catch { console.warn('[RemoteQuestion] question projection deferred'); }
    }
  }
  private bindingCurrent(entry: Entry): boolean { return stableJson(this.getBinding(entry.state.sessionId)) === stableJson(entry.binding); }
  private response(entry: Entry, result: PermissionResult, source: QuestionDecisionOptions['source']): QuestionResponse | null {
    if (result.behavior === 'deny') return { action: 'cancel', answers: {} };
    let answers = result.updatedInput?.answers;
    if (source === RemoteQuestionSource.Desktop && entry.kind === RemoteQuestionKind.Legacy) {
      const old = answers as Record<string, unknown> | undefined, normalized: QuestionAnswers = {};
      for (const question of entry.state.questions) {
        const value = old?.[question.question];
        if (value !== undefined && typeof value !== 'string') return null;
        normalized[question.questionId] = typeof value === 'string' && value.trim() ? question.multiSelect ? value.split('|||').map(v => v.trim()).filter(Boolean) : [value] : [];
      }
      answers = normalized;
    }
    const valid = parseQuestionAnswers(entry.state.questions, answers);
    return valid ? { action: 'answer', answers: valid } : null;
  }
  submit(id: string, result: PermissionResult, options?: QuestionDecisionOptions): Promise<QuestionDecisionOutcome> {
    const opts = options || { submissionId: randomUUID(), source: RemoteQuestionSource.Desktop };
    const entry = this.entry(id);
    if (!entry) return Promise.resolve({ kind: RemoteQuestionOutcome.KnownNotApplied, reason: 'QUESTION_UNAVAILABLE' });
    const response = this.response(entry, result, opts.source);
    if (!response) return Promise.resolve({ kind: RemoteQuestionOutcome.KnownNotApplied, reason: 'QUESTION_INVALID_ANSWER' });
    const hash = payloadHash({ questionId: entry.state.questionId, response, source: opts.source, version: opts.expectedVersion ?? null, digest: opts.operationDigest ?? null });
    const existing = this.read<Submission>(`questionSubmission:${opts.submissionId}`);
    if (existing) {
      if (existing.hash !== hash) return Promise.resolve({ kind: RemoteQuestionOutcome.KnownNotApplied, reason: 'IDEMPOTENCY_CONFLICT' });
      return this.inFlight.get(opts.submissionId) || Promise.resolve(existing.outcome || { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' });
    }
    if (entry.state.status !== RemoteQuestionStatus.Pending || entry.submission || !this.bindingCurrent(entry)
      || Date.parse(entry.state.expiresAt) <= Date.now() || !this.adapters.has(entry.state.questionId)
      || opts.expectedVersion !== undefined && opts.expectedVersion !== entry.state.questionVersion
      || opts.operationDigest !== undefined && opts.operationDigest !== entry.state.operationDigest
      || opts.source === RemoteQuestionSource.Mobile && (this.volatileOnly || !entry.binding.owner || !entry.state.remoteAllowed || !opts.expectedVersion || !opts.operationDigest || !opts.beforeDispatch)) {
      return Promise.resolve({ kind: RemoteQuestionOutcome.KnownNotApplied, reason: 'QUESTION_STALE', state: entry.state });
    }
    this.transaction(() => {
      entry.submission = { id: opts.submissionId, hash, response, source: opts.source, phase: 'reserved', process: processIdentity };
      entry.state.remoteAllowed = false; entry.state.resolution = { phase: 'submitting', source: opts.source, answeredAt: null, answers: null };
      this.write(`questionSubmission:${opts.submissionId}`, { questionId: entry.state.questionId, hash }); this.save(entry);
    });
    if (opts.source === RemoteQuestionSource.Mobile && this.volatileOnly) return Promise.resolve(this.finishSubmission(entry.state.questionId,
      { kind: RemoteQuestionOutcome.KnownNotApplied, reason: 'QUESTION_STORAGE_UNAVAILABLE' }));
    const work = this.dispatch(entry.state.questionId, opts).finally(() => this.inFlight.delete(opts.submissionId));
    this.inFlight.set(opts.submissionId, work); return work;
  }
  private async dispatch(id: string, opts: QuestionDecisionOptions): Promise<QuestionDecisionOutcome> {
    let sent = false;
    try {
      await opts.beforeDispatch?.();
      const entry = this.entry(id)!, adapter = this.adapters.get(id);
      if (!adapter || !this.bindingCurrent(entry) || entry.state.status !== RemoteQuestionStatus.Pending || entry.submission?.id !== opts.submissionId
        || Date.parse(entry.state.expiresAt) <= Date.now()) return this.finishSubmission(id, { kind: RemoteQuestionOutcome.KnownNotApplied, reason: 'QUESTION_STALE' });
      opts.onDispatch?.();
      this.transaction(() => { entry.submission!.phase = 'dispatched'; this.save(entry, false); });
      if (opts.source === RemoteQuestionSource.Mobile && this.volatileOnly) return this.finishSubmission(id, { kind: RemoteQuestionOutcome.KnownNotApplied, reason: 'QUESTION_STORAGE_UNAVAILABLE' });
      sent = true;
      const outcome = await adapter.resolve(entry.submission!.response);
      return this.finishSubmission(id, outcome);
    } catch {
      return this.finishSubmission(id, { kind: sent ? 'unknown' : 'known_not_applied', reason: sent ? 'QUESTION_RESULT_UNKNOWN' : 'QUESTION_NOT_DISPATCHED' });
    }
  }
  private finishSubmission(id: string, outcome: QuestionAdapterOutcome): QuestionDecisionOutcome {
    const entry = this.entry(id)!;
    this.transaction(() => {
      const submission = entry.submission!;
      if (outcome.kind === RemoteQuestionOutcome.Confirmed && (!outcome.status || outcome.status === RemoteQuestionStatus.Answered && stableJson(outcome.answers || {}) !== stableJson(submission.response.answers)
        || outcome.status !== (submission.response.action === RemoteQuestionAction.Answer ? 'answered' : 'cancelled'))) outcome = { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' };
      const terminal = entry.state.status !== RemoteQuestionStatus.Pending;
      if (terminal && outcome.status && (outcome.status !== entry.state.status
        || outcome.status === RemoteQuestionStatus.Answered && stableJson(outcome.answers || {}) !== stableJson(entry.state.resolution.answers || {}))) {
        outcome = { kind: 'unknown', reason: 'QUESTION_CONFLICTING_RECEIPT' };
      }
      submission.outcome = outcome; submission.phase = outcome.kind === 'unknown' ? 'unknown' : 'finished';
      this.write(`questionSubmission:${submission.id}`, { questionId: id, hash: submission.hash, outcome });
      if (terminal) {
        // Preserve the first winning terminal fact (including its timestamp). An exact successful
        // call receipt may refine unknown attribution, but may never replace another answer.
        if (outcome.kind === RemoteQuestionOutcome.Confirmed && entry.state.resolution.source === 'unknown') entry.state.resolution.source = submission.source;
      } else if (outcome.status) {
        entry.state.status = outcome.status;
        entry.state.resolution = { phase: 'finished', source: outcome.kind === RemoteQuestionOutcome.Confirmed ? submission.source : 'unknown',
          answeredAt: outcome.status === RemoteQuestionStatus.Answered ? new Date().toISOString() : null, answers: outcome.status === RemoteQuestionStatus.Answered ? outcome.answers || null : null };
      } else if (outcome.kind === 'unknown' && entry.state.status === RemoteQuestionStatus.Pending) entry.state.resolution.phase = 'unknown';
      else if (entry.state.status === RemoteQuestionStatus.Pending) {
        // A proven no-send failure can release this local reservation. A sent/restarted unknown never can.
        entry.state.resolution = { phase: 'idle', source: null, answeredAt: null, answers: null };
        entry.state.remoteAllowed = entry.binding.owner !== null; delete entry.submission;
      }
      this.save(entry);
    });
    return { ...outcome, state: entry.state };
  }
  settle(id: string, result: { status: Exclude<QuestionStatus, 'pending'>; answers?: QuestionAnswers }): void {
    const entry = this.entry(id); if (!entry || entry.state.status !== RemoteQuestionStatus.Pending) return;
    const answers = result.status === RemoteQuestionStatus.Answered ? parseQuestionAnswers(entry.state.questions, result.answers) : null;
    if (result.status === RemoteQuestionStatus.Answered && !answers) return;
    // Events prove the winning state, not which in-flight network submission won the race.
    this.transaction(() => {
      entry.state.status = result.status; entry.state.remoteAllowed = false;
      entry.state.resolution = { phase: 'finished', source: 'unknown', answeredAt: result.status === RemoteQuestionStatus.Answered ? new Date().toISOString() : null, answers };
      this.save(entry);
    });
  }
  suspend(id: string): void {
    const entry = this.entry(id); if (!entry || entry.state.status !== RemoteQuestionStatus.Pending) return;
    if (!entry.state.remoteAllowed && entry.state.requiresLocalAction && entry.state.resolution.phase === 'unknown') return;
    this.transaction(() => {
      entry.state.remoteAllowed = false; entry.state.requiresLocalAction = true;
      entry.state.resolution.phase = 'unknown';
      if (!entry.submission) entry.state.resolution.source = null;
      this.save(entry);
    });
  }
  expire(id: string, now = Date.now()): void {
    const entry = this.entry(id); if (!entry || entry.state.status !== RemoteQuestionStatus.Pending || Date.parse(entry.state.expiresAt) > now) return;
    if (entry.submission && ['dispatched', 'unknown'].includes(entry.submission.phase)) { this.suspend(id); return; }
    this.settle(id, { status: RemoteQuestionStatus.Expired });
  }
  expirePending(now = Date.now()): void {
    const retired = new Set<string>();
    for (const [id, adapter] of this.adapters) {
      this.expire(id, now);
      const entry = this.entry(id);
      if (!this.volatileOnly && adapter.expiresAt + 60_000 < now && entry?.state.status !== RemoteQuestionStatus.Pending
        && (!entry?.submission || !this.inFlight.has(entry.submission.id))) { this.adapters.delete(id); retired.add(id); }
    }
    // Durable terminal receipts remain in core storage; completed form bodies/resolver closures
    // need not accumulate in process memory. Keep uncertain or volatile-only evidence pinned.
    if (retired.size) for (const [key, value] of this.cache) {
      const record = value as { questionId?: string; state?: { questionId?: string } } | null;
      if (typeof value === 'string' && retired.has(value) || record && typeof record === 'object'
        && retired.has(record.questionId || record.state?.questionId || '')) this.cache.delete(key);
    }
  }
  closeSession(sessionId: string, runId: string | null): void {
    for (const id of this.adapters.keys()) {
      const entry = this.entry(id);
      if (!entry || entry.state.sessionId !== sessionId || runId && entry.state.runId !== runId || entry.state.status !== RemoteQuestionStatus.Pending) continue;
      if (entry.submission && ['dispatched', 'unknown'].includes(entry.submission.phase)) this.suspend(id);
      else this.settle(id, { status: RemoteQuestionStatus.Unavailable });
    }
  }
  async reconcile(submissionId: string, proveNative?: (requestId: string) => Promise<boolean>): Promise<QuestionDecisionOutcome | null> {
    const index = this.read<Submission>(`questionSubmission:${submissionId}`);
    if (!index) return null;
    if (index.outcome && index.outcome.kind !== 'unknown') return index.outcome;
    const entry = this.entry(index.questionId);
    if (!entry?.submission || entry.submission.id !== submissionId) return { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' };
    if (proveNative && ['dispatched', 'unknown'].includes(entry.submission.phase) && await proveNative(entry.state.requestId)) {
      const response = entry.submission.response;
      return this.finishSubmission(index.questionId, {
        kind: RemoteQuestionOutcome.Confirmed, status: response.action === RemoteQuestionAction.Answer ? RemoteQuestionStatus.Answered : RemoteQuestionStatus.Cancelled,
        answers: response.answers,
      });
    }
    const adapter = this.adapters.get(index.questionId);
    if (!adapter?.reconcile) return { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN', state: entry.state };
    try {
      const result = await adapter.reconcile();
      if (result.status) this.settle(index.questionId, { status: result.status, answers: result.answers });
      // A terminal state may be another operator's result. Only a matching durable submission receipt proves our effect.
      return this.finishSubmission(index.questionId, { ...result, kind: result.kind === RemoteQuestionOutcome.Confirmed ? 'unknown' : result.kind });
    } catch { return { kind: 'unknown', reason: 'QUESTION_RESULT_UNKNOWN' }; }
  }
}
