import { useMemo, useState } from 'react';
import type { CodeAnchor, Diff, DiffFile, Threads } from './api';
import { anchorFor, parseLines, type Side } from './diff-lines';

const rowHeight = 26;
const visibleRows = 14;
type Selection = { side: Side; first: number; last: number };

export function DiffView({ diff, file, threads, onDraft, onReview }: {
  onReview:(anchor:CodeAnchor)=>void; onDraft:(anchor:CodeAnchor)=>void; diff: Diff; file: DiffFile; threads: Threads['threads'];
}) {
  const rows = useMemo(() => parseLines(file.patch ?? ''), [file.patch]);
  const [scroll, setScroll] = useState(0);
  const [selection, select] = useState<Selection | null>(null);
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 4);
  const anchor = selection && anchorFor(diff, file, selection.side, rows[selection.first], rows[selection.last]);
  const locations = useMemo(() => {
    const map = new Map<string, typeof threads>();
    for (const thread of threads) {
      if (thread.path !== file.path || thread.isOutdated || !thread.line || !thread.diffSide) continue;
      const key = thread.diffSide + thread.line;
      const items = map.get(key) ?? [];
      items.push(thread);
      map.set(key, items);
    }
    return map;
  }, [threads, file.path]);
  if (!file.patch) return <p>{file.patchError ?? 'Patch unavailable offline.'}</p>;
  return <>
    <p>{diff.diffBaseSha ? 'Use + next to a line number to draft a comment. To comment on a range, select a line number and Shift-select another in the same hunk.' :
      'Line selection unavailable because the cached patch has no verified merge base.'}</p>
    <div className="patch" aria-label={`Diff for ${file.path}`} tabIndex={0}
      style={{ maxHeight: visibleRows * rowHeight }} onScroll={event => setScroll(event.currentTarget.scrollTop)}>
      <div style={{ height: rows.length * rowHeight }}>
        <div style={{ paddingTop: start * rowHeight }}>
          {rows.slice(start, start + visibleRows + 9).map((row, offset) => {
            const index = start + offset;
            return <div key={index} className="patch-row" style={{ height: rowHeight }}>
              {(['base', 'head'] as const).map(side => {
                const number = row[side];
                const active = anchor && anchor.side === side && number !== undefined &&
                  number >= anchor.startLine && number <= anchor.endLine;
                const lineAnchor = anchorFor(diff, file, side, row, row);
                return number === undefined ? <span key={side} /> : <span key={side} className="line-gutter">
                  <button aria-label={`${side} line ${number}`} aria-pressed={!!active}
                    disabled={!diff.diffBaseSha} onClick={event => {
                      const extend = event.shiftKey && selection?.side === side &&
                        rows[selection.first].hunk === row.hunk;
                      select({ side, first: extend ? selection.first : index, last: index });
                    }}>{number}</button>
                  {lineAnchor && <button aria-label={`Comment on ${side} line ${number}`}
                    title={`Comment on ${side} line ${number}`} onClick={() => onDraft(lineAnchor)}>+</button>}
                </span>;
              })}
              <code>{row.text}</code>
              {(['LEFT', 'RIGHT'] as const).flatMap(side =>
                (locations.get(side + row[side === 'LEFT' ? 'base' : 'head']) ?? []).map(thread =>
                  <button key={thread.id} onClick={() => {
                    const target = document.getElementById('thread-' + thread.id) as HTMLDetailsElement | null;
                    if (target) {
                      target.open = true;
                      target.querySelector('summary')?.focus();
                      target.scrollIntoView({ block: 'center' });
                    }
                  }}>{thread.isResolved ? 'Resolved thread' : 'Open thread'}</button>))}
            </div>;
          })}
        </div>
      </div>
    </div>
    {anchor && <p aria-live="polite" className="revision">{anchor.path} · {anchor.side} · lines {anchor.startLine}–{anchor.endLine}
      <br />{anchor.commitSha} <button onClick={() => select(null)}>Clear selection</button> <button onClick={() => onDraft(anchor)}>Draft inline comment</button> <button onClick={() => onReview(anchor)}>Review selection with Codex</button></p>}
  </>;
}
