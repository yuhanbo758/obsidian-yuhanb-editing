import type { Hotkey } from 'obsidian';

const MODIFIERS = new Set(['Mod', 'Ctrl', 'Meta', 'Shift', 'Alt']);

function chord(modifiers: string[], key: string, mac: boolean): string {
  const effective = new Set(modifiers.map(modifier => modifier === 'Mod' ? mac ? 'Meta' : 'Ctrl' : modifier));
  return `${[...effective].sort().join('+')}:${key.toUpperCase()}`;
}

/** 用户明示的其他命令键位，以及本插件命令的重绑/清空，均优先于正文默认键。 */
export function parseCustomHotkeys(raw: string, pluginId: string, mac: boolean): (id: string, hotkey: Hotkey) => boolean {
  const value: unknown = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('快捷键配置格式不正确');
  const customized = new Set<string>();
  const reserved = new Set<string>();
  for (const [id, bindings] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(bindings)) continue;
    customized.add(id);
    for (const binding of bindings as unknown[]) {
      if (!binding || typeof binding !== 'object') continue;
      const { key, modifiers } = binding as Partial<Hotkey>;
      if (typeof key !== 'string' || !Array.isArray(modifiers) || !modifiers.every(modifier => MODIFIERS.has(modifier))) continue;
      reserved.add(chord(modifiers, key, mac));
    }
  }
  return (id, hotkey) => customized.has(`${pluginId}:${id}`) || reserved.has(chord(hotkey.modifiers, hotkey.key, mac));
}
