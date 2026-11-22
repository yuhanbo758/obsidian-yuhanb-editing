import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';
export default defineConfig(
  globalIgnores(['node_modules', 'dist', 'scripts', 'tests', 'docs/evidence', 'esbuild.config.mjs', 'versions.json', 'main.js', 'package.json', 'package-lock.json', 'tsconfig.json']),
  { languageOptions: { globals: { ...globals.browser }, parserOptions: {
    projectService: { allowDefaultProject: ['eslint.config.mts', 'manifest.json'] },
    tsconfigRootDir: import.meta.dirname, extraFileExtensions: ['.json'],
  } } },
  ...obsidianmd.configs.recommended,
  // 用户明确要求六个标题快捷键；其余命令仍不设默认值，测试核对实际清单。
  { files: ['src/main.ts'], rules: { 'obsidianmd/commands/no-default-hotkeys': 'off' } },
);
