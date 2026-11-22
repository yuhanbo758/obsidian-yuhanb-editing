import assert from 'node:assert/strict';
import test from 'node:test';
import { createFixture, deferred, FixtureEditor, pos, selection } from './plugin-fixture';

test('旧版取消标题和同级折叠使用正确级别，保护代码并恢复原选区', async context => {
  const fixture = await createFixture('## 甲\n### 子级\n\n```md\n## 示例\n```\n\n## 乙', [selection(0, 4, 3)]);
  context.after(() => fixture.close());
  await fixture.run('fold-heading-level');
  assert.deepEqual(fixture.editor.executedCommands, [
    { id: 'unfoldAll', cursor: pos(0, 3) }, { id: 'toggleFold', cursor: pos(7, 0) }, { id: 'toggleFold', cursor: pos(0, 0) },
  ]);
  assert.deepEqual(fixture.editor.selections, [selection(0, 4, 3)]);
  await fixture.run('heading-clear');
  assert.equal(fixture.editor.getLine(0), '甲');
  assert.equal(fixture.editor.getLine(4), '## 示例');
});

test('旧版同类跳转及选文计算通过命令入口工作', async context => {
  const fixture = await createFixture('==甲== 与 ==乙==\n(2 + 3) × 4 - 1', [selection(0, 0, 5)]);
  context.after(() => fixture.close());
  await fixture.run('jump-next');
  assert.equal(fixture.editor.getSelection(), '==乙==');
  await fixture.run('jump-prev');
  assert.equal(fixture.editor.getSelection(), '==甲==');
  fixture.editor.setSelection(pos(1, 0), pos(1, fixture.editor.getLine(1).length));
  const copied: string[] = [];
  fixture.clipboard.writeText = async value => { copied.push(value); };
  await fixture.run('calculate-selection');
  assert.deepEqual(copied, ['19']);
  fixture.editor.value = '1/0'; fixture.editor.setSelection(pos(0, 0), pos(0, 3));
  await fixture.run('calculate-selection');
  assert.deepEqual(copied, ['19']);
});

test('代码块包裹把原光标映射到正文，空行把光标放进空代码体', async context => {
  const fixture = await createFixture('hello', [selection(0, 2)]); context.after(() => fixture.close());
  await fixture.run('code-block');
  assert.equal(fixture.editor.value, '```\nhello\n```');
  assert.deepEqual(fixture.editor.selections, [selection(1, 2)]);
  fixture.editor.value = ''; fixture.editor.selections = [selection(0, 0)];
  await fixture.run('code-block');
  assert.equal(fixture.editor.value, '```\n\n```');
  assert.deepEqual(fixture.editor.selections, [selection(1, 0)]);
});

test('两行空代码块可以整体取消，局部代码块操作保持原文', async context => {
  const fixture = await createFixture('```\n```', [{ anchor: pos(0, 0), head: pos(1, 3) }]); context.after(() => fixture.close());
  await fixture.run('code-block');
  assert.equal(fixture.editor.value, '');
  fixture.editor.value = '```js\nconsole.log(1)\n```'; fixture.editor.selections = [selection(1, 4)];
  await assert.rejects(fixture.run('code-block'), /完整代码块/);
  assert.equal(fixture.editor.value, '```js\nconsole.log(1)\n```');
});

test('内链边界插入新链接，只有内部光标才取消既有链接', async context => {
  const fixture = await createFixture('[[甲]]后文', [selection(0, 5)]); context.after(() => fixture.close());
  await fixture.run('wiki-link');
  assert.equal(fixture.editor.value, '[[甲]][[]]后文');
  assert.deepEqual(fixture.editor.selections, [selection(0, 7)]);
  fixture.editor.value = '[[甲]]后文'; fixture.editor.selections = [selection(0, 0)];
  await fixture.run('wiki-link');
  assert.equal(fixture.editor.value, '[[]][[甲]]后文');
  fixture.editor.value = '[[甲]]后文'; fixture.editor.selections = [selection(0, 3)];
  await fixture.run('wiki-link');
  assert.equal(fixture.editor.value, '甲后文');
});

test('同一已有内链内的多个光标只执行一次整链替换', async context => {
  const fixture = await createFixture('[[目标|显示]]', [selection(0, 2), selection(0, 7)]); context.after(() => fixture.close());
  await fixture.run('wiki-link');
  assert.equal(fixture.editor.value, '显示');
  assert.equal(fixture.editor.transactions.length, 1);
  assert.equal(fixture.editor.transactions[0]!.changes!.length, 1);
});

