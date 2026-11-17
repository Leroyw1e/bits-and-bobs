/**
 * Citation lists shared with the Source website (source.leroyw1e.workers.dev).
 * Uses the same Account sign-in as cloud sync. Nothing is sent until you're signed in.
 *
 * The Citations tab always edits `settings.citations`. When one of your Source lists is picked, that list's
 * citations are copied into `settings.citations`, and edits are copied back into the list and saved to Source.
 * The list that lives only in Obsidian is kept in `source.local` while a Source list is open.
 *
 * Source stores { lists, deleted } with a version number (`updated`). Saving sends the version we last saw;
 * if someone else saved in between, Source answers 409 with its copy, and the two are merged the same way the
 * website does it: every list from both sides, the most recently changed copy of each list wins, and deleted
 * lists stay deleted.
 */
import { requestUrl } from "obsidian";
import type BitsAndBobs from "./main";
import type { Citation, CiteStyle, SourceKind } from "./citeformat";
import { uid } from "./board";

export const SOURCE_URL = "https://source.leroyw1e.workers.dev";
export const VIEW_CITE_TYPE = "bits-citations";
const COLORS = ["#5b5bf7", "#f76b5b", "#2fa36b", "#e5a50a", "#d14fd6", "#1aa5c4", "#f08a24", "#7c5cff"];

export interface SourceAuthor { first: string; last: string }
export interface SourceItem {
	id: string;
	type: string;
	authors: SourceAuthor[];
	title: string;
	site?: string; journal?: string; publisher?: string; city?: string; edition?: string; volume?: string; issue?: string;
	pages?: string; doi?: string; url?: string; year?: string; month?: string; day?: string; accessed?: string;
	created?: number;
	[k: string]: unknown;
}
export interface SourceList { id: string; name: string; style: CiteStyle; color: string; items: SourceItem[]; updated: number; [k: string]: unknown }
interface SourceData { lists: SourceList[]; deleted: string[] }

export interface SourceState {
	lists: SourceList[];
	deleted: string[];
	/** Source's version number when we last saved or loaded */
	base: number;
	/** changed here and not saved to Source yet */
	dirty: boolean;
	/** the Source list open in the Citations tab, or "" for the list that lives in Obsidian */
	active: string;
	/** the Obsidian-only list, kept here while a Source list is open */
	local: Citation[];
}

export const DEFAULT_SOURCE: SourceState = { lists: [], deleted: [], base: 0, dirty: false, active: "", local: [] };

export type SourceStatus = "signin" | "ok" | "saving" | "offline";

const STYLES: CiteStyle[] = ["apa", "mla", "harvard", "chicago"];
const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Source citation -> the plugin's citation. */
export function toCitation(it: SourceItem): Citation {
	const authors = (it.authors ?? []).filter((a) => s(a.first).trim() || s(a.last).trim());
	const names = authors.map((a) => (s(a.first).trim() ? `${s(a.first).trim()} ${s(a.last).trim()}`.trim() : s(a.last).trim()));
	const kind: SourceKind = it.type === "book" || it.type === "journal" || it.type === "video" ? it.type : "website";
	return {
		id: it.id, kind, authors: names, group: authors.length === 1 && !s(authors[0].first).trim() ? true : undefined,
		title: s(it.title), container: kind === "journal" ? s(it.journal) : s(it.site), publisher: s(it.publisher),
		year: s(it.year), month: s(it.month), day: s(it.day), url: s(it.url), accessed: s(it.accessed),
		edition: s(it.edition), volume: s(it.volume), issue: s(it.issue), pages: s(it.pages), doi: s(it.doi), place: s(it.city),
	};
}

function splitAuthor(name: string, group: boolean): SourceAuthor {
	const n = name.trim().replace(/\s+/g, " ");
	if (group) return { first: "", last: n };
	if (n.includes(",")) { const [last, first] = n.split(",", 2).map((x) => x.trim()); return { first: first ?? "", last }; }
	const parts = n.split(" ");
	const last = parts.pop() ?? "";
	return { first: parts.join(" "), last };
}

/** The plugin's citation -> Source citation, keeping anything Source has that the plugin doesn't. */
export function toSourceItem(c: Citation, old?: SourceItem): SourceItem {
	// unchanged: keep Source's copy exactly, so nothing is marked as changed
	if (old && same(normal(toCitation(old)), normal(c))) return old;
	const journal = c.kind === "journal";
	return {
		...(old ?? {}),
		id: c.id,
		type: c.kind === "news" ? "website" : c.kind,
		authors: c.authors.filter((a) => a.trim()).map((a) => splitAuthor(a, !!c.group)),
		title: c.title, site: journal ? s(old?.site) : c.container, journal: journal ? c.container : s(old?.journal),
		publisher: c.publisher, city: c.place, edition: c.edition, volume: c.volume, issue: c.issue, pages: c.pages,
		doi: c.doi, url: c.url, year: c.year, month: c.month, day: c.day, accessed: c.accessed,
		created: old?.created ?? Date.now(),
	};
}

