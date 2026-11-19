/**
 * Spell checking with Hunspell dictionaries (the same kind Word, LibreOffice and Firefox use).
 * The dictionary for your language is downloaded once from this plugin's GitHub page and kept in the plugin's folder.
 */
import { normalizePath, requestUrl } from "obsidian";
import nspell from "nspell";
import type BitsAndBobs from "./main";
import { maskNonProse } from "./textstats";

export const SPELL_LANGS: Record<string, string> = {
	"en-AU": "English (Australia)", "en-GB": "English (UK)", "en-US": "English (US)", "en-CA": "English (Canada)", "en-ZA": "English (South Africa)",
};
const DICT_URL = "https://raw.githubusercontent.com/Leroyw1e/bits-and-bobs/main/dictionaries/";

type Checker = ReturnType<typeof nspell>;
export type SpellState = "idle" | "loading" | "ready" | "error";

export interface Mistake { word: string; from: number; to: number }

export class Speller {
	state: SpellState = "idle";
	error = "";
	lang = "";
	onChange: (() => void) | null = null;
	private checker: Checker | null = null;
	private loading: Promise<void> | null = null;
	private cache = new Map<string, string[]>();
	private applied = new Set<string>();

	constructor(private plugin: BitsAndBobs) {}

	private get dir() {
		return normalizePath(`${this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`}/dictionaries`);
	}

	/** Get the dictionary ready (downloading it the first time). */
	load(lang = this.plugin.settings.spellLang): Promise<void> {
		if (this.checker && this.lang === lang) return Promise.resolve();
		if (this.loading && this.lang === lang) return this.loading;
		this.lang = lang;
		this.state = "loading";
		this.error = "";
		this.checker = null;
		this.cache.clear();
		this.onChange?.();
		const mine = lang;
		this.loading = this.read(lang).then((c) => {
			if (this.lang !== mine) return;
			this.checker = c;
			this.applied = new Set();
			this.setWords(this.plugin.settings.myWords, false);
			this.state = "ready";
		}, (e: Error) => {
			if (this.lang !== mine) return;
			this.state = "error";
			this.error = e.message;
		}).finally(() => { this.loading = null; this.onChange?.(); });
		return this.loading;
	}

	private async read(lang: string): Promise<Checker> {
		const a = this.plugin.app.vault.adapter;
		const aff = `${this.dir}/${lang}.aff`, dic = `${this.dir}/${lang}.dic`;
		if (!(await a.exists(aff)) || !(await a.exists(dic))) {
			let affText: string, dicText: string;
			try {
				const [x, y] = await Promise.all([requestUrl({ url: `${DICT_URL}${lang}.aff`, throw: false }), requestUrl({ url: `${DICT_URL}${lang}.dic`, throw: false })]);
				if (x.status !== 200 || y.status !== 200) throw new Error(`status ${x.status}/${y.status}`);
				affText = x.text; dicText = y.text;
			} catch {
				throw new Error("Couldn't download the dictionary. Check your internet connection and try again.");
			}
			try { await a.mkdir(this.dir); } catch { /* already there */ }
			await a.write(aff, affText);
			await a.write(dic, dicText);
		}
		return nspell(await a.read(aff), await a.read(dic));
	}

	/** Make the plugin forget everything and start again (after a language change, say). */
	reset() { this.checker = null; this.loading = null; this.state = "idle"; this.cache.clear(); }

	correct(word: string): boolean {
		if (!this.checker) return true;
		const w = word.replace(/’/g, "'");
		if (this.checker.correct(w)) return true;
		// possessives of known words, and words in all capitals
		if (/'s$/i.test(w) && this.checker.correct(w.slice(0, -2))) return true;
		if (w === w.toUpperCase() && this.checker.correct(w.charAt(0) + w.slice(1).toLowerCase())) return true;
		return false;
	}

	/** Corrections already worked out for a word, if any. */
	peek(word: string): string[] | undefined { return this.cache.get(word); }

	suggest(word: string): string[] {
		if (!this.checker) return [];
		const hit = this.cache.get(word);
		if (hit) return hit;
		const w = word.replace(/’/g, "'");
		// two letters the wrong way round (teh, recieve) is the commonest slip, so try that first
		const swapped: string[] = [];
		for (let i = 0; i < w.length - 1; i++) {
			const c = w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2);
			if (c !== w && this.checker.correct(c.toLowerCase()) && !swapped.includes(c.toLowerCase())) swapped.push(c.toLowerCase());
		}
		let out = [...new Set([...swapped, ...this.checker.suggest(w)])].slice(0, 6);
		// keep the capitals the writer used
		const up = word === word.toUpperCase() && word.length > 1, cap = /^\p{Lu}/u.test(word);
		out = out.map((s) => (up ? s.toUpperCase() : cap && /^\p{Ll}/u.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s));
		this.cache.set(word, out);
		return out;
	}

	addWord(word: string) {
		const w = word.replace(/’/g, "'");
		this.checker?.add(w);
		const my = this.plugin.settings.myWords;
		if (!my.includes(w)) { my.push(w); my.sort((a, b) => a.localeCompare(b)); }
		void this.plugin.saveSettings();
	}

	/** Use this list as "my words" (from the settings box). */
	setWords(words: string[], save = true) {
		if (this.checker) {
			for (const w of this.applied) if (!words.includes(w)) this.checker.remove(w);
			for (const w of words) this.checker.add(w);
		}
		this.applied = new Set(words);
		this.cache.clear();
		if (save) void this.plugin.saveSettings();
		this.onChange?.();
	}

	removeWord(word: string) {
		this.checker?.remove(word);
		this.plugin.settings.myWords = this.plugin.settings.myWords.filter((w) => w !== word);
		void this.plugin.saveSettings();
	}

	/** Every misspelled word in a note, with where it is. */
	find(md: string): Mistake[] {
		const text = maskNonProse(md);
		const out: Mistake[] = [];
		const skipNames = this.plugin.settings.spellSkipNames;
		const re = /\p{L}[\p{L}'’]*/gu;
		for (let m = re.exec(text); m; m = re.exec(text)) {
			let word = m[0];
			let from = m.index;
			// trim apostrophes at the edges
			while (/^['’]/.test(word)) { word = word.slice(1); from++; }
			while (/['’]$/.test(word)) word = word.slice(0, -1);
			if (word.length < 2) continue;
			const before = text[from - 1], after = text[from + word.length];
			if ((before && /\d/.test(before)) || (after && /\d/.test(after)) || before === "_" || after === "_") continue;
			if (word === word.toUpperCase() && word.length <= 6) continue; // acronyms such as NASA, PDF
			if (/\p{Ll}\p{Lu}/u.test(word)) continue; // camelCase, iPhone
			if (skipNames && /^\p{Lu}/u.test(word) && !this.sentenceStart(text, from)) continue; // names
			if (!this.correct(word)) out.push({ word, from, to: from + word.length });
		}
		return out;
	}

	/** Is this the first word of a sentence, line or list item? */
	private sentenceStart(text: string, at: number): boolean {
		let i = at - 1;
		while (i >= 0 && /[ \t>*+#"'“‘([\d.)-]/.test(text[i])) {
			// a full stop after a number is a list marker; after letters it ends the sentence
			if (text[i] === "." && i > 0 && !/\d/.test(text[i - 1])) return true;
			i--;
		}
		return i < 0 || /[\n.!?:]/.test(text[i]);
	}
}
