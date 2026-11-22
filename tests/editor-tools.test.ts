import assert from 'node:assert/strict';
import test from 'node:test';
import type { Editor, EditorPosition, EditorSelection, EditorTransaction } from 'obsidian';
import { applyEdits, offsetToPos, protectedLines, selectedRanges, snapshot, transformEditor, transformLines, unchanged } from '../src/editor-tools';

const pos = (line: number, ch: number): EditorPosition => ({ line, ch });
const selection = (aLine: number, aCh: number, hLine = aLine, hCh = aCh): EditorSelection => ({ anchor: pos(aLine, aCh), head: pos(hLine, hCh) });

// 替身只实现本模块所需的公开 Editor 契约；事务选区必须使用真实的 from/to 结构。
class TestEditor {
  value: string;
  selections: EditorSelection[];
  transactions: EditorTransaction[] = [];
  history: Array<{ value: string; selections: EditorSelection[] }> = [];
  constructor(value: string, selections: EditorSelection[] = [selection(0, 0)]) {
    this.value = value;
    this.selections = structuredClone(selections);
  }
  getValue(): string { return this.value; }
  getLine(line: number): string { return this.value.split('\n')[line] ?? ''; }
  listSelections(): EditorSelection[] { return structuredClone(this.selections); }
  posToOffset(point: EditorPosition): number {
    const lines = this.value.split('\n');
    assert(point.line >= 0 && point.line < lines.length, 'mock 收到越界行号');
    assert(point.ch >= 0 && point.ch <= lines[point.line]!.length, 'mock 收到越界列号');
    return lines.slice(0, point.line).reduce((total, line) => total + line.length + 1, 0) + point.ch;
  }
  offsetToPos(offset: number): EditorPosition {
    assert(offset >= 0 && offset <= this.value.length, 'mock 收到越界偏移');
    const prefix = this.value.slice(0, offset).split('\n');
    return pos(prefix.length - 1, prefix[prefix.length - 1]!.length);
  }
  transaction(tx: EditorTransaction): void {
    this.history.push({ value: this.value, selections: this.listSelections() });
    this.transactions.push(structuredClone(tx));
    const changes = (tx.changes ?? []).map(change => ({ from: this.posToOffset(change.from), to: this.posToOffset(change.to ?? change.from), text: change.text }));
    for (const change of changes.sort((a, b) => b.from - a.from)) this.value = this.value.slice(0, change.from) + change.text + this.value.slice(change.to);
    if (tx.selections) {
      this.selections = tx.selections.map(range => {
        assert(range.from, 'EditorTransaction.selections 需要 from/to，不能传 anchor/head');
        return { anchor: { ...range.from }, head: { ...(range.to ?? range.from) } };
      });
    }
  }
  undo(): void {
    const previous = this.history.pop();
    assert(previous, '没有可撤销事务');
    this.value = previous.value;
    this.selections = previous.selections;
  }
  asEditor(): Editor { return this as unknown as Editor; }
}

test('行范围排除在下一行行首结束的未选中行，正反向一致', () => {
  const forward = new TestEditor('第一行\n第二行\n第三行', [selection(0, 1, 2, 0)]);
  const reverse = new TestEditor(forward.value, [selection(2, 0, 0, 1)]);
  assert.deepEqual(selectedRanges(forward.asEditor(), 'lines'), [{ from: 0, to: 7 }]);
  assert.deepEqual(selectedRanges(reverse.asEditor(), 'lines'), [{ from: 0, to: 7 }]);
});

test('多光标同行或重叠行范围只转换一次', () => {
  const mock = new TestEditor('alpha\nbeta', [selection(0, 1), selection(0, 3), selection(0, 4, 1, 2)]);
  transformLines(mock.asEditor(), line => '# ' + line);
  assert.equal(mock.value, '# alpha\n# beta');
  assert.equal(mock.transactions.length, 1);
  assert.equal(mock.transactions[0]!.changes!.length, 2);
});

test('多选区按原始偏移分别转换且保持其他文本', () => {
  const mock = new TestEditor('one two three', [selection(0, 8, 0, 13), selection(0, 0, 0, 3)]);
  transformEditor(mock.asEditor(), 'selection', text => '[' + text + ']');
  assert.equal(mock.value, '[one] two [three]');
  assert.equal(mock.transactions.length, 1);
});

