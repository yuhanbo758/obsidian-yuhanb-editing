import { expandCallout } from './callouts';

/** 这些转换仅处理调用者交付的编辑范围；文档区域保护由编辑器适配层统一负责。 */
export function toggleHeading(line: string, level: number): string {
	if (!Number.isInteger(level) || level < 1 || level > 6) throw new RangeError('标题级别必须为 1 至 6。');
	const prefix = /^( {0,3}(?:>[ \t]? {0,3})*)/.exec(line)?.[0] ?? '';
	const body = line.slice(prefix.length);
	const heading = /^(#{1,6})(?:[ \t]+|$)(.*)$/.exec(body);
	if (heading) return prefix + (heading[1]?.length === level ? '' : '#'.repeat(level) + ' ') + (heading[2] ?? '');
	return prefix + '#'.repeat(level) + ' ' + body;
}

function inlineCode(text: string): string {
	const wrapped = /^(`+)([\s\S]*?)\1$/.exec(text);
	if (wrapped && wrapped[2] !== undefined && !/^`|`$/.test(wrapped[2]) && !(wrapped[2].match(/`+/g) ?? []).some(run => run.length === wrapped[1]?.length)) {
		const inner = wrapped[2];
		return inner.startsWith(' ') && inner.endsWith(' ') && /\S/.test(inner) ? inner.slice(1, -1) : inner;
	}
	const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(longest + 1);
	// 边界反引号和有意义的首尾空格需要额外 padding，防止 Markdown 吞并分隔符或空格。
	const padding = /^`|`$/.test(text) || (/^ .* $/.test(text) && /\S/.test(text)) ? ' ' : '';
	return fence + padding + text + padding + fence;
}

export function toggleWrapper(text: string, open: string, close: string): string {
	if (!open && !close) return text;
	if (open === '`' && close === '`') return inlineCode(text);
	if (['**', '*', '_', '__', '~~', '==', '%%'].includes(open) && open === close) {
		const boundary = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
		if (boundary?.[2] && (boundary[1] || boundary[3])) {
			return (boundary[1] ?? '') + toggleWrapper(boundary[2], open, close) + (boundary[3] ?? '');
		}
	}
	if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
		return text.slice(open.length, close.length ? -close.length : undefined);
	}
	return open + text + close;
}

export function toggleCodeBlock(text: string, language = ''): string {
	const firstBreak = text.indexOf('\n');
	const finalBreak = text.lastIndexOf('\n');
	if (firstBreak >= 0) {
		const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?$/.exec(text.slice(0, firstBreak));
		const ending = /^ {0,3}(`+|~+)[ \t]*$/.exec(text.slice(finalBreak + 1));
		const startFence = opening?.[1];
		const endFence = ending?.[1];
		const body = firstBreak === finalBreak ? '' : text.slice(firstBreak + 1, finalBreak).replace(/\r$/, '');
		if (startFence && endFence && endFence[0] === startFence[0] && endFence.length >= startFence.length) {
			const closesEarly = body.split(/\r?\n/).some(line => {
				const candidate = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
				return candidate !== undefined && candidate[0] === startFence[0] && candidate.length >= startFence.length;
			});
			if (!closesEarly) return body;
		}
	}
	if (!/^[\w+-]*$/.test(language)) throw new Error('代码语言只能包含字母、数字、下划线、加号或连字符。');
	const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length));
	const fence = '`'.repeat(longest + 1);
	return fence + language + '\n' + text + '\n' + fence;
}

export function cycleTask(line: string, states: string[]): string {
	const valid = [...new Set(states.filter(state => state.length === 1 && !/[\r\n\]]/.test(state)))];
	const cycle = valid.length ? valid : [' ', 'x'];
	const task = /^([ \t]*(?:>[ \t]*)*)([-+*]|\d+[.)])[ \t]+\[([^\]\r\n])\][ \t]?(.*)$/.exec(line);
	if (task) {
		const next = cycle[(cycle.indexOf(task[3] ?? '') + 1) % cycle.length] ?? ' ';
		return `${task[1] ?? ''}${task[2] ?? '-'} [${next}] ${task[4] ?? ''}`;
	}
	const list = /^([ \t]*(?:>[ \t]*)*)([-+*]|\d+[.)])[ \t]+(.*)$/.exec(line);
	if (list) return `${list[1] ?? ''}${list[2] ?? '-'} [${cycle[0] ?? ' '}] ${list[3] ?? ''}`;
	const prefix = /^[ \t]*(?:>[ \t]*)*/.exec(line)?.[0] ?? '';
	return `${prefix}- [${cycle[0] ?? ' '}] ${line.slice(prefix.length)}`;
}

