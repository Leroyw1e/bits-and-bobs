/**
 * Share a spreadsheet as a link (needs the Account sign-in from cloud sync).
 *
 * A link is either "live" (your changes go up automatically) or a copy as it was, and either view only or
 * editable. For a live, editable link, changes people make online come back into the .xlsx in your vault.
 * The server keeps a time for every cell and the newest change to a cell wins, on both sides.
 *
 * What was last sent for each link is kept in shares-state.json in the plugin folder, so only changed
 * cells are sent and changes made online can be told apart from changes made here.
 */
import { App, Modal, Notice, Setting, TAbstractFile, TFile, normalizePath } from "obsidian";
import type BitsAndBobs from "./main";
import { SheetView, VIEW_SHEET, Workbook } from "./sheet";
import type { ShareCells, ShareMeta } from "./sharecalc";
import { cellKey } from "./sharecalc";
import { ShareKind, capture, shareKind } from "./sharecapture";

export interface ShareLink {
	id: string;
	/** what's shared: a spreadsheet, or a note, board, deck, PDF or picture (view only) */
	kind?: ShareKind;
	url: string;
	/** vault path of the spreadsheet */
	file: string;
	name: string;
	live: boolean;
	edit: boolean;
	signin: boolean;
	/** server version up to which online changes have been brought in */
	lastVer: number;
}

interface LinkState { pushed: ShareCells; meta: string; sent?: string }
type Op = [string, string, number];

const POLL_MS = 20_000;

export const shareSummary = (l: Pick<ShareLink, "live" | "edit" | "signin">) =>
	`${l.live ? "Kept up to date" : "A copy as it was"} · ${!l.edit ? "view only" : l.signin ? "people can edit after signing in to Keyring" : "anyone with the link can edit"}`;

const isSheet = (l: Pick<ShareLink, "kind">) => !l.kind || l.kind === "sheet";

