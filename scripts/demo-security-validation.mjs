import { openExternalSafe } from '../src/shared/shell/externalUrl.ts';
import { validateStdioCommand } from '../src/shared/mcp/stdio.ts';

const stdioCases = [
  ['legal npx server', validateStdioCommand('npx', ['-y', 'tavily-mcp@latest'])],
  ['absolute path with spaces', validateStdioCommand('C:\\Program Files\\nodejs\\node.exe', ['server.js'])],
  ['injected inline args', validateStdioCommand('npx -y evil')],
  ['shell metachar', validateStdioCommand('node & calc')],
  ['path traversal', validateStdioCommand('C:\\safe\\..\\evil.exe')],
];

const urlCases = [
  ['https URL', openExternalSafe('https://example.com/path')],
  ['mailto', openExternalSafe('mailto:test@example.com')],
  ['javascript URL', openExternalSafe('javascript:alert(1)')],
  ['scheme-less URL', openExternalSafe('//host/path')],
];

console.log('stdio validation:');
for (const [label, result] of stdioCases) {
  console.log(`  ${label}: ${JSON.stringify(result)}`);
}

console.log('external URL validation:');
for (const [label, result] of urlCases) {
  console.log(`  ${label}: ${JSON.stringify(result)}`);
}
