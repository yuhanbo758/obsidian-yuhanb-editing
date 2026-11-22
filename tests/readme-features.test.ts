import assert from 'node:assert/strict';
import test from 'node:test';
import { expandCallout } from '../src/callouts';
import { applyBrushFormat, captureBrushFormat, expandBrushRange } from '../src/format-brush';
import { hotkeyLabel, parseReferenceShortcuts, REFERENCE_SHORTCUTS } from '../src/reference-shortcuts';
import { fixMarkdown } from '../src/text-tools';
import { smartSymbol } from '../src/transforms';

test('Callout 支持中文名称、紧邻和分隔的对齐折叠简写，以及官方别名', () => {
  const examples = [
    ['笔记 右+', '> [!note|yuhanbo-right]+\n> '],
    ['摘要l-', '> [!abstract|yuhanbo-left]-\n> '],
    ['提示 中-', '> [!tip|yuhanbo-center]-\n> '],
    ['问题r+', '> [!question|yuhanbo-right]+\n> '],
    ['info c', '> [!info|yuhanbo-center]\n> '],
    ['warning - 提醒', '> [!warning]- 提醒\n> '],
    ['faq + 常见问题', '> [!faq]+ 常见问题\n> '],
    ['important', '> [!important]\n> '],
    ['done', '> [!done]\n> '],
    ['note center + 标题', '> [!note|yuhanbo-center]+ 标题\n> '],
  ];
  for (const [input, expected] of examples) assert.equal(expandCallout(input!), expected, input);
  for (const input of ['notebook', 'information', '普通正文', 'noteworthy']) assert.equal(expandCallout(input), null);
  assert.deepEqual(smartSymbol('笔记 右+', ''), { before: '> [!note|yuhanbo-right]+\n> ', after: '' });
});

test('格式刷复制复合样式与颜色，并且重复应用保持样式', () => {
  const source = '### **<span style="color: #e03131">源文字</span>**';
  const format = captureBrushFormat(source)!;
  assert.equal(format.heading, 3);
  assert.equal(format.wrappers.length, 2);
  const once = applyBrushFormat('## _目标_', format);
  assert.equal(once, '### **<span style="color: #e03131">目标</span>**');
  assert.equal(applyBrushFormat(once, format), once);
});

test('实时预览选中正文时向外恢复嵌套格式，不吞并相邻文字', () => {
  const source = '前文 **<span style="color: #1971c2">文字</span>** 后文';
  const from = source.indexOf('文字');
  const expanded = expandBrushRange(source, from, from + 2);
  assert.equal(expanded.text, '**<span style="color: #1971c2">文字</span>**');
  assert.equal(source.slice(expanded.from, expanded.to), expanded.text);
  assert.equal(captureBrushFormat(expanded.text)?.wrappers.length, 2);
});

test('参考键组覆盖 README 明示按键，配置去重并拒绝未知命令', () => {
  assert.equal(REFERENCE_SHORTCUTS.length, 39);
  assert.equal(new Set(REFERENCE_SHORTCUTS.map(item => hotkeyLabel(item.hotkey, false))).size, 39);
  assert.deepEqual(parseReferenceShortcuts(['bold', 'bold', 'untrusted', 'wiki-link']), ['wiki-link', 'bold']);
  assert.deepEqual(parseReferenceShortcuts(undefined), []);
  assert.equal(hotkeyLabel(REFERENCE_SHORTCUTS.find(item => item.id === 'smart-paste')!.hotkey, true), 'Cmd+Alt+V');
});

test('修复混合全半角链接和本地目标，保留正常链接、代码及危险协议', () => {
  const source = '【文档】（附件/文件.pdf） [网页]（https://example.com） 【跳转】(#标题)\n`【代码】（原文）`\n[正常](target) 【危险】（javascript:alert）';
  assert.equal(fixMarkdown(source), '[文档](附件/文件.pdf) [网页](https://example.com) [跳转](#标题)\n`【代码】（原文）`\n[正常](target) 【危险】（javascript:alert）');
});
