import { Notice, PluginSettingTab, SettingGroup, type App, type SettingControl, type SettingDefinition, type SettingDefinitionItem } from 'obsidian';
import type EditingPlugin from './main';
import { parseReferenceShortcuts, REFERENCE_SHORTCUTS } from './reference-shortcuts';

export interface EditingSettings {
  textColors: string[];
  backgroundColors: string[];
  taskStates: string;
  extraEnter: boolean;
  headingKeys: boolean;
  pasteTables: boolean;
  autoHeadingLevel: number;
  referenceShortcuts: string[];
}
export const DEFAULT_SETTINGS: EditingSettings = {
  textColors: ['#e03131', '#e8590c', '#2f9e44', '#1971c2', '#9c36b5'],
  backgroundColors: ['#ffc9c9', '#ffec99', '#b2f2bb', '#a5d8ff', '#eebefa'],
  taskStates: ' x-!?><+', extraEnter: false, headingKeys: true, pasteTables: false, autoHeadingLevel: 2,
  referenceShortcuts: REFERENCE_SHORTCUTS.map(binding => binding.id),
};

const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const COLOR_KEY_PATTERN = /^(textColors|backgroundColors)\.([0-4])$/;
type SettingKey = 'extraEnter' | 'headingKeys' | 'pasteTables' | 'taskStates' | 'autoHeadingLevel' | `textColors.${number}` | `backgroundColors.${number}`;

function taskStateError(value: string): string | undefined {
  if (!value || value.length > 64 || /[^\x20-\x7e]/.test(value) || /[[\]\\]/.test(value)) return '请输入半角单字符状态，不要使用方括号、反斜杠、换行或中文。';
  const count = new Set(value).size;
  return count >= 2 && count <= 12 ? undefined : '去重后需要 2～12 个状态；半角空格表示未完成。';
}

export function parseSettings(data: unknown): EditingSettings {
  const saved = typeof data === 'object' && data !== null && !Array.isArray(data) && (Object.getPrototypeOf(data) === Object.prototype || Object.getPrototypeOf(data) === null) ? data as Record<string, unknown> : {};
  // 只读取已知的自有数据字段，既不继承配置，也不执行意外的访问器。
  const read = (key: string): unknown => Object.getOwnPropertyDescriptor(saved, key)?.value as unknown;
  const colors = (value: unknown, defaults: string[]): string[] => defaults.map((fallback, index) => {
    const color: unknown = Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, String(index))?.value : undefined;
    return typeof color === 'string' && COLOR_PATTERN.test(color) ? color.toLowerCase() : fallback;
  });
  const states = read('taskStates');
  const level = read('autoHeadingLevel');
  return {
    textColors: colors(read('textColors'), DEFAULT_SETTINGS.textColors),
    backgroundColors: colors(read('backgroundColors'), DEFAULT_SETTINGS.backgroundColors),
    taskStates: typeof states === 'string' && !taskStateError(states) ? [...new Set(states)].join('') : DEFAULT_SETTINGS.taskStates,
    extraEnter: read('extraEnter') === true,
    headingKeys: read('headingKeys') !== false,
    pasteTables: read('pasteTables') === true,
    autoHeadingLevel: typeof level === 'number' && Number.isInteger(level) && level >= 1 && level <= 6 ? level : DEFAULT_SETTINGS.autoHeadingLevel,
    // 新安装及缺少该字段的旧配置默认启用全部参考键；保留用户随后主动关闭或自选的列表。
    referenceShortcuts: Array.isArray(read('referenceShortcuts')) ? parseReferenceShortcuts(read('referenceShortcuts')) : [...DEFAULT_SETTINGS.referenceShortcuts],
  };
}

class EditingSettingsState {
  failed = false;
  constructor(readonly plugin: EditingPlugin) {}

  getValue(key: string): unknown {
    const match = COLOR_KEY_PATTERN.exec(key);
    if (match) {
      const colors = match[1] === 'textColors' ? this.plugin.settings.textColors : this.plugin.settings.backgroundColors;
      return colors[Number(match[2])];
    }
    switch (key) {
      case 'extraEnter': return this.plugin.settings.extraEnter;
      case 'headingKeys': return this.plugin.settings.headingKeys;
      case 'pasteTables': return this.plugin.settings.pasteTables;
      case 'taskStates': return this.plugin.settings.taskStates;
      case 'autoHeadingLevel': return String(this.plugin.settings.autoHeadingLevel);
      default: return undefined;
    }
  }

