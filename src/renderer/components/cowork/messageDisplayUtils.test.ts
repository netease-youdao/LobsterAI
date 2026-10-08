import { expect, test } from 'vitest';

import {
  ContextCompactionMode,
  ContextCompactionStatus,
  CoworkSystemMessageKind,
} from '../../../common/coworkSystemMessages';
import type { CoworkMessage } from '../../types/cowork';
import { ActivityStepKind } from './constants';
import { computeDiffStats } from './DiffView';
import {
  buildConversationTurns,
  buildDisplayItems,
  canFoldTurnProcess,
  chunkConsolidatedItemsForDisplay,
  type ConsolidatedItem,
  countTurnCompletedSteps,
  countTurnFailedSteps,
  formatElapsedDuration,
  formatStructuredText,
  formatTurnDuration,
  getActivityCurrentActionText,
  getActivityGroupHeaderLabel,
  getActivityGroupStepKind,
  getActivityGroupSummary,
  getActivityIndicatorStatusText,
  getActivityLiveDetail,
  getActivityLiveStatusText,
  getActivityStepDisplay,
  getActivityStepKind,
  getLiveEditDiff,
  getShellCommandDescription,
  getStreamingTextSignature,
  getThinkingPhaseLabels,
  getToolInputSummary,
  getToolResultCollapsedDisplay,
  getToolResultDisplay,
  getTurnActivityFingerprint,
  getTurnAnswerStartIndex,
  getTurnEndTimestamp,
  getTurnMessageIds,
  getTurnStartTimestamp,
  isAbandonedToolPlaceholder,
  isActivityConsolidatedItem,
  isActivityItemLive,
  isToolGroupSettled,
  STRUCTURED_TEXT_FORMAT_MAX_CHARS,
  TOOL_RESULT_COLLAPSED_FULL_DISPLAY_MAX_CHARS,
  turnHasSelfIndicatingActivity,
} from './messageDisplayUtils';

const createToolResultMessage = (content: string): CoworkMessage => ({
  id: 'tool-result-test',
  type: 'tool_result',
  content,
  timestamp: 0,
});

test('turn message IDs include both the user and assistant messages', () => {
  const messages: CoworkMessage[] = [{
    id: 'user-1',
    type: 'user',
    content: 'question',
    timestamp: 1,
  }, {
    id: 'assistant-1',
    type: 'assistant',
    content: 'answer',
    timestamp: 2,
  }];

  const [turn] = buildConversationTurns(buildDisplayItems(messages));

  expect([...getTurnMessageIds(turn)]).toEqual(['user-1', 'assistant-1']);
});

test('orphan turn IDs stay unique across paged windows', () => {
  const firstWindow = buildConversationTurns(buildDisplayItems([{
    id: 'assistant-window-one',
    type: 'assistant',
    content: 'first window',
    timestamp: 1,
  }]));
  const secondWindow = buildConversationTurns(buildDisplayItems([{
    id: 'assistant-window-two',
    type: 'assistant',
    content: 'second window',
    timestamp: 2,
  }]));

  expect(firstWindow[0].id).toBe('orphan-assistant-window-one');
  expect(secondWindow[0].id).toBe('orphan-assistant-window-two');
  expect(secondWindow[0].id).not.toBe(firstWindow[0].id);
});

test('tool result display still formats small JSON output', () => {
  const message = createToolResultMessage('{"ok":true,"count":2}');

  expect(getToolResultDisplay(message)).toBe('{\n  "ok": true,\n  "count": 2\n}');
});

test('structured text formatting skips oversized JSON output', () => {
  const oversizedJson = `{"value":"${'x'.repeat(STRUCTURED_TEXT_FORMAT_MAX_CHARS)}"}`;

  expect(formatStructuredText(oversizedJson)).toBe(oversizedJson);
});

test('collapsed tool result display keeps small output details', () => {
  const collapsed = getToolResultCollapsedDisplay(createToolResultMessage('line one\nline two'));

  expect(collapsed.hasText).toBe(true);
  expect(collapsed.isLarge).toBe(false);
  expect(collapsed.lineCount).toBe(2);
  expect(collapsed.text).toBe('line one\nline two');
});

test('collapsed tool result display summarizes medium output without structured formatting', () => {
  const mediumJson = `{"value":"${'x'.repeat(TOOL_RESULT_COLLAPSED_FULL_DISPLAY_MAX_CHARS)}"}`;
  const collapsed = getToolResultCollapsedDisplay(createToolResultMessage(mediumJson));

  expect(collapsed.hasText).toBe(true);
  expect(collapsed.isLarge).toBe(true);
  expect(collapsed.sizeLabel).not.toBeNull();
  expect(collapsed.lineCount).toBe(0);
  expect(collapsed.text.length).toBeLessThan(mediumJson.length);
  expect(collapsed.text).not.toContain('\n  "value"');
});

test('collapsed tool result display summarizes large output without full formatting', () => {
  const largeOutput = `first line\n${'x'.repeat(TOOL_RESULT_COLLAPSED_FULL_DISPLAY_MAX_CHARS)}`;
  const collapsed = getToolResultCollapsedDisplay(createToolResultMessage(largeOutput));

  expect(collapsed.hasText).toBe(true);
  expect(collapsed.isLarge).toBe(true);
  expect(collapsed.sizeLabel).not.toBeNull();
  expect(collapsed.lineCount).toBe(0);
  expect(collapsed.text.length).toBeLessThan(largeOutput.length);
  expect(collapsed.text).toContain('first line');
});

