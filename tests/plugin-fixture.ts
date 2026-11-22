import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import type { Editor, EditorPosition, EditorSelection, EditorTransaction, Hotkey } from 'obsidian';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 只替换宿主公开契约；被测入口及其设置、编辑器适配、转换算法均使用真实模块。 */
const HOST_STUB = String.raw`
import {StateField} from '@codemirror/state';
export const Platform={isMacOS:false};
export const editorInfoField=StateField.define({create:()=>({}),update:value=>value});
export class Scope { constructor(parent){this.parent=parent;this.keys=[];} register(modifiers,key,func){const handler={scope:this,modifiers,key,func};this.keys.push(handler);return handler;} unregister(handler){this.keys=this.keys.filter(candidate=>candidate!==handler);} }
export class Plugin {
  constructor(app, manifest) { this.app=app; this.manifest=manifest; this.commands=[]; this.cleanups=[]; this.domRegistrations=[]; this.editorExtensions=[]; }
  async loadData() { return this.app.pluginData; }
  async saveData(data) { this.app.savedData.push(structuredClone(data)); }
  addCommand(command) { this.commands.push(command); return command; }
  addSettingTab() {}
  addRibbonIcon() { return this.app.document.createElement('div'); }
  addStatusBarItem() { const element=this.app.document.createElement('div'); element.setText=text=>{element.textContent=text;}; element.addClass=name=>element.classList.add(name); return element; }
  registerDomEvent(element, type, callback, options) {
    element.addEventListener(type, callback, options);
    const record={element,type,active:true}; this.domRegistrations.push(record);
    this.cleanups.push(()=>{ element.removeEventListener(type, callback, options); record.active=false; });
  }
  registerEvent(reference) { this.cleanups.push(()=>reference.off()); }
  registerInterval(id) { this.cleanups.push(()=>window.clearInterval(id)); }
  register(callback) { this.cleanups.push(callback); }
  registerEditorExtension(extension) { this.editorExtensions.push(extension); this.cleanups.push(()=>{this.editorExtensions=this.editorExtensions.filter(candidate=>candidate!==extension);}); }
  unload() { this.onunload?.(); for(const cleanup of this.cleanups.splice(0).reverse()) cleanup(); }
}
export class PluginSettingTab { constructor(app, plugin) { this.app=app; this.plugin=plugin; this.containerEl=app.document.createElement('div'); } }
export class FuzzySuggestModal { constructor(app) {this.app=app;} setPlaceholder(){} open(){} }
export class MarkdownView { static [Symbol.hasInstance](candidate) { return candidate?.fixtureMarkdownView === true; } }
export class TFile {}
export class Menu {}
export class Modal { constructor(app) {this.app=app;this.contentEl=app.document.createElement('div');} setTitle(){} open(){} close(){} }
export class Notice { constructor(message) { globalThis.__editingNotices?.push(String(message)); } }
export class Setting {}
export class SettingGroup {}
export const normalizePath=path=>path.replace(/\\/g,'/').replace(/\/+/g,'/');
`;

interface FixtureTool { id: string; hotkeys?: Hotkey[]; run(editor: Editor): void | Promise<void> }
interface FixtureCommand { id: string; hotkeys?: Hotkey[]; editorCallback?: (editor: Editor) => void; callback?: () => void }
export interface FixturePlugin {
  tools: FixtureTool[];
  commands: FixtureCommand[];
  domRegistrations: Array<{ element: EventTarget; type: string; active: boolean }>;
  editorExtensions: unknown[];
  settings: { extraEnter: boolean; pasteTables: boolean; referenceShortcuts: string[] };
  onload(): Promise<void>;
  unload(): void;
}

let pluginConstructor: Promise<new (app: unknown, manifest: unknown) => FixturePlugin> | undefined;

function loadPluginClass(): Promise<new (app: unknown, manifest: unknown) => FixturePlugin> {
  return pluginConstructor ??= (async () => {
    const result = await build({
      absWorkingDir: ROOT,
      entryPoints: ['src/main.ts'], bundle: true, write: false, platform: 'browser', format: 'esm',
      plugins: [{ name: 'obsidian-test-host', setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test-host' }));
        builder.onLoad({ filter: /.*/, namespace: 'test-host' }, () => ({ contents: HOST_STUB, resolveDir: ROOT }));
      } }],
    });
    const source = result.outputFiles[0]?.text;
    assert(source, '入口构建没有输出');
    const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')) as { default: new (app: unknown, manifest: unknown) => FixturePlugin };
    return module.default;
  })();
}

export const pos = (line: number, ch: number): EditorPosition => ({ line, ch });
export const selection = (line: number, from: number, to = from): EditorSelection => ({ anchor: pos(line, from), head: pos(line, to) });

