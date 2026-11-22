import type { Hotkey } from 'obsidian';

export interface ReferenceShortcut { id: string; label: string; hotkey: Hotkey }

/** 用户要求 README 明确的参考操作键默认可用；只作用于正文，不写入宿主快捷键配置。 */
export const REFERENCE_SHORTCUTS: ReferenceShortcut[] = [
  ...([
    ['wiki-link', '内部链接', 'Z'], ['wiki-alias', '别名内部链接', 'Q'], ['smart-symbol', '智能符号', ';'],
    ['bold', '粗体', 'C'], ['italic', '斜体', 'X'], ['inline-code', '行内代码', 'D'],
    ['strike', '删除线', 'S'], ['underline', '下划线', 'H'], ['superscript', '上标', 'U'], ['subscript', '下标', 'N'],
    ['highlight', '高亮', 'G'], ['cursor-up', '光标上移', 'I'], ['cursor-down', '光标下移', 'K'],
    ['cursor-left', '光标左移', 'J'], ['cursor-right', '光标右移', 'L'], ['cursor-line-end', '光标移至行尾', 'O'],
  ] as const).map(([id, label, key]): ReferenceShortcut => ({ id, label, hotkey: { modifiers: ['Alt'], key } })),
  ...([
    ['sibling-prev', '打开同文件夹上一笔记', 'U'], ['sibling-next', '打开同文件夹下一笔记', 'N'],
    ['jump-prev', '向上跳到同类内容', 'J'], ['jump-next', '向下跳到同类内容', 'L'],
  ] as const).map(([id, label, key]): ReferenceShortcut => ({ id, label, hotkey: { modifiers: ['Alt', 'Shift'], key } })),
  { id: 'heading-clear', label: '取消标题', hotkey: { modifiers: ['Mod'], key: '`' } },
  { id: 'calculate-selection', label: '计算选文或统计字符', hotkey: { modifiers: [], key: 'F9' } },
  { id: 'blank-line-visible', label: '插入可渲染空行', hotkey: { modifiers: ['Mod', 'Alt', 'Shift'], key: 'Enter' } },
  { id: 'fold-heading-level', label: '折叠同级标题', hotkey: { modifiers: ['Mod', 'Alt', 'Shift'], key: 'D' } },
  ...Array.from({ length: 5 }, (_, index): ReferenceShortcut => ({ id: `text-color-${index + 1}`, label: `文字颜色 ${index + 1}`, hotkey: { modifiers: ['Mod', 'Shift'], key: String(index + 1) } })),
  ...Array.from({ length: 5 }, (_, index): ReferenceShortcut => ({ id: `background-color-${index + 1}`, label: `背景颜色 ${index + 1}`, hotkey: { modifiers: ['Mod', 'Alt'], key: String(index + 1) } })),
  { id: 'strip-markdown', label: '转换无格式文本', hotkey: { modifiers: ['Mod', 'Alt'], key: 'Z' } },
  { id: 'copy-plain-text', label: '复制无格式文本', hotkey: { modifiers: ['Mod', 'Alt'], key: 'C' } },
  { id: 'smart-paste', label: '智能粘贴', hotkey: { modifiers: ['Mod', 'Alt'], key: 'V' } },
  { id: 'blank-lines-add', label: '批量插入空行', hotkey: { modifiers: ['Mod', 'Shift'], key: 'L' } },
  { id: 'blank-lines-remove', label: '批量去除空行', hotkey: { modifiers: ['Mod', 'Alt'], key: 'L' } },
];

export function parseReferenceShortcuts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const saved = new Set(Array.from({ length: Math.min(value.length, 128) }, (_, index) => Object.getOwnPropertyDescriptor(value, String(index))?.value as unknown));
  return REFERENCE_SHORTCUTS.filter(binding => saved.has(binding.id)).map(binding => binding.id);
}

export function hotkeyLabel(hotkey: Hotkey, mac: boolean): string {
  return [...hotkey.modifiers.map(modifier => modifier === 'Mod' ? mac ? 'Cmd' : 'Ctrl' : modifier), hotkey.key].join('+');
}
