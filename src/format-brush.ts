import { detectFormat } from './transforms';

export interface BrushFormat { heading?: number; wrappers: Array<{ open: string; close: string }> }

export function expandBrushRange(source: string, from: number, to: number): { from: number; to: number; text: string } {
  for (let depth = 0; depth < 12; depth++) {
    const match = /(\*\*|__|==|~~|%%|\*|_|`+|<u>|<sup>|<sub>|<span style="(?:color|background-color):\s*#[\da-f]{6};?">|\{\{c\d+::|\[\[|【|（|「|《|〈|［|｛|〖|〔|『|“|‘)$/i.exec(source.slice(0, from));
    if (!match) break;
    const open = match[1]!;
    const pairs: Record<string, string> = { '<u>': '</u>', '<sup>': '</sup>', '<sub>': '</sub>', '[[': ']]', '【': '】', '（': '）', '「': '」', '《': '》', '〈': '〉', '［': '］', '｛': '｝', '〖': '〗', '〔': '〕', '『': '』', '“': '”', '‘': '’' };
    const close = open.startsWith('<span ') ? '</span>' : open.startsWith('{{c') ? '}}' : pairs[open] ?? open;
    if (source.slice(to, to + close.length) !== close || !detectFormat(open + source.slice(from, to) + close)) break;
    from -= open.length; to += close.length;
  }
  return { from, to, text: source.slice(from, to) };
}

export function captureBrushFormat(text: string): BrushFormat | null {
  const heading = /^ {0,3}(#{1,6})[ \t]+/.exec(text);
  let body = heading ? text.slice(heading[0].length) : text;
  const wrappers: BrushFormat['wrappers'] = [];
  for (let depth = 0; depth < 12; depth++) {
    const format = detectFormat(body);
    if (!format) break;
    wrappers.push(format);
    body = body.slice(format.open.length, body.length - format.close.length);
  }
  return heading || wrappers.length ? { ...(heading ? { heading: heading[1]!.length } : {}), wrappers } : null;
}

/** 格式刷是赋予样式而非切换样式；重复应用不能把刚刷上的样式去掉。 */
export function applyBrushFormat(text: string, format: BrushFormat): string {
  let body = format.heading ? text.replace(/^ {0,3}#{1,6}[ \t]+/, '') : text;
  for (let depth = 0; depth < 12; depth++) {
    const existing = detectFormat(body);
    if (!existing) break;
    body = body.slice(existing.open.length, body.length - existing.close.length);
  }
  for (const wrapper of [...format.wrappers].reverse()) body = wrapper.open + body + wrapper.close;
  return (format.heading ? '#'.repeat(format.heading) + ' ' : '') + body;
}