/** A short fingerprint of what was sent, so unchanged files aren't sent again. */
async function fingerprint(files: { name: string; data: ArrayBuffer }[]): Promise<string> {
	const parts: string[] = [];
	for (const f of files) {
		const h = new Uint8Array(await crypto.subtle.digest("SHA-256", f.data));
		parts.push(f.name + ":" + Array.from(h.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join(""));
	}
	return parts.join(",");
}

export class Shares {
	private state: Record<string, LinkState> | null = null;
	private timers = new Map<string, number>();
	private running = new Map<string, Promise<void>>();
	private ticks = 0;

	constructor(private plugin: BitsAndBobs) {}

	get links(): ShareLink[] { return this.plugin.settings.shares; }
	forFile(path: string) { return this.links.filter((l) => l.file === path); }

	private get statePath() {
		return normalizePath(`${this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`}/shares-state.json`);
	}
	private async loadState(): Promise<Record<string, LinkState>> {
		if (this.state) return this.state;
		try {
			const a = this.plugin.app.vault.adapter;
			this.state = (await a.exists(this.statePath)) ? (JSON.parse(await a.read(this.statePath)) as Record<string, LinkState>) : {};
		} catch { this.state = {}; }
		return this.state;
	}
	private async saveState() {
		if (this.state) await this.plugin.app.vault.adapter.write(this.statePath, JSON.stringify(this.state));
	}

	start() {
		const vault = this.plugin.app.vault;
		this.plugin.registerEvent(vault.on("modify", (f) => this.onModify(f)));
		this.plugin.registerEvent(vault.on("rename", (f, old) => { void this.onRename(f, old); }));
		this.plugin.register(() => { for (const t of this.timers.values()) window.clearTimeout(t); });
		// bring in changes people make online: often while the spreadsheet is open, now and then otherwise
		this.plugin.registerInterval(window.setInterval(() => {
			if (!this.plugin.cloud.signedIn) return;
			this.ticks++;
			for (const l of this.links) {
				if (!l.live || !l.edit || !isSheet(l)) continue;
				if (this.isOpen(l.file) || this.ticks % 3 === 0) void this.syncLink(l);
			}
		}, POLL_MS));
	}

	private isOpen(path: string) {
		return this.plugin.app.workspace.getLeavesOfType(VIEW_SHEET).some((leaf) => leaf.view instanceof SheetView && leaf.view.file?.path === path);
	}

	/** Your changes go up a few seconds after you stop typing. */
	private onModify(f: TAbstractFile) {
		if (!(f instanceof TFile) || !this.plugin.cloud.signedIn) return;
		for (const l of this.forFile(f.path)) {
			if (!l.live) continue;
			const old = this.timers.get(l.id);
			if (old) window.clearTimeout(old);
			this.timers.set(l.id, window.setTimeout(() => { this.timers.delete(l.id); void this.syncLink(l); }, isSheet(l) ? 4000 : 6000));
		}
	}

	private async onRename(f: TAbstractFile, old: string) {
		const moved = this.links.filter((l) => l.file === old);
		if (!moved.length) return;
		for (const l of moved) l.file = f.path;
		await this.plugin.saveSettings();
		for (const l of moved) {
			try { await this.plugin.cloud.api(`/api/shares/${l.id}`, { method: "PATCH", body: JSON.stringify({ file: f.path }), contentType: "application/json" }); } catch { /* offline: fixed next time */ }
		}
	}

	// ---------- the spreadsheet as cells ----------

	private async model(file: TFile): Promise<{ meta: ShareMeta; cells: ShareCells }> {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_SHEET)) {
			if (leaf.view instanceof SheetView && leaf.view.file?.path === file.path) await leaf.view.flush();
		}
		const book = new Workbook(await this.plugin.app.vault.readBinary(file));
		const meta: ShareMeta = { sheets: [] };
		const cells: ShareCells = {};
		for (const s of book.sheets) {
			meta.sheets.push({ name: s.name, colW: Object.fromEntries(s.colW), rowH: Object.fromEntries(s.rowH), fmt: Object.fromEntries(s.fmt) });
			for (const [ref, raw] of s.raw) if (raw !== "") cells[cellKey(s.name, ref)] = raw;
		}
		return { meta, cells };
	}

	/** Write changed cells into the spreadsheet: into the open view if it's open, otherwise into the .xlsx. */
	private async applyToFile(file: TFile, changes: [string, string][]) {
		for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_SHEET)) {
			if (leaf.view instanceof SheetView && leaf.view.file?.path === file.path) { await leaf.view.applyCells(changes); return; }
		}
		const book = new Workbook(await this.plugin.app.vault.readBinary(file));
		for (const [key, raw] of changes) {
			const i = key.lastIndexOf("!");
			const sheet = book.sheets.find((s) => s.name === key.slice(0, i));
			if (!sheet) continue;
			const ref = key.slice(i + 1);
			if (raw === "") sheet.raw.delete(ref); else sheet.raw.set(ref, raw);
		}
		await this.plugin.app.vault.modifyBinary(file, book.toArrayBuffer());
	}

	// ---------- links ----------

	async create(file: TFile, opts: { live: boolean; edit: boolean; signin: boolean }): Promise<ShareLink> {
		const kind = shareKind(file);
		if (!kind) throw new Error("This kind of file can't be shared.");
		if (kind !== "sheet") {
			const files = await capture(this.plugin, file, kind);
			const r = await this.plugin.cloud.api("/api/shares", {
				method: "POST", contentType: "application/json",
				body: JSON.stringify({ kind, name: file.basename, file: file.path, live: opts.live }),
			});
			const d = r.json as { id: string; url: string; version: number };
			const link: ShareLink = { id: d.id, kind, url: d.url, file: file.path, name: file.basename, live: opts.live, edit: false, signin: false, lastVer: 0 };
			try { await this.upload(link, files); }
			catch (e) { await this.plugin.cloud.api(`/api/shares/${link.id}`, { method: "DELETE" }).catch(() => null); throw e; }
			const st = await this.loadState();
			st[link.id] = { pushed: {}, meta: "", sent: await fingerprint(files) };
			await this.saveState();
			this.links.push(link);
			await this.plugin.saveSettings();
			return link;
		}
		const { meta, cells } = await this.model(file);
		const r = await this.plugin.cloud.api("/api/shares", {
			method: "POST", contentType: "application/json",
			body: JSON.stringify({ name: file.basename, file: file.path, ...opts, meta, cells, t: file.stat.mtime }),
		});
		const d = r.json as { id: string; url: string; version: number };
		const link: ShareLink = { id: d.id, kind: "sheet", url: d.url, file: file.path, name: file.basename, ...opts, lastVer: d.version };
		this.links.push(link);
		const st = await this.loadState();
		st[link.id] = { pushed: cells, meta: JSON.stringify(meta) };
		await this.saveState();
		await this.plugin.saveSettings();
		return link;
	}

	/** Send a note, board, deck, PDF or picture's files, then show them. */
	private async upload(link: ShareLink, files: { name: string; type: string; data: ArrayBuffer }[]) {
		for (const f of files) {
			await this.plugin.cloud.api(`/api/shares/${link.id}/blob?name=${encodeURIComponent(f.name)}`, { method: "PUT", body: f.data, contentType: f.type });
		}
		await this.plugin.cloud.api(`/api/shares/${link.id}/publish`, { method: "POST", contentType: "application/json", body: JSON.stringify({ names: files.map((f) => f.name) }) });
	}

	async change(link: ShareLink, opts: Partial<Pick<ShareLink, "live" | "edit" | "signin">>) {
		if (!isSheet(link)) { delete opts.edit; delete opts.signin; }
		await this.plugin.cloud.api(`/api/shares/${link.id}`, { method: "PATCH", body: JSON.stringify(opts), contentType: "application/json" });
		const wasLive = link.live;
		Object.assign(link, opts);
		await this.plugin.saveSettings();
		// turned live: send what's changed since
		if (link.live && !wasLive) await this.syncLink(link);
	}

	async stop(link: ShareLink) {
		try {
			await this.plugin.cloud.api(`/api/shares/${link.id}`, { method: "DELETE" });
		} catch (e) {
			if (!/turned off/i.test((e as Error).message)) throw e;
		}
		this.forget(link.id);
		await this.plugin.saveSettings();
	}

	private forget(id: string) {
		this.plugin.settings.shares = this.links.filter((l) => l.id !== id);
		if (this.state) { delete this.state[id]; void this.saveState(); }
	}

	/** Match the list to the server (links made on another device show up; turned-off ones go). */
	async refresh() {
		const d = (await this.plugin.cloud.api("/api/shares")).json as { shares: (ShareLink & { version: number })[] };
		const have = new Map(this.links.map((l) => [l.id, l]));
		const next: ShareLink[] = [];
		for (const s of d.shares) {
			const mine = have.get(s.id);
			next.push(mine ? { ...mine, kind: s.kind ?? mine.kind, live: s.live, edit: s.edit, signin: s.signin, url: s.url } : { id: s.id, kind: s.kind, url: s.url, file: s.file, name: s.name, live: s.live, edit: s.edit, signin: s.signin, lastVer: s.version });
		}
		for (const l of this.links) if (!next.some((n) => n.id === l.id)) this.forget(l.id);
		this.plugin.settings.shares = next;
		await this.plugin.saveSettings();
	}

	// ---------- keeping a live link in step ----------

	syncLink(link: ShareLink): Promise<void> {
		const cur = this.running.get(link.id);
		if (cur) return cur;
		const p = this.doSync(link).catch((e: Error) => {
			if (/turned off/i.test(e.message)) { this.forget(link.id); void this.plugin.saveSettings(); return; }
			console.warn("Bits and Bobs: shared link sync", e);
		}).finally(() => this.running.delete(link.id));
		this.running.set(link.id, p);
		return p;
	}

	/** Sync every live link (used by Sync now). */
	async syncAll() {
		for (const l of this.links) if (l.live) await this.syncLink(l);
	}

	private async doSync(link: ShareLink) {
		if (!link.live || !this.plugin.cloud.signedIn) return;
		const vault = this.plugin.app.vault;
		const file = vault.getAbstractFileByPath(link.file);
		if (!(file instanceof TFile)) return;
		const st = await this.loadState();
		const ls = (st[link.id] ??= { pushed: {}, meta: "" });

		// notes, boards, decks, PDFs and pictures: send a fresh copy when the file has changed
		if (!isSheet(link)) {
			const kind = link.kind ?? shareKind(file);
			if (!kind || kind === "sheet") return;
			const files = await capture(this.plugin, file, kind);
			const fp = await fingerprint(files);
			if (fp === ls.sent) return;
			await this.upload(link, files);
			ls.sent = fp;
			await this.saveState();
			return;
		}

		// 1. bring in changes made online
		if (link.edit) {
			const d = (await this.plugin.cloud.api(`/api/shares/${link.id}/changes?since=${link.lastVer}`)).json as { version: number; ops: Op[] };
			if (d.ops.length) {
				const { cells } = await this.model(file);
				const take: [string, string][] = [];
				let keptHere = 0;
				for (const [key, raw, t] of d.ops) {
					const here = cells[key] ?? "";
					const sent = ls.pushed[key] ?? "";
					if (here === raw) { ls.pushed[key] = raw; continue; }
					// changed here too since the last send: the newest change wins
					if (here !== sent && file.stat.mtime > t) { keptHere++; continue; }
					take.push([key, raw]);
					ls.pushed[key] = raw;
				}
				if (take.length) {
					await this.applyToFile(file, take);
					new Notice(`${take.length} cell${take.length === 1 ? " was" : "s were"} changed online in ${file.basename}.` + (keptHere ? ` ${keptHere} you changed more recently ${keptHere === 1 ? "was" : "were"} kept.` : ""));
				}
			}
			link.lastVer = d.version;
		}

		// 2. send changes made here
		const fresh = vault.getAbstractFileByPath(link.file);
		if (!(fresh instanceof TFile)) return;
		const { meta, cells } = await this.model(fresh);
		const ops: Op[] = [];
		for (const [k, raw] of Object.entries(cells)) if (ls.pushed[k] !== raw) ops.push([k, raw, fresh.stat.mtime]);
		for (const k of Object.keys(ls.pushed)) if (!(k in cells) && ls.pushed[k] !== "") ops.push([k, "", fresh.stat.mtime]);
		const metaText = JSON.stringify(meta);
		if (ops.length || metaText !== ls.meta) {
			await this.plugin.cloud.api(`/api/shares/${link.id}/push`, {
				method: "POST", contentType: "application/json",
				body: JSON.stringify({ ops, ...(metaText !== ls.meta ? { meta } : {}) }),
			});
			for (const [k, raw] of ops) { if (raw === "") delete ls.pushed[k]; else ls.pushed[k] = raw; }
			ls.meta = metaText;
		}
		await this.saveState();
		await this.plugin.saveSettings();
	}
}

const copy = (url: string) => { void navigator.clipboard.writeText(url).then(() => new Notice("Link copied.")); };

/** The Share menu for one spreadsheet: make a link, and see, change or stop the links it has. */
export class ShareModal extends Modal {
	constructor(app: App, private plugin: BitsAndBobs, private file: TFile) { super(app); }

	onOpen() {
		this.setTitle(`Share ${this.file.name}`);
		void this.draw(true);
	}
	onClose() { this.contentEl.empty(); }

	private async draw(refresh = false) {
		const el = this.contentEl, shares = this.plugin.shares, cloud = this.plugin.cloud;
		el.empty();
		if (!cloud.signedIn) {
			el.createEl("p", { text: "Share links use Keyring. Sign in first, then come back here." });
			new Setting(el).addButton((b) => b.setButtonText("Sign in with Keyring").setCta().onClick(() => { void cloud.beginSignIn(); this.close(); }));
			return;
		}
		if (refresh) { try { await shares.refresh(); } catch { /* offline: show what we know */ } }

		let live = true, edit = false, signin = false;
		const sheet = shareKind(this.file) === "sheet";
		new Setting(el).setName("New link").setHeading();
		new Setting(el).setName("Updates")
			.addDropdown((d) => d.addOptions({ live: "Keep it up to date with my changes", copy: "Share a copy of it as it is now" }).setValue("live").onChange((v) => { live = v === "live"; }));
		if (sheet) {
			const signinRow = new Setting(el).setName("Editors must sign in").setDesc("People need to sign in with Keyring to make changes. Anyone can still look.")
				.addToggle((t) => t.setValue(false).onChange((v) => { signin = v; }));
			new Setting(el).setName("Others can")
				.addDropdown((d) => d.addOptions({ view: "View only", edit: "Edit" }).setValue("view").onChange((v) => { edit = v === "edit"; signinRow.settingEl.toggle(edit); }));
			el.appendChild(signinRow.settingEl);
			signinRow.settingEl.toggle(false);
		} else {
			el.createDiv({ cls: "setting-item-description ms-note", text: "People with the link can look at it in any web browser, but can't change it." });
		}
		new Setting(el).addButton((b) => b.setButtonText("Make link and copy it").setCta().onClick(async () => {
			b.setDisabled(true).setButtonText("Making link…");
			try {
				const l = await shares.create(this.file, { live, edit, signin });
				copy(l.url);
				await this.draw();
			} catch (e) {
				new Notice(`Couldn't make a link: ${(e as Error).message}`);
				b.setDisabled(false).setButtonText("Make link and copy it");
			}
		}));

		const mine = shares.forFile(this.file.path);
		if (!mine.length) return;
		new Setting(el).setName("Shared links").setHeading();
		for (const l of mine) linkRow(el, this.plugin, l, () => { void this.draw(); });
	}
}

