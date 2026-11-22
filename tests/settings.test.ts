import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import type { EditingSettings } from '../src/settings.ts';

interface Definition {
  name?: string;
  type?: string;
  heading?: string;
  items?: Definition[];
  control?: { key: string; type: string; defaultValue?: unknown; validate?: (value: string) => string | undefined };
  desc?: string;
  render?: (setting: unknown) => void;
}
interface SettingsTab {
  getSettingDefinitions(): Definition[];
  getControlValue(key: string): unknown;
  setControlValue(key: string, value: unknown): Promise<void>;
}
interface SettingsModule {
  DEFAULT_SETTINGS: EditingSettings;
  parseSettings(data: unknown): EditingSettings;
  EditingSettingTab: new (app: unknown, plugin: unknown) => SettingsTab;
  renderEditingSettings(container: unknown, plugin: unknown): void;
}

class MockControl {
  value: unknown;
  text = '';
  change: (value: string | boolean) => Promise<void> = async () => {};
  click: () => Promise<void> = async () => {};
  setValue(value: unknown): this { this.value = value; return this; }
  setButtonText(value: string): this { this.text = value; return this; }
  setPlaceholder(): this { return this; }
  addOption(): this { return this; }
  onChange(callback: (value: string | boolean) => Promise<void>): this { this.change = callback; return this; }
  onClick(callback: () => Promise<void>): this { this.click = callback; return this; }
}
class MockSetting {
  name = '';
  desc = '';
  controls: MockControl[] = [];
  setName(name: string): this { this.name = name; return this; }
  setDesc(desc: string): this { this.desc = desc; return this; }
  clear(): this { this.controls = []; return this; }
  private add(callback: (control: MockControl) => void): this { const control = new MockControl(); this.controls.push(control); callback(control); return this; }
  addButton(callback: (control: MockControl) => void): this { return this.add(callback); }
  addText(callback: (control: MockControl) => void): this { return this.add(callback); }
  addToggle(callback: (control: MockControl) => void): this { return this.add(callback); }
  addDropdown(callback: (control: MockControl) => void): this { return this.add(callback); }
  addColorPicker(callback: (control: MockControl) => void): this { return this.add(callback); }
}
interface MockContainer { rows: MockSetting[]; empty(): void; }
class MockSettingGroup {
  constructor(private container: MockContainer) {}
  setHeading(): this { return this; }
  addSetting(callback: (setting: MockSetting) => void): this { const setting = new MockSetting(); this.container.rows.push(setting); callback(setting); return this; }
}