export class FixtureEditor {
  value: string;
  selections: EditorSelection[];
  transactions: EditorTransaction[] = [];
  constructor(value: string, selections: EditorSelection[] = [selection(0, 0)]) { this.value = value; this.selections = structuredClone(selections); }
  asEditor(): Editor { return this as unknown as Editor; }
  getValue(): string { return this.value; }
  getLine(line: number): string { return this.value.split('\n')[line] ?? ''; }
  lastLine(): number { return this.value.split('\n').length - 1; }
  listSelections(): EditorSelection[] { return structuredClone(this.selections); }
  hasFocus(): boolean { return true; }
  somethingSelected(): boolean { return this.selections.some(({ anchor, head }) => anchor.line !== head.line || anchor.ch !== head.ch); }
  posToOffset(point: EditorPosition): number {
    const lines = this.value.split('\n');
    assert(point.line >= 0 && point.line < lines.length, '编辑器收到越界行号');
    assert(point.ch >= 0 && point.ch <= lines[point.line]!.length, '编辑器收到越界列号');
    return lines.slice(0, point.line).reduce((total, line) => total + line.length + 1, 0) + point.ch;
  }
  offsetToPos(offset: number): EditorPosition {
    assert(offset >= 0 && offset <= this.value.length, '编辑器收到越界偏移');
    const lines = this.value.slice(0, offset).split('\n');
    return pos(lines.length - 1, lines[lines.length - 1]!.length);
  }
  getCursor(which: 'from' | 'to' | 'anchor' | 'head' = 'head'): EditorPosition {
    const current = this.selections[0]!;
    if (which === 'anchor' || which === 'head') return { ...current[which] };
    const offsets = [this.posToOffset(current.anchor), this.posToOffset(current.head)].sort((a, b) => a - b);
    return this.offsetToPos(offsets[which === 'from' ? 0 : 1]!);
  }
  getSelection(): string { return this.value.slice(this.posToOffset(this.getCursor('from')), this.posToOffset(this.getCursor('to'))); }
  setSelection(anchor: EditorPosition, head = anchor): void { this.selections = [{ anchor: { ...anchor }, head: { ...head } }]; }
  setSelections(ranges: EditorSelection[]): void { this.selections = structuredClone(ranges); }
  scrollIntoView(): void {}
  executedCommands: Array<{ id: string; cursor: EditorPosition }> = [];
  exec(id: string): void { this.executedCommands.push({ id, cursor: this.getCursor() }); }
  setCursor(point: EditorPosition): void { this.setSelection(point); }
  focus(): void {}
  selectOffsets(from: number, to = from): void { this.setSelection(this.offsetToPos(from), this.offsetToPos(to)); }
  transaction(transaction: EditorTransaction): void {
    const changes = (transaction.changes ?? []).map(change => ({ from: this.posToOffset(change.from), to: this.posToOffset(change.to ?? change.from), text: change.text }));
    const ordered = [...changes].sort((a, b) => a.from - b.from);
    for (let index = 1; index < ordered.length; index++) assert(ordered[index]!.from >= ordered[index - 1]!.to, '宿主事务不接受重叠修改');
    this.transactions.push(structuredClone(transaction));
    for (const change of changes.sort((a, b) => b.from - a.from)) this.value = this.value.slice(0, change.from) + change.text + this.value.slice(change.to);
    if (transaction.selections) this.selections = transaction.selections.map(range => {
      assert(range.from, '事务必须遵守 Editor 的 from/to 契约');
      this.posToOffset(range.from);
      this.posToOffset(range.to ?? range.from);
      return { anchor: { ...range.from }, head: { ...(range.to ?? range.from) } };
    });
  }
}

type ClipboardPort = { read(): Promise<Array<{ types: string[]; getType(type: string): Promise<Blob> }>>; readText(): Promise<string>; writeText(text: string): Promise<void> };

