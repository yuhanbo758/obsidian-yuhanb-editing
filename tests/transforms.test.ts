import test from 'node:test';
import assert from 'node:assert/strict';
import { toggleHeading, toggleWrapper, toggleCodeBlock, cycleTask, toggleWikiLinks, stripMarkdown, setColor, smartSymbol, detectFormat } from '../src/transforms.ts';

test('标题级别切换、取消和引用缩进保留', () => {
	assert.equal(toggleHeading('标题', 1), '# 标题');
	assert.equal(toggleHeading('### 标题', 6), '###### 标题');
	assert.equal(toggleHeading('## 标题', 2), '标题');
	assert.equal(toggleHeading('  > > ## 标题', 3), '  > > ### 标题');
	assert.equal(toggleHeading('  > ## 标题', 2), '  > 标题');
	assert.equal(toggleHeading('#标签', 2), '## #标签');
	assert.throws(() => toggleHeading('标题', 7), RangeError);
});

test('普通包裹支持切换并保留正文', () => {
	assert.equal(toggleWrapper('中文', '**', '**'), '**中文**');
	assert.equal(toggleWrapper('**中文**', '**', '**'), '中文');
	assert.equal(toggleWrapper('', '<sup>', '</sup>'), '<sup></sup>');
	assert.equal(toggleWrapper('内容', '', ''), '内容');
	assert.equal(toggleWrapper(' 内容 \n', '**', '**'), ' **内容** \n');
});

test('行内代码为内容中的反引号选择不冲突的围栏', () => {
	assert.equal(toggleWrapper('x`y', '`', '`'), '``x`y``');
	assert.equal(toggleWrapper('`x', '`', '`'), '`` `x ``');
	assert.equal(toggleWrapper('`` `x ``', '`', '`'), '`x');
	assert.equal(toggleWrapper('`内容`', '`', '`'), '内容');
	assert.equal(toggleWrapper('`a``b`', '`', '`'), 'a``b');
	assert.equal(toggleWrapper('``x```', '`', '`'), '```` ``x``` ````');
});

test('代码块与围栏冲突、末尾换行均可往返', () => {
	for (const text of ['a', 'a\n', 'a\n```\nb']) {
		assert.equal(toggleCodeBlock(toggleCodeBlock(text, 'ts')), text);
	}
	assert.equal(toggleCodeBlock('~~~js\nconst a = 1;\n~~~'), 'const a = 1;');
	assert.equal(toggleCodeBlock('```js\ncode\n````'), 'code');
	assert.equal(toggleCodeBlock('```\n```'), '');
	assert.equal(toggleCodeBlock('```\na\n```\nb\n```'), '````\n```\na\n```\nb\n```\n````');
	assert.throws(() => toggleCodeBlock('x', 'js\n坏内容'));
});

test('待办循环保留列表样式、引用和未知状态', () => {
	assert.equal(cycleTask('  > 1. [ ] 内容', [' ', 'x', '-']), '  > 1. [x] 内容');
	assert.equal(cycleTask('- [-] 内容', [' ', 'x', '-']), '- [ ] 内容');
	assert.equal(cycleTask('* 内容', [' ', 'x']), '* [ ] 内容');
	assert.equal(cycleTask('文字', [' ', 'x']), '- [ ] 文字');
	assert.equal(cycleTask('- [?] 内容', [' ', 'x']), '- [ ] 内容');
});

test('内链批量支持中文顿号、别名和非法文件名原样保留', () => {
	assert.equal(toggleWikiLinks('甲、乙\n 丙 '), '[[甲]]、[[乙]]\n [[丙]] ');
	assert.equal(toggleWikiLinks('[[目标|显示]]'), '显示');
	assert.equal(toggleWikiLinks('[[目标]]'), '目标');
	assert.equal(toggleWikiLinks('显示', true), '[[|显示]]');
	for (const text of ['a/b', 'a:b', 'a?b', 'a[b]', 'a\\b']) assert.equal(toggleWikiLinks(text), text);
});

test('去语法保留代码里的符号及 YAML，去除普通格式', () => {
	const content = '---\ntags: [a, b]\n---\n# 标题\n**粗体** 与 _斜体_\n[链接](https://example.com/a_(b)) [[目标|显示]]\n```js\nconst x = "**原样**"; a < b;\n```\n`a * b`';
	assert.equal(stripMarkdown(content), '---\ntags: [a, b]\n---\n标题\n粗体 与 斜体\n链接 显示\nconst x = "**原样**"; a < b;\na * b');
	assert.equal(stripMarkdown('a < b 与 c > d'), 'a < b 与 c > d');
	assert.equal(stripMarkdown('\\*字面量\\* 与 1_2'), '*字面量* 与 1_2');
	assert.equal(stripMarkdown('这是*重点*内容，a * b'), '这是重点内容，a * b');
	assert.equal(stripMarkdown('{{c1::答案::提示}} <u>下划线</u>'), '答案 下划线');
	assert.equal(stripMarkdown('```js\n未闭合 **代码**'), '```js\n未闭合 **代码**');
});