const same = (a: object, b: object) => JSON.stringify(a, Object.keys(a).sort()) === JSON.stringify(b, Object.keys(b).sort());

/** for comparing: news counts as a website on Source, and a lone group author looks the same either way */
function normal(c: Citation) {
	return { ...c, kind: c.kind === "news" ? "website" : c.kind, group: c.authors.length === 1 && (c.group || !c.authors[0].includes(" ")) ? true : undefined };
}

/** Every list from both sides; the most recently changed copy of each wins; deleted lists stay deleted. */
export function mergeData(cloud: SourceData, local: SourceData): SourceData {
	const deleted = [...new Set([...(cloud.deleted ?? []), ...(local.deleted ?? [])])].slice(-500);
	const pick = new Map<string, SourceList>();
	for (const l of [...cloud.lists, ...local.lists]) {
		const c = pick.get(l.id);
		if (!c || (l.updated || 0) > (c.updated || 0)) pick.set(l.id, l);
	}
	const ids = [...new Set([...cloud.lists, ...local.lists].map((l) => l.id))].filter((id) => !deleted.includes(id));
	return { lists: ids.map((id) => pick.get(id)).filter((l): l is SourceList => !!l), deleted };
}

export class SourceLists {
	status: SourceStatus = "signin";
	/** Source's address (a property so tests can point it at a local copy) */
	base = SOURCE_URL;
	private pushTimer: number | null = null;
	private running: Promise<void> | null = null;
	private listeners = new Set<() => void>();
	/** which Source list the Citations tab is showing right now ("" = none); only that list is ever written back */
	private loadedFor = "";

	constructor(private plugin: BitsAndBobs) {}

	get st(): SourceState { return this.plugin.settings.source; }
	get signedIn(): boolean { return this.plugin.cloud.signedIn; }
	get activeList(): SourceList | null { return this.st.lists.find((l) => l.id === this.st.active) ?? null; }

	/** The list that lives only in Obsidian (also what cloud sync copies between devices). */
	getLocal(): Citation[] { return this.st.active ? this.st.local : this.plugin.settings.citations; }
	setLocal(list: Citation[]) {
		if (this.st.active) this.st.local = list;
		else this.plugin.settings.citations = list;
	}

	onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
	private changed() { for (const fn of this.listeners) fn(); }
	private setStatus(v: SourceStatus) { if (this.status !== v) { this.status = v; this.changed(); } }

	start() {
		this.loadedFor = this.activeList ? this.st.active : "";
		this.plugin.register(() => { if (this.pushTimer !== null) window.clearTimeout(this.pushTimer); });
		// look for changes made on the website while the Citations tab is open
		this.plugin.registerInterval(window.setInterval(() => {
			if (this.signedIn && this.plugin.app.workspace.getLeavesOfType(VIEW_CITE_TYPE).length) void this.sync();
		}, 60_000));
		if (!this.signedIn && this.st.active) this.select("");
	}

	// ---------- picking a list ----------

	/** Open a Source list (or "" for the Obsidian list) in the Citations tab. */
	select(id: string) {
		if (id === this.st.active) return;
		if (id && !this.st.lists.some((l) => l.id === id)) return;
		this.commitActive();
		const st = this.st, set = this.plugin.settings;
		if (!st.active) st.local = set.citations;
		st.active = id;
		if (!id) {
			set.citations = st.local;
			st.local = [];
			this.loadedFor = "";
		}
		this.applyActive();
		void this.plugin.saveSettings();
		this.changed();
	}

	newList(name: string) {
		const st = this.st;
		const list: SourceList = { id: uid(), name: name.trim() || "Untitled list", style: this.plugin.settings.citeStyle, color: COLORS[st.lists.length % COLORS.length], items: [], updated: Date.now() };
		st.lists.push(list);
		st.dirty = true;
		this.select(list.id);
		this.schedulePush(200);
	}

	deleteList(id: string) {
		const st = this.st;
		if (st.active === id) this.select("");
		st.lists = st.lists.filter((l) => l.id !== id);
		st.deleted = [...st.deleted.filter((x) => x !== id), id].slice(-500);
		st.dirty = true;
		void this.plugin.saveSettings();
		this.changed();
		this.schedulePush(200);
	}