test('实时预览只选正文时改色和去色均保留正文选区，不嵌套 span', async context => {
  const original = '<span style="color: #e03131">文字</span>';
  const fixture = await createFixture(original); context.after(() => fixture.close());
  const from = original.indexOf('文字'); fixture.editor.selectOffsets(from, from + 2);
  await fixture.run('text-color-2');
  assert.equal(fixture.editor.value, '<span style="color: #e8590c">文字</span>');
  assert.equal(fixture.editor.getSelection(), '文字');
  await fixture.run('text-color-2');
  assert.equal(fixture.editor.value, '文字');
  assert.deepEqual(fixture.editor.selections, [selection(0, 0, 2)]);
});

test('取消外部粗体保留正反向多选区的正文范围', async context => {
  const original = '**甲** 和 **乙**';
  const fixture = await createFixture(original); context.after(() => fixture.close());
  const first = original.indexOf('甲'), second = original.indexOf('乙');
  fixture.editor.selections = [selection(0, first, first + 1), selection(0, second + 1, second)];
  await fixture.run('bold');
  assert.equal(fixture.editor.value, '甲 和 乙');
  assert.deepEqual(fixture.editor.selections, [selection(0, 0, 1), selection(0, 5, 4)]);
});

test('切入行内代码的局部选区不会被标点、颜色或粗体命令修改', async context => {
  const original = '值为 `a,b`';
  const fixture = await createFixture(original, [selection(0, 4, 7)]); context.after(() => fixture.close());
  for (const command of ['punctuation-zh', 'text-color-1', 'bold']) {
    await assert.rejects(fixture.run(command), /行内代码/);
    assert.equal(fixture.editor.value, original);
  }
  assert.equal(fixture.editor.transactions.length, 0);
});

test('跨越围栏代码的粗体选区整批拒绝，不留下部分修改', async context => {
  const original = '开始\n```js\nconst a = 1;\n```\n结束';
  const fixture = await createFixture(original, [{ anchor: pos(0, 0), head: pos(4, 2) }]); context.after(() => fixture.close());
  await assert.rejects(fixture.run('bold'), /YAML 或代码/);
  assert.equal(fixture.editor.value, original);
  assert.equal(fixture.editor.transactions.length, 0);
});

test('清理全文尾空格保护 YAML、围栏和缩进代码中的原始尾空格', async context => {
  const original = '---\ntitle: value  \n---\n```txt\ncode  \n```\n    indent  \n正文  ';
  const fixture = await createFixture(original, [selection(7, 1)]); context.after(() => fixture.close());
  await fixture.run('trim-trailing-spaces');
  assert.equal(fixture.editor.value, '---\ntitle: value  \n---\n```txt\ncode  \n```\n    indent  \n正文');
});

test('同行多光标智能补全分别插入，跳过右符号仅移动对应光标', async context => {
  const fixture = await createFixture('【甲 【乙', [selection(0, 2), selection(0, 5)]); context.after(() => fixture.close());
  await fixture.run('smart-symbol');
  assert.equal(fixture.editor.value, '【甲】 【乙】');
  assert.deepEqual(fixture.editor.selections, [selection(0, 3), selection(0, 7)]);
  fixture.editor.value = '[[甲]] [[乙]]'; fixture.editor.selections = [selection(0, 3), selection(0, 9)];
  await fixture.run('smart-symbol');
  assert.equal(fixture.editor.value, '[[甲]] [[乙]]');
  assert.deepEqual(fixture.editor.selections, [selection(0, 5), selection(0, 11)]);
});

test('等待剪贴板期间切换笔记取消粘贴，不写入旧笔记或新笔记', async context => {
  const fixture = await createFixture('原笔记', [selection(0, 3)]); context.after(() => fixture.close());
  const waiting = deferred<Array<{ types: string[]; getType(type: string): Promise<Blob> }>>();
  fixture.clipboard.read = () => waiting.promise;
  const pending = fixture.run('smart-paste');
  const next = new FixtureEditor('新笔记', [selection(0, 3)]);
  fixture.switchNote(next);
  waiting.resolve([{ types: ['text/plain'], getType: async () => new Blob(['a\tb\n1\t2'], { type: 'text/plain' }) }]);
  await assert.rejects(pending, /笔记或选区已变化/);
  assert.equal(fixture.editor.value, '原笔记'); assert.equal(next.value, '新笔记');
  assert.equal(fixture.editor.transactions.length + next.transactions.length, 0);
});