export function toggleWikiLinks(text: string, alias = false): string {
	if (!text) return alias ? '[[|]]' : '[[]]';
	const parts: string[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		// 已有链接的目标或显示别名可以包含顿号，不能把链接内部也当成批量分隔符切开。
		if (text.startsWith('[[', index)) {
			const end = text.indexOf(']]', index + 2);
			if (end >= 0 && !/[\r\n]/.test(text.slice(index, end))) { index = end + 1; continue; }
		}
		if (text[index] !== '、' && text[index] !== '\n' && !(text[index] === '\r' && text[index + 1] === '\n')) continue;
		parts.push(text.slice(start, index));
		const length = text[index] === '\r' ? 2 : 1;
		parts.push(text.slice(index, index + length));
		index += length - 1;
		start = index + 1;
	}
	parts.push(text.slice(start));
	return parts.map(part => {
		if (/^(?:\r?\n|、)$/.test(part)) return part;
		const leading = /^[ \t]*/.exec(part)?.[0] ?? '';
		const trailing = /[ \t]*$/.exec(part)?.[0] ?? '';
		const content = part.trim();
		if (!content) return part;
		const existing = /^\[\[([^\][\r\n]+)\]\]$/.exec(content);
		if (existing) {
			const inside = existing[1] ?? '';
			return leading + (inside.includes('|') ? inside.slice(inside.indexOf('|') + 1) : inside) + trailing;
		}
		if (/[<>:"/\\|?*[\]]/.test(content) || [...content].some(character => character.charCodeAt(0) < 32)) return part;
		return leading + (alias ? `[[|${content}]]` : `[[${content}]]`) + trailing;
	}).join('');
}

export function stripMarkdown(text: string): string {
	if (/^---[ \t]*\r?\n/.test(text) && !/^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/.test(text)) return text;
	const preserved: string[] = [];
	let marker = '\uE000';
	while (text.includes(marker)) marker += '\uE000';
	const hold = (value: string): string => `${marker}${preserved.push(value) - 1}\uE001`;
	// 先隔离元数据和代码，再处理标记，避免把代码里的 *、[]、< 比较符当作格式删除。
	let working = text.replace(/^(---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?=\r?\n|$))/, match => hold(match));
	working = working.replace(/<(pre|code)(?:\s[^<>]*?)?>([\s\S]*?)<\/\1\s*>/gi, (_match, tag: string, inner: string) => {
		const content = tag.toLowerCase() === 'pre' ? inner.replace(/^<code(?:\s[^<>]*?)?>|<\/code>$/gi, '') : inner;
		return hold(content);
	});
	const lines = working.split('\n');
	const chunks: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? '';
		if (/^(?: {4}|\t)/.test(line)) {
			chunks.push(hold(line));
			continue;
		}
		const fence = /^( {0,3})(`{3,}|~{3,})[^\r\n]*\r?$/.exec(line);
		if (!fence) {
			chunks.push(line);
			continue;
		}
		const delimiter = fence[2] ?? '```';
		let end = index + 1;
		for (; end < lines.length; end++) {
			const closing = /^( {0,3})(`+|~+)[ \t]*\r?$/.exec(lines[end] ?? '');
			const closingDelimiter = closing?.[2];
			if (closingDelimiter && closingDelimiter[0] === delimiter[0] && closingDelimiter.length >= delimiter.length) break;
		}
		if (end >= lines.length) {
			chunks.push(hold(lines.slice(index).join('\n')));
			break;
		}
		chunks.push(hold(lines.slice(index + 1, end).join('\n')));
		index = end;
	}
	working = chunks.join('\n');
	working = working.replace(/(?<!`)(`+)([\s\S]*?)\1(?!`)/g, (_match, _fence: string, inner: string) => {
		const content = inner.startsWith(' ') && inner.endsWith(' ') && /\S/.test(inner) ? inner.slice(1, -1) : inner;
		return hold(content);
	});
	working = working.replace(/\\([\\`*{}[\]()#+\-.!_>~|=])/g, (_match, literal: string) => hold(literal));
	working = working.replace(/!?\[\[([^\][\n]+)\]\]/g, (_match, inner: string) => inner.includes('|') ? inner.slice(inner.indexOf('|') + 1) : inner);
	working = working.replace(/!?\[([^\]\n]*)\]\((?:[^()\\]|\\.|\([^()]*\))*\)/g, '$1');
	working = working.replace(/!?\[([^\]\n]+)\]\[[^\]\n]*\]/g, '$1');
	working = working.replace(/^ {0,3}\[[^\]\n]+\]:[ \t]+\S+.*$/gm, '');
	working = working.replace(/<((?:https?:\/\/|mailto:)[^<>\s]+)>/g, '$1');
	working = working.replace(/<br\s*\/?>/gi, '\n');
	// 标签属性也必须符合 HTML 形状；不能把 a<b && c>d 中的 <b && c> 当作粗体标签。
	const attributes = /^(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?$/;
	working = working.replace(/<\/?(?:span|u|sup|sub|mark|strong|em|del|s|b|i|a)([^<>]*)>/gi, (match, tail: string) => attributes.test(tail) ? '' : match);
	working = working.replace(/<\/?(?:p|div|section|article|blockquote|li|ul|ol|h[1-6])([^<>]*)>/gi, (match, tail: string) => attributes.test(tail) ? '\n' : match);
	working = working.replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, '$1');
	working = working.replace(/^ {0,3}(?:>[ \t]?)+/gm, '');
	working = working.replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/gm, '');
	working = working.replace(/^[ \t]*=+[ \t]*\r?$/gm, '');
	working = working.replace(/^( {0,3})(?:[-+*]|\d+[.)])[ \t]+(?:\[[^\]\n]\][ \t]*)?/gm, '$1');
	working = working.replace(/^ {0,3}(?:[-*_][ \t]*){3,}\r?$/gm, '');
	for (let pass = 0; pass < 3; pass++) {
		working = working.replace(/(\*\*|__|~~|==|%%)(?=\S)([\s\S]*?\S)\1/g, '$2');
		working = working.replace(/(?<!\*)\*(\S(?:[^\n]*?\S)?)\*(?!\*)/g, '$1');
		working = working.replace(/(?<![\p{L}\p{N}\\])_(\S(?:[^\n]*?\S)?)_(?![\p{L}\p{N}])/gu, '$1');
	}
	const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return working.replace(new RegExp(`${escapedMarker}(\\d+)\\uE001`, 'g'), (_match, index: string) => preserved[Number(index)] ?? '');
}

function validateColor(color: string): string {
	if (!/^#[\da-f]{6}$/i.test(color)) throw new Error('颜色必须是六位十六进制值。');
	return color.toLowerCase();
}

export function setColor(text: string, color: string, background = false): string {
	const safeColor = validateColor(color);
	const property = background ? 'background-color' : 'color';
	const span = /^<span style="(color|background-color):\s*(#[\da-f]{6});?">([\s\S]*)<\/span>$/i.exec(text);
	if (span?.[1] === property) {
		const content = span[3] ?? '';
		return span[2]?.toLowerCase() === safeColor ? content : `<span style="${property}: ${safeColor}">${content}</span>`;
	}
	return `<span style="${property}: ${safeColor}">${text}</span>`;
}

const BRACKETS: ReadonlyArray<readonly [string, string]> = [
	['[[', ']]'], ['【', '】'], ['（', '）'], ['「', '」'], ['《', '》'], ['〈', '〉'], ['［', '］'], ['｛', '｝'],
	['〖', '〗'], ['〔', '〕'], ['『', '』'], ['“', '”'], ['‘', '’'], ['(', ')'], ['[', ']'], ['{', '}'],
];
const SYMMETRIC = ['**', '==', '~~', '%%'];

export function smartSymbol(before: string, after: string): { before: string; after: string } {
	const closing = [...BRACKETS.map(pair => pair[1]), ...SYMMETRIC].sort((a, b) => b.length - a.length).find(token => after.startsWith(token));
	if (closing) return { before: before + closing, after: after.slice(closing.length) };
	const lineStart = before.lastIndexOf('\n') + 1;
	const line = before.slice(lineStart);
	const prefix = before.slice(0, lineStart);
	const aliases: Record<string, string> = { dv: 'dataview', qy: 'query', mm: 'mermaid', js: 'javascript', ts: 'typescript', py: 'python', ph: 'php', css: 'css', c: 'c', java: 'java', json: 'json', sql: 'sql', html: 'html', bash: 'bash', dataview: 'dataview', query: 'query', mermaid: 'mermaid' };
	const language = aliases[line.trim().toLowerCase()];
	if (language && !after.split('\n')[0]?.trim()) return { before: prefix + '```' + language + '\n', after: '\n```' + after };
	const callout = expandCallout(line);
	if (callout && !after.split('\n')[0]?.trim()) {
		return { before: prefix + callout, after };
	}
	if (/^[ \t]*[》、]$/.test(line)) return { before: before.slice(0, -1) + (line.endsWith('》') ? '>' : '/'), after };
	const compositions: Record<string, string> = { '【（': '〖', '[(': '〖', '（<': '〈', '(<': '〈', '（【': '〔', '([': '〔', '“【': '『', '"[': '『', '‘【': '「', "'[": '「', '……': '^' };
	const composed = compositions[before.slice(-2)];
	if (composed) return { before: before.slice(0, -2) + composed, after };
	const stack: Array<{ close: string }> = [];
	// 按 token 扫描而不是单字符计数，否则 [[ 会误补成一个 ]，嵌套括号也会错配。
	for (let index = 0; index < line.length;) {
		if (line[index] === '\\') { index += 2; continue; }
		const active = stack[stack.length - 1];
		if (active && line.startsWith(active.close, index)) { stack.pop(); index += active.close.length; continue; }
		const symmetric = SYMMETRIC.find(token => line.startsWith(token, index));
		if (symmetric) { stack.push({ close: symmetric }); index += symmetric.length; continue; }
		const bracket = BRACKETS.find(pair => line.startsWith(pair[0], index));
		if (bracket) { stack.push({ close: bracket[1] }); index += bracket[0].length; continue; }
		index++;
	}
	const pending = stack[stack.length - 1];
	return pending ? { before: before + pending.close, after } : { before, after };
}

export function detectFormat(text: string): { open: string; close: string } | null {
	const span = /^(<span style="(?:color|background-color):\s*#[\da-f]{6};?">)[\s\S]*<\/span>$/i.exec(text);
	if (span?.[1]) return { open: span[1], close: '</span>' };
	const cloze = /^(\{\{c\d+::)[\s\S]*\}\}$/.exec(text);
	if (cloze?.[1]) return { open: cloze[1], close: '}}' };
	const pairs: ReadonlyArray<readonly [string, string]> = [['**', '**'], ['==', '=='], ['~~', '~~'], ['%%', '%%'], ['__', '__'], ['_', '_'], ['*', '*'], ['<u>', '</u>'], ['<sup>', '</sup>'], ['<sub>', '</sub>'], ...BRACKETS];
	for (const [open, close] of pairs) {
		if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) return { open, close };
	}
	const code = /^(`+)[\s\S]*\1$/.exec(text);
	if (code?.[1]) return { open: code[1], close: code[1] };
	return null;
}