const notices: string[] = [];
const output = await build({ entryPoints: ['src/settings.ts'], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'] });
const context = vm.createContext({
  module: { exports: {} },
  require: () => ({
    PluginSettingTab: class { update(): void {} },
    SettingGroup: MockSettingGroup,
    Notice: class { constructor(message: string) { notices.push(message); } },
  }),
});
vm.runInContext(output.outputFiles[0]?.text ?? '', context);
const settings = (context.module as { exports: SettingsModule }).exports;
// 在同一个 realm 调用解析器，避免 VM 边界给普通 JSON 的原型检查引入假差异。
const parse = (value: unknown): EditingSettings => {
  context.inputValue = JSON.stringify(value);
  return vm.runInContext('module.exports.parseSettings(inputValue === undefined ? undefined : JSON.parse(inputValue))', context) as EditingSettings;
};
const flatten = (definitions: Definition[]): Definition[] => definitions.flatMap(item => [item, ...flatten(item.items ?? [])]);

test('设置拒绝无效根结构并提供完整默认值', () => {
  for (const value of [undefined, null, true, 'text', [], 3]) {
    const parsed = parse(value);
    assert.equal(JSON.stringify(parsed), JSON.stringify(settings.DEFAULT_SETTINGS));
  }
});
test('解析结果与默认颜色数组互不共享', () => {
  const first = parse(undefined);
  const second = parse(undefined);
  assert.notEqual(first.textColors, second.textColors);
  assert.notEqual(first.backgroundColors, settings.DEFAULT_SETTINGS.backgroundColors);
  first.textColors[0] = '#000000';
  assert.equal(second.textColors[0], '#e03131');
  assert.equal(settings.DEFAULT_SETTINGS.textColors[0], '#e03131');
});

test('新安装和缺少快捷键字段的旧配置默认启用全部参考按键，保留其他设置', () => {
  const fresh = parse(undefined);
  assert.equal(fresh.referenceShortcuts.length, 39);
  assert.equal(new Set(fresh.referenceShortcuts).size, 39);
  const old = parse({ extraEnter: true, pasteTables: true, headingKeys: false, autoHeadingLevel: 5, taskStates: ' x!', textColors: ['#abcdef'] });
  assert.deepEqual(Array.from(old.referenceShortcuts), Array.from(fresh.referenceShortcuts));
  assert.equal(old.extraEnter, true); assert.equal(old.pasteTables, true); assert.equal(old.headingKeys, false);
  assert.equal(old.autoHeadingLevel, 5); assert.equal(old.taskStates, ' x!'); assert.equal(old.textColors[0], '#abcdef');
  fresh.referenceShortcuts.length = 0;
  assert.equal(parse(undefined).referenceShortcuts.length, 39);
  assert.equal(settings.DEFAULT_SETTINGS.referenceShortcuts.length, 39);
});

test('用户后续主动关闭或仅保留个别快捷键时不被默认值重置', () => {
  assert.deepEqual(Array.from(parse({ referenceShortcuts: [] }).referenceShortcuts), []);
  assert.deepEqual(Array.from(parse({ referenceShortcuts: ['bold', 'invalid', 'bold'] }).referenceShortcuts), ['bold']);
});
test('颜色逐槽校验且不接受 CSS 注入', () => {
  const parsed = parse({ textColors: ['#ABCDEF', 'red', '#fff', 'url(x)', 5, '#000000'], backgroundColors: null });
  assert.deepEqual(Array.from(parsed.textColors), ['#abcdef', ...Array.from(settings.DEFAULT_SETTINGS.textColors).slice(1)]);
  assert.equal(parsed.backgroundColors.length, 5);
});
test('设置严格解析开关和标题级别', () => {
  const parsed = parse({ extraEnter: 'true', pasteTables: 1, autoHeadingLevel: '3' });
  assert.equal(parsed.extraEnter, false);
  assert.equal(parsed.pasteTables, false);
  assert.equal(parsed.autoHeadingLevel, 2);
  assert.equal(parse({ extraEnter: true, pasteTables: true, autoHeadingLevel: 6 }).autoHeadingLevel, 6);
  for (const level of [0, 7, 2.5, null]) assert.equal(parse({ autoHeadingLevel: level }).autoHeadingLevel, 2);
});
test('标题键组兼容旧配置，只有显式 false 才关闭', () => {
  assert.equal(parse({ extraEnter: true }).headingKeys, true);
  assert.equal(parse(undefined).headingKeys, true);
  assert.equal(parse({ headingKeys: false }).headingKeys, false);
  assert.equal(parse({ headingKeys: true }).headingKeys, true);
  for (const value of [null, 0, 1, '', 'false', 'true', [], {}]) assert.equal(parse({ headingKeys: value }).headingKeys, true);
  const persisted = JSON.parse(JSON.stringify(parse({ headingKeys: false, pasteTables: true }))) as EditingSettings;
  assert.equal(parse(persisted).headingKeys, false);
  assert.equal(parse(persisted).pasteTables, true);
});
test('任务状态按原顺序去重并拒绝不可用状态', () => {
  assert.equal(parse({ taskStates: ' xx--!!?? ' }).taskStates, ' x-!?');
  assert.equal(parse({ taskStates: ' /x' }).taskStates, ' /x');
  for (const value of ['x', 'xx', '[]', ' x\n', ' x\\', ' 中文', 'abcdefghijklmnop']) assert.equal(parse({ taskStates: value }).taskStates, settings.DEFAULT_SETTINGS.taskStates);
});
test('配置不继承未知原型字段或执行访问器', () => {
  const result = vm.runInContext('module.exports.parseSettings(Object.create({ extraEnter: true }))', context) as EditingSettings;
  assert.equal(result.extraEnter, false);
  assert.doesNotThrow(() => vm.runInContext('module.exports.parseSettings({ get taskStates() { throw new Error("must not run") } })', context));
});
test('声明式定义包含可搜索的行为、十个颜色槽位与状态校验', () => {
  const plugin = { settings: parse(undefined), saveSettings: async () => {} };
  const tab = new settings.EditingSettingTab({}, plugin);
  const items = flatten(tab.getSettingDefinitions());
  assert.equal(items.filter(item => item.control?.type === 'color').length, 10);
  assert.equal(items.find(item => item.control?.key === 'taskStates')?.control?.validate?.('xx')?.includes('2～12'), true);
  assert.equal(items.find(item => item.control?.key === 'taskStates')?.control?.validate?.(' x-'), undefined);
  assert.equal(items.some(item => item.name === '自动将粘贴表格转为 Markdown'), true);
  assert.equal(tab.getControlValue('autoHeadingLevel'), '2');
});
test('无效设置变更不会落盘或覆盖现值', async () => {
  let writes = 0;
  const plugin = { settings: parse(undefined), saveSettings: async () => { writes++; } };
  const tab = new settings.EditingSettingTab({}, plugin);
  await assert.rejects(tab.setControlValue('textColors.0', '#fff'), /颜色/);
  await assert.rejects(tab.setControlValue('autoHeadingLevel', '9'), /标题/);
  await assert.rejects(tab.setControlValue('taskStates', 'xx'), /2～12/);
  await assert.rejects(tab.setControlValue('headingKeys', 'false'), /开关值无效/);
  await assert.rejects(tab.setControlValue('headingKeys', 0), /开关值无效/);
  await assert.rejects(tab.setControlValue('__proto__', true), /未知/);
  assert.equal(writes, 0);
  assert.equal(plugin.settings.textColors[0], '#e03131');
  assert.equal(plugin.settings.headingKeys, true);
});
test('声明式设置页切换标题键组并持久化，保留其他设置', async () => {
  const saved: EditingSettings[] = [];
  const initial = parse({ extraEnter: true, pasteTables: true, autoHeadingLevel: 4, taskStates: ' /x', textColors: ['#123456'] });
  const original = JSON.parse(JSON.stringify(initial)) as EditingSettings;
  const plugin = { settings: initial, saveSettings: async () => { saved.push(JSON.parse(JSON.stringify(plugin.settings)) as EditingSettings); } };
  const tab = new settings.EditingSettingTab({}, plugin);
  const definition = flatten(tab.getSettingDefinitions()).find(item => item.control?.key === 'headingKeys');
  assert.equal(definition?.name, '编辑器内优先使用标题快捷键');
  assert.equal(definition?.control?.type, 'toggle');
  assert.equal(definition?.control?.defaultValue, true);
  assert.equal(tab.getControlValue('headingKeys'), true);
  await tab.setControlValue('headingKeys', false);
  assert.equal(tab.getControlValue('headingKeys'), false);
  assert.deepEqual(saved[0], { ...original, headingKeys: false });
  assert.equal(parse(saved[0]).headingKeys, false);
  await tab.setControlValue('headingKeys', true);
  assert.equal(tab.getControlValue('headingKeys'), true);
  assert.deepEqual(saved[1], original);
});
test('保存失败保留输入并通过重试保存落盘', async () => {
  let fail = true;
  let writes = 0;
  const plugin = { settings: parse(undefined), saveSettings: async () => { writes++; if (fail) throw new Error('disk failed'); } };
  const tab = new settings.EditingSettingTab({}, plugin);
  await tab.setControlValue('taskStates', ' xx--');
  assert.equal(plugin.settings.taskStates, ' x-');
  assert.equal(notices.at(-1)?.includes('输入已保留'), true);
  const save = flatten(tab.getSettingDefinitions()).find(item => item.name === '保存状态');
  assert.equal(save?.desc?.includes('保存失败'), true);
  let click: (() => Promise<void>) | undefined;
  save?.render?.({ addButton(callback: (button: unknown) => void) { const button = { setButtonText() { return button; }, onClick(handler: () => Promise<void>) { click = handler; return button; } }; callback(button); } });
  fail = false;
  assert.ok(click);
  await click();
  assert.equal(writes, 2);
  assert.equal(flatten(tab.getSettingDefinitions()).find(item => item.name === '保存状态')?.desc?.includes('保存失败'), false);
});
test('独立设置弹窗保留非法输入反馈，并在落盘失败后显示重试按钮', async () => {
  let fail = true;
  let writes = 0;
  const plugin = { settings: parse(undefined), saveSettings: async () => { writes++; if (fail) throw new Error('disk failed'); } };
  const container: MockContainer = { rows: [], empty() { this.rows = []; } };
  settings.renderEditingSettings(container, plugin);
  assert.equal(container.rows.at(-1)?.name, '保存状态');
  const row = container.rows.find(setting => setting.name === '待办状态轮换顺序');
  assert.ok(row?.controls[0]);
  await row.controls[0].change('xx');
  assert.equal(writes, 0);
  assert.equal(row.desc.includes('2～12'), true);
  await row.controls[0].change(' x-');
  assert.equal(plugin.settings.taskStates, ' x-');
  assert.equal(row.desc.includes('保存失败'), true);
  const save = container.rows.at(-1);
  assert.equal(save?.controls[0]?.text, '重试保存');
  fail = false;
  await save?.controls[0]?.click();
  assert.equal(writes, 2);
  assert.equal(container.rows.at(-1)?.controls[0]?.text, '保存当前设置');
});
test('独立设置弹窗可切换标题键组且重新打开保持保存值', async () => {
  const saved: EditingSettings[] = [];
  const initial = parse({ extraEnter: true, pasteTables: true, autoHeadingLevel: 5, taskStates: ' x!', backgroundColors: ['#abcdef'] });
  const original = JSON.parse(JSON.stringify(initial)) as EditingSettings;
  const plugin = { settings: initial, saveSettings: async () => { saved.push(JSON.parse(JSON.stringify(plugin.settings)) as EditingSettings); } };
  const container: MockContainer = { rows: [], empty() { this.rows = []; } };
  settings.renderEditingSettings(container, plugin);
  const control = container.rows.find(row => row.name === '编辑器内优先使用标题快捷键')?.controls[0];
  assert.ok(control);
  assert.equal(control.value, true);
  await control.change(false);
  assert.equal(plugin.settings.headingKeys, false);
  assert.deepEqual(saved[0], { ...original, headingKeys: false });
  plugin.settings = parse(saved[0]);
  settings.renderEditingSettings(container, plugin);
  const reopened = container.rows.find(row => row.name === '编辑器内优先使用标题快捷键')?.controls[0];
  assert.ok(reopened);
  assert.equal(reopened.value, false);
  await reopened.change(true);
  assert.deepEqual(saved[1], original);
});
