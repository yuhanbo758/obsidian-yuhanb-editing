interface TextLine {
	text: string;
	eol: string;
	protected: boolean;
}

/** 先标记整块，再处理正文，防止批量编辑误改 YAML、围栏代码和缩进代码。 */
function splitLines(text: string): TextLine[] {
	const matches = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) ?? [];
	if (matches[matches.length - 1] === "") matches.pop();
	let frontmatter = false;
	let fence: { char: string; length: number } | null = null;
	let htmlBlock = "";
	return matches.map((raw, index) => {
		const eol = raw.match(/(?:\r\n|\n|\r)$/)?.[0] ?? "";
		const line = eol ? raw.slice(0, -eol.length) : raw;
		if (index === 0 && /^\uFEFF?---\s*$/.test(line)) {
			frontmatter = true;
			return { text: line, eol, protected: true };
		}
		if (frontmatter) {
			if (/^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false;
			return { text: line, eol, protected: true };
		}
		if (htmlBlock) {
			if (new RegExp(`</${htmlBlock}\\s*>`, "i").test(line)) htmlBlock = "";
			return { text: line, eol, protected: true };
		}
		const htmlStart = line.match(/^\s*<(pre|script|style)\b/i)?.[1];
		if (htmlStart) {
			if (!new RegExp(`</${htmlStart}\\s*>`, "i").test(line)) htmlBlock = htmlStart;
			return { text: line, eol, protected: true };
		}
		const marker = line.match(/^[ \t]{0,3}(?:>\s*)*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/);
		if (fence) {
			if (marker && marker[1]?.[0] === fence.char && marker[1].length >= fence.length && !marker[2]?.trim()) fence = null;
			return { text: line, eol, protected: true };
		}
		if (marker?.[1]) {
			fence = { char: marker[1][0] ?? "`", length: marker[1].length };
			return { text: line, eol, protected: true };
		}
		return { text: line, eol, protected: /^(?: {4}|\t)/.test(line) };
	});
}