test('activity indicator status defaults to thinking and escalates for long waits', () => {
  expect(getActivityIndicatorStatusText()).toBe('正在思考');
  expect(getActivityIndicatorStatusText(true)).toBe('正在整理上下文...');
  expect(getActivityIndicatorStatusText(false, true)).toBe('模型仍在响应，请耐心等待…');
  // Once the turn has shown content, the label switches to "working".
  expect(getActivityIndicatorStatusText(false, false, true)).toBe('正在处理');
});

test('elapsed duration formats seconds, minutes, and hours', () => {
  expect(formatElapsedDuration(-500)).toBe('0s');
  expect(formatElapsedDuration(8_400)).toBe('8s');
  expect(formatElapsedDuration(84_000)).toBe('1m 24s');
  expect(formatElapsedDuration(3_720_000)).toBe('1h 2m');
});

const buildTurn = (messages: CoworkMessage[]) =>
  buildConversationTurns(buildDisplayItems(messages))[0];

test('pending tool call counts as self-indicating activity', () => {
  const turn = buildTurn([{
    id: 'user-1',
    type: 'user',
    content: 'hello',
    timestamp: 1,
  }, {
    id: 'tool-1',
    type: 'tool_use',
    content: '',
    timestamp: 2,
    metadata: {
      toolUseId: 'tool-use-1',
      toolName: 'exec_command',
    },
  }]);

  expect(turnHasSelfIndicatingActivity(turn)).toBe(true);
});

test('resolved tool call is not self-indicating activity', () => {
  const turn = buildTurn([{
    id: 'user-1',
    type: 'user',
    content: 'hello',
    timestamp: 1,
  }, {
    id: 'tool-1',
    type: 'tool_use',
    content: '',
    timestamp: 2,
    metadata: {
      toolUseId: 'tool-use-1',
      toolName: 'exec_command',
    },
  }, {
    id: 'result-1',
    type: 'tool_result',
    content: 'done',
    timestamp: 3,
    metadata: {
      toolUseId: 'tool-use-1',
    },
  }]);

  expect(turnHasSelfIndicatingActivity(turn)).toBe(false);
});

test('streaming thinking block counts as self-indicating activity', () => {
  const turn = buildTurn([{
    id: 'user-1',
    type: 'user',
    content: 'hello',
    timestamp: 1,
  }, {
    id: 'thinking-1',
    type: 'assistant',
    content: 'pondering',
    timestamp: 2,
    metadata: {
      isThinking: true,
      isStreaming: true,
    },
  }]);

  expect(turnHasSelfIndicatingActivity(turn)).toBe(true);
});

test('turn start timestamp uses the earliest message and survives orphan turns', () => {
  const turnWithUser = buildTurn([{
    id: 'user-1',
    type: 'user',
    content: 'hello',
    timestamp: 1000,
  }, {
    id: 'tool-1',
    type: 'tool_use',
    content: '',
    timestamp: 2000,
    metadata: { toolUseId: 'tool-use-1', toolName: 'exec' },
  }]);
  expect(getTurnStartTimestamp(turnWithUser)).toBe(1000);

  // Orphan turn without a user message anchors to its first tool call.
  const orphanTurn = buildTurn([{
    id: 'tool-1',
    type: 'tool_use',
    content: '',
    timestamp: 5000,
    metadata: { toolUseId: 'tool-use-1', toolName: 'exec' },
  }]);
  expect(getTurnStartTimestamp(orphanTurn)).toBe(5000);

  expect(getTurnStartTimestamp({ id: 'empty', userMessage: null, assistantItems: [] })).toBeNull();
});

test('a turn that began before the loaded message window keeps its real start', () => {
  const windowMessages: CoworkMessage[] = [{
    id: 'tool-1',
    type: 'tool_use',
    content: '',
    timestamp: 5000,
    metadata: { toolUseId: 'tool-use-1', toolName: 'exec' },
  }, {
    id: 'tool-result-1',
    type: 'tool_result',
    content: 'done',
    timestamp: 6000,
    metadata: { toolUseId: 'tool-use-1' },
  }];

  const [leadingTurn] = buildConversationTurns(buildDisplayItems(windowMessages), {
    leadingTurnStartTimestamp: 1000,
  });
  expect(leadingTurn.userMessage).toBeNull();
  expect(getTurnStartTimestamp(leadingTurn)).toBe(1000);
  expect(getTurnEndTimestamp(leadingTurn)).toBe(6000);

  // A window that starts at a user message has nothing to inherit.
  const [userTurn] = buildConversationTurns(buildDisplayItems([{
    id: 'user-2', type: 'user', content: 'next', timestamp: 7000,
  }, ...windowMessages]), { leadingTurnStartTimestamp: 1000 });
  expect(getTurnStartTimestamp(userTurn)).toBe(5000);
});

