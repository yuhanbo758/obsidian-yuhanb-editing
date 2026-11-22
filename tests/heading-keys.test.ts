import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Window } from 'happy-dom';
import { fileURLToPath } from 'node:url';
import type { App, Editor, Hotkey } from 'obsidian';
import { parseCustomHotkeys } from '../src/custom-hotkeys';
import type { StateField } from '@codemirror/state';

interface Runtime {
  headingKeys: typeof import('../src/heading-keys').headingKeys;
  HeadingKeyScope: typeof import('../src/heading-keys').HeadingKeyScope;
  EditorState: typeof import('@codemirror/state').EditorState;
  EditorView: typeof import('@codemirror/view').EditorView;
  keymap: typeof import('@codemirror/view').keymap;
  editorInfoField: StateField<{ editor: Editor }>;
  Platform: { isMacOS: boolean };
  Scope: new (parent?: TestScope) => TestScope;
  TestKeymap: new (scope: TestScope) => TestKeymap;
}

interface TestScope { register(modifiers: string[] | null, key: string | null, callback: (event: KeyboardEvent) => unknown): unknown }
interface TestKeymap { active: TestScope; pushes: number; pops: number; pushScope(scope: TestScope): void; popScope(scope: TestScope): void; dispatch(event: KeyboardEvent): void }

let runtime: Promise<Runtime> | undefined;
async function loadRuntime(): Promise<Runtime> {
  return runtime ??= (async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const result = await build({
      absWorkingDir: root, bundle: true, write: false, platform: 'browser', format: 'esm',
      stdin: { resolveDir: root, sourcefile: 'heading-key-test-entry.ts', contents: `
        export {headingKeys,HeadingKeyScope} from './src/heading-keys';
        export {EditorState} from '@codemirror/state';
        export {EditorView,keymap} from '@codemirror/view';
        export {Platform,editorInfoField,Scope,TestKeymap} from 'obsidian';
      ` },
      plugins: [{ name: 'obsidian-public-editor-field', setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test-host' }));
        builder.onLoad({ filter: /.*/, namespace: 'test-host' }, () => ({ resolveDir: root, contents: `
          import {StateField} from '@codemirror/state';
          export const Platform={isMacOS:false};
          export const editorInfoField=StateField.define({create:()=>({editor:null}),update:value=>value});
          export class Notice {}
          function modifiers(values){return values.map(value=>value==='Mod'?(Platform.isMacOS?'Meta':'Ctrl'):value).sort().join(',');}
          export class Scope {
            constructor(parent){this.parent=parent;this.keys=[];}
            register(mods,key,func){const handler={scope:this,modifiers:mods===null?null:modifiers(mods),key,func};this.keys.push(handler);return handler;}
            unregister(handler){this.keys=this.keys.filter(candidate=>candidate!==handler);}
            handle(event,context){
              for(const binding of this.keys)if((binding.modifiers===null||binding.modifiers===context.modifiers)&&(binding.key===null||binding.key===context.key))return binding.func(event,context);
              return this.parent?.handle(event,context);
            }
          }
          export class TestKeymap {
            constructor(root){this.root=root;this.active=root;this.previous=[];this.pushes=0;this.pops=0;}
            pushScope(scope){if(this.active!==scope){this.previous.push(this.active);this.active=scope;this.pushes++;}}
            popScope(scope){this.pops++;if(this.active===scope)this.active=this.previous.pop()??this.root;else this.previous=this.previous.filter(candidate=>candidate!==scope);}
            dispatch(event){const mods=[];if(event.ctrlKey)mods.push('Ctrl');if(event.metaKey)mods.push('Meta');if(event.altKey)mods.push('Alt');if(event.shiftKey)mods.push('Shift');const result=this.active.handle(event,{key:event.key,modifiers:modifiers(mods),vkey:event.code});if(result===false){event.preventDefault();event.stopPropagation();}}
          }
        ` }));
      } }],
    });
    return await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0]!.text).toString('base64')) as Runtime;
  })();
}