function prefixLength(line: string): number {
	return line.match(/^[ \t]*(?:>[ \t]*)*(?:(?:#{1,6}(?:[ \t]+|$))|(?:(?:[-+*]|\d+[.)])[ \t]+(?:\[[^\]\r\n]\][ \t]+)?))?/)?.[0].length ?? 0;
}

function bracketEnd(text: string, start: number, open: string, close: string): number {
	let depth = 0;
	for (let index = start; index < text.length; index++) {
		if (text[index] === "\\") { index++; continue; }
		if (text[index] === open) depth++;
		if (text[index] === close && --depth === 0) return index + 1;
	}
	return -1;
}

function protectedTokenEnd(text: string, index: number): number {
	const tail = text.slice(index);
	if (tail.startsWith("\\") && tail.length > 1) return index + 2;
	if (tail.startsWith("`")) {
		const marker = tail.match(/^`+/)?.[0] ?? "`";
		let end = text.indexOf(marker, index + marker.length);
		while (end >= 0 && (text[end - 1] === "`" || text[end + marker.length] === "`")) end = text.indexOf(marker, end + marker.length);
		return end < 0 ? text.length : end + marker.length;
	}
	if (tail.startsWith("[[") || tail.startsWith("![[")) {
		const end = text.indexOf("]]", index + 2);
		return end < 0 ? text.length : end + 2;
	}
	const linkStart = tail.startsWith("![") ? index + 1 : index;
	if (text[linkStart] === "[") {
		const labelEnd = bracketEnd(text, linkStart, "[", "]");
		if (labelEnd > 0 && text[labelEnd] === "(") {
			const end = bracketEnd(text, labelEnd, "(", ")");
			if (end > 0) return end;
		}
		if (labelEnd > 0 && text[labelEnd] === "[") {
			const end = bracketEnd(text, labelEnd, "[", "]");
			if (end > 0) return end;
		}
	}
	const token = tail.match(/^(?:(?:https?|file|obsidian):\/\/[^\s<>]+|www\.[^\s<>]+|<!--.*?(?:-->|$)|<\/?[A-Za-z][^>]*>|<(?:https?:\/\/|mailto:)[^>]*>)/)?.[0];
	return token ? index + token.length : index;
}

function transformInline(text: string, transform: (text: string) => string): string {
	let result = "";
	let start = 0;
	for (let index = 0; index < text.length;) {
		const end = protectedTokenEnd(text, index);
		if (end > index) {
			result += transform(text.slice(start, index)) + text.slice(index, end);
			index = end;
			start = index;
		} else index++;
	}
	return result + transform(text.slice(start));
}

export function transformProse(text: string, transform: (text: string) => string): string {
	return splitLines(text).map(line => {
		if (line.protected || /^\s*\[[^\]]+\]:\s/.test(line.text)) return line.text + line.eol;
		const prefix = prefixLength(line.text);
		return line.text.slice(0, prefix) + transformInline(line.text.slice(prefix), transform) + line.eol;
	}).join("");
}

export function convertPunctuation(text: string, direction: "zh" | "en"): string {
	let doubleOpen = true;
	let singleOpen = true;
	const toChinese: Record<string, string> = { ",": "，", ".": "。", "?": "？", "!": "！", ":": "：", ";": "；", "(": "（", ")": "）" };
	const toEnglish: Record<string, string> = { "，": ",", "。": ".", "？": "?", "！": "!", "：": ":", "；": ";", "（": "(", "）": ")", "“": '"', "”": '"', "‘": "'", "’": "'", "、": "," };
	return transformProse(text, segment => direction === "en"
		? segment.replace(/[，。？！：；（）“”‘’、]/g, char => toEnglish[char] ?? char)
		: segment.replace(/[,.?!:;()"']/g, (char: string, offset: number) => {
			if ((char === "." || char === "," || char === ":") && /\d/.test(segment[offset - 1] ?? "") && /\d/.test(segment[offset + 1] ?? "")) return char;
			if (char === "'" && /[A-Za-z]/.test(segment[offset - 1] ?? "") && /[A-Za-z]/.test(segment[offset + 1] ?? "")) return char;
			if (char === '"') { const quote = doubleOpen ? "“" : "”"; doubleOpen = !doubleOpen; return quote; }
			if (char === "'") { const quote = singleOpen ? "‘" : "’"; singleOpen = !singleOpen; return quote; }
			return toChinese[char] ?? char;
		}));
}

export function fixMarkdown(text: string): string {
	return splitLines(text).map(line => {
		if (line.protected) return line.text + line.eol;
		const fixed = line.text.replace(/^(\s*\d+)。[ \t]*(?=\S)/, "$1. ");
		const repair = (value: string) => value.replace(/(?:【([^【】\r\n]+)】|\[([^[\]\r\n]+)\])(?:（([^（）\r\n]+)）|\(([^()\r\n]+)\))/g, (match, chineseLabel: string | undefined, label: string | undefined, chineseTarget: string | undefined, target: string | undefined) => {
			const destination = chineseTarget ?? target ?? '';
			if (!chineseLabel && !chineseTarget || /^(?:javascript|data|vbscript):/i.test(destination.trim())) return match;
			return `[${chineseLabel ?? label}](${destination})`;
		})
			.replace(/\[\[([^[\]\r\n]+)\]\]\(\)/g, "[[$1]]");
		let result = "";
		let start = 0;
		// 链接外壳可以修复；代码片段按围栏长度逐段跳过，不向用户文本注入占位符。
		for (let index = 0; index < fixed.length; index++) {
			if (fixed[index] !== "`") continue;
			const end = protectedTokenEnd(fixed, index);
			result += repair(fixed.slice(start, index)) + fixed.slice(index, end);
			index = end - 1;
			start = end;
		}
		return result + repair(fixed.slice(start)) + line.eol;
	}).join("");
}

function isParagraph(line: TextLine): boolean {
	return !line.protected && !!line.text.trim() && !/^(?:\s*(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s|\||[-*_]{3,}\s*$|\[[^\]]+\]:|<)|.*\|.*\|)/.test(line.text);
}

export function joinSoftLines(text: string): string {
	const lines = splitLines(text);
	let result = "";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line) continue;
		const next = lines[index + 1];
		if (next && isParagraph(line) && isParagraph(next) && !/[。！？.!?；;：:…][”’」』）)]*\s*$/.test(line.text) && !/(?: {2}|\\)$/.test(line.text)) {
			const joiner = /[\u3400-\u9fff]$/.test(line.text) && /^[\u3400-\u9fff]/.test(next.text.trimStart()) ? "" : " ";
			result += line.text.trimEnd() + joiner;
			next.text = next.text.trimStart();
		} else result += line.text + line.eol;
	}
	return result;
}

