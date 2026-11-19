/**
 * File history: every save of a note, board, slide deck or spreadsheet is recorded on this device, so you can go back
 * and see what you added at any year, month, day, hour, minute or second, and bring an old version back.
 *
 * Where: <vault>/.obsidian/plugins/bits-and-bobs/history/  (never uploaded by this plugin; left out of OneDrive sync)
 *   index.json     which file has which log, and what each file looked like at the last record
 *   <id>.jsonl     one line per update, oldest first:
 *       {t, k:"s", x}          a full copy of the text (the first one, and one every 150 updates)
 *       {t, k:"d", p, r, i}    a change to text: at position p, the text r was replaced by i
 *       {t, k:"b", h, n}       a spreadsheet saved (blob h, n bytes); at most one every 10 seconds
 *       {t, k:"x"}             the file was deleted
 *   blobs/<hash>   gzipped spreadsheet copies, shared when identical
 */
import { Notice, TAbstractFile, TFile, normalizePath } from "obsidian";
import type BitsAndBobs from "./main";
import { countWords } from "./textstats";

export interface Entry {
	t: number;
	k: "s" | "d" | "b" | "x";
	p?: number;
	r?: string;
	i?: string;
	x?: string;
	h?: string;
	n?: number;
	/** the file was changed while this plugin wasn't looking (outside Obsidian, or while it was closed) */
	e?: 1;
	/** words added and removed by this update (worked out when loaded) */
	add?: number;
	del?: number;
}

interface IndexFile { id: string; mtime: number; size: number; del?: 1 }
interface Index { v: 1; files: Record<string, IndexFile> }

const SNAPSHOT_EVERY = 150;
const BINARY_EVERY_MS = 10_000;
const MAX_TEXT = 10 * 1024 * 1024;

export const isBinaryPath = (p: string) => /\.xlsx$/i.test(p);

/** The one edit that turns `a` into `b`: everything before and after it is the same. */
export function singleEdit(a: string, b: string): { p: number; r: string; i: string } {
	let s = 0;
	const max = Math.min(a.length, b.length);
	while (s < max && a.charCodeAt(s) === b.charCodeAt(s)) s++;
	let e = 0;
	while (e < max - s && a.charCodeAt(a.length - 1 - e) === b.charCodeAt(b.length - 1 - e)) e++;
	return { p: s, r: a.slice(s, a.length - e), i: b.slice(s, b.length - e) };
}

export function applyEntry(text: string, en: Entry): string {
	if (en.k === "s") return en.x ?? "";
	if (en.k === "d") return text.slice(0, en.p ?? 0) + (en.i ?? "") + text.slice((en.p ?? 0) + (en.r ?? "").length);
	if (en.k === "x") return "";
	return text;
}

/** Text as it was after entry number `upTo` (counting from 0). */
export function textAt(entries: Entry[], upTo: number): string {
	let from = 0;
	for (let i = upTo; i >= 0; i--) if (entries[i].k === "s") { from = i; break; }
	let t = "";
	for (let i = from; i <= upTo; i++) t = applyEntry(t, entries[i]);
	return t;
}

