import {
  type BrowserCredentialSummary,
  BrowserCredentialUseMode,
  type BrowserCredentialUseMode as BrowserCredentialUseModeValue,
} from '../../shared/browserCredentials/constants';
import type { AskUserRequest, AskUserResponse } from '../libs/mcpBridgeServer';

const APPROVAL_TIMEOUT_MS = 120_000;
const MAX_TASK_GRANTS = 1_000;

export interface BrowserCredentialApprovalRequest {
  sessionId?: string;
  sessionKey?: string;
  origin: string;
  candidates: BrowserCredentialSummary[];
  accountHint?: string;
  reason?: string;
  useMode: BrowserCredentialUseModeValue;
}

export interface BrowserCredentialApprovalResult {
  approved: boolean;
  credential?: BrowserCredentialSummary;
}

export interface BrowserCredentialApprovalDeps {
  askUser: (
    questions: AskUserRequest['questions'],
    timeoutMs: number,
    options: { sessionKey?: string },
  ) => Promise<AskUserResponse | null>;
  translate: (key: string, params?: Record<string, string | number>) => string;
}

const normalizeAccountHint = (value?: string): string => value?.trim().toLowerCase() ?? '';

export class BrowserCredentialApprovalService {
  private readonly taskGrants = new Set<string>();

  constructor(private readonly deps: BrowserCredentialApprovalDeps) {}

  async requestApproval(
    request: BrowserCredentialApprovalRequest,
  ): Promise<BrowserCredentialApprovalResult> {
    if (request.useMode === BrowserCredentialUseMode.Disabled || request.candidates.length === 0) {
      return { approved: false };
    }

    const candidates = this.filterCandidates(request.candidates, request.accountHint);
    const previouslyGranted = request.useMode === BrowserCredentialUseMode.OncePerTask
      ? candidates.filter(candidate => this.hasGrant(request, candidate.id))
      : [];
    if (previouslyGranted.length === 1) {
      return { approved: true, credential: previouslyGranted[0] };
    }

    const question = candidates.length === 1
      ? this.buildSingleCredentialQuestion(request, candidates[0])
      : this.buildCredentialSelectionQuestion(request, candidates);
    const response = await this.deps.askUser(
      [question],
      APPROVAL_TIMEOUT_MS,
      { sessionKey: request.sessionKey },
    );
    if (!response || response.behavior !== 'allow') {
      return { approved: false };
    }

    const answer = response.answers?.[question.question]?.trim() ?? '';
    const selected = candidates.length === 1
      ? (answer === this.deps.translate('browserCredentialApprovalAllow') ? candidates[0] : undefined)
      : candidates.find(candidate => candidate.username === answer);
    if (!selected) {
      return { approved: false };
    }

    if (request.useMode === BrowserCredentialUseMode.OncePerTask) {
      this.rememberGrant(request, selected.id);
    }
    return { approved: true, credential: selected };
  }

  clearSession(sessionId: string): void {
    const prefix = `${sessionId.trim()}\u0000`;
    for (const key of this.taskGrants) {
      if (key.startsWith(prefix)) this.taskGrants.delete(key);
    }
  }

  private filterCandidates(
    candidates: BrowserCredentialSummary[],
    accountHint?: string,
  ): BrowserCredentialSummary[] {
    const hint = normalizeAccountHint(accountHint);
    if (!hint) return candidates;
    const exactMatches = candidates.filter(candidate => candidate.username.toLowerCase() === hint);
    return exactMatches.length > 0 ? exactMatches : candidates;
  }

  private buildSingleCredentialQuestion(
    request: BrowserCredentialApprovalRequest,
    credential: BrowserCredentialSummary,
  ): AskUserRequest['questions'][number] {
    const question = this.deps.translate('browserCredentialApprovalQuestion', {
      origin: request.origin,
      username: credential.username,
    });
    const reason = request.reason?.trim().slice(0, 240);
    return {
      question,
      header: this.deps.translate('browserCredentialApprovalHeader'),
      title: this.deps.translate('browserCredentialApprovalTitle'),
      subtitle: reason
        ? this.deps.translate('browserCredentialApprovalReason', { reason })
        : this.deps.translate('browserCredentialApprovalSubtitle'),
      options: [
        {
          label: this.deps.translate('browserCredentialApprovalAllow'),
          description: this.deps.translate('browserCredentialApprovalAllowDescription'),
        },
        {
          label: this.deps.translate('browserCredentialApprovalDeny'),
          description: this.deps.translate('browserCredentialApprovalDenyDescription'),
        },
      ],
    };
  }

  private buildCredentialSelectionQuestion(
    request: BrowserCredentialApprovalRequest,
    candidates: BrowserCredentialSummary[],
  ): AskUserRequest['questions'][number] {
    return {
      question: this.deps.translate('browserCredentialSelectionQuestion', { origin: request.origin }),
      header: this.deps.translate('browserCredentialApprovalHeader'),
      title: this.deps.translate('browserCredentialSelectionTitle'),
      subtitle: this.deps.translate('browserCredentialSelectionSubtitle'),
      options: candidates.map(candidate => ({
        label: candidate.username,
        description: this.deps.translate('browserCredentialSelectionDescription'),
      })),
    };
  }

  private hasGrant(request: BrowserCredentialApprovalRequest, credentialId: string): boolean {
    const key = this.grantKey(request, credentialId);
    return key ? this.taskGrants.has(key) : false;
  }

  private rememberGrant(request: BrowserCredentialApprovalRequest, credentialId: string): void {
    const key = this.grantKey(request, credentialId);
    if (!key) return;
    if (this.taskGrants.size >= MAX_TASK_GRANTS) {
      const oldestKey = this.taskGrants.values().next().value as string | undefined;
      if (oldestKey) this.taskGrants.delete(oldestKey);
    }
    this.taskGrants.add(key);
  }

  private grantKey(
    request: BrowserCredentialApprovalRequest,
    credentialId: string,
  ): string | undefined {
    const sessionId = request.sessionId?.trim();
    if (!sessionId) return undefined;
    return `${sessionId}\u0000${request.origin}\u0000${credentialId}`;
  }
}