export function adjustBlankLines(text: string, mode: "add" | "remove"): string {
	const lines = splitLines(text);
	const newline = text.match(/\r\n|\n|\r/)?.[0] ?? "\n";
	return lines.map((line, index) => {
		if (mode === "remove" && !line.protected && !line.text.trim()) return "";
		const next = lines[index + 1];
		// 表格行之间插入空行会使表格失效；正文中的管道行保守地保持相邻关系。
		const tableBoundary = /(?<!\\)\|/.test(line.text) || (next && /(?<!\\)\|/.test(next.text));
		const extra = mode === "add" && line.eol && next && !line.protected && !next.protected && !tableBoundary && line.text.trim() && next.text.trim() ? newline : "";
		return line.text + line.eol + extra;
	}).join("");
}

export function chineseSpacing(text: string): string {
	return transformProse(text, segment => segment.replace(/([\u3400-\u9fff])([A-Za-z0-9])/g, "$1 $2").replace(/([A-Za-z0-9])([\u3400-\u9fff])/g, "$1 $2"));
}

export function stripSpaces(text: string): string {
	return transformProse(text, segment => segment.replace(/[ \u3000]+/g, ""));
}

export function autoHeadings(text: string, level: number): string {
	if (!Number.isInteger(level) || level < 1 || level > 6) throw new Error("标题级别必须介于 1 和 6 之间");
	return splitLines(text).map(line => {
		const value = line.text.trim();
		return isParagraph(line) && value.length <= 60 && !/[\p{P}\p{N}\p{S}]$/u.test(value) && !/^\s/.test(line.text)
			? `${"#".repeat(level)} ${line.text}${line.eol}` : line.text + line.eol;
	}).join("");
}