/** One link with copy, options and stop sharing. Used in the Share menu and in settings. */
export function linkRow(el: HTMLElement, plugin: BitsAndBobs, l: ShareLink, redraw: () => void, showFile = false) {
	const s = new Setting(el).setClass("bb-share-row").setName(showFile ? l.file || l.name : l.url.replace(/^https:\/\//, "")).setDesc(shareSummary(l));
	s.addButton((b) => b.setButtonText("Copy link").onClick(() => copy(l.url)));
	s.addExtraButton((b) => b.setIcon("settings-2").setTooltip("Change options").onClick(() => new LinkOptions(plugin.app, plugin, l, redraw).open()));
	s.addExtraButton((b) => b.setIcon("x").setTooltip("Stop sharing").onClick(() => new StopModal(plugin.app, async () => {
		try { await plugin.shares.stop(l); new Notice("Stopped sharing. The link doesn't work any more."); }
		catch (e) { new Notice(`Couldn't stop sharing: ${(e as Error).message}`); }
		redraw();
	}).open()));
}

class LinkOptions extends Modal {
	constructor(app: App, private plugin: BitsAndBobs, private link: ShareLink, private done: () => void) { super(app); }
	onOpen() {
		const l = this.link, el = this.contentEl;
		this.setTitle("Link options");
		const next = { live: l.live, edit: l.edit, signin: l.signin };
		new Setting(el).setName("Updates")
			.addDropdown((d) => d.addOptions({ live: "Keep it up to date with my changes", copy: "Keep it as it is now" }).setValue(l.live ? "live" : "copy").onChange((v) => { next.live = v === "live"; }));
		if (isSheet(l)) {
			const signinRow = new Setting(el).setName("Editors must sign in").setDesc("People need to sign in with Keyring to make changes. Anyone can still look.")
				.addToggle((t) => t.setValue(l.signin).onChange((v) => { next.signin = v; }));
			new Setting(el).setName("Others can")
				.addDropdown((d) => d.addOptions({ view: "View only", edit: "Edit" }).setValue(l.edit ? "edit" : "view").onChange((v) => { next.edit = v === "edit"; signinRow.settingEl.toggle(next.edit); }));
			el.appendChild(signinRow.settingEl);
			signinRow.settingEl.toggle(l.edit);
		}
		new Setting(el)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Save").setCta().onClick(async () => {
				try { await this.plugin.shares.change(l, next); new Notice("Link options saved."); }
				catch (e) { new Notice(`Couldn't change the link: ${(e as Error).message}`); }
				this.close();
				this.done();
			}));
	}
	onClose() { this.contentEl.empty(); }
}

class StopModal extends Modal {
	constructor(app: App, private run: () => Promise<void>) { super(app); }
	onOpen() {
		this.setTitle("Stop sharing?");
		this.contentEl.createEl("p", { text: "The link will stop working for everyone. Your spreadsheet stays in your vault." });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Stop sharing").setClass("mod-warning").onClick(() => { this.close(); void this.run(); }));
	}
	onClose() { this.contentEl.empty(); }
}
