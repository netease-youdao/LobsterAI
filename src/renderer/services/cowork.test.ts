import { describe, it, expect } from 'vitest';

/**
 * BUG-1 验证测试: continueSession 双重错误消息
 *
 * 问题: 修改前，当 continueSession 失败时，会连续 dispatch 两条系统错误消息
 *       （一条 coworkErrorSessionContinueFailed，一条 classifyError）
 * 修复: 合并为一条 classifyError 消息
 *
 * 测试策略: 提取错误处理的核心逻辑为纯函数，分别模拟修改前和修改后的行为，
 *          对比 dispatch 调用次数和消息内容。
 */

// ---- 模拟依赖 ----

/** 模拟 classifyErrorKey（从 coworkErrorClassify.ts 提取的简化版） */
function classifyErrorKey(error: string): string | null {
  if (/authentication.*error|api.*key.*invalid|unauthorized|\b401\b/i.test(error)) {
    return 'coworkErrorAuthInvalid';
  }
  if (/\b429\b|rate.*limit|too many requests/i.test(error)) {
    return 'coworkErrorRateLimit';
  }
  if (/insufficient.*(balance|quota)/i.test(error)) {
    return 'coworkErrorInsufficientBalance';
  }
  return null;
}

/** 模拟 i18nService.t */
const translations: Record<string, string> = {
  coworkErrorSessionContinueFailed: '继续会话失败: {error}',
  coworkErrorEngineNotReady: '引擎未就绪',
  coworkErrorAuthInvalid: 'API 密钥无效或已过期',
  coworkErrorRateLimit: '请求频率超限，请稍后重试',
  coworkErrorInsufficientBalance: '账户余额不足',
};

function t(key: string): string {
  return translations[key] ?? key;
}

function classifyError(error: string): string {
  const key = classifyErrorKey(error);
  return key ? t(key) : error;
}

// ---- 模拟 continueSession 失败时的错误处理逻辑 ----

interface DispatchedMessage {
  id: string;
  type: string;
  content: string;
  timestamp: number;
}

interface FailureResult {
  success: false;
  error?: string;
  code?: string;
  engineStatus?: unknown;
}

/**
 * 修改前的错误处理逻辑（BUG 版本）
 * 会产生两条错误消息
 */
function handleContinueFailure_BEFORE(
  result: FailureResult,
  sessionId: string,
): DispatchedMessage[] {
  const messages: DispatchedMessage[] = [];

  if (result.code !== 'ENGINE_NOT_READY') {
    // 第一条消息: coworkErrorSessionContinueFailed
    if (result.error) {
      messages.push({
        id: `error-${Date.now()}`,
        type: 'system',
        content: t('coworkErrorSessionContinueFailed').replace('{error}', result.error),
        timestamp: Date.now(),
      });
    }
  }

  // 第二条消息: classifyError
  if (result.error) {
    const errorContent = result.code === 'ENGINE_NOT_READY'
      ? t('coworkErrorEngineNotReady')
      : classifyError(result.error);
    messages.push({
      id: `error-${Date.now()}`,
      type: 'system',
      content: errorContent,
      timestamp: Date.now(),
    });
  }

  return messages;
}

/**
 * 修改后的错误处理逻辑（修复版本）
 * 只产生一条错误消息
 */