/** 使用真正的 CM EditorState / EditorView / DOM 事件，只替换 Obsidian 注入的 editorInfoField。 */
async function createKeyEditor(options: { mac?: boolean; readOnly?: boolean; enabled?: boolean; scope?: boolean; shortcuts?: string[]; yieldToCustom?: (id: string, hotkey: Hotkey) => boolean } = {}) {
  const window = new Window({ url: 'https://fixture.invalid' });
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window, document: window.document, navigator: window.navigator, Node: window.Node, Element: window.Element,
    HTMLElement: window.HTMLElement, Text: window.Text, MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window), requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const loaded = await loadRuntime(); loaded.Platform.isMacOS = options.mac === true;
  const editor = {} as Editor;
  const calls: Array<{ editor: Editor; level: number }> = [];
  const enabled = { value: options.enabled !== false };
  const shortcuts = { value: options.shortcuts ?? [] };
  const shortcutCalls: string[] = [];
  const counters = { lowerBinding: 0, bubble: 0, capture: 0, core: 0 };
  const rootScope = new loaded.Scope();
  const appKeymap = new loaded.TestKeymap(rootScope);
  for (let level = 1; level <= 7; level++) rootScope.register(['Mod'], String(level), () => { counters.core++; return false; });
  const scope = options.scope ? new loaded.HeadingKeyScope({ scope: rootScope, keymap: appKeymap } as unknown as App, () => enabled.value, (owner, level) => { calls.push({ editor: owner, level }); }, () => shortcuts.value, (_editor, id) => { shortcutCalls.push(id); }, options.yieldToCustom) : undefined;
  const hostCapture = (event: KeyboardEvent) => { appKeymap.dispatch(event); };
  if (options.scope) window.addEventListener('keydown', hostCapture as unknown as EventListener, true);
  const hostBinding = () => { counters.lowerBinding++; return true; };
  const stateFor = (owner: Editor) => loaded.EditorState.create({ doc: '正文', extensions: [
    loaded.editorInfoField.init(() => ({ editor: owner })),
    scope?.extension ?? loaded.headingKeys(() => enabled.value, (owner, level) => { calls.push({ editor: owner, level }); }),
    loaded.keymap.of([{ key: 'Ctrl-1', run: hostBinding }, { key: 'Meta-1', run: hostBinding }]),
    loaded.EditorState.readOnly.of(options.readOnly === true),
  ] });
  const views = new Set<InstanceType<Runtime['EditorView']>>();
  const addView = (owner: Editor) => { const next = new loaded.EditorView({ state: stateFor(owner), parent: window.document.body as unknown as HTMLElement }); views.add(next); return next; };
  const view = addView(editor);
  view.focus();
  const capture = () => { counters.capture++; }; const bubble = () => { counters.bubble++; };
  window.document.addEventListener('keydown', capture, true); window.document.addEventListener('keydown', bubble);
  const press = (init: KeyboardEventInit = {}, target: EventTarget = view.contentDOM): KeyboardEvent => {
    const event = new window.KeyboardEvent('keydown', { key: '1', ctrlKey: options.mac !== true, metaKey: options.mac === true, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event as unknown as Event);
    return event as unknown as KeyboardEvent;
  };
  return {
    view, window, editor, calls, enabled, counters, press, platform: loaded.Platform, scope, rootScope, appKeymap, addView, Scope: loaded.Scope, shortcuts, shortcutCalls,
    destroyView: (target: InstanceType<Runtime['EditorView']>): void => { target.destroy(); views.delete(target); },
    close: (): void => {
      window.document.removeEventListener('keydown', capture, true); window.document.removeEventListener('keydown', bubble);
      window.removeEventListener('keydown', hostCapture as unknown as EventListener, true);
      scope?.destroy(); for (const target of views) target.destroy(); window.close();
      for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

test('正文把已有 Alt+U 和本插件明确清空的标题键交给宿主，保留其他参考键', async context => {
  let custom = parseCustomHotkeys(JSON.stringify({ 'template:custom': [{ modifiers: ['Alt'], key: 'u' }], 'yuhanbo-editing:heading-1': [] }), 'yuhanbo-editing', false);
  const fixture = await createKeyEditor({ scope: true, shortcuts: ['superscript', 'highlight'], yieldToCustom: (id, key) => custom(id, key) });
  context.after(() => fixture.close());
  let templateInvocations = 0;
  fixture.rootScope.register(['Alt'], 'U', () => { templateInvocations++; return false; });
  fixture.press({ key: 'U', altKey: true, ctrlKey: false });
  fixture.press({ key: 'G', altKey: true, ctrlKey: false });
  fixture.press({ key: '1' });
  fixture.press({ key: '2' });
  assert.equal(templateInvocations, 1);
  assert.deepEqual(fixture.shortcutCalls, ['highlight']);
  assert.deepEqual(fixture.calls.map(call => call.level), [2]);
  assert.equal(fixture.counters.core, 1);
  custom = parseCustomHotkeys('{}', 'yuhanbo-editing', false);
  fixture.scope!.refresh();
  fixture.press({ key: 'U', altKey: true, ctrlKey: false });
  assert.equal(templateInvocations, 1);
  assert.deepEqual(fixture.shortcutCalls, ['highlight', 'superscript']);
});

test('Mac 自定义 Cmd 与 Mod 等价，Ctrl 与 Cmd 独立，并保留插件自己的重绑', () => {
  const yieldToCustom = parseCustomHotkeys(JSON.stringify({ 'other:action': [{ modifiers: ['Meta', 'Alt'], key: 'V' }], 'yuhanbo-editing:bold': [{ modifiers: ['Alt'], key: 'B' }] }), 'yuhanbo-editing', true);
  assert.equal(yieldToCustom('smart-paste', { modifiers: ['Alt', 'Mod'], key: 'v' }), true);
  assert.equal(yieldToCustom('smart-paste', { modifiers: ['Alt', 'Ctrl'], key: 'v' }), false);
  assert.equal(yieldToCustom('bold', { modifiers: ['Alt'], key: 'C' }), true);
});

test('参考快捷键逐项开启、即时关闭，标题关闭时不阻挡父级标签页命令', async context => {
  const fixture = await createKeyEditor({ scope: true, enabled: false }); context.after(() => fixture.close());
  fixture.press({ key: 'Z', ctrlKey: false, altKey: true });
  assert.deepEqual(fixture.shortcutCalls, []);
  fixture.shortcuts.value = ['wiki-link']; fixture.scope!.refresh();
  fixture.press({ key: 'Z', ctrlKey: false, altKey: true });
  assert.deepEqual(fixture.shortcutCalls, ['wiki-link']);
  fixture.press(); assert.equal(fixture.counters.core, 1);
  fixture.press({ key: 'Z', ctrlKey: false, altKey: true, repeat: true });
  fixture.press({ key: 'Z', ctrlKey: false, altKey: true, isComposing: true });
  assert.equal(fixture.shortcutCalls.length, 1);
  fixture.shortcuts.value = []; fixture.scope!.refresh();
  fixture.press({ key: 'Z', ctrlKey: false, altKey: true });
  assert.equal(fixture.shortcutCalls.length, 1);
});

test('Mac 参考颜色与粘贴键组仅使用 Cmd，并在输入框失焦后停止', async context => {
  const fixture = await createKeyEditor({ scope: true, mac: true, enabled: false, shortcuts: ['text-color-1', 'smart-paste'] }); context.after(() => fixture.close());
  fixture.press({ key: '1', shiftKey: true });
  fixture.press({ key: 'V', altKey: true });
  assert.deepEqual(fixture.shortcutCalls, ['text-color-1', 'smart-paste']);
  fixture.press({ key: 'V', altKey: true, ctrlKey: true, metaKey: false });
  assert.equal(fixture.shortcutCalls.length, 2);
  const input = fixture.window.document.createElement('input'); fixture.window.document.body.append(input); input.focus();
  fixture.press({ key: 'V', altKey: true }, input);
  assert.equal(fixture.shortcutCalls.length, 2);
});

test('最高优先级编辑器处理先于普通 CM 键组，并阻止后续全局冒泡', async context => {
  const fixture = await createKeyEditor(); context.after(() => fixture.close());
  const event = fixture.press();
  assert.deepEqual(fixture.calls, [{ editor: fixture.editor, level: 1 }]);
  assert.equal(fixture.counters.lowerBinding, 0); assert.equal(fixture.counters.bubble, 0);
  assert.equal(event.defaultPrevented, true);
  assert.equal(fixture.counters.capture, 1, 'DOM 捕获发生在 CM 内容节点之前，不能将单测解释为已胜过宿主捕获监听');
});

test('Windows Ctrl 和 macOS Cmd 的六个数字都传递正确级别与所属编辑器', async context => {
  const fixture = await createKeyEditor(); context.after(() => fixture.close());
  for (let level = 1; level <= 6; level++) fixture.press({ key: String(level) });
  assert.deepEqual(fixture.calls.map(call => call.level), [1, 2, 3, 4, 5, 6]);
  assert(fixture.calls.every(call => call.editor === fixture.editor));
  fixture.platform.isMacOS = true; fixture.calls.length = 0;
  for (let level = 1; level <= 6; level++) fixture.press({ key: String(level), ctrlKey: false, metaKey: true });
  assert.deepEqual(fixture.calls.map(call => call.level), [1, 2, 3, 4, 5, 6]);
  fixture.calls.length = 0;
  fixture.press({ metaKey: false, ctrlKey: true });
  assert.equal(fixture.calls.length, 0, 'Mac 不应将 Ctrl 误判为 Cmd');
});

test('关闭优先标题键后即时恢复宿主键组，无需重建编辑器', async context => {
  const fixture = await createKeyEditor({ enabled: false }); context.after(() => fixture.close());
  fixture.press(); assert.equal(fixture.calls.length, 0); assert.equal(fixture.counters.lowerBinding, 1);
  fixture.enabled.value = true;
  fixture.press(); assert.equal(fixture.calls.length, 1); assert.equal(fixture.counters.lowerBinding, 1);
  fixture.enabled.value = false;
  fixture.press(); assert.equal(fixture.calls.length, 1); assert.equal(fixture.counters.lowerBinding, 2);
});

test('按键长按只消费，不重复切换也不让宿主标签命令接管', async context => {
  const fixture = await createKeyEditor(); context.after(() => fixture.close());
  const event = fixture.press({ repeat: true });
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.counters.lowerBinding, 0);
  assert.equal(fixture.counters.bubble, 0); assert.equal(event.defaultPrevented, true);
});

test('输入法组合事件及刚开始组合但尚未改字的阶段均不切换标题', async context => {
  const fixture = await createKeyEditor(); context.after(() => fixture.close());
  fixture.press({ isComposing: true }); assert.equal(fixture.calls.length, 0);
  fixture.view.contentDOM.dispatchEvent(new fixture.window.CompositionEvent('compositionstart', { bubbles: true }) as unknown as Event);
  assert.equal(fixture.view.compositionStarted, true);
  fixture.press({ isComposing: false });
  assert.equal(fixture.calls.length, 0, '不能只依赖 KeyboardEvent.isComposing');
});

test('只读编辑器不调用文档变换', async context => {
  const fixture = await createKeyEditor({ readOnly: true }); context.after(() => fixture.close());
  fixture.press(); assert.equal(fixture.calls.length, 0);
});

test('设置输入框和阅读区域的同样按键不触发编辑器标题变换', async context => {
  const fixture = await createKeyEditor(); context.after(() => fixture.close());
  const input = fixture.window.document.createElement('input'); fixture.window.document.body.append(input); input.focus();
  const inputEvent = fixture.press({}, input as unknown as EventTarget);
  assert.equal(fixture.calls.length, 0); assert.equal(inputEvent.defaultPrevented, false);
  const reading = fixture.window.document.createElement('div'); fixture.window.document.body.append(reading);
  const readingEvent = fixture.press({}, reading as unknown as EventTarget);
  assert.equal(fixture.calls.length, 0); assert.equal(readingEvent.defaultPrevented, false);
});

test('其他数字和 Alt、Shift、双修饰键不触发标题优先处理', async context => {
  const fixture = await createKeyEditor(); context.after(() => fixture.close());
  for (const init of [{ key: '7' }, { key: '0' }, { altKey: true }, { shiftKey: true }, { metaKey: true }, { ctrlKey: false }]) fixture.press(init);
  assert.equal(fixture.calls.length, 0);
});

test('更早的祖先捕获监听若已消费按键，CM 扩展不会执行或假称覆盖它', async context => {
  const fixture = await createKeyEditor(); context.after(() => fixture.close());
  let captured = 0;
  const earlierHost = (event: Event) => { captured++; event.preventDefault(); event.stopPropagation(); };
  fixture.window.document.addEventListener('keydown', earlierHost, true);
  context.after(() => fixture.window.document.removeEventListener('keydown', earlierHost, true));
  fixture.press();
  assert.equal(captured, 1); assert.equal(fixture.calls.length, 0);
});

test('公开 Scope 在宿主 window 捕获调度中处理 Windows 六级标题，不落到核心标签命令', async context => {
  const fixture = await createKeyEditor({ scope: true }); context.after(() => fixture.close());
  assert.notEqual(fixture.appKeymap.active, fixture.rootScope);
  for (let level = 1; level <= 6; level++) fixture.press({ key: String(level) });
  assert.deepEqual(fixture.calls.map(call => call.level), [1, 2, 3, 4, 5, 6]);
  assert(fixture.calls.every(call => call.editor === fixture.editor));
  assert.equal(fixture.counters.core, 0); assert.equal(fixture.counters.lowerBinding, 0);
  assert.equal(fixture.appKeymap.pushes, 1, '正文操作不能重复压入同一 scope');
});

test('公开 Scope 的 Mac Cmd 六键同样先于核心命令，未注册键由父 scope 处理', async context => {
  const fixture = await createKeyEditor({ scope: true, mac: true }); context.after(() => fixture.close());
  for (let level = 1; level <= 6; level++) fixture.press({ key: String(level) });
  assert.deepEqual(fixture.calls.map(call => call.level), [1, 2, 3, 4, 5, 6]);
  assert.equal(fixture.counters.core, 0);
  fixture.press({ key: '7' });
  assert.equal(fixture.counters.core, 1, '未注册的 Mod7 必须自然继承父 scope');
  assert.equal(fixture.calls.length, 6);
});

test('焦点离开正文时立即 pop，回到正文重新启用，销毁当前编辑器后不残留 scope', async context => {
  const fixture = await createKeyEditor({ scope: true }); context.after(() => fixture.close());
  const input = fixture.window.document.createElement('input'); fixture.window.document.body.append(input); input.focus();
  assert.equal(fixture.appKeymap.active, fixture.rootScope);
  fixture.press({}, input as unknown as EventTarget);
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.counters.core, 1);
  fixture.view.focus(); assert.notEqual(fixture.appKeymap.active, fixture.rootScope);
  fixture.press(); assert.equal(fixture.calls.length, 1);
  fixture.destroyView(fixture.view);
  assert.equal(fixture.appKeymap.active, fixture.rootScope);
});

test('打开模态 scope 后正文更新和 refresh 不将标题 scope 重新压到模态之上', async context => {
  const fixture = await createKeyEditor({ scope: true }); context.after(() => fixture.close());
  let modalCalls = 0;
  const modal = new fixture.Scope(fixture.rootScope);
  modal.register(['Mod'], '1', () => { modalCalls++; return false; });
  fixture.appKeymap.pushScope(modal);
  const pushes = fixture.appKeymap.pushes;
  fixture.view.dispatch({}); fixture.view.dispatch({}); fixture.scope!.refresh();
  assert.equal(fixture.appKeymap.pushes, pushes);
  assert.equal(fixture.appKeymap.active, modal);
  fixture.press(); assert.equal(modalCalls, 1); assert.equal(fixture.calls.length, 0);
  fixture.scope!.destroy();
  assert.equal(fixture.appKeymap.active, modal, '销毁下面的标题 scope 不能误弹模态 scope');
  fixture.appKeymap.popScope(modal);
  assert.equal(fixture.appKeymap.active, fixture.rootScope, '销毁后模态关闭不能恢复已失效的标题 scope');
});

test('切换到另一编辑器后，旧编辑器迟到的销毁不会 pop 新正文的 scope', async context => {
  const fixture = await createKeyEditor({ scope: true }); context.after(() => fixture.close());
  const secondEditor = {} as Editor;
  const second = fixture.addView(secondEditor); second.focus();
  fixture.destroyView(fixture.view);
  assert.notEqual(fixture.appKeymap.active, fixture.rootScope);
  fixture.press({}, second.contentDOM);
  assert.deepEqual(fixture.calls, [{ editor: secondEditor, level: 1 }]);
  fixture.destroyView(second);
  assert.equal(fixture.appKeymap.active, fixture.rootScope);
});

test('公开 Scope 在 IME 与重复事件中消费标题键，不执行变换也不误切标签', async context => {
  const fixture = await createKeyEditor({ scope: true }); context.after(() => fixture.close());
  assert.equal(fixture.press({ repeat: true }).defaultPrevented, true);
  assert.equal(fixture.press({ isComposing: true }).defaultPrevented, true);
  fixture.view.contentDOM.dispatchEvent(new fixture.window.CompositionEvent('compositionstart', { bubbles: true }) as unknown as Event);
  assert.equal(fixture.view.compositionStarted, true);
  assert.equal(fixture.press({ isComposing: false }).defaultPrevented, true);
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.counters.core, 0);
});