test('a context compaction split keeps timing the work it continues', () => {
  const turns = buildConversationTurns(buildDisplayItems([{
    id: 'user-1', type: 'user', content: 'long task', timestamp: 1000,
  }, {
    id: 'tool-1',
    type: 'tool_use',
    content: '',
    timestamp: 2000,
    metadata: { toolUseId: 'tool-use-1', toolName: 'exec' },
  }, {
    id: 'tool-result-1',
    type: 'tool_result',
    content: 'done',
    timestamp: 2500,
    metadata: { toolUseId: 'tool-use-1' },
  }, {
    id: 'compaction-1',
    type: 'system',
    content: 'Context compaction completed, continuing task',
    timestamp: 3000,
    metadata: {
      kind: CoworkSystemMessageKind.ContextCompaction,
      mode: ContextCompactionMode.Auto,
      status: ContextCompactionStatus.Retrying,
    },
  }, {
    id: 'assistant-1', type: 'assistant', content: 'finished', timestamp: 4000,
  }]));

  expect(turns).toHaveLength(2);
  expect(turns[1].userMessage).toBeNull();
  expect(getTurnStartTimestamp(turns[1])).toBe(1000);
  expect(getTurnEndTimestamp(turns[1])).toBe(4000);
});

test('turn end timestamp is the latest message time and duration formats in locale units', () => {
  const turn = buildTurn([{
    id: 'user-1',
    type: 'user',
    content: 'hello',
    timestamp: 1000,
  }, {
    id: 'tool-1',
    type: 'tool_use',
    content: '',
    timestamp: 2000,
    metadata: { toolUseId: 'tool-use-1', toolName: 'exec' },
  }, {
    id: 'result-1',
    type: 'tool_result',
    content: 'done',
    timestamp: 9000,
    metadata: { toolUseId: 'tool-use-1' },
  }]);
  expect(getTurnEndTimestamp(turn)).toBe(9000);

  expect(formatTurnDuration(45_000)).toBe('45秒');
  expect(formatTurnDuration(21 * 60_000 + 45_000)).toBe('21分钟 45秒');
  expect(formatTurnDuration(3_720_000)).toBe('1小时 2分钟');
});

test('failed tool steps are counted for analytics', () => {
  const turn = buildTurn([{
    id: 'user-1', type: 'user', content: 'hello', timestamp: 1000,
  }, {
    id: 'tool-1', type: 'tool_use', content: '', timestamp: 2000, metadata: { toolUseId: 'tool-use-1', toolName: 'exec' },
  }, {
    id: 'result-1', type: 'tool_result', content: 'command not found', timestamp: 3000, metadata: { toolUseId: 'tool-use-1', isError: true },
  }, {
    id: 'tool-2', type: 'tool_use', content: '', timestamp: 4000, metadata: { toolUseId: 'tool-use-2', toolName: 'read' },
  }, {
    id: 'result-2', type: 'tool_result', content: 'ok', timestamp: 5000, metadata: { toolUseId: 'tool-use-2' },
  }, {
    id: 'tool-3', type: 'tool_use', content: '', timestamp: 6000, metadata: { toolUseId: 'tool-use-3', toolName: 'image' },
  }, {
    id: 'result-3', type: 'tool_result', content: '', timestamp: 7000, metadata: { toolUseId: 'tool-use-3', error: 'unsupported' },
  }, {
    id: 'assistant-1', type: 'assistant', content: 'done', timestamp: 8000,
  }]);
  expect(countTurnFailedSteps(turn)).toBe(2);
  expect(countTurnFailedSteps(buildTurn([{ id: 'user-2', type: 'user', content: 'hi', timestamp: 1 }]))).toBe(0);
});

test('image and browser tool rows summarize their target instead of a generic tool label', () => {
  expect(getToolInputSummary('image', { path: '/tmp/shots/cover.png', prompt: 'describe' })).toBe('/tmp/shots/cover.png');
  expect(getToolInputSummary('browser', { action: 'navigate', url: 'https://example.com/docs' })).toBe('navigate · https://example.com/docs');
  expect(getToolInputSummary('browser', { action: 'screenshot' })).toBe('screenshot');
  expect(getToolInputSummary('browser', {})).toBeNull();
});

test('turn answer start index splits trailing answer text from the process', () => {
  // process (thinking + tools) followed by the final answer text
  const chunksWithAnswer = chunkConsolidatedItemsForDisplay([
    activityThinkingItem('think-1'),
    activityToolItem('tool-1'),
    activityTextItem('text-mid'),
    activityToolItem('tool-2'),
    activityTextItem('text-final'),
  ]);
  const answerStart = getTurnAnswerStartIndex(chunksWithAnswer);
  expect(answerStart).toBe(chunksWithAnswer.length - 1);
  const answerChunk = chunksWithAnswer[answerStart];
  expect(answerChunk).toMatchObject({ kind: 'item', index: 4 });

  // a turn that ends with tools has no trailing answer
  const chunksNoAnswer = chunkConsolidatedItemsForDisplay([
    activityTextItem('text-1'),
    activityToolItem('tool-1'),
  ]);
  expect(getTurnAnswerStartIndex(chunksNoAnswer)).toBe(chunksNoAnswer.length);

  // an answer-only turn folds nothing
  const answerOnly = chunkConsolidatedItemsForDisplay([activityTextItem('text-1')]);
  expect(getTurnAnswerStartIndex(answerOnly)).toBe(0);
});

