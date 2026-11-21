import assert from 'node:assert/strict';
import { parseLines, anchorFor } from '../src/diff-lines.ts';

const rows = parseLines('@@ -6,2 +9,2 @@\n context\n-old\n+new\n\\ No newline at end of file\n@@ -15 +18 @@\n-again\n+replacement');
const file = { path: 'new.ts', previousPath: 'old.ts' };
const diff = { diffBaseSha: 'merge-base', baseSha: 'target-tip', headSha: 'head' };
assert.deepEqual(anchorFor(diff, file, 'base', rows[2], rows[1]), {
  commitSha: 'merge-base', path: 'old.ts', side: 'base', startLine: 6, endLine: 7,
});
assert.deepEqual(anchorFor(diff, file, 'head', rows[1], rows[3]), {
  commitSha: 'head', path: 'new.ts', side: 'head', startLine: 9, endLine: 10,
});
for (const index of [0, 2, 4, 7]) assert.equal(anchorFor(diff, file, 'head', rows[1], rows[index]), null);
assert.equal(anchorFor({ ...diff, diffBaseSha: null }, file, 'head', rows[1], rows[3]), null);
console.log('Diff selection fixtures passed');