test('公开 Scope 开关关闭后回到核心绑定，重复 refresh 与 destroy 均不会重复 push/pop', async context => {
  const fixture = await createKeyEditor({ scope: true }); context.after(() => fixture.close());
  fixture.enabled.value = false; fixture.scope!.refresh(); fixture.scope!.refresh();
  assert.equal(fixture.appKeymap.active, fixture.rootScope);
  fixture.press(); assert.equal(fixture.counters.core, 1); assert.equal(fixture.calls.length, 0);
  fixture.enabled.value = true; fixture.scope!.refresh(); fixture.scope!.refresh();
  fixture.press(); assert.equal(fixture.calls.length, 1); assert.equal(fixture.counters.core, 1);
  fixture.scope!.destroy(); const pops = fixture.appKeymap.pops;
  fixture.scope!.destroy(); fixture.scope!.refresh();
  assert.equal(fixture.appKeymap.pops, pops); assert.equal(fixture.appKeymap.active, fixture.rootScope);
});

test('只读正文不 push 标题 scope，直接保留宿主绑定', async context => {
  const fixture = await createKeyEditor({ scope: true, readOnly: true }); context.after(() => fixture.close());
  assert.equal(fixture.appKeymap.active, fixture.rootScope); assert.equal(fixture.appKeymap.pushes, 0);
  fixture.press(); assert.equal(fixture.calls.length, 0); assert.equal(fixture.counters.core, 1);
});