test('turn process only folds once a trailing answer exists', () => {
  // Completed turn: tools followed by the final answer text → foldable.
  const completed = chunkConsolidatedItemsForDisplay([
    activityToolItem('tool-1'),
    activityTextItem('text-final'),
  ]);
  expect(canFoldTurnProcess(completed, getTurnAnswerStartIndex(completed))).toBe(true);

  // Multi-agent wait: the turn ends with a sessions_yield tool while the
  // parent waits for subagents to hand back — no answer yet, never fold.
  const waitingOnSubagents = chunkConsolidatedItemsForDisplay([
    activityTextItem('text-plan'),
    activityToolItem('spawn-1', 'sessions_spawn'),
    activityTextItem('text-progress'),
    activityToolItem('yield-1', 'sessions_yield'),
  ]);
  expect(
    canFoldTurnProcess(waitingOnSubagents, getTurnAnswerStartIndex(waitingOnSubagents)),
  ).toBe(false);

  // Answer-only turn: nothing to fold.
  const answerOnlyTurn = chunkConsolidatedItemsForDisplay([activityTextItem('text-1')]);
  expect(canFoldTurnProcess(answerOnlyTurn, getTurnAnswerStartIndex(answerOnlyTurn))).toBe(false);
});

test('turn activity fingerprint changes as streamed content grows', () => {
  const baseMessages: CoworkMessage[] = [{
    id: 'user-1',
    type: 'user',
    content: 'hello',
    timestamp: 1,
  }, {
    id: 'assistant-1',
    type: 'assistant',
    content: 'partial',
    timestamp: 2,
  }];
  const grownMessages: CoworkMessage[] = [
    baseMessages[0],
    { ...baseMessages[1], content: 'partial plus more text' },
  ];

  const before = getTurnActivityFingerprint(buildTurn(baseMessages));
  const after = getTurnActivityFingerprint(buildTurn(grownMessages));

  expect(before).not.toBe(after);
});

// ── Activity grouping ────────────────────────────────────────────────────────

const activityToolItem = (
  id: string,
  toolName = 'Bash',
  timestamps?: { use?: number; result?: number },
  toolInput?: Record<string, unknown>,
): ConsolidatedItem => ({
  type: 'tool_group',
  group: {
    type: 'tool_group',
    toolUse: {
      id,
      type: 'tool_use',
      content: '',
      timestamp: timestamps?.use ?? 0,
      metadata: { toolName, ...(toolInput ? { toolInput } : {}) },
    },
    toolResult: timestamps?.result != null
      ? { id: `${id}-result`, type: 'tool_result', content: 'ok', timestamp: timestamps.result }
      : null,
  },
});

const activityThinkingItem = (id: string): ConsolidatedItem => ({
  type: 'assistant',
  message: {
    id,
    type: 'assistant',
    content: 'thinking...',
    timestamp: 0,
    metadata: { isThinking: true },
  },
});

const activityTextItem = (id: string): ConsolidatedItem => ({
  type: 'assistant',
  message: { id, type: 'assistant', content: 'answer', timestamp: 0 },
});

test('consecutive work items collapse into groups and text breaks the run', () => {
  const items: ConsolidatedItem[] = [
    activityThinkingItem('think-1'),
    activityToolItem('tool-1'),
    activityToolItem('tool-2'),
    activityTextItem('text-1'),
    activityToolItem('tool-3'),
  ];

  const chunks = chunkConsolidatedItemsForDisplay(items);

  expect(chunks).toHaveLength(3);
  expect(chunks[0].kind).toBe('activity_group');
  const group = chunks[0] as Extract<typeof chunks[number], { kind: 'activity_group' }>;
  expect(group.entries.map(entry => entry.index)).toEqual([0, 1, 2]);
  expect(chunks[1]).toMatchObject({ kind: 'item', index: 3 });
  // A single trailing work item collapses too, so turns read as summary
  // lines interleaved with text.
  expect(chunks[2].kind).toBe('activity_group');
  const trailingGroup = chunks[2] as Extract<typeof chunks[number], { kind: 'activity_group' }>;
  expect(trailingGroup.entries.map(entry => entry.index)).toEqual([4]);
});

test('activity grouping respects a custom groupable predicate', () => {
  const items: ConsolidatedItem[] = [
    activityToolItem('tool-1'),
    activityToolItem('tool-2'),
    activityToolItem('tool-3'),
    activityToolItem('tool-4'),
  ];

  const chunks = chunkConsolidatedItemsForDisplay(
    items,
    (item) => isActivityConsolidatedItem(item)
      && !(item.type === 'tool_group' && item.group.toolUse.id === 'tool-2'),
  );

  expect(chunks.map(chunk => chunk.kind)).toEqual(['activity_group', 'item', 'activity_group']);
  const trailing = chunks[2] as Extract<typeof chunks[number], { kind: 'activity_group' }>;
  expect(trailing.entries.map(entry => entry.index)).toEqual([2, 3]);
});

test('activity summary counts steps', () => {
  const items: ConsolidatedItem[] = [
    activityThinkingItem('think-1'),
    activityToolItem('tool-1', 'Bash', { use: 1000, result: 8000 }),
    activityToolItem('tool-2', 'Bash', { use: 9000, result: 46000 }),
    activityToolItem('tool-3', 'read_file'),
  ];

  expect(getActivityGroupSummary(items).stepCount).toBe(4);
});