test('颜色合法值及重复切换，拒绝属性注入', () => {
	assert.equal(setColor('文字', '#AABBCC'), '<span style="color: #aabbcc">文字</span>');
	assert.equal(setColor('<span style="color: #aabbcc">文字</span>', '#aabbcc'), '文字');
	assert.equal(setColor('<span style="color: #aabbcc">文字</span>', '#112233'), '<span style="color: #112233">文字</span>');
	assert.equal(setColor('文字', '#112233', true), '<span style="background-color: #112233">文字</span>');
	assert.throws(() => setColor('文字', 'red" onclick="x'));
});

test('去语法只移除明确 HTML 格式，不吞掉比较符和未知普通文本', () => {
	assert.equal(stripMarkdown('a<b && c>d，1 < 2，a<abc>z'), 'a<b && c>d，1 < 2，a<abc>z');
	assert.equal(stripMarkdown('<span style="color: red"><u>文字</u></span><sup>2</sup>'), '文字2');
	assert.equal(stripMarkdown('<code>**不变** a<b</code>'), '**不变** a<b');
	assert.equal(stripMarkdown('<pre><code>[[不是链接]]\n**不是粗体**</code></pre>'), '[[不是链接]]\n**不是粗体**');
});

test('连续围栏与元数据不误删正文', () => {
	assert.equal(stripMarkdown('````md\n```\n**code**\n```\n````'), '```\n**code**\n```');
	assert.equal(stripMarkdown('---\ntags: [**未闭合元数据**]'), '---\ntags: [**未闭合元数据**]');
	assert.equal(stripMarkdown('    **缩进代码**\n\t[[缩进代码]]'), '    **缩进代码**\n\t[[缩进代码]]');
	assert.equal(stripMarkdown('```\nx\n```\n**普通文本**\n~~~\ny\n~~~'), 'x\n普通文本\ny');
});

test('多行格式去语法不改动普通标点和字面量', () => {
	assert.equal(stripMarkdown('**第一行\n第二行**\n_斜体_'), '第一行\n第二行\n斜体');
	assert.equal(stripMarkdown('```js\n[1, 2].map(x => x * 2)\n```'), '[1, 2].map(x => x * 2)');
	assert.equal(stripMarkdown('`**代码**` 与 **正文**'), '**代码** 与 正文');
});

test('混合批量内链的无效项、已有别名和首尾空白保持数据完整', () => {
	assert.equal(toggleWikiLinks('甲、无效/名字、[[目标|显示]]\n 乙 '), '[[甲]]、无效/名字、显示\n [[乙]] ');
	assert.equal(toggleWikiLinks('[[目标#标题|显示]]'), '显示');
	assert.equal(toggleWikiLinks('未闭合[[链接'), '未闭合[[链接');
	assert.equal(toggleWikiLinks('名字\u0001'), '名字\u0001');
	assert.equal(toggleWikiLinks('甲\r\n乙'), '[[甲]]\r\n[[乙]]');
	assert.equal(toggleWikiLinks('[[目标|甲、乙]]'), '甲、乙');
	assert.equal(toggleWikiLinks('甲、[[目标|乙、丙]]、丁'), '[[甲]]、乙、丙、[[丁]]');
	assert.equal(toggleWikiLinks('[[甲、乙]]'), '甲、乙');
});

test('智能符号匹配、跳过右符号和嵌套 token', () => {
	assert.deepEqual(smartSymbol('[[文字', ''), { before: '[[文字]]', after: '' });
	assert.deepEqual(smartSymbol('【（', ''), { before: '〖', after: '' });
	assert.deepEqual(smartSymbol('文字', ']]后文'), { before: '文字]]', after: '后文' });
	assert.deepEqual(smartSymbol('《（文字', ''), { before: '《（文字）', after: '' });
	assert.deepEqual(smartSymbol('**文字', ''), { before: '**文字**', after: '' });
	assert.deepEqual(smartSymbol('上一行\ndv', ''), { before: '上一行\n```dataview\n', after: '\n```' });
	assert.deepEqual(smartSymbol('note + 标题', ''), { before: '> [!note]+ 标题\n> ', after: '' });
	assert.deepEqual(smartSymbol('普通文字', ''), { before: '普通文字', after: '' });
});

test('格式刷仅识别显式包裹格式', () => {
	assert.deepEqual(detectFormat('**文字**'), { open: '**', close: '**' });
	assert.deepEqual(detectFormat('<span style="color: #aabbcc">文字</span>'), { open: '<span style="color: #aabbcc">', close: '</span>' });
	assert.equal(detectFormat('普通文字'), null);
});