	/** Copy the open Source list into the Citations tab. */
	private applyActive() {
		const l = this.activeList;
		if (!l) return;
		this.plugin.settings.citations = l.items.map(toCitation);
		if (STYLES.includes(l.style)) this.plugin.settings.citeStyle = l.style;
		this.loadedFor = l.id;
	}

	/** Copy the Citations tab back into the open Source list. Returns true if anything changed. */
	private commitActive(): boolean {
		const l = this.activeList;
		if (!l || this.loadedFor !== l.id) return false;
		const old = new Map(l.items.map((i) => [i.id, i]));
		const items = this.plugin.settings.citations.map((c) => toSourceItem(c, old.get(c.id)));
		const style = this.plugin.settings.citeStyle;
		if (JSON.stringify(items) === JSON.stringify(l.items) && style === l.style) return false;
		l.items = items;
		l.style = style;
		l.updated = Date.now();
		this.st.dirty = true;
		return true;
	}

	/** Called by the Citations tab after every change. */
	localEdit() {
		if (!this.st.active) { this.plugin.cloud.citationsChanged(); return; }
		if (this.commitActive()) {
			void this.plugin.saveSettings();
			this.schedulePush();
		}
	}

	// ---------- talking to Source ----------

	private async api(method: "GET" | "PUT", body?: unknown) {
		const token = this.plugin.settings.sync.token;
		if (!token) throw new Error("signed out");
		const r = await requestUrl({
			url: `${this.base}/api/lists`, method, throw: false,
			headers: { authorization: `Bearer ${token}` },
			contentType: body ? "application/json" : undefined,
			body: body ? JSON.stringify(body) : undefined,
		});
		if (r.status === 401) {
			this.setStatus("signin");
			await this.plugin.cloud.handleSignedOut();
			throw new Error("signed out");
		}
		return r;
	}

	private schedulePush(delay = 1500) {
		if (!this.signedIn) return;
		if (this.pushTimer !== null) window.clearTimeout(this.pushTimer);
		this.setStatus("saving");
		this.pushTimer = window.setTimeout(() => { this.pushTimer = null; void this.sync(); }, delay);
	}

	/** Get changes from Source and send ours. Safe to call any time; calls while one is running share it. */
	sync(): Promise<void> {
		if (!this.signedIn) { this.setStatus("signin"); return Promise.resolve(); }
		if (this.running) return this.running;
		this.running = this.doSync().finally(() => { this.running = null; });
		return this.running;
	}

	private async doSync() {
		const st = this.st;
		try {
			this.commitActive();
			const r = await this.api("GET");
			if (r.status !== 200) throw new Error(`Source said ${r.status}`);
			const cur = r.json as { data: SourceData | null; updated: number };
			if (cur.data && cur.updated !== st.base) {
				if (st.dirty) this.take(mergeData(cur.data, st), cur.updated);
				else this.take({ lists: cur.data.lists, deleted: cur.data.deleted ?? [] }, cur.updated);
			}
			if (st.dirty) await this.push();
			this.setStatus(st.dirty ? "saving" : "ok");
		} catch (e) {
			if ((e as Error).message === "signed out") return;
			console.warn("Bits and Bobs: Source sync", e);
			this.setStatus("offline");
		}
		await this.plugin.saveSettings();
	}

	private async push() {
		const st = this.st;
		for (let tries = 0; tries < 3 && st.dirty; tries++) {
			const r = await this.api("PUT", { base: st.base, data: { lists: st.lists, deleted: st.deleted } });
			if (r.status === 409) {
				const cur = r.json as { data: SourceData | null; updated: number };
				if (cur.data) this.take(mergeData(cur.data, st), cur.updated);
				else st.base = cur.updated;
				continue;
			}
			if (r.status !== 200) throw new Error(`Source said ${r.status}`);
			st.base = (r.json as { updated: number }).updated;
			st.dirty = false;
		}
	}

	/** Use lists from Source and show the open one again if it changed. */
	private take(data: SourceData, updated: number) {
		const st = this.st;
		const before = JSON.stringify(this.activeList);
		st.lists = data.lists;
		st.deleted = data.deleted ?? [];
		st.base = updated;
		if (st.active && !this.activeList) {
			// the open list was deleted on another device
			const set = this.plugin.settings;
			set.citations = st.local;
			st.local = [];
			st.active = "";
			this.loadedFor = "";
		} else if (JSON.stringify(this.activeList) !== before) {
			this.applyActive();
		}
		this.changed();
	}
}