  async setValue(key: string, value: unknown): Promise<void> {
    const next = parseSettings(this.plugin.settings);
    const match = COLOR_KEY_PATTERN.exec(key);
    if (match) {
      if (typeof value !== 'string' || !COLOR_PATTERN.test(value)) throw new Error('颜色必须为 #rrggbb 格式。');
      const colors = match[1] === 'textColors' ? next.textColors : next.backgroundColors;
      colors[Number(match[2])] = value.toLowerCase();
    } else {
      switch (key) {
        case 'extraEnter':
        case 'headingKeys':
        case 'pasteTables':
          if (typeof value !== 'boolean') throw new Error('开关值无效。');
          next[key] = value;
          break;
        case 'taskStates': {
          const error = typeof value === 'string' ? taskStateError(value) : '待办状态必须是文本。';
          if (error || typeof value !== 'string') throw new Error(error ?? '待办状态无效。');
          next.taskStates = [...new Set(value)].join('');
          break;
        }
        case 'autoHeadingLevel': {
          const level = typeof value === 'string' && /^[1-6]$/.test(value) ? Number(value) : value;
          if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) throw new Error('标题级别必须为 1～6。');
          next.autoHeadingLevel = level;
          break;
        }
        default: throw new Error('未知的编辑设置。');
      }
    }
    this.plugin.settings = next;
    await this.persist();
  }

  async persist(notifySuccess = false): Promise<void> {
    try {
      await this.plugin.saveSettings();
      this.failed = false;
      if (notifySuccess) new Notice('编辑设置已保存。');
    } catch {
      // 不回滚用户刚输入的值；保留内存状态，让同一份内容可以直接重试落盘。
      this.failed = true;
      new Notice('编辑设置保存失败，当前输入已保留，请点击「重试保存」。');
    }
  }
}

const states = new WeakMap<EditingPlugin, EditingSettingsState>();
function stateFor(plugin: EditingPlugin): EditingSettingsState {
  let state = states.get(plugin);
  if (!state) { state = new EditingSettingsState(plugin); states.set(plugin, state); }
  return state;
}

function definitions(state: EditingSettingsState, refresh: () => void): SettingDefinitionItem<SettingKey>[] {
  const colors: SettingDefinition<SettingKey>[] = [];
  for (let index = 0; index < 5; index++) {
    colors.push({ name: `文字颜色 ${index + 1}`, aliases: ['前景色', 'text color'], control: { type: 'color', key: `textColors.${index}`, defaultValue: DEFAULT_SETTINGS.textColors[index] } });
    colors.push({ name: `背景颜色 ${index + 1}`, aliases: ['底色', 'background color'], control: { type: 'color', key: `backgroundColors.${index}`, defaultValue: DEFAULT_SETTINGS.backgroundColors[index] } });
  }
  return [
    { name: '快捷键面板', desc: '标题默认使用 Ctrl/Cmd+1～6，参考键可按需关闭。Obsidian 的自定义键位优先。', aliases: ['标题', '快捷键', 'heading', 'hotkeys'], render: setting => { setting.addButton(button => button.setButtonText('配置快捷键').onClick(() => { state.plugin.openHotkeys(); })); } },
    {
      type: 'group', heading: '编辑行为', items: [
        { name: '编辑器内优先使用标题快捷键', desc: '仅正文编辑器内使用 Ctrl+1～6（Mac 为 Cmd+1～6），优先于默认标签切换。关闭后完全按宿主快捷键配置处理。不会改写用户的全局快捷键文件。', aliases: ['标题', 'Ctrl', 'Cmd', '快捷键'], control: { type: 'toggle', key: 'headingKeys', defaultValue: true } },
        { name: '回车额外插入空行', desc: '仅普通正文生效，跳过输入法组合、列表、引用、表格、代码与 YAML。', aliases: ['Enter', '空白行'], control: { type: 'toggle', key: 'extraEnter', defaultValue: false } },
        { name: '自动将粘贴表格转为 Markdown', desc: '仅转换 HTML 表格或制表符表格；也可主动执行「智能粘贴表格」。', aliases: ['Office', 'Excel', 'paste'], control: { type: 'toggle', key: 'pasteTables', defaultValue: false } },
        { name: '自动识别标题的级别', aliases: ['heading'], control: { type: 'dropdown', key: 'autoHeadingLevel', defaultValue: '2', options: { '1': '1 级', '2': '2 级', '3': '3 级', '4': '4 级', '5': '5 级', '6': '6 级' } } },
        { name: '待办状态轮换顺序', desc: '每个半角字符是一个状态，空格表示未完成；允许 2～12 种状态，重复字符会去重。默认顺序以一个空格开头。', aliases: ['任务', 'checkbox', 'task'], control: { type: 'text', key: 'taskStates', defaultValue: DEFAULT_SETTINGS.taskStates, placeholder: DEFAULT_SETTINGS.taskStates, validate: taskStateError } },
      ],
    },
    {
      type: 'group', heading: '颜色槽位', items: [...colors, {
        name: '恢复默认颜色', desc: '恢复五种文字颜色与五种背景颜色。',
        render: setting => { setting.addButton(button => button.setButtonText('恢复').onClick(async () => {
          state.plugin.settings = { ...parseSettings(state.plugin.settings), textColors: [...DEFAULT_SETTINGS.textColors], backgroundColors: [...DEFAULT_SETTINGS.backgroundColors] };
          await state.persist(); refresh();
        })); },
      }],
    },
    {
      name: '保存状态', aliases: ['重试', '保存失败', 'retry'],
      desc: state.failed ? '保存失败，当前输入已保留在内存中。请重试保存后再退出。' : '有效更改会立即保存；可点击按钮再次保存当前设置。',
      render: setting => { setting.addButton(button => button.setButtonText(state.failed ? '重试保存' : '保存当前设置').onClick(async () => { await state.persist(true); refresh(); })); },
    },
  ];
}

