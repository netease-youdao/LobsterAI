import {
  LibraryArtifactType,
  LibraryAvailability,
  LibraryCategory,
  LibraryItemKind,
  LibraryOrigin,
} from '@shared/library/constants';
import type { LocalArtifactItem } from '@shared/library/types';
import { describe, expect, test } from 'vitest';

import { type Artifact, ArtifactTypeValue } from '@/types/artifact';

import {
  ArtifactNewTabCardId,
  ArtifactNewTabMode,
  classifyOmniBarInput,
  dedupeLibraryItemsAgainstSession,
  extractSessionLocalServicePorts,
  filterSessionArtifactsForOmniBar,
  getWorkspaceDisplayName,
  OmniBarInputKind,
  resolveNewTabMode,
  resolveNewTabOverflowItems,
  resolveNewTabPrimaryCards,
} from './artifactNewTabModel';

const makeArtifact = (id: string, fileName: string, filePath?: string): Artifact => ({
  id,
  messageId: 'm1',
  sessionId: 's1',
  type: ArtifactTypeValue.Document,
  title: fileName,
  fileName,
  filePath,
  content: '',
  createdAt: 1,
});

const makeLibraryItem = (
  itemId: string,
  title: string,
  filePath: string,
  availability: LocalArtifactItem['availability'] = LibraryAvailability.Available,
): LocalArtifactItem => ({
  itemKind: LibraryItemKind.LocalArtifact,
  itemId,
  title,
  category: LibraryCategory.Document,
  sortTime: 1,
  createdAt: 1,
  isFavorite: false,
  latestSession: {
    sessionId: 's1',
    title: 'Session',
    agentId: 'main',
    createdAt: 1,
    updatedAt: 1,
    lastRelatedAt: 1,
  },
  filePath,
  artifactType: LibraryArtifactType.Document,
  extension: '.docx',
  availability,
  origin: LibraryOrigin.Conversation,
  relatedSessionCount: 1,
});

describe('classifyOmniBarInput', () => {
  test('treats empty or whitespace input as Empty', () => {
    expect(classifyOmniBarInput('   ')).toEqual({
      kind: OmniBarInputKind.Empty,
      query: '',
      normalizedUrl: null,
    });
  });

  test('recognizes explicit schemes, localhost, and bare web domains as URLs', () => {
    expect(classifyOmniBarInput('https://example.com/docs')).toMatchObject({
      kind: OmniBarInputKind.Url,
      normalizedUrl: 'https://example.com/docs',
    });
    expect(classifyOmniBarInput('localhost:5175/app')).toMatchObject({
      kind: OmniBarInputKind.Url,
      normalizedUrl: 'http://localhost:5175/app',
    });
    expect(classifyOmniBarInput('github.com/deepseek-ai')).toMatchObject({
      kind: OmniBarInputKind.Url,
      normalizedUrl: 'https://github.com/deepseek-ai',
    });
  });

  test('treats common file names with extensions as file Search instead of URLs', () => {
    expect(classifyOmniBarInput('report.docx', 'zh').kind).toBe(OmniBarInputKind.Search);
    expect(classifyOmniBarInput('README.md', 'en').kind).toBe(OmniBarInputKind.Search);
    expect(classifyOmniBarInput('App.tsx', 'en').kind).toBe(OmniBarInputKind.Search);
    expect(classifyOmniBarInput('产品介绍', 'zh').kind).toBe(OmniBarInputKind.Search);
  });
});