test('activity header label summarizes commands, reads, and edits in natural language', () => {
  expect(getActivityGroupHeaderLabel([
    activityThinkingItem('think-1'),
    activityToolItem('tool-1', 'Bash'),
    activityToolItem('tool-2', 'exec'),
    activityToolItem('tool-3', 'Bash'),
    activityToolItem('tool-4', 'read_file'),
    activityToolItem('tool-5', 'Read'),
  ])).toBe('运行了 3 个命令、读取了 2 个文件');

  expect(getActivityGroupHeaderLabel([
    activityToolItem('tool-1', 'Edit'),
    activityToolItem('tool-2', 'web_fetch'),
  ])).toBe('进行了 1 次编辑、调用了 1 次工具');

  // Thinking-only groups fall back to a dedicated label.
  expect(getActivityGroupHeaderLabel([
    activityThinkingItem('think-1'),
    activityThinkingItem('think-2'),
  ])).toBe('深度思考');

  // Single-step groups show the concrete action as a past-tense phrase; a
  // shell step shows the model's plain-language summary, never the command.
  expect(getActivityGroupHeaderLabel([
    activityToolItem('tool-1', 'exec', undefined, { command: 'npm test -- cowork', description: '运行单元测试' }),
  ])).toBe('运行单元测试');
  expect(getActivityGroupHeaderLabel([
    activityToolItem('tool-1', 'Bash', undefined, { command: 'npm test -- cowork' }),
  ])).toBe('运行了命令');
  expect(getActivityGroupHeaderLabel([
    activityToolItem('tool-1', 'read_file', undefined, { file_path: '/repo/src/App.tsx' }),
  ])).toBe('读取了 App.tsx');
  expect(getActivityGroupHeaderLabel([
    activityToolItem('tool-1', 'tavily__tavily_search', undefined, { query: 'youdao' }),
  ])).toBe('使用了 tavily__tavily_search');
  expect(getActivityGroupHeaderLabel([activityToolItem('tool-1', 'write')])).toBe('写入了文件');
});

test('a folded run with one real step names that step, not a count', () => {
  expect(getActivityGroupHeaderLabel([
    activityThinkingItem('think-1'),
    activityToolItem('tool-1', 'tavily__tavily_search', undefined, { query: 'GPT-6' }),
  ])).toBe('使用了 tavily__tavily_search');
  expect(getActivityGroupHeaderLabel([
    activityThinkingItem('think-1'),
    activityToolItem('tool-1', 'read', undefined, { file_path: '/skills/pptx/SKILL.md' }),
    activityThinkingItem('think-2'),
  ])).toBe('读取了 SKILL.md');
});

test('step lines lead with an icon kind that follows the tool, and thinking has none', () => {
  expect(getActivityStepKind(activityThinkingItem('think-1'))).toBe(ActivityStepKind.Thinking);
  expect(getActivityStepKind(activityToolItem('tool-1', 'exec'))).toBe(ActivityStepKind.Command);
  expect(getActivityStepKind(activityToolItem('tool-2', 'process'))).toBe(ActivityStepKind.Command);
  expect(getActivityStepKind(activityToolItem('tool-3', 'read'))).toBe(ActivityStepKind.Read);
  expect(getActivityStepKind(activityToolItem('tool-4', 'write'))).toBe(ActivityStepKind.Edit);
  expect(getActivityStepKind(activityToolItem('tool-5', 'apply_patch'))).toBe(ActivityStepKind.Edit);
  expect(getActivityStepKind(activityToolItem('tool-6', 'web_search'))).toBe(ActivityStepKind.Web);
  expect(getActivityStepKind(activityToolItem('tool-7', 'browser'))).toBe(ActivityStepKind.Web);
  expect(getActivityStepKind(activityToolItem('tool-8', 'memory_search'))).toBe(ActivityStepKind.Search);
  expect(getActivityStepKind(activityToolItem('tool-9', 'lobsterai_image_generate'))).toBe(ActivityStepKind.Media);
  expect(getActivityStepKind(activityToolItem('tool-10', 'sessions_spawn'))).toBe(ActivityStepKind.Agent);
  expect(getActivityStepKind(activityToolItem('tool-11', 'TodoWrite'))).toBe(ActivityStepKind.Todo);
  expect(getActivityStepKind(activityToolItem('tool-12', 'cron'))).toBe(ActivityStepKind.Schedule);
  expect(getActivityStepKind(activityToolItem('tool-13', 'tavily__tavily_search'))).toBe(ActivityStepKind.Tool);
});

test('a folded run summary leads with the icon of the first category its label names', () => {
  // The label reads "运行了 1 个命令、读取了 1 个文件", so the command icon leads.
  expect(getActivityGroupStepKind([
    activityThinkingItem('think-1'),
    activityToolItem('tool-1', 'read'),
    activityToolItem('tool-2', 'exec'),
  ])).toBe(ActivityStepKind.Command);
  expect(getActivityGroupStepKind([
    activityToolItem('tool-1', 'web_search'),
    activityToolItem('tool-2', 'edit'),
  ])).toBe(ActivityStepKind.Edit);
  // Only other tools: the first one's kind.
  expect(getActivityGroupStepKind([
    activityThinkingItem('think-1'),
    activityToolItem('tool-1', 'web_fetch'),
    activityToolItem('tool-2', 'cron'),
  ])).toBe(ActivityStepKind.Web);
  expect(getActivityGroupStepKind([
    activityThinkingItem('think-1'),
    activityThinkingItem('think-2'),
  ])).toBe(ActivityStepKind.Thinking);
});