export function extractAnnotations(text: string): string {
	const result: string[] = [];
	let inComment = false;
	let comment = "";
	for (const line of splitLines(text)) {
		if (line.protected) continue;
		if (/^\s*(?:#{1,6}\s|#(?:标注|批注|反思)(?:\s|[:：]|$))/.test(line.text)) result.push(line.text);
		// 行内代码中的 == 和 %% 只属于示例，不纳入标注结果。
		const segments: string[] = [];
		transformInline(line.text, value => { segments.push(value); return value; });
		const prose = segments.join("\uFFFC");
		for (const match of prose.matchAll(/==([^=\n]+)==/g)) if (match[1]) result.push(match[1]);
		const pieces = prose.split("%%");
		for (let index = 0; index < pieces.length; index++) {
			if (inComment) comment += pieces[index] ?? "";
			if (index < pieces.length - 1) {
				if (inComment) { result.push(comment.trim()); comment = ""; }
				inComment = !inComment;
			}
		}
		if (inComment) comment += "\n";
	}
	return [...new Set(result.filter(Boolean))].join("\n");
}

function markdownCell(value: string): string {
	return value.trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

function renderTable(rows: string[][]): string {
	if (!rows.length) return "";
	const columns = Math.max(...rows.map(row => row.length));
	if (columns > 200 || rows.length > 10000) throw new Error("表格过大，请缩小选择范围");
	const render = (row: string[]) => `| ${Array.from({ length: columns }, (_, index) => markdownCell(row[index] ?? "")).join(" | ")} |`;
	return [render(rows[0] ?? []), `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`, ...rows.slice(1).map(render)].join("\n");
}

export function tsvToMarkdown(text: string): string {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === '"') {
			if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
			else if (quoted || cell === "") quoted = !quoted;
			else cell += char;
		} else if (!quoted && (char === "\t" || char === "\r" || char === "\n")) {
			row.push(cell); cell = "";
			if (char !== "\t") {
				rows.push(row); row = [];
				if (char === "\r" && text[index + 1] === "\n") index++;
			}
		} else cell += char;
	}
	if (quoted) throw new Error("表格包含未闭合的引号单元格");
	if (cell || row.length || !rows.length) { row.push(cell); rows.push(row); }
	return renderTable(rows);
}

export function htmlTableToMarkdown(html: string, document: Document): string {
	const Parser = document.defaultView?.DOMParser;
	if (!Parser) throw new Error("当前环境不支持 HTML 表格解析");
	// 离线解析且从不挂载节点；先去掉可能加载外部资源的标签，避免剪贴板触发联网。
	const safeHtml = html.replace(/<(script|style|iframe|object|embed|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
		.replace(/<(?:img|iframe|frame|object|embed|video|audio|source|link|base)\b[^>]*>/gi, "");
	const parsed = new Parser().parseFromString(safeHtml, "text/html");
	const tables = parsed.querySelectorAll("table");
	if (tables.length !== 1) throw new Error(tables.length ? "请一次只复制一个表格，暂不支持嵌套表格" : "剪贴板中没有 HTML 表格");
	const table = tables[0];
	if (!table) return "";
	const rows: string[][] = [];
	const occupied: boolean[][] = [];
	const sourceRows = Array.from(table.querySelectorAll("tr"));
	if (sourceRows.length > 10000) throw new Error("表格过大，请缩小选择范围");
	for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex++) {
		rows[rowIndex] ??= [];
		occupied[rowIndex] ??= [];
		let column = 0;
		const sourceRow = sourceRows[rowIndex];
		if (!sourceRow) continue;
		for (const cell of Array.from(sourceRow.children).filter(node => /^(?:TD|TH)$/.test(node.tagName))) {
			while (occupied[rowIndex]?.[column]) column++;
			const rowSpan = Number(cell.getAttribute("rowspan") ?? 1);
			const colSpan = Number(cell.getAttribute("colspan") ?? 1);
			if (!Number.isInteger(rowSpan) || !Number.isInteger(colSpan) || rowSpan < 1 || colSpan < 1 || rowSpan > 1000 || colSpan > 200 || column + colSpan > 200) throw new Error("表格合并范围无效或过大");
			if (rowIndex + rowSpan > sourceRows.length) throw new Error("表格的合并单元格超出实际行数");
			for (let y = 0; y < rowSpan; y++) {
				rows[rowIndex + y] ??= [];
				occupied[rowIndex + y] ??= [];
				for (let x = 0; x < colSpan; x++) {
					if (occupied[rowIndex + y]?.[column + x]) throw new Error("表格的合并单元格相互重叠");
					occupied[rowIndex + y]![column + x] = true;
					rows[rowIndex + y]![column + x] = y === 0 && x === 0 ? cellText(cell) : "";
				}
			}
			column += colSpan;
		}
	}
	return renderTable(rows);
}

function cellText(node: Node): string {
	if (node.nodeType === 3) return node.textContent ?? "";
	if (node.nodeType !== 1) return "";
	const element = node as Element;
	if (/^(?:SCRIPT|STYLE|TEMPLATE|NOSCRIPT)$/.test(element.tagName)) return "";
	if (element.tagName === "BR") return "\n";
	return Array.from(node.childNodes).map(cellText).join("") + (/^(?:P|DIV)$/.test(element.tagName) ? "\n" : "");
}

export function parseTimestamp(text: string): number | null {
	const match = text.match(/(?:^|[^\d:])(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?(?![\d:])/);
	if (!match) return null;
	const hours = Number(match[1] ?? 0);
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	if (seconds > 59 || (match[1] !== undefined && minutes > 59)) return null;
	return hours * 3600 + minutes * 60 + seconds + Number(`0.${match[4] ?? "0"}`);
}
