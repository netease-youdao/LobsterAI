import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { AgentAvatarSvg } from '../../shared/agent/avatar';
import {
  AgentDraftErrorCode,
  AgentDraftLanguage,
  AgentDraftMode,
} from '../../shared/agent/draft';
import { OpenClawApi } from '../../shared/providers';
import { generateAgentDraft, readFolderContextSnippet } from './agentDraftGenerator';
import { OneShotTargetError } from './oneShotModelClient';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function createSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('readFolderContextSnippet', () => {
  test('reads non-hidden entries and prefers AGENTS.md over README.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lobsterai-folder-ctx-'));
    tempDirs.push(dir);
    fs.writeFileSync(path.join(dir, '.hidden'), 'secret', 'utf8');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Repo Rules\nUse strict TypeScript.', 'utf8');
    fs.writeFileSync(path.join(dir, 'README.md'), '# Readme', 'utf8');
    fs.mkdirSync(path.join(dir, 'docs'));

    const snippet = readFolderContextSnippet(dir);
    expect(snippet).toContain('AGENTS.md');
    expect(snippet).toContain('docs/');
    expect(snippet).not.toContain('.hidden');
    expect(snippet).toContain('Use strict TypeScript.');
  });

  test('returns empty string for missing directories', () => {
    expect(readFolderContextSnippet('/non/existent/lobsterai/path')).toBe('');
  });
});