test('选文或全文范围仅在所有选区为空时使用全文', () => {
  const empty = new TestEditor('alpha\nbeta', [selection(0, 1), selection(1, 1)]);
  assert.deepEqual(selectedRanges(empty.asEditor(), 'selection-or-document'), [{ from: 0, to: 10 }]);
  const mixed = new TestEditor('alpha\nbeta', [selection(0, 1, 0, 3), selection(1, 1)]);
  assert.deepEqual(selectedRanges(mixed.asEditor(), 'selection-or-document'), [{ from: 1, to: 3 }, { from: 7, to: 7 }]);
});

test('重叠选择合并后只生成一个替换', () => {
  const mock = new TestEditor('abcdefgh', [selection(0, 1, 0, 5), selection(0, 3, 0, 7)]);
  assert.deepEqual(selectedRanges(mock.asEditor(), 'selection'), [{ from: 1, to: 7 }]);
  transformEditor(mock.asEditor(), 'selection', text => text.toUpperCase());
  assert.equal(mock.value, 'aBCDEFGh');
  assert.equal(mock.transactions[0]!.changes!.length, 1);
});

test('标题前缀增减后光标仍指向原来的正文位置', () => {
  const mock = new TestEditor('标题内容', [selection(0, 2)]);
  transformLines(mock.asEditor(), line => '### ' + line);
  assert.deepEqual(mock.selections, [selection(0, 6)]);
  transformLines(mock.asEditor(), line => line.slice(4));
  assert.equal(mock.value, '标题内容');
  assert.deepEqual(mock.selections, [selection(0, 2)]);
});

test('反向选区经长度变化保持方向和两个端点', () => {
  const mock = new TestEditor('first\nsecond', [selection(1, 6, 0, 2)]);
  transformLines(mock.asEditor(), line => '# ' + line);
  assert.equal(mock.value, '# first\n# second');
  assert.deepEqual(mock.selections, [selection(1, 8, 0, 4)]);
});

test('前面替换引起的偏移累积映射到后面光标', () => {
  const mock = new TestEditor('aa bb cc', [selection(0, 7)]);
  applyEdits(mock.asEditor(), [{ from: 0, to: 2, text: 'aaaa' }, { from: 3, to: 5, text: 'b' }]);
  assert.equal(mock.value, 'aaaa b cc');
  assert.deepEqual(mock.selections, [selection(0, 8)]);
});

test('显式 cursor 可将空选区放进新插入的符号内部', () => {
  const mock = new TestEditor('abcd', [selection(0, 2)]);
  applyEdits(mock.asEditor(), [{ from: 2, to: 2, text: '[[]]', cursor: 2 }]);
  assert.equal(mock.value, 'ab[[]]cd');
  assert.deepEqual(mock.selections, [selection(0, 4)]);
});

test('智能符号跳过已有右括号时，即使文字未变化也提交光标移动', () => {
  const mock = new TestEditor('【文字】', [selection(0, 3)]);
  applyEdits(mock.asEditor(), [{ from: 0, to: 4, text: '【文字】', cursor: 4 }]);
  assert.equal(mock.value, '【文字】');
  assert.deepEqual(mock.selections, [selection(0, 4)]);
  assert.equal(mock.transactions.length, 1);
});

test('一次批量操作为单个撤销事务，撤销恢复正文和反向选择', () => {
  const initial = 'alpha\nbeta\ngamma';
  const ranges = [selection(2, 4, 0, 1)];
  const mock = new TestEditor(initial, ranges);
  transformLines(mock.asEditor(), line => '> ' + line);
  assert.equal(mock.transactions.length, 1);
  assert.equal(mock.transactions[0]!.changes!.length, 3);
  mock.undo();
  assert.equal(mock.value, initial);
  assert.deepEqual(mock.selections, ranges);
});

