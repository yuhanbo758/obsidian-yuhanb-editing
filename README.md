# yuhanbo-editing

[中文快速开始](#中文快速开始) · [完整中文说明](docs/README.zh-CN.md) · [Obsidian Community](https://community.obsidian.md/plugins/yuhanbo-editing)

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

## 中文快速开始

`yuhanbo-editing` 适合经常在 Obsidian 桌面端编辑中文笔记、调整 Markdown 格式或整理表格的用户。插件支持快捷键切换标题、批量转换双链、简繁与标点转换，以及将剪贴板表格粘贴为 Markdown。需要 Obsidian 1.14.4 或更高版本。

1. **安装**：在「设置 → 社区插件 → 浏览」搜索 `yuhanbo-editing`，安装后启用。手动安装可从 [GitHub Releases](https://github.com/yuhanbo758/obsidian-yuhanb-editing/releases/latest) 下载 `main.js`、`manifest.json` 和 `styles.css`。
2. **使用**：在 Markdown 编辑区按 `Ctrl/Cmd+1～6` 切换标题级别，或打开命令面板搜索 `yuhanbo-editing` 查看全部命令。自定义快捷键优先。
3. **隐私**：文字处理在本地完成，无须账号或 API 密钥。智能粘贴和复制命令按需访问剪贴板。主动嵌入网页时，Obsidian 渲染该网页会访问对应站点。

全部功能、快捷键和设置见[完整中文说明](docs/README.zh-CN.md)。

<!-- sanrenjz-promotion:start -->
## 👨‍💻 作者信息

**余汉波** - 编程爱好者-量化交易和效率工具开发

- **GitHub**: [@yuhanbo758](https://github.com/yuhanbo758)

- **Email**: yuhanbo@sanrenjz.com

- **Website**: [三人聚智](https://www.sanrenjz.com)

## 🌐 相关链接

- 🏠 [项目主页](https://www.sanrenjz.com)

- 📚 [在线文档](https://docs.sanrenjz.com)（财经、代码和库文档等）

- 🛒 [插件商店](https://shop.sanrenjz.com)（所有程序，包括开源和不开源）


## 联系我们

[联系我们 - 三人聚智-余汉波](https://www.sanrenjz.com/contact_us/)

证券开户（+V：yuhanbo758）：[证券开户免5万0.854，无门槛开量化QMT，送框架策略，支持VIP快速通道，也可开Ptrade | 余汉波 文档](https://docs.sanrenjz.com/article/%E8%AF%81%E5%88%B8%E5%BC%80%E6%88%B7%E5%85%8D5%20%E4%B8%870.854%EF%BC%8C%E6%97%A0%E9%97%A8%E6%A7%9B%E5%BC%80%E9%87%8F%E5%8C%96QMT%EF%BC%8C%E9%80%81%E6%A1%86%E6%9E%B6%E7%AD%96%E7%95%A5%EF%BC%8C%E6%94%AF%E6%8C%81VIP%E5%BF%AB%E9%80%9F%E9%80%9A%E9%81%93%EF%BC%8C%E4%B9%9F%E5%8F%AF%E5%BC%80Ptrade)

三人聚智下载：[sanrenjz - 三人聚智](https://www.sanrenjz.com/sanrenjz/)

codebot 下载：[sanrenjz-codebot - 三人聚智-余汉波](https://www.sanrenjz.com/sanrenjz-codebot/)

![三码合一](https://gdsx.sanrenjz.com/image/sanrenjz_yuhanbolh_yuhanbo758.png?imageSlim&t=1ab9b82c-e220-8022-beff-e265a194292a)

![余汉波打赏码](https://gdsx.sanrenjz.com/image/%E6%89%93%E8%B5%8F%E7%A0%81%E5%90%88%E4%B8%80.png?imageSlim)

## 🙏 致谢

感谢所有为本项目贡献代码和想法的开发者们！

---
**⭐ 如果这个项目对您有帮助，请给它一个 Star！**
<!-- sanrenjz-promotion:end -->