test('等待剪贴板期间卸载插件会取消写入', async context => {
  const fixture = await createFixture('原笔记', [selection(0, 3)]); context.after(() => fixture.close());
  const waiting = deferred<Array<{ types: string[]; getType(type: string): Promise<Blob> }>>();
  fixture.clipboard.read = () => waiting.promise;
  const pending = fixture.run('smart-paste'); fixture.plugin.unload();
  waiting.resolve([{ types: ['text/plain'], getType: async () => new Blob(['不可写入'], { type: 'text/plain' }) }]);
  await assert.rejects(pending, /笔记或选区已变化/);
  assert.equal(fixture.editor.value, '原笔记');
});

test('只有六个标题命令声明默认快捷键，加载不重写用户的自定义绑定', async context => {
  const fixture = await createFixture(); context.after(() => fixture.close());
  const commands = fixture.plugin.commands.filter(command => command.hotkeys?.length);
  assert.deepEqual(commands.map(command => command.id), ['heading-1', 'heading-2', 'heading-3', 'heading-4', 'heading-5', 'heading-6']);
  for (let index = 0; index < 6; index++) assert.deepEqual(commands[index]!.hotkeys, [{ modifiers: ['Mod'], key: String(index + 1) }]);
  assert.deepEqual(fixture.app.hotkeyManager.customKeys, fixture.customHotkeys);
});

