import { FuzzySuggestModal, MarkdownView, Menu, Modal, Notice, Platform, Plugin, Setting, TFile, normalizePath, type Editor } from 'obsidian';
import OpenCC from 'opencc-js';
import { HeadingKeyScope } from './heading-keys';
import { applyEdits, inlineCodeRanges, protectedLines, selectedRanges, snapshot, transformEditor, transformLines, unchanged, type TextEdit } from './editor-tools';
import { EditingSettingTab, parseSettings, renderEditingSettings, type EditingSettings } from './settings';
import { cycleTask, setColor, smartSymbol, stripMarkdown, toggleCodeBlock, toggleHeading, toggleWikiLinks, toggleWrapper } from './transforms';
import { applyBrushFormat, captureBrushFormat, expandBrushRange, type BrushFormat } from './format-brush';
import { hotkeyLabel, REFERENCE_SHORTCUTS } from './reference-shortcuts';
import { parseCustomHotkeys } from './custom-hotkeys';
import { calculateArithmetic, clearHeading, foldHeadingLevel, jumpToSimilar } from './legacy-editing';
import { adjustBlankLines, autoHeadings, chineseSpacing, convertPunctuation, extractAnnotations, fixMarkdown, htmlTableToMarkdown, joinSoftLines, parseTimestamp, stripSpaces, transformProse, tsvToMarkdown } from './text-tools';

interface Tool { id: string; name: string; group: string; run: (editor: Editor) => void | Promise<void> }

class ToolPicker extends FuzzySuggestModal<Tool> {
  constructor(private plugin: EditingPlugin, private tools: Tool[]) { super(plugin.app); this.setPlaceholder('搜索编辑功能…'); }
  getItems(): Tool[] { return this.tools; }
  getItemText(tool: Tool): string { return `${tool.group} · ${tool.name}`; }
  onChooseItem(tool: Tool): void { this.plugin.execute(tool); }
}

export default class EditingPlugin extends Plugin {
  settings: EditingSettings = parseSettings(undefined);
  private tools: Tool[] = [];
  private brush: BrushFormat | null = null;
  private brushMode: 'off' | 'once' | 'continuous' = 'off';
  private status?: HTMLElement;
  private disposed = false;
  private saveQueue: Promise<void> = Promise.resolve();
  private headingKeyScope?: HeadingKeyScope;
  private customHotkeys: ReturnType<typeof parseCustomHotkeys> = () => true;
  private customHotkeyStamp?: string;
  private readingCustomHotkeys = false;