test('activity step display shortens file paths to basenames', () => {
  const readStep = getActivityStepDisplay(activityToolItem(
    'tool-1',
    'read_file',
    undefined,
    { file_path: '/Users/dev/project/src/renderer/App.tsx' },
  ));
  expect(readStep).toEqual({ name: 'Read', summary: 'App.tsx' });

  const bashStep = getActivityStepDisplay(activityToolItem(
    'tool-2',
    'Bash',
    undefined,
    { command: 'npm test -- cowork' },
  ));
  expect(bashStep).toEqual({ name: 'Bash', summary: 'npm test -- cowork' });

  // A described shell step reads as its summary alone, without the tool name.
  const describedStep = getActivityStepDisplay(activityToolItem(
    'tool-3',
    'exec',
    undefined,
    { command: 'node -v', description: '检查 Node.js 版本' },
  ));
  expect(describedStep).toEqual({ name: '检查 Node.js 版本', summary: null });
});

test('shell command description is trimmed, single-line, and only read for shell tools', () => {
  expect(getShellCommandDescription('exec', { command: 'ls', description: '  列出\n 工作目录   文件 ' }))
    .toBe('列出 工作目录 文件');
  expect(getShellCommandDescription('bash', { command: 'ls', description: 'x'.repeat(200) }))
    .toHaveLength(80);
  expect(getShellCommandDescription('exec', { command: 'ls', description: '   ' })).toBeNull();
  expect(getShellCommandDescription('exec', { command: 'ls', description: 42 })).toBeNull();
  expect(getShellCommandDescription('exec', { command: 'ls' })).toBeNull();
  expect(getShellCommandDescription('exec', undefined)).toBeNull();
  // Other tools may carry a `description` argument with another meaning.
  expect(getShellCommandDescription('task', { description: 'Explore the repo' })).toBeNull();
});

test('activity current action text is a verb phrase for the latest step', () => {
  expect(getActivityCurrentActionText(activityThinkingItem('think-1'))).toBe('思考中…');
  expect(getActivityCurrentActionText(activityToolItem(
    'tool-1',
    'read_file',
    undefined,
    { file_path: '/tmp/notes.md' },
  ))).toBe('正在读取 notes.md');
  // Shell steps show the model's summary while running, or a generic phrase,
  // never the raw command.
  expect(getActivityCurrentActionText(activityToolItem(
    'tool-2',
    'exec',
    undefined,
    { command: 'npm run build', description: '构建项目' },
  ))).toBe('构建项目');
  expect(getActivityCurrentActionText(activityToolItem(
    'tool-2',
    'Bash',
    undefined,
    { command: 'npm run build' },
  ))).toBe('正在运行命令');
  expect(getActivityCurrentActionText(activityToolItem(
    'tool-3',
    'Edit',
    undefined,
    { file_path: '/repo/src/i18n.ts', old_string: 'a', new_string: 'b' },
  ))).toBe('正在修改 i18n.ts');
  expect(getActivityCurrentActionText(activityToolItem('tool-4', 'web_fetch')))
    .toBe('正在使用 web_fetch');
  // Session orchestration tools get plain-language labels instead of raw names.
  expect(getActivityCurrentActionText(activityToolItem('tool-5', 'sessions_yield')))
    .toBe('正在等待子 Agent 完成');
  expect(getActivityStepDisplay(activityToolItem('tool-6', 'sessions_yield')).name)
    .toBe('等待子 Agent 完成');
});

test('diff stats count added and removed lines', () => {
  expect(computeDiffStats('a\nb\nc', 'a\nB\nc\nd')).toEqual({ added: 2, removed: 1 });
  expect(computeDiffStats('same', 'same')).toEqual({ added: 0, removed: 0 });
});

test('media polling groups count their polls as steps', () => {
  const polls = [
    activityToolItem('poll-1', 'lobsterai_video_generate'),
    activityToolItem('poll-2', 'lobsterai_video_generate'),
    activityToolItem('poll-3', 'lobsterai_video_generate'),
  ].map(item => (item as Extract<ConsolidatedItem, { type: 'tool_group' }>).group);

  const mediaItem = {
    type: 'media_polling_group',
    group: {
      type: 'media_polling_group',
      toolName: 'lobsterai_video_generate',
      taskId: 'task-1',
      lastStatus: 'succeeded',
      pollCount: 3,
      polls,
      isComplete: true,
    },
  } as unknown as ConsolidatedItem;

  const summary = getActivityGroupSummary([mediaItem, activityToolItem('tool-1')]);

  expect(summary.stepCount).toBe(4);
});

test('thinking phase labels start with the plain thinking label so the first render is unchanged', () => {
  const phases = getThinkingPhaseLabels();
  expect(phases[0]).toBe(getActivityIndicatorStatusText());
  expect(phases.length).toBeGreaterThan(1);
  expect(new Set(phases).size).toBe(phases.length);
});