export async function createFixture(value = '', selections: EditorSelection[] = [selection(0, 0)]) {
  const PluginClass = await loadPluginClass();
  const window = new Window();
  const document = window.document as unknown as Document;
  const editor = new FixtureEditor(value, selections);
  const containerEl = document.createElement('div'); document.body.append(containerEl);
  const target = document.createElement('div'); containerEl.append(target);
  Object.assign(target, { instanceOf: (constructor: typeof Node) => target instanceof constructor });
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  let activeFile = { path: '测试.md' };
  const searches: string[] = [];
  let activeView = { editor: editor.asEditor(), containerEl, file: activeFile, fixtureMarkdownView: true, showSearch: () => { searches.push(editor.getSelection()); } };
  const leaves = [{ view: activeView as { file: { path: string }; containerEl: HTMLElement; fixtureMarkdownView: boolean } }];
  const destinations = new Map<string, { path: string; extension: string }>();
  const linkLookups: Array<{ linkpath: string; sourcePath: string }> = [];
  const unopenedVideos = new Map<string, number[]>();
  const openedFiles: string[] = [];
  const makeVideo = (container: HTMLElement, time: number): HTMLVideoElement => {
    const video = document.createElement('video'); video.currentTime = time;
    Object.defineProperty(video, 'duration', { configurable: true, value: 300 });
    Object.defineProperty(video, 'play', { configurable: true, value: async () => { video.setAttribute('data-played', 'true'); } });
    container.append(video); return video;
  };
  const clipboard: ClipboardPort = { read: async () => [], readText: async () => '', writeText: async () => undefined };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, assigned] of Object.entries({ window, activeDocument: document, document, Node: window.Node, MutationObserver: window.MutationObserver, navigator: { clipboard }, __editingNotices: [] })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: assigned });
  }
  const customHotkeys = { 'yuhanbo-editing:heading-1': [{ modifiers: ['Alt'], key: 'H' }] };
  const app = {
    document, pluginData: undefined, savedData: [] as unknown[],
    scope: {}, keymap: { pushScope: (_scope: unknown) => undefined, popScope: (_scope: unknown) => undefined },
    hotkeyManager: { customKeys: structuredClone(customHotkeys), setHotkeys: () => { throw new Error('插件不应重写宿主快捷键。'); } },
    metadataCache: { getFirstLinkpathDest: (linkpath: string, sourcePath: string) => { linkLookups.push({ linkpath, sourcePath }); return destinations.get(linkpath) ?? null; } },
    vault: { configDir: '.obsidian', adapter: { stat: async () => ({ mtime: 1, size: 100 }), read: async () => JSON.stringify(customHotkeys) }, read: async () => { throw new Error('跳转视频不应读取其他笔记。'); } },
    workspace: {
      getActiveFile: () => activeFile,
      getActiveViewOfType: () => activeView,
      getLeavesOfType: (type: string) => type === 'markdown' ? leaves : [],
      getLeaf: () => {
        const container = document.createElement('div');
        const leaf = { view: { file: { path: '' }, containerEl: container, fixtureMarkdownView: true }, openFile: async (file: { path: string }) => {
          openedFiles.push(file.path); leaf.view.file = file;
          for (const time of unopenedVideos.get(file.path) ?? []) makeVideo(container, time);
          leaves.push(leaf);
        } };
        return leaf;
      },
      openLinkText: async () => { throw new Error('跳转视频不应自动打开笔记。'); },
      on: (name: string, callback: (...args: unknown[]) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name)!.add(callback);
        return { off: () => { listeners.get(name)?.delete(callback); } };
      },
    },
  };
  const plugin = new PluginClass(app, { id: 'yuhanbo-editing', name: 'yuhanbo-editing', version: '1.0.0' });
  await plugin.onload();
  return {
    plugin, editor, app, clipboard, window, document, target, listeners, customHotkeys, linkLookups, searches, openedFiles,
    tool: (id: string): FixtureTool => { const result = plugin.tools.find(tool => tool.id === id); assert(result, `未注册命令 ${id}`); return result; },
    run: async (id: string): Promise<void> => { const tool = plugin.tools.find(tool => tool.id === id); assert(tool, `未注册命令 ${id}`); await tool.run(editor.asEditor()); },
    switchNote: (next: FixtureEditor, path = '另一篇.md'): void => { activeFile = { path }; activeView = { editor: next.asEditor(), containerEl, file: activeFile, fixtureMarkdownView: true, showSearch: () => { searches.push(next.getSelection()); } }; },
    prepareUnopenedVideo: (path: string, times: number[] = [0]): void => { unopenedVideos.set(path, times); },
    resolveNote: (linkpath: string, path: string, extension = 'md'): void => { destinations.set(linkpath, { path, extension }); },
    addCurrentVideo: (time = 0): HTMLVideoElement => {
      return makeVideo(containerEl, time);
    },
    addVideoView: (path: string, times: number[] = [0]): HTMLVideoElement[] => {
      const container = document.createElement('div');
      const videos = times.map(time => makeVideo(container, time));
      leaves.push({ view: { file: { path }, containerEl: container, fixtureMarkdownView: true } });
      return videos;
    },
    emit: (name: string, ...args: unknown[]): void => { for (const callback of listeners.get(name) ?? []) callback(...args); },
    close: (): void => {
      plugin.unload(); window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(callback => { resolve = callback; });
  return { promise, resolve };
}