describe('generateAgentDraft', () => {
  test('rejects completely empty requests before resolving model', async () => {
    const resolveModel = vi.fn();
    const result = await generateAgentDraft(
      { mode: AgentDraftMode.Create, goal: '   ' },
      { resolveModel },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(AgentDraftErrorCode.EmptyInput);
    }
    expect(resolveModel).not.toHaveBeenCalled();
  });

  test('maps missing model target to NoModel error code', async () => {
    const result = await generateAgentDraft(
      { mode: AgentDraftMode.Create, goal: 'Daily tech digest' },
      { resolveModel: () => ({ error: OneShotTargetError.NoModel, detail: 'No API key' }) },
    );

    expect(result).toEqual({
      success: false,
      errorCode: AgentDraftErrorCode.NoModel,
      error: 'No API key',
    });
  });

  test('streams OpenAI SSE chunks and parses structured agent draft', async () => {
    const payload = JSON.stringify({
      name: '科技早报助手',
      description: '每天汇总 AI 与科技热点，提炼重点结论',
      instructions: '- 筛选过去 24 小时高价值科技新闻\n- 按领域分类并附一句话点评',
      avatarSvg: AgentAvatarSvg.Lightning,
      recommendedSkillIds: ['web-search', 'non-existent'],
      starterPrompts: ['生成今天的 AI 科技早报', '对比本周大模型发布动态'],
    });
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(0, 40) } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: payload.slice(40) } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const mockFetch = vi.fn(async () => createSseResponse(sse));
    const result = await generateAgentDraft(
      {
        mode: AgentDraftMode.Create,
        goal: '每天帮我汇总科技早报',
        skills: [{ id: 'web-search', name: 'Web Search' }],
        language: AgentDraftLanguage.Zh,
      },
      {
        resolveModel: () => ({
          target: {
            api: OpenClawApi.OpenAICompletions,
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            providerName: 'openai',
          },
        }),
        fetch: mockFetch as unknown as typeof fetch,
      },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      success: true,
      draft: {
        name: '科技早报助手',
        description: '每天汇总 AI 与科技热点，提炼重点结论',
        instructions: '- 筛选过去 24 小时高价值科技新闻\n- 按领域分类并附一句话点评',
        avatarSvg: AgentAvatarSvg.Lightning,
        recommendedSkillIds: ['web-search'],
        starterPrompts: ['生成今天的 AI 科技早报', '对比本周大模型发布动态'],
      },
    });
  });

  test('streams OpenAI Codex OAuth Responses plain-text chunks with lowLatency and emits live progress', async () => {
    const polished = '- 定位：全场景个人助理，协作完成文档、数据、PPT 与日程任务\n- 风格：专业直接、先给结论';
    const sse = [
      'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"thinking..."}\n\n',
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: polished.slice(0, 20) })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: polished.slice(20) })}\n\n`,
      'event: response.done\ndata: {"type":"response.done"}\n\n',
    ];

    const progressUpdates: Array<{ instructions?: string; description?: string }> = [];
    const mockFetch = vi.fn(async () => createSseResponse(sse));
    const result = await generateAgentDraft(
      {
        mode: AgentDraftMode.Polish,
        name: '主 Agent',
        goal: '主 Agent',
        existingInstructions: '你的名字是 LobsterAI，回复专业直接',
        language: AgentDraftLanguage.Zh,
      },
      {
        resolveModel: () => ({
          target: {
            api: OpenClawApi.OpenAICodexResponses,
            baseUrl: 'http://127.0.0.1:45555/v1/openai-codex',
            apiKey: 'loopback-secret',
            model: 'gpt-6-astra',
            providerName: 'openai',
          },
        }),
        fetch: mockFetch as unknown as typeof fetch,
        onProgress: (preview) => progressUpdates.push(preview),
      },
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [requestUrl, requestInit] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe('http://127.0.0.1:45555/v1/openai-codex/responses');
    const body = JSON.parse(String(requestInit.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-6-astra',
      store: false,
      stream: true,
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    });
    expect(typeof body.instructions).toBe('string');
    expect(body).not.toHaveProperty('max_output_tokens');
    expect(progressUpdates).toEqual([
      { instructions: polished.slice(0, 20) },
      { instructions: polished },
    ]);
    expect(result).toEqual({
      success: true,
      draft: {
        name: '主 Agent',
        description: '',
        instructions: polished,
        recommendedSkillIds: [],
        starterPrompts: [],
      },
    });
  });

  test('returns Cancelled when external AbortSignal aborts in-flight generation', async () => {
    const controller = new AbortController();
    const mockFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    const promise = generateAgentDraft(
      { mode: AgentDraftMode.Polish, name: 'Helper', goal: 'Polish', existingInstructions: 'Be concise' },
      {
        resolveModel: () => ({
          target: {
            api: OpenClawApi.OpenAICompletions,
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            providerName: 'openai',
          },
        }),
        fetch: mockFetch as unknown as typeof fetch,
        signal: controller.signal,
      },
    );
    controller.abort();
    const result = await promise;
    expect(result).toEqual({
      success: false,
      errorCode: AgentDraftErrorCode.Cancelled,
      error: 'Cancelled.',
    });
  });

  test('returns ParseFailed when Create mode model returns non-JSON text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Sorry, I cannot help with that.' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const result = await generateAgentDraft(
      { mode: AgentDraftMode.Create, name: 'Helper', goal: 'Build helper' },
      {
        resolveModel: () => ({
          target: {
            api: OpenClawApi.OpenAICompletions,
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            providerName: 'openai',
          },
        }),
        fetch: (async () => createSseResponse(sse)) as unknown as typeof fetch,
      },
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorCode).toBe(AgentDraftErrorCode.ParseFailed);
    }
    warn.mockRestore();
  });

  test('streams polish SUMMARY line and instructions when includeDescription is true', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'SUM' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'MARY: 整理结构化周报，先给结论再列细节\n\n' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: '- 先给核心结论\n- 再补充关键细节' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const progressUpdates: Array<{ instructions?: string; description?: string }> = [];
    const result = await generateAgentDraft(
      {
        mode: AgentDraftMode.Polish,
        name: '周报助手',
        goal: '周报助手',
        existingInstructions: '整理周报',
        includeDescription: true,
        language: AgentDraftLanguage.Zh,
      },
      {
        resolveModel: () => ({
          target: {
            api: OpenClawApi.OpenAICompletions,
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            providerName: 'openai',
          },
        }),
        fetch: (async () => createSseResponse(sse)) as unknown as typeof fetch,
        onProgress: (preview) => progressUpdates.push(preview),
      },
    );

    expect(progressUpdates).toEqual([
      { description: '整理结构化周报，先给结论再列细节' },
      {
        description: '整理结构化周报，先给结论再列细节',
        instructions: '- 先给核心结论\n- 再补充关键细节',
      },
    ]);
    expect(result).toEqual({
      success: true,
      draft: {
        name: '周报助手',
        description: '整理结构化周报，先给结论再列细节',
        instructions: '- 先给核心结论\n- 再补充关键细节',
        recommendedSkillIds: [],
        starterPrompts: [],
      },
    });
  });

  test('generates cleaned one-line summary in Summary mode with compact token budget', async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: '简介：「将会议记录提炼为行动项与结构化纪要」' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const mockFetch = vi.fn(async () => createSseResponse(sse));

    const result = await generateAgentDraft(
      {
        mode: AgentDraftMode.Summary,
        name: '纪要助手',
        goal: '纪要助手',
        existingInstructions: '帮我把会议录音文字稿整理成包含行动项和负责人的会议纪要。',
        language: AgentDraftLanguage.Zh,
      },
      {
        resolveModel: () => ({
          target: {
            api: OpenClawApi.OpenAICompletions,
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'test-key',
            model: 'gpt-4o-mini',
            providerName: 'openai',
          },
        }),
        fetch: mockFetch as unknown as typeof fetch,
      },
    );

    const [, requestInit] = mockFetch.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(requestInit.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(256);
    expect(result).toEqual({
      success: true,
      draft: {
        name: '纪要助手',
        description: '将会议记录提炼为行动项与结构化纪要',
        instructions: '帮我把会议录音文字稿整理成包含行动项和负责人的会议纪要。',
        recommendedSkillIds: [],
        starterPrompts: [],
      },
    });
  });
});