test('completed step count only includes tool groups with a final result', () => {
  const group = (id: string, result?: { isStreaming?: boolean; isFinal?: boolean } | null) => ({
    type: 'tool_group' as const,
    group: {
      type: 'tool_group' as const,
      toolUse: { id, type: 'tool_use' as const, content: '', timestamp: 1, metadata: { toolName: 'exec' } },
      ...(result === undefined ? {} : { toolResult: result === null ? null : { id: `${id}-r`, type: 'tool_result' as const, content: 'ok', timestamp: 2, metadata: result } }),
    },
  });
  const turn = {
    id: 'turn', userMessage: null,
    assistantItems: [
      group('done', { isFinal: true }),
      group('legacy', {}),
      group('streaming', { isStreaming: true, isFinal: false }),
      group('pending'),
      { type: 'assistant' as const, message: { id: 'a', type: 'assistant' as const, content: 'text', timestamp: 3 } },
    ],
  };
  expect(countTurnCompletedSteps(turn)).toBe(2);
});

const runningToolItem = (
  toolName: string,
  toolInput: Record<string, unknown>,
  result?: { content: string; isFinal: boolean },
): ConsolidatedItem => ({
  type: 'tool_group',
  group: {
    type: 'tool_group',
    toolUse: { id: 'use-1', type: 'tool_use', content: '', timestamp: 1, metadata: { toolName, toolInput, toolUseId: 'call-1' } },
    toolResult: result
      ? {
        id: 'result-1',
        type: 'tool_result',
        content: result.content,
        timestamp: 2,
        metadata: { toolUseId: 'call-1', isStreaming: !result.isFinal, isFinal: result.isFinal },
      }
      : null,
  },
});

test('a tool step with a streaming result is still live, not settled', () => {
  const streaming = runningToolItem('exec', { command: 'npm install' }, { content: 'added 3 packages', isFinal: false });
  const done = runningToolItem('exec', { command: 'npm install' }, { content: 'added 3 packages', isFinal: true });
  const pending = runningToolItem('exec', { command: 'npm install' });
  expect(isToolGroupSettled((streaming as Extract<ConsolidatedItem, { type: 'tool_group' }>).group)).toBe(false);
  expect(isToolGroupSettled((done as Extract<ConsolidatedItem, { type: 'tool_group' }>).group)).toBe(true);
  expect(isToolGroupSettled((pending as Extract<ConsolidatedItem, { type: 'tool_group' }>).group)).toBe(false);
});

test('live detail shows the reasoning tail while thinking streams', () => {
  const reasoning = `${'The runtime says node v24 but the shell has v20. '.repeat(8)}Let me check NODE_PATH.`;
  const detail = getActivityLiveDetail({
    type: 'assistant',
    message: { id: 'think-1', type: 'assistant', content: reasoning, timestamp: 0, metadata: { isThinking: true, isStreaming: true } },
  });
  expect(detail?.kind).toBe('reasoning');
  expect(detail?.text.startsWith('…')).toBe(true);
  expect(detail?.text.endsWith('Let me check NODE_PATH.')).toBe(true);
  expect(detail?.text.length).toBeLessThanOrEqual(221);
  expect(getActivityLiveDetail(activityTextItem('text-1'))).toBeNull();
});

test('live detail shows the latest output line of a running command and nothing before output', () => {
  const silent = runningToolItem('exec', { command: 'npm root -g' });
  expect(getActivityLiveDetail(silent)).toBeNull();

  const streaming = runningToolItem('exec', { command: 'npm root -g' }, {
    content: '/usr/lib/node_modules\ncorepack\nnpm\n\n',
    isFinal: false,
  });
  expect(getActivityLiveDetail(streaming)).toEqual({ kind: 'output', text: 'npm' });

  const reading = runningToolItem('read', { path: '/tmp/a.md' }, { content: 'partial', isFinal: false });
  expect(getActivityLiveDetail(reading)).toBeNull();
});

test('a tool call whose arguments are still streaming reads as generating with live counts', () => {
  const generating: ConsolidatedItem = {
    type: 'tool_group',
    group: {
      type: 'tool_group',
      toolUse: {
        id: 'use-2',
        type: 'tool_use',
        content: '',
        timestamp: 1,
        metadata: { toolName: 'write', toolInput: {}, toolUseId: 'call-2', isGenerating: true, liveEditDiff: { added: 118, removed: 0 } },
      },
      toolResult: null,
    },
  };
  expect(getActivityCurrentActionText(generating)).toBe('正在写入文件');
  expect(getLiveEditDiff((generating as Extract<ConsolidatedItem, { type: 'tool_group' }>).group.toolUse)).toEqual({ added: 118, removed: 0 });

  const started = runningToolItem('write', { path: '/tmp/build.py', content: 'print(1)' });
  expect(getActivityCurrentActionText(started)).toBe('正在写入 build.py');
  expect(getLiveEditDiff((started as Extract<ConsolidatedItem, { type: 'tool_group' }>).group.toolUse)).toBeNull();
});

