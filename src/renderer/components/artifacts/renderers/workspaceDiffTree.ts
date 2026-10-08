import type { WorkspaceDiffFile, WorkspaceDiffHunk } from './workspaceDiff';

export interface DiffTreeNode { id: string; name: string; path: string; file?: WorkspaceDiffFile; children: DiffTreeNode[] }

export function buildDiffFileTree(files: WorkspaceDiffFile[], query = ''): DiffTreeNode[] {
  const roots: DiffTreeNode[] = [];
  const filter = query.trim().toLocaleLowerCase();
  for (const file of files) {
    if (filter && !file.path.toLocaleLowerCase().includes(filter)) continue;
    const parts = file.path.split('/').filter(Boolean);
    let children = roots;
    for (let index = 0; index < parts.length; index += 1) {
      const path = parts.slice(0, index + 1).join('/');
      if (index === parts.length - 1) children.push({ id: file.id, name: parts[index], path, file, children: [] });
      else {
        let folder = children.find(node => !node.file && node.path === path);
        if (!folder) { folder = { id: `directory:${path}`, name: parts[index], path, children: [] }; children.push(folder); }
        children = folder.children;
      }
    }
  }
  const sort = (nodes: DiffTreeNode[]) => { nodes.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name, undefined, { numeric: true })); nodes.forEach(node => sort(node.children)); };
  sort(roots);
  return roots;
}

/** Only known omitted context between complete hunks is labelled unmodified. */
export function unmodifiedLinesBefore(hunks: WorkspaceDiffHunk[], index: number): number {
  const current = hunks[index]; const previous = hunks[index - 1];
  if (!current || !previous || previous.incomplete) return 0;
  const oldGap = current.oldStart - previous.oldStart - previous.oldLines;
  const newGap = current.newStart - previous.newStart - previous.newLines;
  return oldGap === newGap ? Math.max(0, oldGap) : 0;
}
