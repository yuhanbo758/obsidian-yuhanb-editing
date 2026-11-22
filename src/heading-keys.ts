import { Prec, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { Notice, Platform, Scope, editorInfoField, type App, type Editor, type Hotkey, type KeymapEventHandler } from 'obsidian';
import { REFERENCE_SHORTCUTS } from './reference-shortcuts';

/**
 * 宿主在 window 捕获阶段调度 Scope，先于 CM 内容节点；仅聚焦正文期间入栈。
 * CM highest 只在 CM 内部排序，不能单独覆盖宿主标签页快捷键。
 */
export class HeadingKeyScope {
  readonly extension: Extension;
  private readonly scope: Scope;
  private readonly handlers: KeymapEventHandler[] = [];
  private current: EditorView | null = null;
  private pushed = false;
  private destroyed = false;
  private shortcutSignature = '';
  private shortcutHandlers: KeymapEventHandler[] = [];
  private headingSignature = '';

  constructor(private readonly app: App, private readonly enabled: () => boolean, private readonly apply: (editor: Editor, level: number) => void,
    private readonly shortcutIds: () => string[] = () => [], private readonly runShortcut: (editor: Editor, id: string) => void = () => undefined,
    private readonly yieldToCustom: (id: string, hotkey: Hotkey) => boolean = () => false) {
    this.scope = new Scope(app.scope);
    this.syncHeadingHandlers();
    const focus = (view: EditorView): void => { this.focus(view); };
    const blur = (view: EditorView): void => { this.blur(view); };
    const updateFocus = (update: ViewUpdate): void => {
      if (update.focusChanged && update.view.hasFocus) this.focus(update.view);
      else if (this.current === update.view) this.refresh();
    };
    this.extension = ViewPlugin.fromClass(class {
      constructor(readonly view: EditorView) { if (view.hasFocus) focus(view); }
      update(update: ViewUpdate): void { updateFocus(update); }
      destroy(): void { blur(this.view); }
    }, { eventHandlers: {
      focus(_event, view) { focus(view); return false; },
      blur(_event, view) { blur(view); return false; },
    } });
  }

  /** 开关变化只同步当前正文焦点，不反复 push，避免抢到后来打开的模态 Scope 之上。 */
  refresh(): void {
    this.syncHeadingHandlers();
    const ids = new Set(this.shortcutIds());
    const bindings = this.destroyed ? [] : REFERENCE_SHORTCUTS.filter(binding => ids.has(binding.id) && !this.yieldToCustom(binding.id, binding.hotkey));
    const signature = bindings.map(binding => binding.id).join('|');
    if (signature !== this.shortcutSignature) {
      for (const handler of this.shortcutHandlers) this.scope.unregister(handler);
      this.shortcutHandlers = bindings.map(binding => this.scope.register(binding.hotkey.modifiers, binding.hotkey.key, event => {
        const view = this.current;
        if (!view || !this.eligible(view) || !event.target || !view.contentDOM.contains(event.target as Node)) return;
        event.preventDefault(); event.stopPropagation();
        if (!event.isComposing && !event.repeat && !view.composing && !view.compositionStarted) {
          const editor = view.state.field(editorInfoField, false)?.editor;
          if (editor) this.runShortcut(editor, binding.id);
        }
        return false;
      }));
      this.shortcutSignature = signature;
    }
    if (!this.destroyed && this.current && this.eligible(this.current)) {
      if (!this.pushed) { this.app.keymap.pushScope(this.scope); this.pushed = true; }
    } else if (this.pushed) { this.app.keymap.popScope(this.scope); this.pushed = false; }
  }

  private syncHeadingHandlers(): void {
    const levels = !this.destroyed && this.enabled() ? [1, 2, 3, 4, 5, 6].filter(level => !this.yieldToCustom(`heading-${level}`, { modifiers: ['Mod'], key: String(level) })) : [];
    const signature = levels.join('');
    if (signature === this.headingSignature) return;
    for (const handler of this.handlers) this.scope.unregister(handler);
    this.handlers.length = 0;
    this.headingSignature = signature;
    for (const level of levels) this.handlers.push(this.scope.register(['Mod'], String(level), event => {
      const view = this.current;
      this.refresh();
      if (!this.enabled() || !view || !this.eligible(view) || !event.target || !view.contentDOM.contains(event.target as Node)) return;
      // Scope 的 false 表示已消费；IME 和长按也消费数字键，避免误触父级标签页命令。
      event.preventDefault(); event.stopPropagation();
      if (!event.isComposing && !event.repeat && !view.composing && !view.compositionStarted && !event.altKey && !event.shiftKey) {
        const editor = view.state.field(editorInfoField, false)?.editor;
        if (editor) {
          try { this.apply(editor, level); }
          catch (error) { new Notice(error instanceof Error ? error.message : '标题转换失败，请重试。'); }
        }
      }
      return false;
    }));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.current = null;
    this.refresh();
    for (const handler of this.handlers) this.scope.unregister(handler);
    for (const handler of this.shortcutHandlers) this.scope.unregister(handler);
    this.shortcutHandlers.length = 0;
    this.handlers.length = 0;
  }

  private eligible(view: EditorView): boolean {
    return !this.destroyed && (this.handlers.length > 0 || this.shortcutHandlers.length > 0) && view.hasFocus && !view.state.readOnly && !!view.state.field(editorInfoField, false)?.editor;
  }

  private focus(view: EditorView): void {
    if (this.destroyed || !view.hasFocus) return;
    this.current = view;
    this.refresh();
  }

  private blur(view: EditorView): void {
    // 旧视图延迟发来的 blur/destroy 不得清除另一视图刚建立的作用域。
    if (this.current !== view) return;
    this.current = null;
    this.refresh();
  }
}

/** 编辑器扩展在正文内处理键组，避免修改宿主或用户的全局快捷键配置。 */
export function headingKeys(enabled: () => boolean, apply: (editor: Editor, level: number) => void): Extension {
  return Prec.highest(EditorView.domEventHandlers({
    keydown(event, view) {
      if (!enabled() || !view.hasFocus || view.composing || view.compositionStarted || view.state.readOnly || event.isComposing || event.defaultPrevented || event.altKey || event.shiftKey) return false;
      const modifier = Platform.isMacOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!modifier || !/^[1-6]$/.test(event.key)) return false;
      if (!event.target || !view.contentDOM.contains(event.target as Node)) return false;
      const editor = view.state.field(editorInfoField, false)?.editor;
      if (!editor) return false;
      // 同一按键长按只消费事件，不重复切换，也不让标签页命令在重复事件上接管。
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) apply(editor, Number(event.key));
      return true;
    },
  }));
}