test('status line phrase follows the running step', () => {
  expect(getActivityLiveStatusText(runningToolItem('exec', { command: 'npm install' }))).toBe('正在运行命令');
  expect(getActivityLiveStatusText(runningToolItem('read', { path: '/Users/me/project/README.md' }))).toBe('正在读取文件');
  expect(getActivityLiveStatusText(runningToolItem('read', { path: '/Users/me/.openclaw/skills/pptx/SKILL.md' }))).toBe('正在读取技能说明');
  expect(getActivityLiveStatusText(runningToolItem('write', { path: '/tmp/a.py', content: 'x' }))).toBe('正在写入文件');
  expect(getActivityLiveStatusText(runningToolItem('edit', { path: '/tmp/a.py' }))).toBe('正在修改文件');
  expect(getActivityLiveStatusText(runningToolItem('grep', { pattern: 'TODO' }))).toBe('正在搜索文件');
  expect(getActivityLiveStatusText(runningToolItem('web_search', { query: 'tencent 2025' }))).toBe('正在搜索网页');
  expect(getActivityLiveStatusText(runningToolItem('todowrite', { todos: [] }))).toBe('正在更新任务清单');
  expect(getActivityLiveStatusText(runningToolItem('ask_user', { question: 'which?' }))).toBe('正在准备提问');
  expect(getActivityLiveStatusText(runningToolItem('some_plugin_tool', {}))).toBe('正在调用工具');
  expect(getActivityLiveStatusText({
    type: 'assistant',
    message: { id: 'a', type: 'assistant', content: 'partial reply', timestamp: 0, metadata: { isStreaming: true } },
  })).toBe('正在生成回复');
  expect(getActivityLiveStatusText({
    type: 'assistant',
    message: { id: 't', type: 'assistant', content: 'hmm', timestamp: 0, metadata: { isThinking: true, isStreaming: true } },
  })).toBe('正在思考');
});

test('a file streaming its content reads the same on its step line and the status line', () => {
  const generating = (toolName: string): ConsolidatedItem => ({
    type: 'tool_group',
    group: {
      type: 'tool_group',
      toolUse: {
        id: `use-${toolName}`, type: 'tool_use', content: '', timestamp: 1,
        metadata: { toolName, toolInput: {}, toolUseId: `call-${toolName}`, isGenerating: true, liveEditDiff: { added: 4, removed: 0 } },
      },
      toolResult: null,
    },
  });
  expect(getActivityLiveStatusText(generating('write'))).toBe('正在写入文件');
  expect(getActivityCurrentActionText(generating('write'))).toBe('正在写入文件');
  expect(getActivityLiveStatusText(generating('edit'))).toBe('正在修改文件');
  expect(getActivityCurrentActionText(generating('edit'))).toBe('正在修改文件');
  expect(isActivityItemLive(generating('write'))).toBe(true);
});

test('a running command without a description reads the same on its step line and the status line', () => {
  const command = runningToolItem('exec', { command: 'npm install' });
  expect(getActivityCurrentActionText(command)).toBe(getActivityLiveStatusText(command));
});

test('a work item is live until its result is final', () => {
  expect(isActivityItemLive(runningToolItem('exec', { command: 'ls' }))).toBe(true);
  expect(isActivityItemLive(runningToolItem('exec', { command: 'ls' }, { content: 'a', isFinal: false }))).toBe(true);
  expect(isActivityItemLive(runningToolItem('exec', { command: 'ls' }, { content: 'a', isFinal: true }))).toBe(false);
  expect(isActivityItemLive({
    type: 'assistant',
    message: { id: 'a', type: 'assistant', content: 'partial', timestamp: 0, metadata: { isStreaming: true } },
  })).toBe(true);
  expect(isActivityItemLive(activityTextItem('done'))).toBe(false);
});

test('streaming text signature changes as a thought grows and is absent once it closes', () => {
  const thought = (content: string, isStreaming: boolean): ConsolidatedItem => ({
    type: 'assistant',
    message: { id: 'think-1', type: 'assistant', content, timestamp: 0, metadata: { isThinking: true, isStreaming } },
  });
  const early = getStreamingTextSignature(thought('Let me', true));
  const later = getStreamingTextSignature(thought('Let me check', true));
  expect(early).not.toBeNull();
  expect(later).not.toBe(early);
  expect(getStreamingTextSignature(thought('Let me check', true))).toBe(later);
  expect(getStreamingTextSignature(thought('Let me check', false))).toBeNull();
  expect(getStreamingTextSignature(runningToolItem('exec', { command: 'ls' }))).toBeNull();
  expect(getStreamingTextSignature(null)).toBeNull();
});

test('a file step whose tool never started is an abandoned placeholder', () => {
  const placeholder = {
    type: 'tool_group' as const,
    group: {
      type: 'tool_group' as const,
      toolUse: {
        id: 'use-4', type: 'tool_use' as const, content: '', timestamp: 1,
        metadata: { toolName: 'write', toolInput: {}, toolUseId: 'call-4', isGenerating: true, liveEditDiff: { added: 40, removed: 0 } },
      },
      toolResult: null,
    },
  };
  expect(isAbandonedToolPlaceholder(placeholder)).toBe(true);

  const started = runningToolItem('write', { path: '/tmp/a.html', content: '<html>' });
  expect(isAbandonedToolPlaceholder(started as Extract<ConsolidatedItem, { type: 'tool_group' }>)).toBe(false);
  const finished = runningToolItem('write', { path: '/tmp/a.html', content: '<html>' }, { content: 'ok', isFinal: true });
  expect(isAbandonedToolPlaceholder(finished as Extract<ConsolidatedItem, { type: 'tool_group' }>)).toBe(false);
});
