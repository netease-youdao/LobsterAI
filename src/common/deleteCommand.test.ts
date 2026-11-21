import { describe, expect, test } from 'vitest';

import { isDeleteCommand } from './deleteCommand';

describe('Word report scripts and file deletion approval', () => {
  const generated = [
    'cd "/tmp/Word report" && .venv/bin/python - <<\'PY\'',
    "head = '''",
    'totals = {p: RM[(region, p)][0] for p in products}',
    "'''",
    "open('_body.py', 'w').write(head)",
    'PY',
    'cat _prefix.py _body.py > report.py && .venv/bin/python report.py',
  ].join('\n');

  test('treats Python dictionary assignments and generated dictionary lookups as data', () => {
    expect(isDeleteCommand('python3 -c "RM = {\'v\': 1}; print(str(RM), RM[\'v\'])"')).toBe(false);
    expect(isDeleteCommand(generated)).toBe(false);
  });

  test.each([
    'rm report.tmp', 'Remove-Item report.tmp', 'find . -name report.tmp -delete', 'git clean -fd',
    'python3 -c "from pathlib import Path; Path(\'report.tmp\').unlink()"',
    'python3 -c "RM = {}; import os; os.system(\'rm report.tmp\')"',
    generated + '\nrm report.tmp',
    generated.replace("open('_body.py', 'w').write(head)", "import os; os.unlink('report.tmp')"),
  ])('keeps file deletion subject to approval (%#)', command => {
    expect(isDeleteCommand(command)).toBe(true);
  });
});
