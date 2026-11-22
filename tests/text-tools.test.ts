import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import { adjustBlankLines, autoHeadings, chineseSpacing, convertPunctuation, extractAnnotations, fixMarkdown, htmlTableToMarkdown, joinSoftLines, parseTimestamp, stripSpaces, transformProse, tsvToMarkdown } from "../src/text-tools.ts";

test("正文转换保留 frontmatter、代码、链接、网址和 HTML 属性", () => {
	const source = '---\ntitle: a,b\n---\n# 标题,a\n`a,b` [a,b](https://a.com/x(y)) [[a,b]] https://a.com/x,y <span title="a,b">a,b</span>\n```js\na,b\n```\n    a,b\n';
	assert.equal(transformProse(source, text => text.replace(/,/g, "，")), '---\ntitle: a,b\n---\n# 标题，a\n`a,b` [a,b](https://a.com/x(y)) [[a,b]] https://a.com/x,y <span title="a,b">a，b</span>\n```js\na,b\n```\n    a,b\n');
});
test("未闭合 frontmatter 和围栏整块保护", () => {
	assert.equal(chineseSpacing("---\nx: 中文ABC"), "---\nx: 中文ABC");
	assert.equal(chineseSpacing("~~~\n中文ABC"), "~~~\n中文ABC");
	assert.equal(chineseSpacing("- ```\n  中文ABC\n  ```\n正文ABC"), "- ```\n  中文ABC\n  ```\n正文 ABC");
});
test("不同长度的行内代码围栏与转义符不改变", () => {
	assert.equal(chineseSpacing("中文ABC ``中文ABC`代码`` \\中ABC"), "中文 ABC ``中文ABC`代码`` \\中ABC");
});
test("英文标点转中文保留数字、链接和列表结构", () => {
	assert.equal(convertPunctuation('1. Hello, "world"! 3.14 12:30 don\'t\n[链接](https://a.com)', "zh"), '1. Hello， “world”！ 3.14 12:30 don\'t\n[链接](https://a.com)');
	assert.equal(convertPunctuation("“你好”，（测试）！", "en"), '"你好",(测试)!');
});
test("保守修复列表和中文括号链接", () => {
	assert.equal(fixMarkdown("1。项目\n【链接】（https://example.com）\n[[笔记]]()\n`1。代码`\n```\n1。代码\n```"), "1. 项目\n[链接](https://example.com)\n[[笔记]]\n`1。代码`\n```\n1。代码\n```");
});
test("合并中英文软换行，保留段落和结构", () => {
	assert.equal(joinSoftLines("中文意外\n断行\n\nEnglish\nwords.\nNext sentence\n# 标题\n- 列表\n继续\n| a | b |\n"), "中文意外断行\n\nEnglish words.\nNext sentence\n# 标题\n- 列表\n继续\n| a | b |\n");
	assert.equal(joinSoftLines("硬换行  \n保留\\\n保留"), "硬换行  \n保留\\\n保留");
});
test("空行增减不改 frontmatter 或代码块内部", () => {
	const source = "---\na: b\n\n---\n甲\n乙\n\n```\na\n\nb\n```";
	assert.equal(adjustBlankLines(source, "add"), "---\na: b\n\n---\n甲\n\n乙\n\n```\na\n\nb\n```");
	assert.equal(adjustBlankLines(source, "remove"), "---\na: b\n\n---\n甲\n乙\n```\na\n\nb\n```");
});
test("空行保持 CRLF 并具备幂等性", () => {
	const added = adjustBlankLines("甲\r\n乙\r\n", "add");
	assert.equal(added, "甲\r\n\r\n乙\r\n");
	assert.equal(adjustBlankLines(added, "add"), added);
	assert.equal(adjustBlankLines("| 名称 | 值 |\n| --- | --- |\n| A | 1 |", "add"), "| 名称 | 值 |\n| --- | --- |\n| A | 1 |");
});
test("中英空格只处理正文", () => {
	assert.equal(chineseSpacing("# 中文ABC和123\n[中文ABC](x) `中文ABC`"), "# 中文 ABC 和 123\n[中文ABC](x) `中文ABC`");
});
test("去空格保留标题列表引用缩进与链接", () => {
	assert.equal(stripSpaces("# 一 二\n- [ ] 一 二\n> 一 二\n  - 一 二\n[一 二](a b)\n    一 二"), "# 一二\n- [ ] 一二\n> 一二\n  - 一二\n[一 二](a b)\n    一 二");
});
test("自动标题只转换短小的普通单行", () => {
	assert.equal(autoHeadings("标题\n句子。\n序号1\n- 列表\n# 已有\n```\n代码\n```", 2), "## 标题\n句子。\n序号1\n- 列表\n# 已有\n```\n代码\n```");
	assert.throws(() => autoHeadings("标题", 7), /标题级别/);
});
test("提取标题高亮注释与标签，忽略代码", () => {
	assert.equal(extractAnnotations("# 标题\n正文==高亮==\n%%注释%%\n#标注 重点\n`==代码==`\n```\n# 代码\n```"), "# 标题\n高亮\n注释\n#标注 重点");
	assert.equal(extractAnnotations("普通\n%%第一行\n第二行%%\n未标注\n%%另一条%%"), "第一行\n第二行\n另一条");
});
test("TSV 支持转义、空格、CRLF和引号多行", () => {
	assert.equal(tsvToMarkdown('标题\t值\r\n"多\n行"\t"a|b"\r\n"引号""值"\t2\r\n'), '| 标题 | 值 |\n| --- | --- |\n| 多<br>行 | a\\|b |\n| 引号"值 | 2 |');
	assert.equal(tsvToMarkdown("a\tb\n1"), "| a | b |\n| --- | --- |\n| 1 |  |");
	assert.throws(() => tsvToMarkdown('"未闭合'), /未闭合/);
	assert.equal(tsvToMarkdown("表头\n<img src=x> & <b>"), "| 表头 |\n| --- |\n| &lt;img src=x&gt; &amp; &lt;b&gt; |");
});
test("HTML 表格支持合并单元格、换行和安全文本", () => {
	const window = new Window();
	const html = '<table><thead><tr><th colspan="2">名称</th><th>值</th></tr></thead><tbody><tr><td rowspan="2">A</td><td>甲<br>乙</td><td>x|y<script>bad()</script><img src="https://example.com/track"></td></tr><tr><td>B</td><td>2</td></tr></tbody></table>';
	assert.equal(htmlTableToMarkdown(html, window.document as unknown as Document), "| 名称 |  | 值 |\n| --- | --- | --- |\n| A | 甲<br>乙 | x\\|y |\n|  | B | 2 |");
});
test("HTML 表格拒绝多表、嵌套、非法合并", () => {
	const window = new Window();
	const document = window.document as unknown as Document;
	assert.throws(() => htmlTableToMarkdown("<p>没有表格</p>", document), /没有 HTML 表格/);
	assert.throws(() => htmlTableToMarkdown("<table><tr><td><table></table></td></tr></table>", document), /嵌套表格/);
	assert.throws(() => htmlTableToMarkdown('<table><tr><td rowspan="2">x</td></tr></table>', document), /超出实际行数/);
});
test("时间解析支持分秒、时分秒和毫秒", () => {
	assert.equal(parseTimestamp("视频 12:34 说明"), 754);
	assert.equal(parseTimestamp("[01:02:03.250]"), 3723.25);
	assert.equal(parseTimestamp("90:01"), 5401);
	assert.equal(parseTimestamp("1:60:00"), null);
	assert.equal(parseTimestamp("12:99"), null);
	assert.equal(parseTimestamp("普通文本"), null);
});
