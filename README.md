# yuhanbo-editing

[中文说明](docs/README.zh-CN.md)

An editing toolkit for Obsidian desktop. It adds heading shortcuts, Markdown formatting, wiki links, Chinese text cleanup, and spreadsheet-to-Markdown paste. It runs on Obsidian 1.14.4 or later on Windows, macOS, and Linux.

## Installation

1. In Obsidian desktop, open **Settings → Community plugins → Browse**, then search for **yuhanbo-editing**, install it, and enable it when it is available in the directory.
2. For manual installation, download `main.js`, `manifest.json`, and `styles.css` from the [latest GitHub release](https://github.com/yuhanbo758/obsidian-yuhanb-editing/releases/latest). Put the three files in `.obsidian/plugins/yuhanbo-editing/` inside your vault, then enable the plugin under **Community plugins**.

## Usage

- With a Markdown editor focused, press `Ctrl+1` through `Ctrl+6` on Windows or Linux, or `Cmd+1` through `Cmd+6` on macOS, to set the heading level for the current line or selected lines. Press the same shortcut again to remove that heading level.
- Open the command palette and search for `yuhanbo-editing` to see available commands. The ribbon icon, editor context menu, and status bar also open the tool picker.
- Open the plugin settings to configure colors, table-paste behavior, and reference shortcuts. User-defined Obsidian hotkeys take precedence over the plugin's default bindings.

## Privacy and permissions

The plugin performs text conversion locally. No account or API key is required. The plugin does not send vault or clipboard data to an external service and does not collect telemetry. The wiki-link matching command indexes Markdown file names in the current vault when invoked. It does not read every note's contents. The plugin reads the vault's hotkey configuration to avoid conflicts and stores its own settings through Obsidian.

Smart paste reads the clipboard when invoked, and the optional paste handler reads only data already attached to the editor's paste event. Copy and calculation commands write results to the clipboard when invoked. The plugin does not directly access files outside the vault. If you choose to embed an HTTP(S) page, Obsidian may contact that site when rendering the resulting iframe. The site can receive ordinary request information such as your IP address.

## Development

Use Node.js 24. Run `npm ci`, `npm run lint`, `npm test`, and `npm run build`. The build emits `main.js` at the project root. GitHub Actions checks and publishes release assets when plugin code or release configuration changes on `main`. Each release tag matches the manifest version.

This project is available under the [MIT license](LICENSE). The bundled OpenCC conversion code and dictionaries are documented in [Third-party notices](THIRD_PARTY_NOTICES.md).