test('无变更不提交事务或移动选区', () => {
  const mock = new TestEditor('hello', [selection(0, 4, 0, 1)]);
  applyEdits(mock.asEditor(), [{ from: 0, to: 5, text: 'hello' }]);
  assert.equal(mock.transactions.length, 0);
  assert.deepEqual(mock.selections, [selection(0, 4, 0, 1)]);
});

test('重叠或越界的修改整批取消，不产生部分写入', () => {
  for (const edits of [
    [{ from: 0, to: 3, text: 'x' }, { from: 2, to: 4, text: 'y' }],
    [{ from: -1, to: 2, text: 'x' }],
    [{ from: 1, to: 9, text: 'x' }],
    [{ from: 3, to: 1, text: 'x' }],
  ]) {
    const mock = new TestEditor('abcde');
    assert.throws(() => applyEdits(mock.asEditor(), edits), /重叠或越界/);
    assert.equal(mock.value, 'abcde');
    assert.equal(mock.transactions.length, 0);
  }
});

test('偏移转换使用 UTF-16 编辑器列号并夹紧首尾', () => {
  const text = '😀中文\nsecond';
  assert.deepEqual(offsetToPos(text, 4), pos(0, 4));
  assert.deepEqual(offsetToPos(text, 5), pos(1, 0));
  assert.deepEqual(offsetToPos(text, -5), pos(0, 0));
  assert.deepEqual(offsetToPos(text, 999), pos(1, 6));
});

test('保护 YAML、长围栏与缩进代码，不被围栏内短标记提前关闭', () => {
  const lines = ['---', 'title: 原标题', '---', '正文', '````js', '```', '代码', '````', '正文二', '    缩进代码', '\t制表代码'];
  assert.deepEqual([...protectedLines(lines.join('\n'))], [0, 1, 2, 4, 5, 6, 7, 9, 10]);
});

test('行批量转换只修改允许的正文，未闭合代码块保守保护到底', () => {
  const original = '---\ntitle: keep\n---\n正文\n```js\ncode\n```\n末段\n~~~\n未闭合代码';
  const mock = new TestEditor(original, [selection(0, 0, 9, 5)]);
  transformLines(mock.asEditor(), line => '# ' + line);
  assert.equal(mock.value, '---\ntitle: keep\n---\n# 正文\n```js\ncode\n```\n# 末段\n~~~\n未闭合代码');
});

test('引用与列表中嵌套的围栏代码完整保护，关闭后恢复正文转换', () => {
  const cases = [
    { source: '> ```js\n> const x = 1;\n> ```\n正文', protected: [0, 1, 2], expected: '> ```js\n> const x = 1;\n> ```\n# 正文' },
    { source: '- ```js\n  const x = 1;\n  ```\n正文', protected: [0, 1, 2], expected: '- ```js\n  const x = 1;\n  ```\n# 正文' },
    { source: '- 引用\n  > ```js\n  > const x = 1;\n  > ```\n正文', protected: [1, 2, 3], expected: '# - 引用\n  > ```js\n  > const x = 1;\n  > ```\n# 正文' },
  ];
  for (const fixture of cases) {
    assert.deepEqual([...protectedLines(fixture.source)], fixture.protected);
    const mock = new TestEditor(fixture.source, [selection(0, 0, fixture.source.split('\n').length - 1, 2)]);
    transformLines(mock.asEditor(), line => '# ' + line);
    assert.equal(mock.value, fixture.expected);
  }
});

test('光标在当前行且没有选区时只转换当前行', () => {
  const mock = new TestEditor('alpha\nbeta\ngamma', [selection(1, 2)]);
  transformLines(mock.asEditor(), line => '# ' + line);
  assert.equal(mock.value, 'alpha\n# beta\ngamma');
});

test('异步快照同时检查内容和选区，修改任一项即失效', () => {
  const mock = new TestEditor('original', [selection(0, 2)]);
  const saved = snapshot(mock.asEditor());
  assert(unchanged(mock.asEditor(), saved));
  mock.selections = [selection(0, 3)];
  assert(!unchanged(mock.asEditor(), saved));
  mock.selections = [selection(0, 2)];
  mock.value = 'modified';
  assert(!unchanged(mock.asEditor(), saved));
  mock.value = 'original';
  assert(unchanged(mock.asEditor(), saved));
});
