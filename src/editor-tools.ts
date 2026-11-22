import type { Editor, EditorPosition, EditorRangeOrCaret } from 'obsidian';

export interface TextEdit {
  from: number; to: number; text: string; cursor?: number;
  selectionMap?: { oldFrom: number; oldTo: number; newFrom: number; newTo: number };
}
export type Scope = 'selection' | 'lines' | 'selection-or-document';

/** 返回完整行内代码范围；选区切入代码正文时，必须拒绝丢失上下文的局部转换。 */
export function inlineCodeRanges(line: string): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '\\') { index++; continue; }
    if (line[index] !== '`') continue;
    const from = index;
    while (line[index] === '`') index++;
    const marker = line.slice(from, index);
    let end = line.indexOf(marker, index);
    while (end >= 0 && (line[end - 1] === '`' || line[end + marker.length] === '`')) end = line.indexOf(marker, end + marker.length);
    if (end >= 0) { ranges.push({ from, to: end + marker.length }); index = end + marker.length - 1; }
    else index--;
  }
  return ranges;
}

export function protectedLines(text: string): Set<number> {
  const result = new Set<number>();
  const lines = text.split('\n');
  let yaml = lines[0]?.trim() === '---';
  let fence: { char: string; size: number } | undefined;
  lines.forEach((line, index) => {
    if (yaml) {
      result.add(index);
      if (index > 0 && /^(---|\.\.\.)\s*$/.test(line)) yaml = false;
      return;
    }
    const fenceLine = line.replace(/^ {0,3}(?:>\s*)+(?=\S)/, '').replace(/^ {0,3}(?:[-+*]|\d+[.)])\s+/, '');
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(fenceLine)?.[1];
    if (fence) {
      result.add(index);
      if (marker?.[0] === fence.char && marker.length >= fence.size && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(fenceLine)) fence = undefined;
    } else if (marker) {
      fence = { char: marker[0]!, size: marker.length };
      result.add(index);
    } else if (/^( {4}|\t)/.test(line)) result.add(index);
  });
  return result;
}

function compare(a: EditorPosition, b: EditorPosition): number { return a.line - b.line || a.ch - b.ch; }

export function selectedRanges(editor: Editor, scope: Scope): Array<{ from: number; to: number }> {
  const ranges = editor.listSelections().map(({ anchor, head }) => {
    const [start, end] = compare(anchor, head) <= 0 ? [anchor, head] : [head, anchor];
    if (scope === 'lines') {
      // 选区在下一行行首结束时，不应把未选中的下一行也改掉。
      const endLine = end.ch === 0 && end.line > start.line ? end.line - 1 : end.line;
      return { from: editor.posToOffset({ line: start.line, ch: 0 }), to: editor.posToOffset({ line: endLine, ch: editor.getLine(endLine).length }) };
    }
    return { from: editor.posToOffset(start), to: editor.posToOffset(end) };
  });
  if (scope === 'selection-or-document' && ranges.every(range => range.from === range.to)) return [{ from: 0, to: editor.getValue().length }];
  const result: Array<{ from: number; to: number }> = [];
  for (const range of ranges.sort((a, b) => a.from - b.from)) {
    const previous = result[result.length - 1];
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else result.push({ ...range });
  }
  return result;
}

export function offsetToPos(text: string, offset: number): EditorPosition {
  const head = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const last = head.lastIndexOf('\n');
  return { line: head.split('\n').length - 1, ch: head.length - last - 1 };
}

export function applyEdits(editor: Editor, edits: TextEdit[]): void {
  const original = editor.getValue();
  const ordered = edits.filter(edit => edit.cursor !== undefined || original.slice(edit.from, edit.to) !== edit.text).sort((a, b) => a.from - b.from);
  if (!ordered.length) return;
  for (let i = 0; i < ordered.length; i++) {
    const edit = ordered[i]!;
    if (edit.from < 0 || edit.to < edit.from || edit.to > original.length || (i > 0 && edit.from < ordered[i - 1]!.to)) throw new Error('编辑范围重叠或越界，已取消操作。');
  }
  const oldSelections = editor.listSelections();
  let next = original;
  for (const edit of [...ordered].reverse()) next = next.slice(0, edit.from) + edit.text + next.slice(edit.to);
  const mappedOffset = (offset: number): number => {
    let delta = 0;
    for (const edit of ordered) {
      if (offset < edit.from) break;
      if (offset <= edit.to) {
        if (edit.cursor !== undefined) return edit.from + delta + edit.cursor;
        const old = original.slice(edit.from, edit.to);
        const relative = offset - edit.from;
        const map = edit.selectionMap;
        if (map && relative >= map.oldFrom && relative <= map.oldTo) {
          const mapped = map.oldTo === map.oldFrom ? map.newFrom : map.newFrom + (relative - map.oldFrom) * (map.newTo - map.newFrom) / (map.oldTo - map.oldFrom);
          return edit.from + delta + Math.round(mapped);
        }
        if (offset === edit.to) return edit.from + delta + edit.text.length;
        // 光标相对于未变化的尾部定位，标题前缀增减时仍指向同一个文字。
        let suffix = 0;
        while (suffix < Math.min(old.length, edit.text.length) && old[old.length - suffix - 1] === edit.text[edit.text.length - suffix - 1]) suffix++;
        return edit.from + delta + (relative >= old.length - suffix ? edit.text.length - (old.length - relative) : Math.min(relative, edit.text.length));
      }
      delta += edit.text.length - (edit.to - edit.from);
    }
    return offset + delta;
  };
  const selections: EditorRangeOrCaret[] = oldSelections.map(selection => ({
    from: offsetToPos(next, mappedOffset(editor.posToOffset(selection.anchor))),
    to: offsetToPos(next, mappedOffset(editor.posToOffset(selection.head))),
  }));
  editor.transaction({ changes: ordered.map(edit => ({ from: editor.offsetToPos(edit.from), to: editor.offsetToPos(edit.to), text: edit.text })), selections });
}

export function transformEditor(editor: Editor, scope: Scope, transform: (text: string) => string): void {
  const text = editor.getValue();
  applyEdits(editor, selectedRanges(editor, scope).map(range => ({ ...range, text: transform(text.slice(range.from, range.to)) })));
}

export function transformLines(editor: Editor, transform: (line: string) => string, documentWhenEmpty = false): void {
  const original = editor.getValue();
  const excluded = protectedLines(original);
  const edits: TextEdit[] = [];
  const ranges = documentWhenEmpty && !editor.somethingSelected() ? [{ from: 0, to: original.length }] : selectedRanges(editor, 'lines');
  for (const range of ranges) {
    const start = editor.offsetToPos(range.from).line;
    const end = editor.offsetToPos(range.to).line;
    for (let line = start; line <= end; line++) {
      if (excluded.has(line)) continue;
      const value = editor.getLine(line);
      const from = editor.posToOffset({ line, ch: 0 });
      edits.push({ from, to: from + value.length, text: transform(value) });
    }
  }
  applyEdits(editor, edits);
}

export interface EditorSnapshot { value: string; selections: string }
export function snapshot(editor: Editor): EditorSnapshot { return { value: editor.getValue(), selections: JSON.stringify(editor.listSelections()) }; }
export function unchanged(editor: Editor, saved: EditorSnapshot): boolean { return editor.getValue() === saved.value && JSON.stringify(editor.listSelections()) === saved.selections; }