export class EditingSettingTab extends PluginSettingTab {
  private readonly editingState: EditingSettingsState;
  constructor(app: App, plugin: EditingPlugin) { super(app, plugin); this.editingState = stateFor(plugin); }

  getSettingDefinitions(): SettingDefinitionItem[] { return definitions(this.editingState, () => { this.update(); }); }
  getControlValue(key: string): unknown { return this.editingState.getValue(key); }
  async setControlValue(key: string, value: unknown): Promise<void> {
    await this.editingState.setValue(key, value);
    this.update();
  }
}

/** 命令打开的独立弹窗复用同一份定义，不调用已弃用的设置页 display()。 */
export function renderEditingSettings(container: HTMLElement, plugin: EditingPlugin): void {
  const state = stateFor(plugin);
  const refresh = (): void => { renderEditingSettings(container, plugin); };
  let refreshSaveStatus = (): void => {};
  container.empty();
  const renderItems = (items: SettingDefinitionItem<SettingKey>[], group: SettingGroup): void => {
    for (const definition of items) {
      if ('type' in definition) {
        if (definition.type === 'group' || definition.type === 'list') {
          const nested = new SettingGroup(container);
          if (definition.heading) nested.setHeading(definition.heading);
          renderItems(definition.items ?? [], nested);
          group = new SettingGroup(container);
        }
        continue;
      }
      group.addSetting(setting => {
        setting.setName(definition.name);
        if (definition.desc) setting.setDesc(definition.desc);
        if (definition.render) {
          definition.render(setting, group);
          if (definition.name === '保存状态') refreshSaveStatus = (): void => {
            setting.clear();
            setting.setDesc(state.failed ? '保存失败，当前输入已保留在内存中。请重试保存后再退出。' : '有效更改会立即保存；可点击按钮再次保存当前设置。');
            definition.render?.(setting, group);
          };
          return;
        }
        if (!definition.control) return;
        const control = definition.control;
        const current = state.getValue(control.key) ?? control.defaultValue;
        const changed = async (value: string | boolean): Promise<void> => {
          const error = await validationError(control, value);
          if (error) { setting.setDesc(`${typeof definition.desc === 'string' ? definition.desc + '\n' : ''}${error}`); return; }
          await state.setValue(control.key, value);
          refreshSaveStatus();
          if (state.failed) setting.setDesc('保存失败，当前输入已保留；可使用下方「保存当前设置」按钮重试。');
          else if (definition.desc) setting.setDesc(definition.desc);
        };
        switch (control.type) {
          case 'toggle': setting.addToggle(component => component.setValue(current === true).onChange(changed)); break;
          case 'dropdown': setting.addDropdown(component => { for (const [key, value] of Object.entries(control.options)) component.addOption(key, value); component.setValue(typeof current === 'string' ? current : '').onChange(changed); }); break;
          case 'color': setting.addColorPicker(component => component.setValue(typeof current === 'string' ? current : '#000000').onChange(changed)); break;
          case 'text': setting.addText(component => component.setValue(typeof current === 'string' ? current : '').setPlaceholder(control.placeholder ?? '').onChange(changed)); break;
        }
      });
    }
  };
  renderItems(definitions(state, refresh), new SettingGroup(container));
}

async function validationError(control: SettingControl<SettingKey>, value: string | boolean): Promise<string | void> {
  if (control.type === 'text' && typeof value === 'string') return control.validate?.(value);
  return undefined;
}
