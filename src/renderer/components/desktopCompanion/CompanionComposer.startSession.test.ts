import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import ts from 'typescript';
import { expect, test, vi } from 'vitest';

const sourcePath = fileURLToPath(new URL('./CompanionComposer.tsx', import.meta.url));
const source = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let statements: readonly ts.Statement[] | undefined;
function find(node: ts.Node): void {
  if (ts.isBlock(node)) {
    const index = node.statements.findIndex(statement => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(declaration => declaration.initializer
        && ts.isAwaitExpression(declaration.initializer)
        && ts.isCallExpression(declaration.initializer.expression)
        && declaration.initializer.expression.expression.getText(source) === 'coworkService.startSession'));
    if (index >= 0) statements = node.statements.slice(index + 1, index + 3);
  }
  ts.forEachChild(node, find);
}
find(source);
if (!statements || statements.length !== 2) throw new Error('Companion start response handler missing');
// Execute the real response guard and its following finish(true) statement.
const compiled = ts.transpileModule(`globalThis.handle = () => { ${statements.map(statement => statement.getText(source)).join('\n')} };`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

test.each([false, true])('companion respects success=%s even when a persisted session is returned', success => {
  const context = {
    handle: undefined as unknown as () => boolean | void,
    success, session: { id: 'retained' }, error: success ? undefined : 'Admission failed', code: undefined, rejectedStatus: undefined,
    failureStage: 'session-start', companionTaskFailure: () => 'failed', t: (key: string) => key,
    finish: vi.fn(), showToast: vi.fn(),
  };
  vm.runInNewContext(compiled, context);
  expect(context.handle()).toBe(success ? undefined : false);
  expect(context.finish).toHaveBeenCalledExactlyOnceWith(...(success ? [true] : [false, 'failed']));
  expect(context.showToast).toHaveBeenCalledTimes(success ? 0 : 1);
});
