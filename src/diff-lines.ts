import type { Diff, DiffFile } from './api';

export type Side = 'base' | 'head';
export interface DiffLine {
  text: string;
  hunk: number;
  base?: number;
  head?: number;
}

export function parseLines(patch: string): DiffLine[] {
  let base = 0, head = 0, hunk = 0;
  return patch.replace(/\n$/, '').split('\n').map(text => {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) {
      base = Number(header[1]);
      head = Number(header[2]);
      hunk++;
    }
    const line: DiffLine = { text, hunk };
    if (text.startsWith(' ') || text.startsWith('-')) line.base = base++;
    if (text.startsWith(' ') || text.startsWith('+')) line.head = head++;
    return line;
  });
}

export function anchorFor(diff: Diff, file: DiffFile, side: Side, first: DiffLine, last: DiffLine) {
  const a = first[side], b = last[side];
  if (!diff.diffBaseSha || first.hunk !== last.hunk || a === undefined || b === undefined) return null;
  return {
    commitSha: side === 'base' ? diff.diffBaseSha : diff.headSha,
    path: side === 'base' ? file.previousPath ?? file.path : file.path,
    side, startLine: Math.min(a, b), endLine: Math.max(a, b),
  };
}