function handleContinueFailure_AFTER(
  result: FailureResult,
  sessionId: string,
): DispatchedMessage[] {
  const messages: DispatchedMessage[] = [];

  // 只添加一条消息
  if (result.error) {
    const errorContent = result.code === 'ENGINE_NOT_READY'
      ? t('coworkErrorEngineNotReady')
      : classifyError(result.error);
    messages.push({
      id: `error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'system',
      content: errorContent,
      timestamp: Date.now(),
    });
  }

  return messages;
}

// ---- 测试用例 ----

describe('BUG-1: continueSession 双重错误消息', () => {

  describe('场景1: 普通 API 错误（如认证失败）', () => {
    const result: FailureResult = {
      success: false,
      error: 'authentication error: invalid api key',
      code: undefined,
    };

    it('修改前: 产生 2 条错误消息（BUG）', () => {
      const messages = handleContinueFailure_BEFORE(result, 'session-1');
      expect(messages).toHaveLength(2);
      // 第一条: 原始的 coworkErrorSessionContinueFailed 模板
      expect(messages[0].content).toBe(
        '继续会话失败: authentication error: invalid api key'
      );
      // 第二条: classifyError 分类后的消息
      expect(messages[1].content).toBe('API 密钥无效或已过期');
    });

    it('修改后: 只产生 1 条错误消息（修复）', () => {
      const messages = handleContinueFailure_AFTER(result, 'session-1');
      expect(messages).toHaveLength(1);
      // 唯一一条: classifyError 分类后的精确消息
      expect(messages[0].content).toBe('API 密钥无效或已过期');
    });
  });

  describe('场景2: 速率限制错误', () => {
    const result: FailureResult = {
      success: false,
      error: '429 too many requests',
      code: undefined,
    };

    it('修改前: 产生 2 条错误消息（BUG）', () => {
      const messages = handleContinueFailure_BEFORE(result, 'session-2');
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('继续会话失败: 429 too many requests');
      expect(messages[1].content).toBe('请求频率超限，请稍后重试');
    });

    it('修改后: 只产生 1 条错误消息（修复）', () => {
      const messages = handleContinueFailure_AFTER(result, 'session-2');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('请求频率超限，请稍后重试');
    });
  });

  describe('场景3: 未分类的错误（无匹配规则）', () => {
    const result: FailureResult = {
      success: false,
      error: 'some unexpected weird error from provider',
      code: undefined,
    };

    it('修改前: 产生 2 条内容几乎相同的消息（BUG）', () => {
      const messages = handleContinueFailure_BEFORE(result, 'session-3');
      expect(messages).toHaveLength(2);
      // 第一条: 模板包裹原始错误
      expect(messages[0].content).toBe(
        '继续会话失败: some unexpected weird error from provider'
      );
      // 第二条: classifyError 无匹配，直接返回原始错误
      expect(messages[1].content).toBe('some unexpected weird error from provider');
    });

    it('修改后: 只产生 1 条消息，直接展示原始错误', () => {
      const messages = handleContinueFailure_AFTER(result, 'session-3');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('some unexpected weird error from provider');
    });
  });

  describe('场景4: ENGINE_NOT_READY 错误', () => {
    const result: FailureResult = {
      success: false,
      error: 'OpenClaw engine is not ready',
      code: 'ENGINE_NOT_READY',
    };

    it('修改前: 产生 1 条消息（此场景无双重问题）', () => {
      const messages = handleContinueFailure_BEFORE(result, 'session-4');
      // code === ENGINE_NOT_READY 时，第一段不执行，只有第二段执行
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('引擎未就绪');
    });

    it('修改后: 仍然产生 1 条消息（行为一致）', () => {
      const messages = handleContinueFailure_AFTER(result, 'session-4');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('引擎未就绪');
    });
  });

  describe('场景5: 无 error 字段', () => {
    const result: FailureResult = {
      success: false,
      error: undefined,
      code: undefined,
    };

    it('修改前: 不产生消息', () => {
      const messages = handleContinueFailure_BEFORE(result, 'session-5');
      expect(messages).toHaveLength(0);
    });

    it('修改后: 不产生消息（行为一致）', () => {
      const messages = handleContinueFailure_AFTER(result, 'session-5');
      expect(messages).toHaveLength(0);
    });
  });

  describe('BUG-2 附带验证: 消息 ID 唯一性', () => {
    const result: FailureResult = {
      success: false,
      error: 'authentication error',
      code: undefined,
    };

    it('修改前: 两条消息的 ID 可能相同（BUG）', () => {
      const messages = handleContinueFailure_BEFORE(result, 'session-6');
      expect(messages).toHaveLength(2);
      // 两条消息在同一毫秒生成，ID 格式为 error-{timestamp}，很可能相同
      // 这里验证它们使用的是相同的 ID 格式（无随机后缀）
      expect(messages[0].id).toMatch(/^error-\d+$/);
      expect(messages[1].id).toMatch(/^error-\d+$/);
    });

    it('修改后: 消息 ID 包含随机后缀，保证唯一性', () => {
      const messages = handleContinueFailure_AFTER(result, 'session-6');
      expect(messages).toHaveLength(1);
      // 新格式: error-{timestamp}-{random}
      expect(messages[0].id).toMatch(/^error-\d+-[a-z0-9]+$/);
    });
  });
});