const gzip = async (buf: ArrayBuffer): Promise<ArrayBuffer> => new Response(new Blob([buf]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
const gunzip = async (buf: ArrayBuffer): Promise<ArrayBuffer> => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();

async function sha1(data: ArrayBuffer): Promise<string> {
	const h = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
	return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class History {
	private index: Index = { v: 1, files: {} };
	private ready = false;
	private lastText = new Map<string, string>();
	private lastBinary = new Map<string, number>();
	private counts = new Map<string, number>();
	private chains = new Map<string, Promise<void>>();
	private timers = new Map<string, number>();
	private saveTimer = 0;
	/** called after something is recorded, so an open History view can refresh */
	onRecord: ((path: string) => void) | null = null;

	constructor(private plugin: BitsAndBobs) {}

	private get dir() { return normalizePath(`${this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`}/history`); }
	private get adapter() { return this.plugin.app.vault.adapter; }

	/** Is this file one whose history is kept? */
	tracked(path: string): boolean {
		const st = this.plugin.settings.history;
		const ext = path.split(".").pop()?.toLowerCase() ?? "";
		if (ext === "md") return st.notes;
		if (ext === "mboard" || ext === "mslides") return st.boards;
		if (ext === "xlsx") return st.sheets;
		if (["canvas", "txt", "csv", "json", "base"].includes(ext)) return st.other;
		return false;
	}

	start() {
		const vault = this.plugin.app.vault;
		this.plugin.app.workspace.onLayoutReady(() => {
			void this.load().then(() => {
				this.ready = true;
				void this.scan();
			});
		});
		this.plugin.registerEvent(vault.on("modify", (f) => this.changed(f)));
		this.plugin.registerEvent(vault.on("create", (f) => this.changed(f)));
		this.plugin.registerEvent(vault.on("delete", (f) => { void this.deleted(f); }));
		this.plugin.registerEvent(vault.on("rename", (f, old) => this.renamed(f, old)));
		this.plugin.register(() => { for (const t of this.timers.values()) window.clearTimeout(t); window.clearTimeout(this.saveTimer); void this.saveIndex(); });
	}

	// ---------- the index ----------

	private async load() {
		try {
			if (await this.adapter.exists(`${this.dir}/index.json`)) this.index = JSON.parse(await this.adapter.read(`${this.dir}/index.json`)) as Index;
		} catch { this.index = { v: 1, files: {} }; }
	}

	private async saveIndex() {
		window.clearTimeout(this.saveTimer);
		try { await this.ensureDir(); await this.adapter.write(`${this.dir}/index.json`, JSON.stringify(this.index)); } catch { /* try again next time */ }
	}
	private saveSoon() { window.clearTimeout(this.saveTimer); this.saveTimer = window.setTimeout(() => { void this.saveIndex(); }, 2000); }

	private async ensureDir() {
		if (!(await this.adapter.exists(this.dir))) await this.adapter.mkdir(this.dir);
	}

	private logPath(id: string) { return `${this.dir}/${id}.jsonl`; }

	/** Every file that has a history, newest-changed first. */
	files(): { path: string; deleted: boolean; mtime: number }[] {
		return Object.entries(this.index.files).map(([path, f]) => ({ path, deleted: !!f.del, mtime: f.mtime })).sort((a, b) => b.mtime - a.mtime);
	}

	hasHistory(path: string) { return !!this.index.files[path]; }

	// ---------- watching ----------

	private changed(f: TAbstractFile) {
		if (!this.ready || !(f instanceof TFile) || !this.tracked(f.path)) return;
		if (isBinaryPath(f.path)) {
			// spreadsheets save very often: keep at most one copy every 10 seconds, plus the last one
			const since = Date.now() - (this.lastBinary.get(f.path) ?? 0);
			window.clearTimeout(this.timers.get(f.path));
			if (since >= BINARY_EVERY_MS) { void this.record(f); return; }
			this.timers.set(f.path, window.setTimeout(() => { this.timers.delete(f.path); const cur = this.plugin.app.vault.getAbstractFileByPath(f.path); if (cur instanceof TFile) void this.record(cur); }, BINARY_EVERY_MS - since + 200));
			return;
		}
		void this.record(f);
	}

	private async deleted(f: TAbstractFile) {
		if (!this.ready || !(f instanceof TFile)) return;
		const rec = this.index.files[f.path];
		if (!rec || rec.del) return;
		rec.del = 1;
		await this.append(f.path, rec.id, { t: Date.now(), k: "x" });
		this.lastText.delete(f.path);
		this.saveSoon();
		this.onRecord?.(f.path);
	}

	private renamed(f: TAbstractFile, old: string) {
		const rec = this.index.files[old];
		if (!rec) { this.changed(f); return; }
		delete this.index.files[old];
		this.index.files[f.path] = rec;
		const t = this.lastText.get(old);
		if (t !== undefined) { this.lastText.delete(old); this.lastText.set(f.path, t); }
		this.saveSoon();
	}

	/** Check every tracked file against what was last recorded (catches changes made while Obsidian was closed). */
	async scan() {
		const files = this.plugin.app.vault.getFiles().filter((f) => this.tracked(f.path));
		const fresh = files.filter((f) => !this.index.files[f.path]).length;
		if (fresh > 50) new Notice(`File history: starting to keep the history of ${fresh} files…`, 6000);
		let n = 0;
		for (const f of files) {
			const rec = this.index.files[f.path];
			if (!rec || rec.del || rec.mtime !== f.stat.mtime || rec.size !== f.stat.size) await this.record(f, !!rec);
			if (++n % 20 === 0) await new Promise((r) => window.setTimeout(r, 0));
		}
		this.saveSoon();
	}

	// ---------- recording ----------

	/** Put work for one file in line, so two saves of the same file are never handled at once. */
	private record(f: TFile, external = false): Promise<void> {
		const prev = this.chains.get(f.path) ?? Promise.resolve();
		const next = prev.then(() => this.doRecord(f, external)).catch((e) => console.warn("Bits and Bobs: file history", e));
		this.chains.set(f.path, next);
		void next.finally(() => { if (this.chains.get(f.path) === next) this.chains.delete(f.path); });
		return next;
	}

	private async doRecord(f: TFile, external: boolean) {
		const vault = this.plugin.app.vault;
		const cur = vault.getAbstractFileByPath(f.path);
		if (!(cur instanceof TFile) || !this.tracked(cur.path)) return;
		let rec = this.index.files[cur.path];
		const t = Date.now();
		if (isBinaryPath(cur.path)) {
			const data = await vault.readBinary(cur);
			const h = await sha1(data);
			const last = rec ? (await this.read(cur.path)).filter((e) => e.k === "b").pop() : undefined;
			if (rec && !rec.del && last?.h === h) { rec.mtime = cur.stat.mtime; rec.size = cur.stat.size; this.saveSoon(); return; }
			await this.ensureDir();
			if (!(await this.adapter.exists(`${this.dir}/blobs`))) await this.adapter.mkdir(`${this.dir}/blobs`);
			if (!(await this.adapter.exists(`${this.dir}/blobs/${h}`))) await this.adapter.writeBinary(`${this.dir}/blobs/${h}`, await gzip(data));
			rec = this.index.files[cur.path] ??= { id: Math.random().toString(36).slice(2, 10), mtime: 0, size: 0 };
			delete rec.del;
			rec.mtime = cur.stat.mtime; rec.size = cur.stat.size;
			this.lastBinary.set(cur.path, t);
			await this.append(cur.path, rec.id, { t, k: "b", h, n: data.byteLength, ...(external ? { e: 1 as const } : {}) });
			this.saveSoon();
			this.onRecord?.(cur.path);
			return;
		}
		if (cur.stat.size > MAX_TEXT) return;
		const text = await vault.cachedRead(cur);
		const before = rec && !rec.del ? await this.latest(cur.path) : null;
		if (before !== null && before === text) { if (rec) { rec.mtime = cur.stat.mtime; rec.size = cur.stat.size; this.saveSoon(); } return; }
		rec = this.index.files[cur.path] ??= { id: Math.random().toString(36).slice(2, 10), mtime: 0, size: 0 };
		const wasDeleted = !!rec.del;
		delete rec.del;
		rec.mtime = cur.stat.mtime; rec.size = cur.stat.size;
		const n = (this.counts.get(cur.path) ?? (before === null ? 0 : await this.countLines(rec.id))) + 1;
		let entry: Entry;
		if (before === null || wasDeleted || n % SNAPSHOT_EVERY === 0) entry = { t, k: "s", x: text };
		else {
			const d = singleEdit(before, text);
			// a change that touches most of the file is kept as a whole copy instead
			entry = d.r.length + d.i.length > text.length * 0.6 + 200 ? { t, k: "s", x: text } : { t, k: "d", p: d.p, r: d.r, i: d.i };
		}
		if (external) entry.e = 1;
		this.counts.set(cur.path, n);
		this.lastText.set(cur.path, text);
		await this.append(cur.path, rec.id, entry);
		this.saveSoon();
		this.onRecord?.(cur.path);
	}

	private async countLines(id: string): Promise<number> {
		try { const t = await this.adapter.read(this.logPath(id)); let n = 0; for (let i = t.indexOf("\n"); i >= 0; i = t.indexOf("\n", i + 1)) n++; return n; } catch { return 0; }
	}

	private async append(path: string, id: string, e: Entry) {
		await this.ensureDir();
		await this.adapter.append(this.logPath(id), JSON.stringify(e) + "\n");
		void path;
	}

	/** The newest text recorded for a file. */
	private async latest(path: string): Promise<string | null> {
		const hit = this.lastText.get(path);
		if (hit !== undefined) return hit;
		const rec = this.index.files[path];
		if (!rec) return null;
		const entries = await this.read(path);
		if (!entries.length) return null;
		const t = textAt(entries, entries.length - 1);
		this.lastText.set(path, t);
		this.counts.set(path, entries.length);
		return t;
	}

	// ---------- reading ----------

	/** Every update ever recorded for a file, oldest first, with the words each added or removed. */
	async read(path: string): Promise<Entry[]> {
		const rec = this.index.files[path];
		if (!rec) return [];
		let raw: string;
		try { raw = await this.adapter.read(this.logPath(rec.id)); } catch { return []; }
		const out: Entry[] = [];
		for (const line of raw.split("\n")) {
			if (!line) continue;
			try { out.push(JSON.parse(line) as Entry); } catch { /* a damaged line is skipped */ }
		}
		// words each update added and removed (an update that stores a whole copy is compared with what came before)
		let cur = "", first = true;
		for (const e of out) {
			if (e.k === "d") { e.add = e.i ? countWords(e.i) : 0; e.del = e.r ? countWords(e.r) : 0; cur = applyEntry(cur, e); }
			else if (e.k === "s") {
				const x = e.x ?? "";
				if (first) { e.add = countWords(x); e.del = 0; }
				else { const d = singleEdit(cur, x); e.add = d.i ? countWords(d.i) : 0; e.del = d.r ? countWords(d.r) : 0; }
				cur = x;
			} else if (e.k === "x") cur = "";
			first = false;
		}
		return out;
	}

	async blob(hash: string): Promise<ArrayBuffer> {
		return gunzip(await this.adapter.readBinary(`${this.dir}/blobs/${hash}`));
	}

	/** How much room the history takes on this device. */
	async size(): Promise<number> {
		let total = 0;
		const walk = async (dir: string) => {
			if (!(await this.adapter.exists(dir))) return;
			const l = await this.adapter.list(dir);
			for (const f of l.files) total += (await this.adapter.stat(f))?.size ?? 0;
			for (const d of l.folders) await walk(d);
		};
		await walk(this.dir);
		return total;
	}

	async clearFile(path: string) {
		const rec = this.index.files[path];
		if (!rec) return;
		try { await this.adapter.remove(this.logPath(rec.id)); } catch { /* already gone */ }
		delete this.index.files[path];
		this.lastText.delete(path); this.counts.delete(path);
		await this.saveIndex();
	}

	async clearAll() {
		if (await this.adapter.exists(this.dir)) await this.adapter.rmdir(this.dir, true);
		this.index = { v: 1, files: {} };
		this.lastText.clear(); this.counts.clear(); this.lastBinary.clear();
	}
}