describe('NewTab card layout selection', () => {
  test('selects Work mode by default and Code mode for Git repositories', () => {
    expect(resolveNewTabMode(false)).toBe(ArtifactNewTabMode.Work);
    expect(resolveNewTabMode(true)).toBe(ArtifactNewTabMode.Code);

    expect(resolveNewTabPrimaryCards(ArtifactNewTabMode.Work)).toEqual([
      ArtifactNewTabCardId.NewDocument,
      ArtifactNewTabCardId.NewPresentation,
      ArtifactNewTabCardId.Files,
      ArtifactNewTabCardId.Browser,
    ]);
    expect(resolveNewTabPrimaryCards(ArtifactNewTabMode.Work, { includeSideChat: true })).toEqual([
      ArtifactNewTabCardId.NewDocument,
      ArtifactNewTabCardId.Files,
      ArtifactNewTabCardId.Browser,
      ArtifactNewTabCardId.SideChat,
    ]);
    expect(resolveNewTabPrimaryCards(ArtifactNewTabMode.Code)).toEqual([
      ArtifactNewTabCardId.Files,
      ArtifactNewTabCardId.WorkspaceChanges,
      ArtifactNewTabCardId.Browser,
      ArtifactNewTabCardId.NewMarkdown,
    ]);
    expect(resolveNewTabPrimaryCards(ArtifactNewTabMode.Code, { includeSideChat: true })).toEqual([
      ArtifactNewTabCardId.Files,
      ArtifactNewTabCardId.WorkspaceChanges,
      ArtifactNewTabCardId.Browser,
      ArtifactNewTabCardId.SideChat,
    ]);
  });

  test('surfaces complementary creation tools in the overflow menu without legacy utility rows', () => {
    const workSessionOverflow = resolveNewTabOverflowItems(ArtifactNewTabMode.Work, {
      isGitRepository: false,
      hasWorkingDirectory: true,
      includeSideChat: true,
    });
    expect(workSessionOverflow).toEqual([
      ArtifactNewTabCardId.NewPresentation,
      ArtifactNewTabCardId.NewSpreadsheet,
      ArtifactNewTabCardId.NewMarkdown,
    ]);
    expect(workSessionOverflow).not.toContain(ArtifactNewTabCardId.OpenLocalFile);
    expect(workSessionOverflow).not.toContain(ArtifactNewTabCardId.Subagents);
    expect(workSessionOverflow).not.toContain(ArtifactNewTabCardId.RevealWorkspace);

    const codeOverflow = resolveNewTabOverflowItems(ArtifactNewTabMode.Code, {
      isGitRepository: true,
      hasWorkingDirectory: false,
      includeSideChat: true,
    });
    expect(codeOverflow).toEqual([
      ArtifactNewTabCardId.NewDocument,
      ArtifactNewTabCardId.NewPresentation,
      ArtifactNewTabCardId.NewSpreadsheet,
      ArtifactNewTabCardId.NewMarkdown,
    ]);

    const homeOverflow = resolveNewTabOverflowItems(ArtifactNewTabMode.Work, {
      isGitRepository: false,
      hasWorkingDirectory: true,
      includeSubagents: false,
    });
    expect(homeOverflow).toEqual([
      ArtifactNewTabCardId.NewSpreadsheet,
      ArtifactNewTabCardId.NewMarkdown,
    ]);
  });
});

describe('Omni-Bar file filtering and deduplication', () => {
  test('ranks prefix matches before substring matches', () => {
    const artifacts = [
      makeArtifact('a1', 'Q3_Report.docx', '/work/Q3_Report.docx'),
      makeArtifact('a2', 'report_summary.md', '/work/report_summary.md'),
    ];
    const results = filterSessionArtifactsForOmniBar(artifacts, 'report');
    expect(results.map(item => item.id)).toEqual(['a2', 'a1']);
  });

  test('deduplicates available library items against session files', () => {
    const session = [makeArtifact('a1', 'intro.docx', '/work/intro.docx')];
    const library = [
      makeLibraryItem('l1', 'intro.docx', '/work/intro.docx'),
      makeLibraryItem('l2', 'missing.docx', '/work/missing.docx', LibraryAvailability.Missing),
      makeLibraryItem('l3', 'budget.xlsx', '/work/budget.xlsx'),
    ];
    const filtered = dedupeLibraryItemsAgainstSession(library, session);
    expect(filtered.map(item => item.itemId)).toEqual(['l3']);
  });

  test('formats workspace folder display names across platforms', () => {
    expect(getWorkspaceDisplayName('/Users/alice/Documents/LobsterAI/')).toBe('LobsterAI');
    expect(getWorkspaceDisplayName('C:\\Users\\alice\\Projects\\demo\\')).toBe('demo');
    expect(getWorkspaceDisplayName('')).toBe('');
  });

  test('extracts only valid local-service ports belonging to the current session', () => {
    const artifacts: Artifact[] = [
      makeArtifact('doc-1', 'intro.docx', '/work/intro.docx'),
      {
        id: 'svc-1',
        messageId: 'm1',
        sessionId: 's1',
        type: ArtifactTypeValue.LocalService,
        title: 'Preview App',
        content: 'http://localhost:3000',
        url: 'http://localhost:3000/dashboard',
        createdAt: 1,
      },
      {
        id: 'svc-2',
        messageId: 'm2',
        sessionId: 's1',
        type: ArtifactTypeValue.LocalService,
        title: 'Invalid',
        content: 'not-a-url',
        createdAt: 2,
      },
    ];
    expect(extractSessionLocalServicePorts(artifacts)).toEqual([3000]);
    expect(extractSessionLocalServicePorts([makeArtifact('doc-1', 'a.md')])).toEqual([]);
  });
});
