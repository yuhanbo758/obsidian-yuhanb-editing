import type { Editor } from 'obsidian';
import { protectedLines } from './editor-tools';

const HEADING = /^( {0,3}(?:>[ \t]? {0,3})*)(#{1,6})(?:[ \t]+|$)/;

export function clearHeading(line: string): string {
  return line.replace(HEADING, '$1');
}

export function foldHeadingLevel(editor: Editor): void {
  const excluded = protectedLines(editor.getValue());
  const cursor = editor.getCursor();
  const level = HEADING.exec(editor.getLine(cursor.line))?.[2]?.length;
  if (!level || excluded.has(cursor.line)) return;
  const selections = editor.listSelections();
  // 与旧命令同样先展开再折叠指定级别，从底向上处理，避免上层折叠挡住后续定位。
  try {
    editor.exec('unfoldAll');
    for (let line = editor.lastLine(); line >= 0; line--) {
      if (!excluded.has(line) && HEADING.exec(editor.getLine(line))?.[2]?.length === level) {
        editor.setCursor({ line, ch: 0 });
        editor.exec('toggleFold');
      }
    }
  } finally { editor.setSelections(selections); }
}

function lineKind(line: string): string | undefined {
  if (HEADING.test(line)) return 'heading';
  if (/^\s*[-+*]\s+\[[^\]]\](?:\s|$)/.test(line)) return 'task';
  if (/^\s*(?:[-+*]|\d+[.)])\s+/.test(line)) return 'list';
  if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) return 'fence';
  if (/^ {0,3}>/.test(line)) return 'quote';
  return undefined;
}

export function jumpToSimilar(editor: Editor, direction: -1 | 1): void {
  const selection = editor.getSelection();
  if (selection) {
    const source = editor.getValue();
    const from = editor.posToOffset(editor.getCursor('from'));
    const to = editor.posToOffset(editor.getCursor('to'));
    const formats = [/\*\*[^*\n]+\*\*/g, /==[^=\n]+==/g, /%%[^%\n]+%%/g, /~~[^~\n]+~~/g, /\[\[[^\]\n]+\]\]/g];
    const format = formats.find(regex => selection.match(regex)?.[0] === selection);
    const range = direction > 0 ? source.slice(to) : source.slice(0, from);
    let match: RegExpExecArray | null = null;
    if (format) {
      for (const candidate of range.matchAll(format)) {
        match = candidate;
        if (direction > 0) break;
      }
    }
    const index = format ? (match?.index ?? -1) : direction > 0 ? range.indexOf(selection) : range.lastIndexOf(selection);
    if (index < 0) return;
    const start = (direction > 0 ? to : 0) + index;
    const end = start + (match ? match[0].length : selection.length);
    const target = { from: editor.offsetToPos(start), to: editor.offsetToPos(end) };
    editor.setSelection(target.from, target.to);
    editor.scrollIntoView(target);
    return;
  }
  const cursor = editor.getCursor();
  const kind = lineKind(editor.getLine(cursor.line));
  if (!kind) return;
  const excluded = protectedLines(editor.getValue());
  for (let line = cursor.line + direction; line >= 0 && line <= editor.lastLine(); line += direction) {
    const text = editor.getLine(line);
    if (lineKind(text) !== kind || (kind !== 'fence' && excluded.has(line))) continue;
    const position = { line, ch: text.length };
    editor.setCursor(position);
    editor.scrollIntoView({ from: position, to: position });
    return;
  }
}

/** 仅解析数字、括号和四则运算。长度限制同时约束递归深度和计算工作量。 */
export function calculateArithmetic(text: string): number | undefined {
  if (text.length > 256) return undefined;
  const tokens = text.match(/\d+(?:\.\d*)?|\.\d+|[^\s]/gu) ?? [];
  let index = 0;
  function atom(): number {
    const token = tokens[index++];
    if (token === '+' || token === '-') return (token === '-' ? -1 : 1) * atom();
    if (token === '(') {
      const value = sum();
      return tokens[index++] === ')' ? value : NaN;
    }
    return token && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token) ? Number(token) : NaN;
  }
  function product(): number {
    let value = atom();
    for (let op = tokens[index]; op && /^[*/xX×÷]$/.test(op); op = tokens[index]) {
      index++;
      const term = atom();
      value = op === '/' || op === '÷' ? value / term : value * term;
    }
    return value;
  }
  function sum(): number {
    let value = product();
    for (let op = tokens[index]; op === '+' || op === '-'; op = tokens[index]) {
      index++;
      const term = product();
      value = op === '+' ? value + term : value - term;
    }
    return value;
  }
  const value = sum();
  return index === tokens.length && Number.isFinite(value) ? value : undefined;
}