  async onload(): Promise<void> {
    this.settings = parseSettings(await this.loadData());
    await this.refreshCustomHotkeys();
    this.defineTools();
    // 快捷键只在正文作用域生效；可从命令面板执行或在宿主中手动绑定这些命令。
    for (const tool of this.tools) this.addCommand({ id: tool.id, name: tool.name, editorCallback: editor => { this.execute(tool, editor); } });
    this.addCommand({ id: 'open-menu', name: '打开编辑工具菜单', callback: () => { new ToolPicker(this, this.tools).open(); } });
    this.addCommand({ id: 'open-settings', name: '打开编辑设置', callback: () => { this.openSettings(); } });
    this.addCommand({ id: 'hotkey-guide', name: '查看快捷键配置', callback: () => { this.openHotkeys(); } });
    this.addSettingTab(new EditingSettingTab(this.app, this));
    const headingKeyScope = new HeadingKeyScope(this.app, () => this.settings.headingKeys, (editor, level) => {
      transformLines(editor, line => toggleHeading(line, level));
    }, () => this.settings.referenceShortcuts, (editor, id) => {
      const tool = this.tools.find(candidate => candidate.id === id);
      if (tool) this.execute(tool, editor);
    }, (id, hotkey) => this.customHotkeys(id, hotkey));
    this.headingKeyScope = headingKeyScope;
    this.registerEditorExtension(headingKeyScope.extension);
    this.register(() => { headingKeyScope.destroy(); this.headingKeyScope = undefined; });
    this.registerInterval(window.setInterval(() => { void this.refreshCustomHotkeys(); }, 2000));
    this.addRibbonIcon('text-cursor-input', 'yuhanbo-editing', () => { new ToolPicker(this, this.tools).open(); });
    const status = this.addStatusBarItem();
    this.status = status;
    status.setText('yuhanbo-editing');
    status.addClass('yuhanbo-editing-status');
    this.registerDomEvent(status, 'click', event => { this.showMenu(event); });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => { menu.addItem(item => item.setTitle('yuhanbo-editing…').setIcon('text-cursor-input').onClick(() => { editor.focus(); new ToolPicker(this, this.tools).open(); })); }));
    this.registerEvent(this.app.workspace.on('editor-paste', (event, editor) => {
      if (!this.settings.pasteTables || event.defaultPrevented || !event.clipboardData) return;
      try { this.guard(editor); } catch { return; }
      try {
        const html = event.clipboardData.getData('text/html');
        const text = event.clipboardData.getData('text/plain');
        const result = /<table\b/i.test(html) ? htmlTableToMarkdown(html, activeDocument) : text.includes('\t') ? tsvToMarkdown(text) : null;
        if (result !== null) { event.preventDefault(); this.insert(editor, result); }
      } catch (error) { new Notice(this.errorText(error)); }
    }));
    const bindDocument = (document: Document): void => {
      this.registerDomEvent(document, 'keydown', event => {
        if (event.key === 'Escape' && this.brushMode !== 'off') this.stopBrush();
        this.extraEnter(event);
      }, true);
      this.registerDomEvent(document, 'pointerup', event => { this.paintSelection(event); });
    };
    bindDocument(activeDocument);
    this.registerEvent(this.app.workspace.on('window-open', (_window, win) => { bindDocument(win.document); }));
  }

  onunload(): void { this.disposed = true; this.brush = null; this.brushMode = 'off'; }

  saveSettings(): Promise<void> {
    this.headingKeyScope?.refresh();
    const value = structuredClone(this.settings);
    this.saveQueue = this.saveQueue.catch(() => undefined).then(async () => { await this.saveData(value); });
    return this.saveQueue;
  }

  private async refreshCustomHotkeys(): Promise<void> {
    if (this.readingCustomHotkeys || this.disposed) return;
    this.readingCustomHotkeys = true;
    try {
      // 隐藏配置文件由库的 Adapter 只读访问，仅在文件变动时重新解析自定义键。
      const { adapter, configDir } = this.app.vault;
      const path = normalizePath(`${configDir}/hotkeys.json`);
      const stat = await adapter.stat(path);
      const stamp = stat ? `${stat.mtime}:${stat.size}` : 'missing';
      if (stamp === this.customHotkeyStamp) return;
      this.customHotkeys = parseCustomHotkeys(stat ? await adapter.read(path) : '{}', this.manifest.id, Platform.isMacOS);
      this.customHotkeyStamp = stamp;
    } catch {
      // 配置暂不可读时交还宿主处理，避免抢占尚未识别到的自定义键。
      this.customHotkeys = () => true;
      this.customHotkeyStamp = undefined;
    } finally {
      this.readingCustomHotkeys = false;
      if (!this.disposed) this.headingKeyScope?.refresh();
    }
  }

  execute(tool: Tool, editor?: Editor): void {
    const active = editor ?? this.app.workspace.getActiveViewOfType(MarkdownView)?.editor;
    if (!active) { new Notice('请先打开 Markdown 笔记的编辑视图。'); return; }
    try { Promise.resolve(tool.run(active)).catch(error => { new Notice(this.errorText(error)); }); }
    catch (error) { new Notice(this.errorText(error)); }
  }

  private errorText(error: unknown): string { return error instanceof Error ? error.message : '编辑操作失败，请重试。'; }

  private defineTools(): void {
    const add = (id: string, name: string, group: string, run: Tool['run']): void => { this.tools.push({ id, name, group, run }); };
    for (let level = 1; level <= 6; level++) add(`heading-${level}`, `切换 ${level} 级标题`, '标题', editor => { transformLines(editor, line => toggleHeading(line, level)); });
    add('heading-clear', '取消标题', '标题', editor => { transformLines(editor, clearHeading); });
    add('fold-heading-level', '折叠当前同级标题（先展开现有折叠）', '标题', foldHeadingLevel);
    const wrappers: Array<[string, string, string, string]> = [
      ['bold', '粗体', '**', '**'], ['italic', '斜体', '_', '_'], ['inline-code', '行内代码', '`', '`'], ['strike', '删除线', '~~', '~~'],
      ['highlight', '高亮', '==', '=='], ['comment', '注释', '%%', '%%'], ['underline', '下划线', '<u>', '</u>'], ['superscript', '上标', '<sup>', '</sup>'],
      ['subscript', '下标', '<sub>', '</sub>'], ['cloze', '挖空', '{{c1::', '}}'], ['bracket-square', '方头括号', '【', '】'],
      ['bracket-round', '中文圆括号', '（', '）'], ['bracket-quote', '直角引号', '「', '」'], ['bracket-book', '书名号', '《', '》'],
    ];
    for (const [id, name, open, close] of wrappers) add(id, `切换${name}`, '格式', editor => { this.wrap(editor, open, close); });
    add('code-block', '切换代码块', '格式', editor => { this.codeBlock(editor); });
    add('task-cycle', '轮换待办状态', '格式', editor => { transformLines(editor, line => cycleTask(line, [...this.settings.taskStates])); });
    add('wiki-link', '切换内部链接', '链接', editor => { this.wiki(editor, false); });
    add('wiki-alias', '转为别名内部链接', '链接', editor => { this.wiki(editor, true); });
    add('link-known-notes', '将已知笔记名批量转换为内链', '链接', editor => { this.linkKnownNotes(editor); });
    add('smart-symbol', '智能补全或跳过符号', '格式', editor => { this.symbol(editor); });
    for (let i = 0; i < 5; i++) {
      add(`text-color-${i + 1}`, `切换文字颜色 ${i + 1}`, '颜色', editor => { this.color(editor, this.settings.textColors[i]!, false); });
      add(`background-color-${i + 1}`, `切换背景颜色 ${i + 1}`, '颜色', editor => { this.color(editor, this.settings.backgroundColors[i]!, true); });
    }
    add('strip-markdown', '转换为无格式文本', '整理', editor => { this.prose(editor, stripMarkdown); });
    add('copy-plain-text', '复制无格式文本', '剪贴板', async editor => { await navigator.clipboard.writeText(stripMarkdown(editor.getSelection() || editor.getValue())); new Notice('已复制无格式文本。'); });
    add('punctuation-zh', '英文标点转中文', '中文', editor => { this.prose(editor, text => convertPunctuation(text, 'zh')); });
    add('punctuation-en', '中文标点转英文', '中文', editor => { this.prose(editor, text => convertPunctuation(text, 'en')); });
    // 转换器延迟创建，插件启动不构造词典索引。
    let toTraditional: ((text: string) => string) | undefined;
    let toSimplified: ((text: string) => string) | undefined;
    add('to-traditional', '简体转繁体', '中文', editor => { toTraditional ??= OpenCC.Converter({ from: 'cn', to: 't' }); this.prose(editor, text => transformProse(text, toTraditional!)); });
    add('to-simplified', '繁体转简体', '中文', editor => { toSimplified ??= OpenCC.Converter({ from: 't', to: 'cn' }); this.prose(editor, text => transformProse(text, toSimplified!)); });
    add('path-link', '切换本地路径链接', '链接', editor => { transformEditor(editor, 'selection', text => this.pathLink(text)); });
    add('smart-paste', '智能粘贴表格', '剪贴板', async editor => { await this.smartPaste(editor); });
    add('fix-markdown', '修复常见 Markdown 语法', '整理', editor => { this.prose(editor, fixMarkdown); });
    add('join-soft-lines', '合并意外断行', '整理', editor => { this.prose(editor, joinSoftLines); });
    add('find-selection', '在当前笔记查找选文', '导航', editor => { this.findSelection(editor); });
    for (const [id, name, command] of [
      ['cursor-up', '光标上移', 'goUp'], ['cursor-down', '光标下移', 'goDown'],
      ['cursor-left', '光标左移', 'goLeft'], ['cursor-right', '光标右移', 'goRight'],
      ['cursor-line-start', '光标移至行首', 'goStart'], ['cursor-line-end', '光标移至行尾', 'goEnd'],
    ] as const) add(id, name, '导航', editor => { editor.exec(command); });
    add('sibling-prev', '打开同文件夹上一笔记', '导航', async editor => { await this.openSibling(editor, -1); });
    add('sibling-next', '打开同文件夹下一笔记', '导航', async editor => { await this.openSibling(editor, 1); });
    add('jump-prev', '向上跳到同类内容', '导航', editor => { jumpToSimilar(editor, -1); });
    add('jump-next', '向下跳到同类内容', '导航', editor => { jumpToSimilar(editor, 1); });
    add('seek-video', '按当前行时间跳转并播放视频', '导航', async editor => { await this.seekVideo(editor); });
    add('extract-annotations', '提取标注到剪贴板', '剪贴板', async editor => { const result = extractAnnotations(editor.getSelection() || editor.getValue()); await navigator.clipboard.writeText(result); new Notice(result ? '已复制标注文本。' : '未找到标注。'); });
    add('select-paragraph', '选择当前整段', '选择', editor => { this.selectParagraph(editor); });
    add('select-sentence', '选择当前整句', '选择', editor => { this.selectSentence(editor); });
    add('auto-headings', '自动识别短行标题', '标题', editor => { this.prose(editor, text => autoHeadings(text, this.settings.autoHeadingLevel)); });
    add('rename-from-selection', '用选文重命名当前笔记', '文件', editor => { this.renameFromSelection(editor); });
    add('embed-url', '嵌入选中的网页网址', '链接', editor => { this.embedUrl(editor); });
    add('copy-relative-path', '复制当前笔记相对路径', '剪贴板', async () => { const file = this.app.workspace.getActiveFile(); if (!file) throw new Error('没有活动笔记。'); await navigator.clipboard.writeText(file.path); new Notice('已复制库内相对路径。'); });
    add('blank-lines-add', '批量插入空行', '空白', editor => { this.prose(editor, text => adjustBlankLines(text, 'add')); });
    add('blank-lines-remove', '批量去除空行', '空白', editor => { this.prose(editor, text => adjustBlankLines(text, 'remove')); });
    add('blank-line-above', '当前行上方插入空行', '空白', editor => { const pos = { line: editor.getCursor().line, ch: 0 }; const from = editor.posToOffset(pos); applyEdits(editor, [{ from, to: from, text: '\n' }]); });
    add('blank-line-below', '当前行下方插入空行', '空白', editor => { const line = editor.getCursor().line; const from = editor.posToOffset({ line, ch: editor.getLine(line).length }); applyEdits(editor, [{ from, to: from, text: '\n', cursor: 1 }]); });
    add('blank-line-visible', '插入可渲染空行', '空白', editor => {
      this.guard(editor);
      applyEdits(editor, selectedRanges(editor, 'selection').filter(range => range.from === range.to).map(range => ({ ...range, text: '\u3000\n', cursor: 2 })));
    });
    add('hard-breaks', '每行末尾追加两个空格', '空白', editor => { transformLines(editor, line => line.trim() ? line.replace(/[ \t]+$/, '') + '  ' : line, true); });
    add('trim-trailing-spaces', '去除每行末尾空格', '空白', editor => { transformLines(editor, line => line.replace(/[ \t]+$/, ''), true); });
    add('chinese-spacing', '添加中英文间距', '空白', editor => { this.prose(editor, chineseSpacing); });
    add('strip-spaces', '去除正文全半角空格', '空白', editor => { this.prose(editor, stripSpaces); });
    add('calculate-selection', '计算选文或统计字符', '剪贴板', async editor => {
      const selected = editor.getSelection();
      const result = calculateArithmetic(selected);
      if (result === undefined) { new Notice(`选文共 ${[...selected].length} 个字符。`); return; }
      await navigator.clipboard.writeText(String(result));
      new Notice(`结果 ${result} 已复制。`);
    });
    add('brush-copy', '复制选文格式', '格式刷', editor => { this.copyBrush(editor); new Notice('已复制格式，选择目标后执行「应用已复制格式」。'); });
    add('brush-apply', '应用已复制格式', '格式刷', editor => { this.applyBrush(editor); });
    add('brush-once', '开启一次格式刷（选中源文字后执行）', '格式刷', editor => { this.startBrush(editor, 'once'); });
    add('brush-continuous', '开启连续格式刷（Esc 退出）', '格式刷', editor => { this.startBrush(editor, 'continuous'); });
    this.addCommand({ id: 'brush-stop', name: '关闭格式刷', callback: () => { this.stopBrush(); } });
  }

  private async openSibling(editor: Editor, step: -1 | 1): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    if (!view || view.editor !== editor || !file?.parent) return;
    const notes = file.parent.children.filter((entry): entry is TFile => entry instanceof TFile && entry.extension === 'md');
    notes.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    const index = notes.indexOf(file);
    if (index < 0 || notes.length < 2) return;
    await view.leaf.openFile(notes[(index + step + notes.length) % notes.length]!);
  }

  private copyBrush(editor: Editor): void {
    this.guard(editor);
    const range = selectedRanges(editor, 'selection')[0]!;
    const original = editor.getValue();
    // 实时预览会隐藏语法符号；向外识别紧邻选文的合法包装，才能复制看得见的样式。
    const text = expandBrushRange(original, range.from, range.to).text;
    const line = editor.getLine(editor.getCursor('from').line);
    const heading = /^ {0,3}(#{1,6})[ \t]+/.exec(line)?.[1]?.length;
    const format = captureBrushFormat(text || line);
    this.brush = format ?? (heading ? { heading, wrappers: [] } : null);
    if (this.brush && heading) this.brush.heading = heading;
    if (!this.brush) throw new Error('未识别到格式，请选择带有标题、颜色或成对语法的源文字。');
  }

  private applyBrush(editor: Editor): void {
    if (!this.brush) throw new Error('请先复制一段文字的格式。');
    this.guard(editor);
    const format = this.brush;
    if (format.heading) transformLines(editor, line => applyBrushFormat(line, format));
    else {
      const source = editor.getValue();
      const edits = selectedRanges(editor, 'selection').map(range => {
        const expanded = expandBrushRange(source, range.from, range.to);
        return { from: expanded.from, to: expanded.to, text: applyBrushFormat(expanded.text, format) };
      });
      applyEdits(editor, [...new Map(edits.map(edit => [`${edit.from}:${edit.to}`, edit])).values()]);
    }
  }

  private startBrush(editor: Editor, mode: 'once' | 'continuous'): void {
    this.copyBrush(editor); this.brushMode = mode; this.updateBrushStatus();
    new Notice(mode === 'once' ? '一次格式刷已开启，请用鼠标选中目标文字。Esc 取消。' : '连续格式刷已开启，可依次选择目标文字。Esc 退出。');
  }

  private stopBrush(): void { this.brushMode = 'off'; this.updateBrushStatus(); }
  private updateBrushStatus(): void {
    this.status?.setText(this.brushMode === 'off' ? 'yuhanbo-editing' : `yuhanbo-editing · ${this.brushMode === 'once' ? '一次格式刷' : '连续格式刷'}`);
    this.status?.classList.toggle('yuhanbo-editing-brush-active', this.brushMode !== 'off');
  }

  private paintSelection(event: PointerEvent): void {
    if (this.brushMode === 'off' || event.button !== 0 || this.disposed) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const target = event.target as Element | null;
    if (!view || !target?.closest?.('.cm-content') || !view.containerEl.contains(target) || !view.editor.hasFocus() || !view.editor.somethingSelected()) return;
    try { this.applyBrush(view.editor); if (this.brushMode === 'once') this.stopBrush(); }
    catch (error) { this.stopBrush(); new Notice(this.errorText(error)); }
  }

  private guard(editor: Editor): void {
    const excluded = protectedLines(editor.getValue());
    for (const range of selectedRanges(editor, 'selection')) {
      const start = editor.offsetToPos(range.from), end = editor.offsetToPos(range.to);
      for (let line = start.line; line <= end.line; line++) {
        if (line === end.line && end.ch === 0 && line > start.line) break;
        if (excluded.has(line)) throw new Error('此操作不会修改 YAML 或代码区域，请先选择正文。');
        const base = editor.posToOffset({ line, ch: 0 });
        for (const code of inlineCodeRanges(editor.getLine(line))) {
          const from = base + code.from, to = base + code.to;
          const overlaps = range.from === range.to ? range.from > from && range.from < to : range.from < to && range.to > from;
          if (overlaps && !(range.from <= from && range.to >= to)) throw new Error('选区位于行内代码中，请选择完整代码或正文。');
        }
      }
    }
  }

  private prose(editor: Editor, transform: (text: string) => string): void {
    const ranges = selectedRanges(editor, 'selection');
    if (ranges.some(range => range.from !== range.to)) this.guard(editor);
    transformEditor(editor, 'selection-or-document', transform);
  }

  private wrap(editor: Editor, open: string, close: string): void {
    this.guard(editor);
    const original = editor.getValue();
    applyEdits(editor, selectedRanges(editor, 'selection').map(range => {
      let { from, to } = range;
      const text = original.slice(from, to);
      if (from !== to && original.slice(from - open.length, from) === open && original.slice(to, to + close.length) === close) { from -= open.length; to += close.length; return { from, to, text, selectionMap: { oldFrom: open.length, oldTo: open.length + text.length, newFrom: 0, newTo: text.length } }; }
      const next = toggleWrapper(text, open, close);
      const bodyAt = next.indexOf(text);
      return { from, to, text: next, ...(from === to ? { cursor: open.length } : bodyAt >= 0 && next !== text ? { selectionMap: { oldFrom: 0, oldTo: text.length, newFrom: bodyAt, newTo: bodyAt + text.length } } : {}) };
    }));
  }

  private color(editor: Editor, color: string, background: boolean): void {
    this.guard(editor);
    const original = editor.getValue();
    applyEdits(editor, selectedRanges(editor, 'selection').map(range => {
      let { from, to } = range;
      // 实时预览通常只选中 span 内正文；识别相邻、同类颜色包装，避免每次改色都嵌套。
      const opening = /<span\s+style="\s*(color|background-color)\s*:\s*#[0-9a-f]{6}\s*;?\s*">$/i.exec(original.slice(0, from));
      if (opening && opening[1]?.toLowerCase() === (background ? 'background-color' : 'color') && original.slice(to, to + 7) === '</span>') { from -= opening[0].length; to += 7; }
      const text = original.slice(from, to);
      const next = setColor(text, color, background);
      const oldOpening = /^<span style="(?:color|background-color):\s*#[0-9a-f]{6};?">/i.exec(text)?.[0];
      const oldFrom = oldOpening?.length ?? 0;
      const oldTo = oldOpening ? text.length - 7 : text.length;
      const body = text.slice(oldFrom, oldTo);
      const nextFrom = next === body ? 0 : next.indexOf('>') + 1;
      return { from, to, text: next, selectionMap: { oldFrom, oldTo, newFrom: nextFrom, newTo: nextFrom + body.length } };
    }));
  }

  private codeBlock(editor: Editor): void {
    const original = editor.getValue();
    const excluded = protectedLines(original);
    const ranges = selectedRanges(editor, 'lines');
    const edits: TextEdit[] = [];
    for (const range of ranges) {
      const text = original.slice(range.from, range.to);
      const firstLine = editor.offsetToPos(range.from).line;
      const lastLine = editor.offsetToPos(range.to).line;
      const next = toggleCodeBlock(text);
      const removesFence = next.length < text.length;
      if (!removesFence && [...excluded].some(line => line >= firstLine && line <= lastLine)) throw new Error('请选中完整代码块（含首尾围栏）后取消代码块；不会在已有代码块内部再插入围栏。');
      const prefix = next.indexOf('\n') + 1;
      edits.push({ ...range, text: next, ...(!removesFence ? { selectionMap: { oldFrom: 0, oldTo: text.length, newFrom: prefix, newTo: prefix + text.length } } : {}) });
    }
    applyEdits(editor, edits);
  }

  private wiki(editor: Editor, alias: boolean): void {
    this.guard(editor);
    const original = editor.getValue();
    const edits = selectedRanges(editor, 'selection').map(range => {
      if (range.from === range.to) {
        const linePos = editor.offsetToPos(range.from);
        const line = editor.getLine(linePos.line);
        for (const match of line.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
          if (match.index < linePos.ch && match.index + match[0].length > linePos.ch) { const from = editor.posToOffset({ line: linePos.line, ch: match.index }); return { from, to: from + match[0].length, text: toggleWikiLinks(match[0], alias) }; }
        }
      }
      return { ...range, text: toggleWikiLinks(original.slice(range.from, range.to), alias), ...(range.from === range.to ? { cursor: 2 } : {}) };
    });
    applyEdits(editor, [...new Map(edits.map(edit => [`${edit.from}:${edit.to}`, edit])).values()]);
  }

  private symbol(editor: Editor): void {
    this.guard(editor);
    const edits: TextEdit[] = [];
    for (const range of selectedRanges(editor, 'selection')) {
      if (range.from !== range.to) throw new Error('智能符号适用于光标位置，请先取消选区。');
      const pos = editor.offsetToPos(range.from);
      const line = editor.getLine(pos.line);
      const result = smartSymbol(line.slice(0, pos.ch), line.slice(pos.ch));
      const base = editor.posToOffset({ line: pos.line, ch: 0 });
      const next = result.before + result.after;
      let prefix = 0, suffix = 0;
      while (prefix < Math.min(line.length, next.length) && line[prefix] === next[prefix]) prefix++;
      while (suffix < Math.min(line.length, next.length) - prefix && line[line.length - suffix - 1] === next[next.length - suffix - 1]) suffix++;
      // 只提交局部变化，同一行的多个光标互不覆盖；无正文变化时只移动对应光标。
      if (next === line) edits.push({ from: range.from, to: range.to, text: '', cursor: result.before.length - pos.ch });
      else edits.push({ from: base + prefix, to: base + line.length - suffix, text: next.slice(prefix, next.length - suffix), cursor: result.before.length - prefix });
    }
    applyEdits(editor, edits);
  }

  private insert(editor: Editor, text: string): void {
    applyEdits(editor, selectedRanges(editor, 'selection').map(range => ({ ...range, text, cursor: text.length })));
  }

  private async smartPaste(editor: Editor): Promise<void> {
    const saved = snapshot(editor);
    const activeFile = this.app.workspace.getActiveFile();
    const activePath = activeFile?.path;
    let html = '', text = '';
    try {
      for (const item of await navigator.clipboard.read()) {
        if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
        if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
    } catch { text = await navigator.clipboard.readText(); }
    // 剪贴板读取可能弹出系统授权并等待；用户切换笔记、移动光标或卸载后必须取消写入。
    if (this.disposed || this.app.workspace.getActiveViewOfType(MarkdownView)?.editor !== editor || this.app.workspace.getActiveFile() !== activeFile || activeFile?.path !== activePath || !unchanged(editor, saved)) throw new Error('笔记或选区已变化，本次粘贴已取消。');
    const result = /<table\b/i.test(html) ? htmlTableToMarkdown(html, activeDocument) : text.includes('\t') ? tsvToMarkdown(text) : text;
    if (!result) throw new Error('剪贴板中没有可粘贴的文本或表格。');
    this.insert(editor, result);
  }

  private linkKnownNotes(editor: Editor): void {
    const counts = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles()) counts.set(file.basename, (counts.get(file.basename) ?? 0) + 1);
    const names = [...counts].filter(([name, count]) => count === 1 && name.length >= 2 && !/[<>:"/\\|?*[\]]/.test(name)).map(([name]) => name).sort((a, b) => b.length - a.length);
    if (!names.length) throw new Error('没有可安全匹配的唯一笔记名。');
    const pattern = new RegExp(names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gu');
    this.prose(editor, text => transformProse(text, segment => segment.replace(pattern, (name: string, offset: number, source: string) => {
      const previous = source[offset - 1] ?? '';
      const next = source[offset + name.length] ?? '';
      if (/^[A-Za-z0-9]/.test(name) && /[A-Za-z0-9_]/.test(previous) || /[A-Za-z0-9]$/.test(name) && /[A-Za-z0-9_]/.test(next)) return name;
      return `[[${name}]]`;
    })));
  }

  private pathLink(text: string): string {
    const link = /^\[[^\]]*\]\((file:\/\/\/[^)]+)\)$/.exec(text.trim());
    if (link?.[1]) { const url = new URL(link[1]); const path = decodeURIComponent(url.pathname); return /^\/[A-Za-z]:\//.test(path) ? path.slice(1).replace(/\//g, '\\') : path; }
    const path = text.trim();
    if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(path) || /[\r\n]/.test(path)) throw new Error('请选中完整本地绝对路径或 file 链接。');
    const normalized = path.replace(/\\/g, '/');
    return `[${path.replace(/[[\]]/g, '\\$&')}](file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized).replace(/[()#?]/g, char => '%' + char.charCodeAt(0).toString(16))})`;
  }

  private selectParagraph(editor: Editor): void {
    let start = editor.getCursor().line, end = start;
    if (!editor.getLine(start).trim()) { editor.setSelection({ line: start, ch: 0 }, { line: start, ch: editor.getLine(start).length }); return; }
    while (start > 0 && editor.getLine(start - 1).trim()) start--;
    while (end < editor.lastLine() && editor.getLine(end + 1).trim()) end++;
    editor.setSelection({ line: start, ch: 0 }, { line: end, ch: editor.getLine(end).length });
  }

  private selectSentence(editor: Editor): void {
    const pos = editor.getCursor();
    const line = editor.getLine(pos.line);
    const ends = /[。！？!?；;]/;
    let start = Math.min(pos.ch, Math.max(0, line.length - 1)), end = start;
    while (start > 0 && !ends.test(line[start - 1]!)) start--;
    while (end < line.length && !ends.test(line[end]!)) end++;
    if (end < line.length) end++;
    editor.setSelection({ line: pos.line, ch: start }, { line: pos.line, ch: end });
  }

  private findSelection(editor: Editor): void {
    const query = editor.getSelection();
    if (!query) throw new Error('请先选中需要查找的文字。');
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.editor !== editor) throw new Error('请先激活选文所在的笔记。');
    // 保留选区并聚焦原编辑器，让宿主查找面板使用当前选文，而不是另建插件搜索窗口。
    editor.focus(); view.showSearch();
  }

  private async seekVideo(editor: Editor): Promise<void> {
    const line = editor.getLine(editor.getCursor().line);
    const seconds = parseTimestamp(line);
    if (seconds === null) throw new Error('当前行没有有效的分:秒或时:分:秒时间。');
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const sourceFile = view?.file;
    const saved = snapshot(editor);
    const sourcePath = view?.file?.path ?? '';
    const linkedNotes = new Set<string>();
    const destinations = new Map<string, NonNullable<ReturnType<typeof this.app.metadataCache.getFirstLinkpathDest>>>();
    let hasExplicitLink = false;
    for (const match of line.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)) {
      hasExplicitLink = true;
      const target = this.app.metadataCache.getFirstLinkpathDest(match[1]!, sourcePath);
      if (target?.extension === 'md') { linkedNotes.add(target.path); destinations.set(target.path, target); }
    }
    if (hasExplicitLink && !linkedNotes.size) throw new Error('当前行链接没有指向可解析的笔记，未改动任何播放器。');
    // 仅处理当前行明确链接的目标；唯一目标尚未打开时，在侧边阅读视图加载。
    const views = linkedNotes.size ? this.app.workspace.getLeavesOfType('markdown').map(leaf => leaf.view).filter((candidate): candidate is MarkdownView => candidate instanceof MarkdownView && !!candidate.file && linkedNotes.has(candidate.file.path)) : view ? [view] : [];
    let videos = views.flatMap(candidate => Array.from(candidate.containerEl.querySelectorAll('video')));
    if (!videos.length && destinations.size === 1) {
      const target = [...destinations.values()][0]!;
      let targetView = views[0];
      if (!targetView) {
        const leaf = this.app.workspace.getLeaf('split');
        await leaf.openFile(target, { active: false, state: { mode: 'preview' } });
        if (!(leaf.view instanceof MarkdownView)) throw new Error('链接笔记未能打开为 Markdown 视图。');
        targetView = leaf.view;
      }
      videos = await this.waitForVideos(targetView.containerEl);
    }
    if (this.disposed || this.app.workspace.getActiveFile() !== sourceFile || sourceFile?.path !== sourcePath || !unchanged(editor, saved)) throw new Error('笔记或选区已变化，本次视频跳转已取消。');
    if (!videos.length) throw new Error('没有可控制的视频；请确认目标笔记包含已加载的原生视频。');
    if (videos.length > 1) throw new Error('当前笔记包含多个视频，请先只保留需要跳转的视频。');
    const video = videos[0]!;
    if (Number.isFinite(video.duration) && seconds > video.duration) throw new Error('时间超过视频长度。');
    video.currentTime = seconds;
    try { await video.play(); new Notice(`已跳转至 ${seconds} 秒并播放。`); }
    catch { new Notice(`已跳转至 ${seconds} 秒，浏览器未允许自动播放，请手动播放。`); }
  }

  private waitForVideos(container: HTMLElement): Promise<HTMLVideoElement[]> {
    const read = (): HTMLVideoElement[] => Array.from(container.querySelectorAll('video'));
    const existing = read();
    if (existing.length) return Promise.resolve(existing);
    const win = container.ownerDocument.defaultView;
    if (!win) return Promise.resolve([]);
    return new Promise(resolve => {
      const observer = new win.MutationObserver(() => { const videos = read(); if (videos.length) finish(videos); });
      const finish = (videos: HTMLVideoElement[]): void => { observer.disconnect(); win.clearTimeout(timer); resolve(videos); };
      const timer = win.setTimeout(() => { finish(read()); }, 3000);
      observer.observe(container, { childList: true, subtree: true });
    });
  }

  private renameFromSelection(editor: Editor): void {
    const file = this.app.workspace.getActiveFile();
    const name = editor.getSelection().trim().replace(/\.md$/i, '');
    if (!file || !name || name.length > 180 || /[<>:"/\\|?*\r\n]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || name === '.' || name === '..') throw new Error('请选中适合用作文件名的单行文字。');
    const path = normalizePath((file.parent?.path ? file.parent.path + '/' : '') + name + '.md');
    if (path === file.path) return;
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error('目标文件已存在，未覆盖。');
    const modal = new Modal(this.app); modal.setTitle('重命名当前笔记');
    modal.contentEl.createEl('p', { text: `${file.path} → ${path}` });
    new Setting(modal.contentEl).addButton(button => button.setButtonText('重命名').setCta().onClick(async () => {
      try { if (this.app.vault.getAbstractFileByPath(path)) throw new Error('目标已存在，未覆盖。'); await this.app.fileManager.renameFile(file, path); modal.close(); }
      catch (error) { new Notice(this.errorText(error)); }
    })); modal.open();
  }

  private embedUrl(editor: Editor): void {
    const url = new URL(editor.getSelection().trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持不含账号密码的 HTTP 或 HTTPS 网址。');
    const src = url.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const line = editor.getCursor('to').line;
    const from = editor.posToOffset({ line, ch: editor.getLine(line).length });
    applyEdits(editor, [{ from, to: from, text: `\n<iframe src="${src}" title="嵌入网页" width="100%" height="480" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy"></iframe>\n` }]);
  }

  private extraEnter(event: KeyboardEvent): void {
    if (!this.settings.extraEnter || event.key !== 'Enter' || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.defaultPrevented) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !event.target || !(event.target as Node).instanceOf(Node) || !view.containerEl.contains(event.target as Node) || !view.editor.hasFocus()) return;
    const editor = view.editor;
    if (editor.listSelections().length !== 1 || editor.somethingSelected()) return;
    const pos = editor.getCursor();
    const line = editor.getLine(pos.line);
    if (!line.trim() || pos.ch !== line.length || protectedLines(editor.getValue()).has(pos.line) || /^\s*(?:>|[-+*]\s|\d+[.)]\s|\||#{1,6}\s)/.test(line)) return;
    event.preventDefault(); this.insert(editor, '\n\n');
  }

  private showMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(item => item.setTitle('搜索全部编辑命令…').setIcon('search').onClick(() => { new ToolPicker(this, this.tools).open(); }));
    for (const id of ['brush-once', 'brush-continuous']) {
      const tool = this.tools.find(candidate => candidate.id === id)!;
      menu.addItem(item => item.setTitle(tool.name).setIcon('paintbrush').onClick(() => { this.execute(tool); }));
    }
    if (this.brushMode !== 'off') menu.addItem(item => item.setTitle('关闭格式刷').setIcon('square').onClick(() => { this.stopBrush(); }));
    menu.addSeparator();
    for (const group of [...new Set(this.tools.map(tool => tool.group))]) menu.addItem(item => item.setTitle(group).onClick(() => { new ToolPicker(this, this.tools.filter(tool => tool.group === group)).open(); }));
    menu.addSeparator();
    menu.addItem(item => item.setTitle('编辑设置').setIcon('settings').onClick(() => { this.openSettings(); }));
    menu.addItem(item => item.setTitle('快捷键配置面板').setIcon('keyboard').onClick(() => { this.openHotkeys(); }));
    menu.showAtMouseEvent(event);
  }

  private openSettings(): void { const modal = new Modal(this.app); modal.setTitle('yuhanbo-editing设置'); renderEditingSettings(modal.contentEl, this); modal.open(); }
  openHotkeys(): void {
    const modal = new Modal(this.app); modal.setTitle('yuhanbo-editing 快捷键');
    const render = (): void => {
      modal.contentEl.empty();
      modal.contentEl.createEl('p', { text: '标题默认使用 Ctrl/Cmd+1～6。下列参考快捷键用于正文编辑，Obsidian 的自定义键位优先。可按需关闭个别按键或全部关闭。' });
      new Setting(modal.contentEl).setName('参考快捷键组').addButton(button => button.setButtonText('全部开启').onClick(async () => {
        this.settings.referenceShortcuts = REFERENCE_SHORTCUTS.map(binding => binding.id);
        try { await this.saveSettings(); render(); } catch { new Notice('快捷键保存失败，请重试。'); }
      })).addButton(button => button.setButtonText('全部关闭').onClick(async () => {
        this.settings.referenceShortcuts = [];
        try { await this.saveSettings(); render(); } catch { new Notice('快捷键保存失败，请重试。'); }
      }));
      for (const binding of REFERENCE_SHORTCUTS) new Setting(modal.contentEl).setName(binding.label).setDesc(hotkeyLabel(binding.hotkey, Platform.isMacOS) + (this.customHotkeys(binding.id, binding.hotkey) ? '（让出给宿主）' : '')).addToggle(toggle => toggle.setValue(this.settings.referenceShortcuts.includes(binding.id)).onChange(async enabled => {
        this.settings.referenceShortcuts = this.settings.referenceShortcuts.filter(id => id !== binding.id);
        if (enabled) this.settings.referenceShortcuts.push(binding.id);
        try { await this.saveSettings(); } catch { new Notice('快捷键保存失败，当前选择已保留，请重试。'); }
      }));
    };
    render(); modal.open();
  }
}
