import { App, FuzzySuggestModal, ItemView, Modal, Notice, Setting, TFile, ViewStateResult, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import { diffLines, diffWords } from "diff";
import type BitsAndBobs from "./main";
import { Entry, isBinaryPath, textAt } from "./history";
import { Workbook } from "./sheet";

export const VIEW_HISTORY = "bits-history";

type Zoom = "year" | "month" | "day" | "hour" | "minute" | "second";
const ZOOMS: { id: Zoom; label: string }[] = [
	{ id: "year", label: "Year" }, { id: "month", label: "Month" }, { id: "day", label: "Day" },
	{ id: "hour", label: "Hour" }, { id: "minute", label: "Minute" }, { id: "second", label: "Second" },
];
const finer = (z: Zoom): Zoom => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.findIndex((x) => x.id === z) + 1)].id;

interface Bucket { key: string; start: number; end: number; label: string; idx: number[]; add: number; del: number; bytes: number }
interface Scope { start: number; end: number; label: string }

const pad = (n: number) => String(n).padStart(2, "0");

function startOf(t: number, z: Zoom): Date {
	const d = new Date(t);
	return new Date(d.getFullYear(), z === "year" ? 0 : d.getMonth(), ["year", "month"].includes(z) ? 1 : d.getDate(), ["year", "month", "day"].includes(z) ? 0 : d.getHours(), ["year", "month", "day", "hour"].includes(z) ? 0 : d.getMinutes(), z === "second" ? d.getSeconds() : 0);
}
function nextStart(d: Date, z: Zoom): Date {
	const n = new Date(d);
	if (z === "year") n.setFullYear(n.getFullYear() + 1);
	else if (z === "month") n.setMonth(n.getMonth() + 1);
	else if (z === "day") n.setDate(n.getDate() + 1);
	else if (z === "hour") n.setHours(n.getHours() + 1);
	else if (z === "minute") n.setMinutes(n.getMinutes() + 1);
	else n.setSeconds(n.getSeconds() + 1);
	return n;
}
function labelFor(d: Date, z: Zoom): string {
	if (z === "year") return String(d.getFullYear());
	if (z === "month") return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
	if (z === "day") return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
	if (z === "hour") return `${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}, ${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}`;
	if (z === "minute") return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) + `, ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
	return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" }) + `, ${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

const num = (n: number) => n.toLocaleString();
const words = (n: number) => `${num(n)} ${n === 1 ? "word" : "words"}`;

/** The History tab: pick any year, month, day, hour, minute or second and see what was added and removed, or go back to that version. */
export class HistoryView extends ItemView {
	path = "";
	private entries: Entry[] = [];
	private zoom: Zoom = "day";
	private periods: Scope[] = [];
	private selKey = "";
	private shown = 400;
	private tab: "changes" | "whole" = "changes";
	private listEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private token = 0;
	private refreshSoon = debounce(() => { void this.reload(); }, 600, true);

	constructor(leaf: WorkspaceLeaf, private plugin: BitsAndBobs) { super(leaf); }
	getViewType() { return VIEW_HISTORY; }
	getDisplayText() { return this.path ? `History: ${this.path.split("/").pop()}` : "File history"; }
	getIcon() { return "history"; }
	getState() { return { path: this.path }; }
	async setState(state: { path?: string }, result: ViewStateResult) {
		if (state?.path && state.path !== this.path) { this.path = state.path; this.periods = []; this.selKey = ""; await this.reload(); }
		await super.setState(state, result);
	}

	async onOpen() {
		this.contentEl.addClass("bb-hist");
		this.plugin.history.onRecord = (p) => { if (p === this.path) this.refreshSoon(); };
		await this.reload();
	}
	async onClose() { this.plugin.history.onRecord = null; }

	async reload() {
		const t = ++this.token;
		const entries = this.path ? await this.plugin.history.read(this.path) : [];
		if (t !== this.token) return;
		this.entries = entries;
		this.draw();
	}

	// ---------- the timeline ----------

	private inScope(t: number) {
		const s = this.periods[this.periods.length - 1];
		return !s || (t >= s.start && t <= s.end);
	}

	private buckets(): Bucket[] {
		const map = new Map<string, Bucket>();
		this.entries.forEach((e, i) => {
			if (!this.inScope(e.t)) return;
			const s = startOf(e.t, this.zoom);
			const key = String(s.getTime());
			let b = map.get(key);
			if (!b) { b = { key, start: s.getTime(), end: nextStart(s, this.zoom).getTime() - 1, label: labelFor(s, this.zoom), idx: [], add: 0, del: 0, bytes: 0 }; map.set(key, b); }
			b.idx.push(i);
			b.add += e.add ?? 0;
			b.del += e.del ?? 0;
		});
		return [...map.values()].sort((a, b) => b.start - a.start);
	}

	private draw() {
		const c = this.contentEl;
		c.empty();
		const head = c.createDiv("bb-hist-head");
		const title = head.createDiv("bb-hist-title");
		title.createSpan({ cls: "bb-hist-file", text: this.path ? this.path.split("/").pop()! : "File history" });
		if (this.path) title.createSpan({ cls: "bb-hist-path", text: this.path.includes("/") ? this.path.slice(0, this.path.lastIndexOf("/")) : "" });
		const pick = head.createEl("button", { text: "Other file…" });
		pick.onclick = () => new FilePicker(this.app, this.plugin, (p) => { this.path = p; this.periods = []; this.selKey = ""; void this.reload(); }).open();
		if (!this.path) {
			c.createDiv({ cls: "bb-hist-empty", text: "Pick a file to see its history. Every save of a note, board, deck or spreadsheet is kept on this device." });
			return;
		}
		if (!this.entries.length) {
			c.createDiv({ cls: "bb-hist-empty", text: "Nothing has been recorded for this file yet. History starts from when it was switched on, and keeps every change after that." });
			return;
		}
		const body = c.createDiv("bb-hist-body");
		const left = body.createDiv("bb-hist-left");
		const zoomBar = left.createDiv("bb-hist-zoom");
		for (const z of ZOOMS) {
			const b = zoomBar.createEl("button", { text: z.label, cls: this.zoom === z.id ? "is-active" : "" });
			b.onclick = () => { this.zoom = z.id; this.shown = 400; this.draw(); };
		}
		const crumbs = left.createDiv("bb-hist-crumbs");
		const crumb = (text: string, to: number) => { const a = crumbs.createEl("button", { cls: "bb-hist-crumb", text }); a.onclick = () => { this.periods = this.periods.slice(0, to); this.draw(); }; };
		crumb("All time", 0);
		this.periods.forEach((s, i) => { crumbs.createSpan({ text: "›" }); crumb(s.label, i + 1); });
		const sumEl = left.createDiv("bb-hist-sum");
		this.listEl = left.createDiv("bb-hist-list");
		this.detailEl = body.createDiv("bb-hist-detail");

		const all = this.buckets();
		const nIn = all.reduce((n, b) => n + b.idx.length, 0);
		const first = this.entries[0].t, last = this.entries[this.entries.length - 1].t;
		sumEl.setText(`${num(this.entries.length)} saves recorded, from ${new Date(first).toLocaleString()} to ${new Date(last).toLocaleString()}` + (this.periods.length ? `. ${num(nIn)} in this period.` : "."));
		const max = Math.max(1, ...all.map((b) => b.idx.length));
		for (const b of all.slice(0, this.shown)) {
			const row = this.listEl.createDiv("bb-hist-row" + (b.key === this.selKey ? " is-sel" : ""));
			const main = row.createDiv("bb-hist-row-main");
			main.createDiv({ cls: "bb-hist-label", text: b.label });
			const sub = main.createDiv("bb-hist-sub");
			sub.createSpan({ text: `${num(b.idx.length)} save${b.idx.length === 1 ? "" : "s"}` });
			if (b.add || b.del) {
				if (b.add) sub.createSpan({ cls: "bb-hist-add", text: `+${words(b.add)}` });
				if (b.del) sub.createSpan({ cls: "bb-hist-del", text: `−${words(b.del)}` });
			}
			const kinds = new Set(b.idx.map((i) => this.entries[i].k));
			if (kinds.has("x")) sub.createSpan({ cls: "bb-hist-del", text: "deleted" });
			if (b.idx.some((i) => this.entries[i].e)) sub.createSpan({ cls: "bb-ed-muted", text: "changed outside Obsidian" });
			row.createDiv("bb-hist-bar").createDiv("bb-hist-bar-fill").setCssProps({ width: `${Math.max(3, Math.round((b.idx.length / max) * 100))}%` });
			row.onclick = () => { this.selKey = b.key; this.tab = "changes"; this.draw(); };
			if (this.zoom !== "second") {
				const dive = row.createEl("button", { cls: "clickable-icon bb-hist-dive", attr: { "aria-label": "Look inside this period" } });
				setIcon(dive, "zoom-in");
				dive.onclick = (e) => { e.stopPropagation(); this.periods.push({ start: b.start, end: b.end, label: b.label }); this.zoom = finer(this.zoom); this.selKey = ""; this.shown = 400; this.draw(); };
			}
		}
		if (all.length > this.shown) {
			const more = this.listEl.createEl("button", { text: `Show ${Math.min(400, all.length - this.shown)} more (${num(all.length - this.shown)} older)` });
			more.onclick = () => { this.shown += 400; this.draw(); };
		}
		const sel = all.find((b) => b.key === this.selKey);
		if (sel) void this.drawDetail(sel); else this.detailEl.createDiv({ cls: "bb-hist-empty", text: "Pick a time on the left to see what was added and removed, and to go back to that version. Use the magnifier on a row to look inside it, or the buttons above to change how finely time is divided." });
	}

	// ---------- one period ----------

	private async version(index: number): Promise<string | ArrayBuffer> {
		if (index < 0) return isBinaryPath(this.path) ? new ArrayBuffer(0) : "";
		if (!isBinaryPath(this.path)) return textAt(this.entries, index);
		for (let i = index; i >= 0; i--) { const e = this.entries[i]; if (e.k === "b" && e.h) return this.plugin.history.blob(e.h); if (e.k === "x") break; }
		return new ArrayBuffer(0);
	}

	private async drawDetail(b: Bucket) {
		const d = this.detailEl, tk = this.token;
		d.empty();
		const firstIdx = b.idx[0], lastIdx = b.idx[b.idx.length - 1];
		const e1 = this.entries[lastIdx];
		d.createDiv({ cls: "bb-hist-dtitle", text: b.label });
		const stats = d.createDiv("bb-hist-stats");
		stats.createSpan({ text: `${num(b.idx.length)} save${b.idx.length === 1 ? "" : "s"}` });
		if (b.add) stats.createSpan({ cls: "bb-hist-add", text: `+${words(b.add)} added` });
		if (b.del) stats.createSpan({ cls: "bb-hist-del", text: `−${words(b.del)} removed` });
		if (firstIdx === 0) stats.createSpan({ cls: "bb-ed-muted", text: "the first version recorded is in here" });

		const actions = d.createDiv("bb-hist-actions");
		const canEnd = e1.k !== "x", canStart = firstIdx > 0 && this.entries[firstIdx - 1].k !== "x";
		const act = (text: string, cls: string, on: boolean, fn: () => void) => { const x = actions.createEl("button", { text, cls }); x.disabled = !on; x.onclick = fn; };
		act("Go back to the end of this period", "mod-cta", canEnd, () => this.confirmRestore(lastIdx, `the end of ${b.label}`));
		act("Go back to just before it", "", canStart, () => this.confirmRestore(firstIdx - 1, `just before ${b.label}`));
		act("Save a copy of the end", "", canEnd, () => { void this.saveCopy(lastIdx, e1.t); });

		if (isBinaryPath(this.path)) {
			const sec = d.createDiv("bb-hist-diff");
			sec.createDiv({ cls: "bb-ed-muted", text: "Working out what changed…" });
			try {
				const [before, after] = await Promise.all([this.version(firstIdx - 1), this.version(lastIdx)]);
				if (tk !== this.token) return;
				sec.empty();
				this.drawSheetChanges(sec, before as ArrayBuffer, after as ArrayBuffer);
			} catch { sec.empty(); sec.createDiv({ cls: "bb-ed-muted", text: "This version can't be compared." }); }
			return;
		}
		const before = (await this.version(firstIdx - 1)) as string, after = (await this.version(lastIdx)) as string;
		if (tk !== this.token) return;
		const tabs = d.createDiv("bb-hist-tabs");
		for (const [id, label] of [["changes", "What changed"], ["whole", "Whole version"]] as const) {
			const x = tabs.createEl("button", { text: label, cls: this.tab === id ? "is-active" : "" });
			x.onclick = () => { this.tab = id; void this.drawDetail(b); };
		}
		const box = d.createDiv("bb-hist-diff");
		if (this.tab === "whole") { box.createEl("pre", { cls: "bb-hist-pre", text: after.length > 200_000 ? after.slice(0, 200_000) + "\n…" : after }); return; }
		if (/\.mboard$/i.test(this.path)) { this.drawBoardChanges(box, before, after); return; }
		if (/\.mslides$/i.test(this.path)) { this.drawDeckChanges(box, before, after); return; }
		this.drawTextDiff(box, before, after);
	}

	/** Lines that were added or removed, with a few lines around them, and the changed words picked out. */
	private drawTextDiff(box: HTMLElement, before: string, after: string) {
		if (before === after) { box.createDiv({ cls: "bb-ed-muted", text: "Nothing is different between the start and the end of this period." }); return; }
		const parts = diffLines(before, after);
		let shown = 0;
		const LIMIT = 700;
		const line = (cls: string, text: string, marks?: { v: string; on: boolean }[]) => {
			if (shown++ > LIMIT) return;
			const l = box.createDiv("bb-hist-line " + cls);
			l.createSpan({ cls: "bb-hist-sign", text: cls.includes("add") ? "+" : cls.includes("del") ? "−" : " " });
			const t = l.createSpan({ cls: "bb-hist-text" });
			if (marks) for (const m of marks) t.createSpan({ cls: m.on ? "bb-hist-hl" : "", text: m.v });
			else t.setText(text || " ");
		};
		for (let i = 0; i < parts.length; i++) {
			const p = parts[i];
			const lines = p.value.replace(/\n$/, "").split("\n");
			if (p.removed && parts[i + 1]?.added) {
				const q = parts[i + 1];
				const words = diffWords(p.value, q.value);
				const rm = words.filter((w) => !w.added), ad = words.filter((w) => !w.removed);
				const split = (ws: typeof words, on: (w: (typeof words)[number]) => boolean) => ws.map((w) => ({ v: w.value, on: on(w) }));
				const asLines = (marks: { v: string; on: boolean }[]) => {
					const out: { v: string; on: boolean }[][] = [[]];
					for (const m of marks) { const bits = m.v.split("\n"); bits.forEach((bit, j) => { if (j > 0) out.push([]); if (bit) out[out.length - 1].push({ v: bit, on: m.on }); }); }
					return out.filter((l, j) => l.length || j < out.length - 1);
				};
				for (const l of asLines(split(rm, (w) => !!w.removed))) line("is-del", "", l);
				for (const l of asLines(split(ad, (w) => !!w.added))) line("is-add", "", l);
				i++;
				continue;
			}
			if (p.added || p.removed) { for (const l of lines) line(p.added ? "is-add" : "is-del", l); continue; }
			if (lines.length > 6) {
				if (i > 0) for (const l of lines.slice(0, 2)) line("is-same", l);
				box.createDiv({ cls: "bb-hist-skip", text: `⋯ ${lines.length - (i > 0 ? 2 : 0) - (i < parts.length - 1 ? 2 : 0)} unchanged lines ⋯` });
				if (i < parts.length - 1) for (const l of lines.slice(-2)) line("is-same", l);
			} else for (const l of lines) line("is-same", l);
		}
		if (shown > LIMIT) box.createDiv({ cls: "bb-hist-skip", text: `Only the first ${LIMIT} lines are shown. Use "Whole version" to see everything.` });
	}

	private drawBoardChanges(box: HTMLElement, before: string, after: string) {
		const parse = (t: string) => { try { return (JSON.parse(t || "{}") as { elements?: { id: string; type: string; text?: string }[] }).elements ?? []; } catch { return []; } };
		const a = new Map(parse(before).map((e) => [e.id, e])), b = new Map(parse(after).map((e) => [e.id, e]));
		const tally = (ids: string[], from: Map<string, { type: string }>) => { const n = new Map<string, number>(); for (const id of ids) { const t = from.get(id)?.type ?? "item"; n.set(t, (n.get(t) ?? 0) + 1); } return [...n].map(([t, c]) => `${c} ${t}${c === 1 ? "" : "s"}`).join(", "); };
		const added = [...b.keys()].filter((id) => !a.has(id)), removed = [...a.keys()].filter((id) => !b.has(id));
		const changed = [...b.keys()].filter((id) => a.has(id) && JSON.stringify(a.get(id)) !== JSON.stringify(b.get(id)));
		if (!added.length && !removed.length && !changed.length) { box.createDiv({ cls: "bb-ed-muted", text: "Nothing is different between the start and the end of this period." }); return; }
		if (added.length) box.createDiv({ cls: "bb-hist-line is-add" }).setText(`+ added ${tally(added, b)}`);
		if (removed.length) box.createDiv({ cls: "bb-hist-line is-del" }).setText(`− removed ${tally(removed, a)}`);
		if (changed.length) box.createDiv({ cls: "bb-hist-line is-same" }).setText(`~ changed or moved ${tally(changed, b)}`);
		for (const id of added) { const t = b.get(id)?.text; if (t) box.createDiv({ cls: "bb-hist-line is-add" }).setText(`+ text: ${t.slice(0, 200)}`); }
		for (const id of removed) { const t = a.get(id)?.text; if (t) box.createDiv({ cls: "bb-hist-line is-del" }).setText(`− text: ${t.slice(0, 200)}`); }
		box.createDiv({ cls: "bb-ed-muted bb-hist-skip", text: "To see the board as it was, press \"Save a copy\" and open the copy." });
	}

	private drawDeckChanges(box: HTMLElement, before: string, after: string) {
		type D = { slides?: { id: string; elements?: { text?: string }[] }[] };
		const parse = (t: string): D => { try { return JSON.parse(t || "{}") as D; } catch { return {}; } };
		const A = parse(before).slides ?? [], B = parse(after).slides ?? [];
		const aIds = new Set(A.map((s) => s.id)), bIds = new Set(B.map((s) => s.id));
		const added = B.filter((s) => !aIds.has(s.id)).length, removed = A.filter((s) => !bIds.has(s.id)).length;
		box.createDiv({ cls: "bb-hist-line is-same" }).setText(`${A.length} slides before, ${B.length} after` + (added ? `, ${added} added` : "") + (removed ? `, ${removed} removed` : ""));
		const text = (s: typeof A) => s.map((x, i) => `Slide ${i + 1}\n${(x.elements ?? []).map((e) => e.text ?? "").filter(Boolean).join("\n")}`).join("\n\n") + "\n";
		const tb = text(A), ta = text(B);
		if (tb !== ta) this.drawTextDiff(box, tb, ta); else if (!added && !removed) box.createDiv({ cls: "bb-ed-muted", text: "The words are the same. Shapes, drawings or layouts may have changed: press \"Save a copy\" to look." });
	}

	private drawSheetChanges(box: HTMLElement, before: ArrayBuffer, after: ArrayBuffer) {
		const cells = (buf: ArrayBuffer) => { const out = new Map<string, string>(); if (!buf.byteLength) return out; const wb = new Workbook(buf); for (const s of wb.sheets) for (const [ref, raw] of s.raw) out.set(`${s.name}!${ref}`, raw); return out; };
		const a = cells(before), b = cells(after);
		const keys = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k));
		box.createDiv({ cls: "bb-hist-stats" }).setText(`${num(keys.length)} cell${keys.length === 1 ? "" : "s"} different`);
		if (!keys.length) return;
		for (const k of keys.slice(0, 200)) {
			const x = a.get(k), y = b.get(k);
			const l = box.createDiv("bb-hist-line " + (x === undefined ? "is-add" : y === undefined ? "is-del" : "is-same"));
			l.createSpan({ cls: "bb-hist-sign", text: x === undefined ? "+" : y === undefined ? "−" : "~" });
			l.createSpan({ cls: "bb-hist-text", text: `${k}:  ${x ?? "(empty)"}  →  ${y ?? "(empty)"}` });
		}
		if (keys.length > 200) box.createDiv({ cls: "bb-hist-skip", text: `…and ${num(keys.length - 200)} more` });
	}

	// ---------- going back ----------

	private confirmRestore(index: number, when: string) {
		new ConfirmBox(this.app, "Go back to an older version?", `Replace ${this.path.split("/").pop()} with how it was at ${when}?`, "What you have now isn't lost: it stays in the history, so you can come back to it.", "Go back", async () => {
			const v = await this.version(index);
			const f = this.app.vault.getAbstractFileByPath(this.path);
			if (typeof v === "string") { if (f instanceof TFile) await this.app.vault.modify(f, v); else await this.app.vault.create(this.path, v); }
			else if (f instanceof TFile) await this.app.vault.modifyBinary(f, v); else await this.app.vault.createBinary(this.path, v);
			new Notice(`Went back to ${when}. The version you replaced is still in the history.`);
			await this.reload();
		}).open();
	}

	private async saveCopy(index: number, t: number) {
		const v = await this.version(index);
		const d = new Date(t);
		const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
		const dot = this.path.lastIndexOf("."), slash = this.path.lastIndexOf("/");
		const stem = dot > slash ? this.path.slice(0, dot) : this.path, ext = dot > slash ? this.path.slice(dot) : "";
		let name = `${stem} (version ${stamp})${ext}`;
		for (let i = 2; await this.app.vault.adapter.exists(name); i++) name = `${stem} (version ${stamp} ${i})${ext}`;
		const f = typeof v === "string" ? await this.app.vault.create(name, v) : await this.app.vault.createBinary(name, v);
		new Notice(`Saved ${f.name}`);
		void this.app.workspace.getLeaf("tab").openFile(f);
	}
}

export class ConfirmBox extends Modal {
	constructor(app: App, private title: string, private text: string, private more: string, private yes: string, private run: () => Promise<void>) { super(app); }
	onOpen() {
		this.setTitle(this.title);
		this.contentEl.createEl("p", { text: this.text });
		if (this.more) this.contentEl.createEl("p", { text: this.more });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.yes).setCta().onClick(() => { this.close(); void this.run(); }));
	}
	onClose() { this.contentEl.empty(); }
}

/** Pick which file's history to look at, including files that have since been deleted. */
class FilePicker extends FuzzySuggestModal<{ path: string; deleted: boolean }> {
	constructor(app: App, private plugin: BitsAndBobs, private done: (path: string) => void) { super(app); this.setPlaceholder("Find a file with a history"); }
	getItems() { return this.plugin.history.files(); }
	getItemText(i: { path: string; deleted: boolean }) { return i.path + (i.deleted ? "  (deleted)" : ""); }
	onChooseItem(i: { path: string }) { this.done(i.path); }
}