test('键盘处理和状态栏监听使用生命周期注册，卸载后 DOM 不再修改笔记', async context => {
  const fixture = await createFixture('正文', [selection(0, 2)]); context.after(() => fixture.close());
  assert(fixture.plugin.domRegistrations.some(record => record.type === 'click'));
  assert.equal(fixture.plugin.editorExtensions.length, 1, '标题键组应通过宿主编辑器扩展生命周期注册');
  assert(fixture.plugin.domRegistrations.some(record => record.type === 'keydown' && record.element === fixture.document));
  fixture.plugin.settings.extraEnter = true;
  fixture.target.dispatchEvent(new fixture.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(fixture.editor.value, '正文\n\n', '卸载前监听应确实响应，而非测试空处理器');
  fixture.editor.value = '正文'; fixture.editor.selections = [selection(0, 2)];
  fixture.plugin.unload();
  fixture.target.dispatchEvent(new fixture.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(fixture.editor.value, '正文');
  assert(fixture.plugin.domRegistrations.every(record => !record.active));
  assert.equal(fixture.plugin.editorExtensions.length, 0);
  assert([...fixture.listeners.values()].every(callbacks => callbacks.size === 0));
});

test('空白行选择段落只选本行，不吸收前后两个段落', async context => {
  const fixture = await createFixture('前一段\n  \n后一段', [selection(1, 1)]); context.after(() => fixture.close());
  await fixture.run('select-paragraph');
  assert.deepEqual(fixture.editor.selections, [selection(1, 0, 2)]);
  assert.equal(fixture.editor.getSelection(), '  ');
  fixture.editor.value = '前一段\n\n后一段'; fixture.editor.selections = [selection(1, 0)];
  await fixture.run('select-paragraph');
  assert.deepEqual(fixture.editor.selections, [selection(1, 0)]);
});

test('光标在行末句号之后，选择最后一个完整中文句子', async context => {
  const original = '第一句。最后一句！';
  const fixture = await createFixture(original, [selection(0, original.length)]); context.after(() => fixture.close());
  await fixture.run('select-sentence');
  assert.equal(fixture.editor.getSelection(), '最后一句！');
  assert.equal(fixture.editor.value, original);
});

test('等待读取剪贴板时同一个文件对象改了路径，也取消粘贴', async context => {
  const fixture = await createFixture('原笔记', [selection(0, 3)]); context.after(() => fixture.close());
  const waiting = deferred<Array<{ types: string[]; getType(type: string): Promise<Blob> }>>();
  fixture.clipboard.read = () => waiting.promise;
  const file = fixture.app.workspace.getActiveFile();
  const pending = fixture.run('smart-paste');
  file.path = '重命名后.md';
  assert.equal(fixture.app.workspace.getActiveFile(), file, '必须复现原对象路径变化，而非切换对象');
  waiting.resolve([{ types: ['text/plain'], getType: async () => new Blob(['不可写入'], { type: 'text/plain' }) }]);
  await assert.rejects(pending, /笔记或选区已变化/);
  assert.equal(fixture.editor.value, '原笔记');
  assert.equal(fixture.editor.transactions.length, 0);
});

test('自动表格转换在代码区域保留默认粘贴行为，正文才拦截转换', async context => {
  const original = '```txt\n代码\n```';
  const fixture = await createFixture(original, [selection(1, 2)]); context.after(() => fixture.close());
  fixture.plugin.settings.pasteTables = true;
  const pasteEvent = () => ({ defaultPrevented: false, clipboardData: { getData: (type: string) => type === 'text/plain' ? '列一\t列二\n甲\t乙' : '' }, preventDefault() { this.defaultPrevented = true; } });
  const codePaste = pasteEvent(); fixture.emit('editor-paste', codePaste, fixture.editor.asEditor());
  assert.equal(codePaste.defaultPrevented, false);
  assert.equal(fixture.editor.value, original);
  assert.equal(fixture.editor.transactions.length, 0);
  fixture.editor.value = '正文'; fixture.editor.selections = [selection(0, 2)];
  const prosePaste = pasteEvent(); fixture.emit('editor-paste', prosePaste, fixture.editor.asEditor());
  assert.equal(prosePaste.defaultPrevented, true);
  assert.match(fixture.editor.value, /\| 列一 \| 列二 \|/);
});

test('视频时间只跳转当前行链接笔记中已经打开的播放器，不误控当前或无关笔记', async context => {
  const fixture = await createFixture('00:10 [[目标笔记]]'); context.after(() => fixture.close());
  const current = fixture.addCurrentVideo(2);
  const [target] = fixture.addVideoView('课程/目标笔记.md', [3]);
  const [unrelated] = fixture.addVideoView('其他笔记.md', [4]);
  fixture.resolveNote('目标笔记', '课程/目标笔记.md');
  await fixture.run('seek-video');
  assert.equal(target!.currentTime, 10);
  assert.equal(current.currentTime, 2); assert.equal(unrelated!.currentTime, 4);
  assert.deepEqual(fixture.linkLookups, [{ linkpath: '目标笔记', sourcePath: '测试.md' }]);
});

test('唯一链接笔记尚未打开时在侧边加载并播放，不误控原笔记的视频', async context => {
  const fixture = await createFixture('00:10 [[尚未打开]]'); context.after(() => fixture.close());
  const current = fixture.addCurrentVideo(2);
  fixture.resolveNote('尚未打开', '尚未打开.md');
  fixture.prepareUnopenedVideo('尚未打开.md', [3]);
  await fixture.run('seek-video');
  assert.deepEqual(fixture.openedFiles, ['尚未打开.md']);
  const target = fixture.app.workspace.getLeavesOfType('markdown').at(-1)!.view.containerEl.querySelector('video')!;
  assert.equal(target.currentTime, 10);
  assert.equal(target.getAttribute('data-played'), 'true');
  assert.equal(current.currentTime, 2);
});

test('选文查找使用宿主当前文档搜索面板，保留原始选区', async context => {
  const fixture = await createFixture('甲 查找词 乙 查找词', [selection(0, 2, 5)]); context.after(() => fixture.close());
  await fixture.run('find-selection');
  assert.deepEqual(fixture.searches, ['查找词']);
  assert.deepEqual(fixture.editor.selections, [selection(0, 2, 5)]);
  assert.equal(fixture.editor.transactions.length, 0);
});

test('一次格式刷通过目标选区生效一次，重复应用相同格式不会去除', async context => {
  const fixture = await createFixture('**源** 目标 再选', [selection(0, 2, 3)]); context.after(() => fixture.close());
  fixture.target.classList.add('cm-content');
  await fixture.run('brush-once');
  fixture.editor.selectOffsets(6, 8);
  fixture.target.dispatchEvent(new fixture.window.PointerEvent('pointerup', { button: 0, bubbles: true }));
  assert.equal(fixture.editor.value, '**源** **目标** 再选');
  const start = fixture.editor.value.indexOf('再选'); fixture.editor.selectOffsets(start, start + 2);
  fixture.target.dispatchEvent(new fixture.window.PointerEvent('pointerup', { button: 0, bubbles: true }));
  assert.equal(fixture.editor.value, '**源** **目标** 再选');
  fixture.editor.selectOffsets(8, 10);
  await fixture.run('brush-apply');
  assert.equal(fixture.editor.value, '**源** **目标** 再选');
});

test('连续格式刷支持多次目标选择，Esc 后停止并清理监听器', async context => {
  const fixture = await createFixture('==源== 甲 乙 丙', [selection(0, 2, 3)]); context.after(() => fixture.close());
  fixture.target.classList.add('cm-content');
  await fixture.run('brush-continuous');
  for (const word of ['甲', '乙']) {
    const start = fixture.editor.value.indexOf(word); fixture.editor.selectOffsets(start, start + 1);
    fixture.target.dispatchEvent(new fixture.window.PointerEvent('pointerup', { button: 0, bubbles: true }));
  }
  assert.equal(fixture.editor.value, '==源== ==甲== ==乙== 丙');
  fixture.target.dispatchEvent(new fixture.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const start = fixture.editor.value.indexOf('丙'); fixture.editor.selectOffsets(start, start + 1);
  fixture.target.dispatchEvent(new fixture.window.PointerEvent('pointerup', { button: 0, bubbles: true }));
  assert.equal(fixture.editor.value, '==源== ==甲== ==乙== 丙');
  fixture.plugin.unload();
  assert(fixture.plugin.domRegistrations.every(record => !record.active));
});

test('显式链接无法解析时不猜测为当前笔记的视频', async context => {
  const fixture = await createFixture('00:10 [[不存在的笔记]]'); context.after(() => fixture.close());
  const current = fixture.addCurrentVideo(2);
  await assert.rejects(fixture.run('seek-video'));
  assert.equal(current.currentTime, 2);
});

test('链接笔记有多个播放器时整批拒绝，不先修改其中一个播放器', async context => {
  const fixture = await createFixture('00:10 [[目标笔记]]'); context.after(() => fixture.close());
  const videos = fixture.addVideoView('目标笔记.md', [3, 4]);
  fixture.resolveNote('目标笔记', '目标笔记.md');
  await assert.rejects(fixture.run('seek-video'), /多个视频/);
  assert.deepEqual(videos.map(video => video.currentTime), [3, 4]);
});

test('当前行没有链接时仅控制当前笔记中的唯一播放器', async context => {
  const fixture = await createFixture('00:10'); context.after(() => fixture.close());
  const current = fixture.addCurrentVideo(2);
  const [other] = fixture.addVideoView('无关笔记.md', [4]);
  await fixture.run('seek-video');
  assert.equal(current.currentTime, 10); assert.equal(other!.currentTime, 4);
  assert.equal(fixture.linkLookups.length, 0);
});

test('目标视频加载期间切换笔记会取消跳转和播放', async context => {
  const fixture = await createFixture('00:10 [[目标]]'); context.after(() => fixture.close());
  fixture.resolveNote('目标', '目标.md'); fixture.prepareUnopenedVideo('目标.md', [3]);
  const waiting = deferred<void>();
  const getLeaf = fixture.app.workspace.getLeaf;
  fixture.app.workspace.getLeaf = () => {
    const leaf = getLeaf(); const openFile = leaf.openFile;
    leaf.openFile = async file => { await waiting.promise; await openFile(file); };
    return leaf;
  };
  const pending = fixture.run('seek-video');
  fixture.switchNote(new FixtureEditor('另一篇正文'));
  waiting.resolve();
  await assert.rejects(pending, /已取消/);
  const video = fixture.app.workspace.getLeavesOfType('markdown').at(-1)!.view.containerEl.querySelector('video')!;
  assert.equal(video.currentTime, 3);
  assert.equal(video.getAttribute('data-played'), null);
});

test('浏览器拒绝播放时保留定位结果，不误报播放成功', async context => {
  const fixture = await createFixture('00:10'); context.after(() => fixture.close());
  const video = fixture.addCurrentVideo(2);
  Object.defineProperty(video, 'play', { value: async () => { throw new Error('NotAllowedError'); } });
  await fixture.run('seek-video');
  assert.equal(video.currentTime, 10);
  const notices = (globalThis as unknown as { __editingNotices: string[] }).__editingNotices;
  assert.match(notices.at(-1)!, /手动播放/);
});
