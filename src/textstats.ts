/** Counting words and judging how easy a note is to read. No Obsidian code here. */

export interface TextStats {
	words: number;
	chars: number;
	charsNoSpaces: number;
	sentences: number;
	paragraphs: number;
	readingMin: number;
	speakingMin: number;
	avgSentence: number;
	longestSentence: number;
	unique: number;
	topWords: [string, number][];
	/** Flesch reading ease: higher is easier (0–100) */
	ease: number;
	/** US school grade needed to follow it */
	grade: number;
	headings: number;
	links: number;
}

export const WORD = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

const blank = (s: string) => s.replace(/[^\n]/g, " ");

/**
 * The writing in a note, with everything that isn't prose replaced by spaces (so positions stay the same):
 * properties at the top, code, maths, comments, web addresses, link targets, embedded files and HTML tags.
 */
export function maskNonProse(md: string): string {
	let t = md;
	t = t.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, blank);
	t = t.replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)/g, blank);
	t = t.replace(/%%[\s\S]*?%%/g, blank);
	t = t.replace(/<!--[\s\S]*?-->/g, blank);
	t = t.replace(/\$\$[\s\S]*?\$\$/g, blank);
	t = t.replace(/`[^`\n]*`/g, blank);
	t = t.replace(/(^|[^\\$\d])\$(?!\s)[^$\n]*[^$\s\\]\$(?!\d)/g, (m, pre: string) => pre + blank(m.slice(pre.length)));
	t = t.replace(/!\[\[[^\]]*\]\]/g, blank);
	t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, blank);
	t = t.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, (_, target: string, alias: string) => `  ${" ".repeat(target.length)} ${alias}  `);
	t = t.replace(/\[\[([^\]]*)\]\]/g, (_, target: string) => `  ${target}  `);
	t = t.replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, blank);
	t = t.replace(/https?:\/\/[^\s)>\]]+/g, blank);
	t = t.replace(/<\/?[A-Za-z][^>\n]*>/g, blank);
	t = t.replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, (m, pre: string) => pre + blank(m.slice(pre.length)));
	return t;
}

const STOP = new Set(("about above after again against also always among another because been before being between both could does doing down during each either every from further have having here hers herself himself into itself just like many more most much must myself never only other ourselves over same should since some still such than that their theirs them themselves then there these they this those through under until upon very want wants were what when where whether which while whom whose will with within without would your yours yourself yourselves").split(" "));

function syllables(word: string): number {
	const w = word.toLowerCase().replace(/[^a-z]/g, "");
	if (!w) return 1;
	if (w.length <= 3) return 1;
	const n = (w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g) ?? []).length;
	return Math.max(1, n);
}

export function countWords(text: string): number {
	return (text.match(WORD) ?? []).length;
}

export function analyse(md: string): TextStats {
	const prose = maskNonProse(md);
	const words = prose.match(WORD) ?? [];
	// sentences: stop at . ! ? followed by a space or the end, counting only stretches that have words
	const parts = prose.split(/\n{2,}|\n(?=\s*(?:[-*+>]|\d+[.)]|#{1,6})\s)/);
	const sentences: number[] = [];
	for (const para of parts) {
		for (const seg of para.split(/[.!?…]+(?=\s|$)/)) {
			const n = (seg.match(WORD) ?? []).length;
			if (n) sentences.push(n);
		}
	}
	const paragraphs = parts.filter((p) => /[\p{L}\p{N}]/u.test(p)).length;
	const counts = new Map<string, number>();
	let syl = 0;
	for (const w of words) {
		const l = w.toLowerCase().replace(/[’]/g, "'");
		syl += syllables(l);
		if (l.length >= 4 && !STOP.has(l) && !/^\d+$/.test(l)) counts.set(l, (counts.get(l) ?? 0) + 1);
	}
	const top = [...counts].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
	const wc = words.length, sc = Math.max(1, sentences.length);
	const perSentence = wc / sc, perWord = wc ? syl / wc : 0;
	const ease = wc >= 5 ? Math.max(0, Math.min(100, 206.835 - 1.015 * perSentence - 84.6 * perWord)) : 0;
	const grade = wc >= 5 ? Math.max(0, 0.39 * perSentence + 11.8 * perWord - 15.59) : 0;
	const own = md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
	return {
		words: wc,
		chars: prose.replace(/\s+/g, " ").trim().length,
		charsNoSpaces: prose.replace(/\s+/g, "").length,
		sentences: sentences.length,
		paragraphs,
		readingMin: wc / 238,
		speakingMin: wc / 150,
		avgSentence: sentences.length ? wc / sentences.length : 0,
		longestSentence: sentences.length ? Math.max(...sentences) : 0,
		unique: new Set(words.map((w: string) => w.toLowerCase())).size,
		topWords: top,
		ease,
		grade,
		headings: (own.match(/^#{1,6}\s+\S/gm) ?? []).length,
		links: (own.match(/\[\[[^\]]+\]\]|\[[^\]]*\]\([^)]+\)/g) ?? []).length,
	};
}

export function easeLabel(ease: number): { label: string; tone: "good" | "ok" | "hard" } {
	if (ease >= 80) return { label: "Very easy to read", tone: "good" };
	if (ease >= 70) return { label: "Easy to read", tone: "good" };
	if (ease >= 60) return { label: "Plain English", tone: "good" };
	if (ease >= 50) return { label: "Fairly hard", tone: "ok" };
	if (ease >= 30) return { label: "Hard to read", tone: "hard" };
	return { label: "Very hard to read", tone: "hard" };
}

export function minutes(n: number): string {
	if (n < 0.5) return n === 0 ? "0 min" : "< 1 min";
	if (n < 60) return `${Math.round(n)} min`;
	return `${Math.floor(n / 60)} h ${Math.round(n % 60)} min`;
}
