const TYPES: Record<string, string> = {
  note: 'note', 笔记: 'note', abstract: 'abstract', summary: 'summary', tldr: 'tldr', 摘要: 'abstract', 总结: 'summary',
  info: 'info', 信息: 'info', 信息资讯: 'info', todo: 'todo', 待办: 'todo', tip: 'tip', hint: 'hint', 提示: 'tip',
  important: 'important', 重要: 'important', success: 'success', check: 'check', done: 'done', 成功: 'success', 检查: 'check', 完成: 'done',
  question: 'question', help: 'help', faq: 'faq', 问题: 'question', 帮助: 'help', 常见问题: 'faq',
  warning: 'warning', caution: 'caution', attention: 'attention', 警告: 'warning', 提醒: 'caution', 注意: 'attention',
  failure: 'failure', fail: 'fail', missing: 'missing', 失败: 'failure', 缺失: 'missing',
  danger: 'danger', error: 'error', 危险: 'danger', 错误: 'error', bug: 'bug', 漏洞: 'bug',
  example: 'example', 示例: 'example', quote: 'quote', cite: 'cite', 引用: 'quote',
};
const ALIGNMENTS: Record<string, string> = { 左: 'left', 中: 'center', 右: 'right', l: 'left', c: 'center', r: 'right', left: 'left', center: 'center', right: 'right' };

/** 对齐使用本插件命名空间元数据，不依赖参考插件或主题的样式。 */
export function expandCallout(line: string): string | null {
  const input = line.trim();
  for (const alias of Object.keys(TYPES).sort((a, b) => b.length - a.length)) {
    if (!input.toLowerCase().startsWith(alias.toLowerCase())) continue;
    const rest = input.slice(alias.length);
    if (rest && !/^[ \t+\-左右中lcr]/i.test(rest)) continue;
    let tail = rest.trimStart(), alignment = '', fold = '';
    const align = /^(left|center|right|[左右中lcr])(?=[ \t+-]|$)/i.exec(tail);
    if (align) { alignment = ALIGNMENTS[align[1]!.toLowerCase()] ?? ''; tail = tail.slice(align[0].length).trimStart(); }
    if (/^[+-](?:[ \t]|$)/.test(tail)) { fold = tail[0]!; tail = tail.slice(1).trimStart(); }
    if (rest && !/^\s/.test(rest) && !alignment && !fold) continue;
    return `> [!${TYPES[alias]}${alignment ? '|yuhanbo-' + alignment : ''}]${fold}${tail ? ' ' + tail : ''}\n> `;
  }
  return null;
}
