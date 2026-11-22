import { describe, expect, test } from 'vitest';

import { ShareDeploymentCandidateSource } from '../../shared/shareDeployment/constants';
import type { CoworkMessage, CoworkMessageMetadata } from '../types/cowork';
import { parseLocalServiceArtifactsFromMessages } from './localServiceContextParser';

let timestamp = 0;

function makeMessage(
  id: string,
  type: CoworkMessage['type'],
  content = '',
  metadata?: CoworkMessageMetadata,
): CoworkMessage {
  timestamp += 1;
  return { id, type, content, timestamp, metadata };
}

describe('parseLocalServiceArtifactsFromMessages', () => {
  test('links a chained Bash cd command to Browser navigation and the assistant response', () => {
    const messages = [
      makeMessage('user-1', 'user', '启动服务'),
      makeMessage('bash-1', 'tool_use', '', {
        toolName: 'Bash',
        toolUseId: 'tool-1',
        toolInput: {
          command: 'lsof -ti:8765 | xargs kill -9 2>/dev/null; sleep 1; cd /Users/admin/lobsterai/project/dayan-shenjun && npm run dev',
        },
      }),
      makeMessage('bash-result-1', 'tool_result', 'ready', { toolUseId: 'tool-1' }),
      makeMessage('browser-1', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:8765' },
      }),
      makeMessage('assistant-1', 'assistant', '服务已启动：http://localhost:8765'),
    ];

    const artifacts = parseLocalServiceArtifactsFromMessages(messages, 'session-1', {
      workingDirectory: '/Users/admin/lobsterai/project',
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].messageId).toBe('assistant-1');
    expect(artifacts[0].localService?.projectDirectory).toBe(
      '/Users/admin/lobsterai/project/dayan-shenjun',
    );
    expect(artifacts[0].localService?.projectCandidates?.[0]).toEqual(expect.objectContaining({
      source: ShareDeploymentCandidateSource.ToolCdCommand,
      messageId: 'bash-1',
    }));
  });

  test('creates a local service artifact from Browser navigation without assistant URL text', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '打开服务'),
      makeMessage('browser-1', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:4173/app' },
      }),
    ], 'session-1');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toEqual(expect.objectContaining({
      messageId: 'browser-1',
      url: 'http://localhost:4173/app',
    }));
  });

  test('combines project and URL evidence from separate assistant messages in one turn', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '启动服务'),
      makeMessage('assistant-path', 'assistant', '项目目录：/Users/admin/project/assistant-app'),
      makeMessage('assistant-url', 'assistant', '访问：http://localhost:5174'),
    ], 'session-1');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].localService?.projectDirectory).toBe(
      '/Users/admin/project/assistant-app',
    );
  });

  test('does not leak project directories across user turns', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '处理旧项目'),
      makeMessage('bash-old', 'tool_use', '', {
        toolName: 'bash',
        toolInput: { command: 'cd /Users/admin/old-project && npm run dev' },
      }),
      makeMessage('user-2', 'user', '打开另一个服务'),
      makeMessage('browser-new', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:3000' },
      }),
    ], 'session-1');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].localService?.projectDirectory).toBeUndefined();
  });

  test('ignores thinking content as service and directory evidence', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '启动服务'),
      makeMessage(
        'thinking-1',
        'assistant',
        '也许在 /Users/admin/fake-project，先看 http://localhost:9999',
        { isThinking: true },
      ),
      makeMessage('assistant-1', 'assistant', '服务地址：http://localhost:8765'),
    ], 'session-1');

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].url).toBe('http://localhost:8765');
    expect(artifacts[0].localService?.projectDirectory).toBeUndefined();
  });

  test('resolves relative cd commands against the shell working directory', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '启动服务'),
      makeMessage('exec-1', 'tool_use', '', {
        toolName: 'exec_command',
        toolInput: {
          cwd: '/Users/admin/project',
          cmd: 'cd ./child-app && npm run dev',
        },
      }),
      makeMessage('browser-1', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:5173' },
      }),
    ], 'session-1');

    expect(artifacts[0].localService?.projectDirectory).toBe('/Users/admin/project/child-app');
  });

  test('uses explicit pwd output but ignores arbitrary tool result paths', () => {
    const pwdArtifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-pwd', 'user', '定位并打开'),
      makeMessage('bash-pwd', 'tool_use', '', {
        toolName: 'bash',
        toolUseId: 'pwd-tool',
        toolInput: { command: 'pwd' },
      }),
      makeMessage('result-pwd', 'tool_result', '/Users/admin/project/right-app\n', {
        toolUseId: 'pwd-tool',
      }),
      makeMessage('browser-pwd', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:8080' },
      }),
    ], 'session-1');
    const findArtifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-find', 'user', '搜索并打开'),
      makeMessage('bash-find', 'tool_use', '', {
        toolName: 'bash',
        toolUseId: 'find-tool',
        toolInput: { command: 'find /Users/admin/project -maxdepth 1' },
      }),
      makeMessage('result-find', 'tool_result', '/Users/admin/project/wrong-app\n', {
        toolUseId: 'find-tool',
      }),
      makeMessage('browser-find', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:8081' },
      }),
    ], 'session-1');

    expect(pwdArtifacts[0].localService?.projectDirectory).toBe('/Users/admin/project/right-app');
    expect(pwdArtifacts[0].localService?.projectCandidates?.[0].source).toBe(
      ShareDeploymentCandidateSource.ToolPwdResult,
    );
    expect(findArtifacts[0].localService?.projectDirectory).toBeUndefined();
  });

  test('does not pair pwd output with an unmatched tool id or across a system message', () => {
    const unmatchedArtifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-unmatched', 'user', '打开服务'),
      makeMessage('bash-unmatched', 'tool_use', '', {
        toolName: 'bash',
        toolUseId: 'expected-tool',
        toolInput: { command: 'pwd' },
      }),
      makeMessage('result-unmatched', 'tool_result', '/Users/admin/project/wrong\n', {
        toolUseId: 'another-tool',
      }),
      makeMessage('browser-unmatched', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:7000' },
      }),
    ], 'session-1');
    const interleavedArtifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-interleaved', 'user', '打开服务'),
      makeMessage('bash-interleaved', 'tool_use', '', {
        toolName: 'bash',
        toolInput: { command: 'pwd' },
      }),
      makeMessage('system-interleaved', 'system', 'status'),
      makeMessage('result-interleaved', 'tool_result', '/Users/admin/project/wrong\n'),
      makeMessage('browser-interleaved', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:7001' },
      }),
    ], 'session-1');

    expect(unmatchedArtifacts[0].localService?.projectDirectory).toBeUndefined();
    expect(interleavedArtifacts[0].localService?.projectDirectory).toBeUndefined();
  });

  test('does not treat a compound command with unrelated path output as pwd evidence', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '打开服务'),
      makeMessage('bash-1', 'tool_use', '', {
        toolName: 'bash',
        toolUseId: 'compound-tool',
        toolInput: { command: 'find /Users/admin/project -maxdepth 1; pwd' },
      }),
      makeMessage(
        'result-1',
        'tool_result',
        '/Users/admin/project/wrong-app\n/Users/admin/project/right-app\n',
        { toolUseId: 'compound-tool' },
      ),
      makeMessage('browser-1', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:7002' },
      }),
    ], 'session-1');

    expect(artifacts[0].localService?.projectDirectory).toBeUndefined();
  });

  test('keeps a service start directory ahead of a later diagnostic shell cwd', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '启动服务'),
      makeMessage('bash-start', 'tool_use', '', {
        toolName: 'bash',
        toolInput: { command: 'cd /Users/admin/project/app && npm run dev' },
      }),
      makeMessage('bash-check', 'tool_use', '', {
        toolName: 'bash',
        toolInput: {
          cwd: '/Users/admin/project',
          command: 'curl http://localhost:8765/health',
        },
      }),
      makeMessage('browser-1', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:8765' },
      }),
    ], 'session-1');

    expect(artifacts[0].localService?.projectDirectory).toBe('/Users/admin/project/app');
  });

  test('keeps two services in one turn associated with their matching command ports', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '启动两个服务'),
      makeMessage('bash-3000', 'tool_use', '', {
        toolName: 'bash',
        toolInput: { command: 'cd /Users/admin/project/app-a && npm run dev -- --port 3000' },
      }),
      makeMessage('browser-3000', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:3000' },
      }),
      makeMessage('bash-4000', 'tool_use', '', {
        toolName: 'bash',
        toolInput: { command: 'cd /Users/admin/project/app-b && npm run dev -- --port 4000' },
      }),
      makeMessage('browser-4000', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:4000' },
      }),
      makeMessage(
        'assistant-1',
        'assistant',
        'A：http://localhost:3000\nB：http://localhost:4000',
      ),
    ], 'session-1');

    const byPort = new Map(artifacts.map(artifact => [new URL(artifact.url || '').port, artifact]));
    expect(byPort.get('3000')?.localService?.projectDirectory).toBe('/Users/admin/project/app-a');
    expect(byPort.get('4000')?.localService?.projectDirectory).toBe('/Users/admin/project/app-b');
  });

  test('matches custom launchers by explicit directory and port bindings', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '启动两个自定义服务'),
      makeMessage('bash-3000', 'tool_use', '', {
        toolName: 'bash',
        toolInput: {
          command: 'cd /Users/admin/project/app-a && ./run-web --port 3000',
        },
      }),
      makeMessage('bash-4000', 'tool_use', '', {
        toolName: 'bash',
        toolInput: {
          cwd: '/Users/admin/project/app-b',
          command: './run-web -p 4000',
        },
      }),
      makeMessage('bash-diagnostics', 'tool_use', '', {
        toolName: 'bash',
        toolInput: {
          cwd: '/Users/admin/project',
          command: 'lsof -i:3000; curl http://localhost:4000/health',
        },
      }),
      makeMessage(
        'assistant-1',
        'assistant',
        'A：http://localhost:3000\nB：http://localhost:4000',
      ),
    ], 'session-1');

    const byPort = new Map(artifacts.map(artifact => [new URL(artifact.url || '').port, artifact]));
    expect(byPort.get('3000')?.localService?.projectDirectory).toBe('/Users/admin/project/app-a');
    expect(byPort.get('4000')?.localService?.projectDirectory).toBe('/Users/admin/project/app-b');
  });

  test('supports Windows cd /d with quoted paths', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '启动服务'),
      makeMessage('shell-1', 'tool_use', '', {
        toolName: 'shell',
        toolInput: { command: 'cd /d "D:\\work\\my app" && npm run dev' },
      }),
      makeMessage('browser-1', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:9000' },
      }),
    ], 'session-1');

    expect(artifacts[0].localService?.projectDirectory).toBe('D:\\work\\my app');
  });

  test('extracts projectDir, port, and isServiceStart from pwsh tool calls with workdir', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '启动前端服务'),
      makeMessage('pwsh-start', 'tool_use', '', {
        toolName: 'pwsh',
        toolUseId: 'pwsh-1',
        toolInput: {
          description: 'Start Vite dev server',
          workdir: 'C:\\Users\\dev\\projects\\demo-app',
          command: 'npm run dev -- --port 5173',
          run_in_background: true,
        },
      }),
      makeMessage('pwsh-diag', 'tool_use', '', {
        toolName: 'pwsh',
        toolUseId: 'pwsh-2',
        toolInput: {
          description: 'Check server health',
          workdir: 'C:\\Users\\dev\\projects',
          command: 'Invoke-WebRequest http://localhost:5173',
        },
      }),
      makeMessage('assistant-1', 'assistant', '本地预览：http://localhost:5173'),
    ], 'session-1', {
      workingDirectory: 'C:\\Users\\dev\\projects',
    });

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].localService?.projectDirectory).toBe('C:\\Users\\dev\\projects\\demo-app');
    expect(artifacts[0].localService?.projectCandidates?.[0]).toEqual(expect.objectContaining({
      source: ShareDeploymentCandidateSource.ToolWorkingDirectory,
      messageId: 'pwsh-start',
    }));
  });

  test('supports pwsh Set-Location, sl, Push-Location, and cd patterns', () => {
    const setLocationArtifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '启动 Set-Location 服务'),
      makeMessage('pwsh-set-loc', 'tool_use', '', {
        toolName: 'pwsh',
        toolInput: {
          description: 'Start app via Set-Location',
          command: 'Set-Location -Path "D:\\work\\my app"; npm run dev -- --port 3001',
        },
      }),
      makeMessage('assistant-1', 'assistant', '运行于 http://localhost:3001'),
    ], 'session-1');

    const slArtifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-2', 'user', '启动 sl 服务'),
      makeMessage('pwsh-sl', 'tool_use', '', {
        toolName: 'pwsh',
        toolInput: {
          description: 'Start static server via sl',
          workdir: 'D:\\work',
          command: 'sl .\\static-site; python -m http.server 8000',
        },
      }),
      makeMessage('assistant-2', 'assistant', '运行于 http://localhost:8000'),
    ], 'session-1');

    const pushLocationArtifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-3', 'user', '启动 Push-Location 服务'),
      makeMessage('pwsh-push', 'tool_use', '', {
        toolName: 'pwsh',
        toolInput: {
          description: 'Start app via Push-Location',
          command: "Push-Location -LiteralPath 'D:\\work\\pushed app'; npm run start",
        },
      }),
      makeMessage('assistant-3', 'assistant', '运行于 http://localhost:4100'),
    ], 'session-1');

    const cdArtifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-4', 'user', '启动 cd 服务'),
      makeMessage('pwsh-cd', 'tool_use', '', {
        toolName: 'pwsh',
        toolInput: {
          description: 'Start app via cd',
          command: 'cd "D:\\work\\cd app" && npm run dev',
        },
      }),
      makeMessage('assistant-4', 'assistant', '运行于 http://localhost:4200'),
    ], 'session-1');

    expect(setLocationArtifacts[0].localService?.projectDirectory).toBe('D:\\work\\my app');
    expect(setLocationArtifacts[0].localService?.projectCandidates?.[0].source).toBe(
      ShareDeploymentCandidateSource.ToolCdCommand,
    );
    expect(slArtifacts[0].localService?.projectDirectory).toBe('D:/work/static-site');
    expect(pushLocationArtifacts[0].localService?.projectDirectory).toBe('D:\\work\\pushed app');
    expect(cdArtifacts[0].localService?.projectDirectory).toBe('D:\\work\\cd app');
  });

  test('disambiguates multiple pwsh services by --port, $env:PORT, and python -m http.server port', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '启动多个服务'),
      makeMessage('pwsh-vite', 'tool_use', '', {
        toolName: 'pwsh',
        toolInput: {
          description: 'Start Vite frontend',
          workdir: 'C:\\work\\frontend',
          command: 'npm run dev -- --port 3000',
        },
      }),
      makeMessage('pwsh-python', 'tool_use', '', {
        toolName: 'pwsh',
        toolInput: {
          description: 'Start Python static server',
          command: 'Set-Location "C:\\work\\docs site"; python -m http.server 8000',
        },
      }),
      makeMessage('pwsh-env-port', 'tool_use', '', {
        toolName: 'pwsh',
        toolInput: {
          description: 'Start Node API',
          workdir: 'C:\\work\\api-server',
          command: '$env:PORT=4000; npm run start',
        },
      }),
      makeMessage('pwsh-check', 'tool_use', '', {
        toolName: 'pwsh',
        toolInput: {
          description: 'Check ports',
          workdir: 'C:\\work',
          command: 'Get-NetTCPConnection -LocalPort 3000',
        },
      }),
      makeMessage(
        'assistant-1',
        'assistant',
        '前端：http://localhost:3000\n文档：http://localhost:8000\nAPI：http://localhost:4000',
      ),
    ], 'session-1');

    const byPort = new Map(artifacts.map(artifact => [new URL(artifact.url || '').port, artifact]));
    expect(byPort.get('3000')?.localService?.projectDirectory).toBe('C:\\work\\frontend');
    expect(byPort.get('8000')?.localService?.projectDirectory).toBe('C:\\work\\docs site');
    expect(byPort.get('4000')?.localService?.projectDirectory).toBe('C:\\work\\api-server');
  });

  test('pairs pwsh Get-Location table output as explicit working directory evidence', () => {
    const artifacts = parseLocalServiceArtifactsFromMessages([
      makeMessage('user-1', 'user', '查看目录并预览'),
      makeMessage('pwsh-gl', 'tool_use', '', {
        toolName: 'pwsh',
        toolUseId: 'gl-1',
        toolInput: {
          description: 'Print current directory',
          command: 'Set-Location "C:\\work\\my-site"; Get-Location',
        },
      }),
      makeMessage(
        'pwsh-gl-result',
        'tool_result',
        '\nPath\n----\nC:\\work\\my-site\n\n',
        { toolUseId: 'gl-1' },
      ),
      makeMessage('browser-1', 'tool_use', '', {
        toolName: 'browser',
        toolInput: { action: 'navigate', url: 'http://localhost:8080' },
      }),
    ], 'session-1');

    expect(artifacts[0].localService?.projectDirectory).toBe('C:\\work\\my-site');
    expect(artifacts[0].localService?.projectCandidates?.[0].source).toBe(
      ShareDeploymentCandidateSource.ToolPwdResult,
    );
  });
});
