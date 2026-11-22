import { useMemo, useState, type ReactNode } from 'react';
import { Button, Callout, Select, Text, TextArea } from '@radix-ui/themes';
import { getSingularPatch, type DiffLineAnnotation, type SelectedLineRange } from '@pierre/diffs';
import { FileDiff, Virtualizer } from '@pierre/diffs/react';
import type { CodeAnchor, Diff, DiffFile, Threads } from './api';
import { anchorFor, parseLines } from './diff-lines';

type Thread = Threads['threads'][number];
type Annotation = { thread: Thread } | { draft: CodeAnchor };

export function DiffView({ diff, file, threads, onDraft, onReview, renderThread, canDraft }: {
  onDraft: (anchor: CodeAnchor, body: string) => Promise<void>;
  onReview: (anchor: CodeAnchor) => void;
  renderThread: (thread: Thread) => ReactNode;
  canDraft: boolean;
  diff: Diff;
  file: DiffFile;
  threads: Thread[];
}) {
  const rows = useMemo(() => parseLines(file.patch ?? ''), [file.patch]);
  const parsed = useMemo(() => {
    if (!file.patch) return null;
    const oldPath = file.status === 'added' ? '/dev/null' : 'a/file';
    const newPath = file.status === 'removed' ? '/dev/null' : 'b/file';
    try {
      const patch = getSingularPatch(`diff --git a/file b/file\n--- ${oldPath}\n+++ ${newPath}\n${file.patch}\n`);
      return { ...patch, name: file.path, prevName: file.previousPath ?? undefined };
    } catch {
      return null;
    }
  }, [file]);
  const [mode, setMode] = useState<'split' | 'unified'>('split');
  const [selection, setSelection] = useState<SelectedLineRange | null>(null);
  const [draft, setDraft] = useState<CodeAnchor | null>(null);
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function toAnchor(range: SelectedLineRange | null) {
    if (!range?.side || (range.endSide && range.endSide !== range.side)) return null;
    const side = range.side === 'deletions' ? 'base' : 'head';
    const first = rows.find(row => row[side] === range.start);
    const last = rows.find(row => row[side] === range.end);
    return first && last ? anchorFor(diff, file, side, first, last) : null;
  }
  function compose(anchor: CodeAnchor | null) {
    if (!anchor || saving || (draft && body.trim())) return;
    setError('');
    setBody('');
    setDraft(anchor);
  }
  const annotations: DiffLineAnnotation<Annotation>[] = threads.flatMap(thread => {
    if (thread.path !== file.path || thread.isOutdated || !thread.line || !thread.diffSide) return [];
    const left = thread.diffSide === 'LEFT';
    if (!rows.some(row => row[left ? 'base' : 'head'] === thread.line)) return [];
    return [{ lineNumber: thread.line, side: left ? 'deletions' : 'additions', metadata: { thread } }];
  });
  if (draft) annotations.push({
    lineNumber: draft.endLine,
    side: draft.side === 'base' ? 'deletions' : 'additions',
    metadata: { draft },
  });
  const anchor = toAnchor(selection);
  if (!parsed) return <Callout.Root color="amber"><Callout.Text>
    {file.patchError ?? (file.patch ? 'This patch could not be rendered.' : 'Patch unavailable offline.')}
  </Callout.Text></Callout.Root>;

  return <div className="diff-view">
    <div className="row-between diff-toolbar">
      <div className="toolbar">
        <Text size="2" color="gray">{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</Text>
        {anchor && <Button size="1" variant="soft" disabled={!canDraft || saving || !!(draft && body.trim())}
          onClick={() => compose(anchor)}>Comment on selection</Button>}
        {anchor && <Button size="1" variant="soft" onClick={() => onReview(anchor)}>Review selection</Button>}
      </div>
      <Select.Root size="1" value={mode} onValueChange={value => setMode(value === 'unified' ? 'unified' : 'split')}>
        <Select.Trigger aria-label="Diff layout" />
        <Select.Content><Select.Item value="split">Split</Select.Item><Select.Item value="unified">Unified</Select.Item></Select.Content>
      </Select.Root>
    </div>
    <Virtualizer className="diff-scroll">
      <FileDiff fileDiff={parsed} lineAnnotations={annotations} selectedLines={selection} options={{
        diffStyle: mode, disableFileHeader: true, preferredHighlighter: 'shiki-js',
        enableLineSelection: !!diff.diffBaseSha,
        enableGutterUtility: canDraft && !saving && !(draft && body.trim()),
        onGutterUtilityClick: range => compose(toAnchor(range)),
        onLineSelected: setSelection,
      }} renderAnnotation={({ metadata }) => metadata && ('thread' in metadata ?
        <div className="line-annotation">{renderThread(metadata.thread)}</div> :
        <form className="line-annotation stack" onSubmit={async event => {
          event.preventDefault();
          if (saving || !body.trim()) return;
          setSaving(true);
          setError('');
          try {
            await onDraft(metadata.draft, body);
            setBody('');
            setDraft(null);
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure));
          } finally {
            setSaving(false);
          }
        }}>
          <Text size="2" weight="medium">Comment on {metadata.draft.side} {metadata.draft.startLine === metadata.draft.endLine ?
            `line ${metadata.draft.endLine}` : `lines ${metadata.draft.startLine}–${metadata.draft.endLine}`}</Text>
          <TextArea aria-label="Inline draft text" value={body} onChange={event => setBody(event.target.value)} rows={3} />
          {error && <Text role="alert" color="red">{error}</Text>}
          <div className="toolbar">
            <Button size="1" type="submit" disabled={!canDraft || saving || !body.trim()}>Save local draft</Button>
            <Button size="1" type="button" variant="soft" disabled={saving} onClick={() => { setDraft(null); setBody(''); }}>Cancel</Button>
          </div>
        </form>)} />
    </Virtualizer>
  </div>;
}
