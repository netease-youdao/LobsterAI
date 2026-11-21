const deleteWord = /\b(?:rm|rmdir|unlink|del|erase|remove-item|trash)\b/i;

// Only a literal inline program or a quoted heredoc belonging to Python is
// treated as Python. Any shell commands following the program are still scanned.
const pythonCommand = /^(?:cd\s+(?:"[^"$`\\]*"|'[^']*'|[\w./-]+)\s*&&\s*)?(?:[\w./-]*\/)?python(?:\d+(?:\.\d+)*)?\s+/;
const inlineScript = /^-c\s+(?:"([^"$`\\]*)"|'([^'\\]*)')$/;
const heredoc = /^(?:-\s+)?<<\s*(['"])(\w+)\1[ \t]*\r?\n/;
const pythonTokens = /"[^"\n]*"|'[^'\n]*'|[A-Za-z_]\w*/g;

function maskDictionaryNames(script: string): string {
  // A generated Python file may itself be quoted inside the program. A name
  // immediately subscripted by a tuple is a data lookup in that code as well.
  const body = script.replace(/\b(?:rm|rmdir|unlink|del|erase|trash)(?=\[\()/gi, '_');
  const names = new Set<string>();
  return body.replace(pythonTokens, (token: string, offset: number) => {
    if (!/^\w+$/.test(token) || !deleteWord.test(token) || body[offset - 1] === '.') return token;
    const after = body.slice(offset + token.length).trimStart();
    if (/^=\s*\{/.test(after)) names.add(token);
    return names.has(token) && !after.startsWith('(') ? '_' : token;
  });
}

function scanPythonArguments(command: string): string {
  const prefix = pythonCommand.exec(command)?.[0];
  if (!prefix) return command;
  const args = command.slice(prefix.length);
  const inline = inlineScript.exec(args);
  if (inline) return prefix + maskDictionaryNames(inline[1] ?? inline[2]);
  const header = heredoc.exec(args);
  if (!header) return command;
  const lines = args.slice(header[0].length).split(/\r?\n/);
  const end = lines.indexOf(header[2]);
  if (end < 0) return command;
  return [prefix, maskDictionaryNames(lines.slice(0, end).join('\n')), ...lines.slice(end + 1)].join('\n');
}

export function isDeleteCommand(command: string): boolean {
  return (deleteWord.test(command) && deleteWord.test(scanPythonArguments(command.trim())))
    || /\bfind\b[\s\S]*\s-delete\b/i.test(command)
    || /\bgit\s+clean\b/i.test(command)
    || /\bosascript\b[\s\S]*\bdelete\b/i.test(command);
}
