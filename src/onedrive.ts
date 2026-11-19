/**
 * Optional OneDrive sync of a whole vault, as an alternative to Keyring cloud sync.
 * The files go straight between this device and Microsoft; nothing passes through any other server.
 *
 * Sign-in: Microsoft's "device code" flow. The plugin shows a short code, you type it at
 * microsoft.com/devicelogin, and the plugin keeps a refresh token (in plugin data, never synced) to stay connected.
 * That needs an app (client ID) you register once yourself at entra.microsoft.com; see the README.
 *
 * Each vault has its own folder in the app's OneDrive folder (Apps > the app's name > <folder>), mirroring vault paths.
 * What was in step on both sides at the last sync is kept in onedrive-state.json, so a change on one side is told
 * apart from a change on both sides. If both changed, or if both sides already had different files at the very
 * first sync, both versions are kept. Nothing is deleted unless it was in step at the last sync and then removed
 * on one side; deleted files go to the vault's trash (.trash) or OneDrive's recycle bin.
 *
 * A sync works in two steps: first it works out what to do for every file, then it does it a few files at a time.
 */
import { App, Modal, Notice, RequestUrlResponse, Setting, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import type BitsAndBobs from "./main";
import { SignedOutError } from "./sync";
import type { SyncResult } from "./sync";

export const MS_LOGIN = "https://login.microsoftonline.com/consumers/oauth2/v2.0";
export const GRAPH = "https://graph.microsoft.com/v1.0";
const SCOPE = "Files.ReadWrite.AppFolder offline_access";
const MAX_FILE = 100 * 1024 * 1024;
const SMALL = 4_000_000;
/** Microsoft asks for upload pieces in multiples of 320 KiB */
const CHUNK = 12 * 320 * 1024;
const APPROOT = "/me/drive/special/approot";
const SHA1_EMPTY = "da39a3ee5e6b4b0d3255bfef95601890afd80709";
/** how many files are moved at once */
const PARALLEL = 4;
/** a bigger batch of deletions than this (and more than a third of all synced files) is asked about first */
const BIG_DELETE = 20;

export class OneDriveAuthError extends SignedOutError {}

type Form = { status: number; j: Record<string, unknown> };
interface RemoteItem { path: string; id: string; tag: string; size: number; sha1: string; mtime: number; url: string }
interface FileState { /** local content hash at the last sync */ h: string; /** OneDrive's hash at the last sync */ rh: string; tag: string }
interface ODState { folder: string; /** a first sync has finished */ synced: boolean; files: Record<string, FileState>; cache: Record<string, [number, number, string]> }
interface GraphItem {
	name: string; id: string; eTag?: string; size?: number; lastModifiedDateTime?: string;
	file?: { hashes?: { sha1Hash?: string } }; folder?: object; "@microsoft.graph.downloadUrl"?: string;
}
interface LocalFile { path: string; mtime: number; size: number; tfile: TFile | null }
type Action =
	| { kind: "up"; path: string; lf: LocalFile }
	| { kind: "down"; path: string; lf: LocalFile | null; r: RemoteItem }
	| { kind: "conflict"; path: string; lf: LocalFile; r: RemoteItem }
	| { kind: "trashLocal"; path: string; lf: LocalFile }
	| { kind: "deleteRemote"; path: string };

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function sha1(data: ArrayBuffer): Promise<string> {
	const h = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
	return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** OneDrive can't store some names. */
function badName(path: string): boolean {
	return path.length > 380 || path.split("/").some((seg) =>
		/["*:<>?\\|]/.test(seg) || /[. ]$/.test(seg) || seg.startsWith(" ") || seg.length > 255 || seg.startsWith("~$") ||
		seg === "desktop.ini" || seg.includes("_vti_") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(seg));
}

/** A vault's name as a OneDrive folder name. */
export function folderNameFor(vaultName: string): string {
	const n = vaultName.replace(/["*:<>?\\|/]/g, "-").replace(/[. ]+$/, "").replace(/^ +/, "");
	return n || "Vault";
}

const wait = (ms: number) => new Promise<void>((res) => window.setTimeout(res, ms));

/** Run `fn` over the items, `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
	let i = 0;
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
		while (i < items.length) await fn(items[i++]);
	}));
}

class ConfirmDeletes extends Modal {
	private answered = false;
	constructor(app: App, private text: string, private done: (yes: boolean) => void) { super(app); }
	onOpen() {
		this.setTitle("Delete lots of files?");
		this.contentEl.createEl("p", { text: this.text });
		this.contentEl.createEl("p", { text: "Deleted files go to the trash (this device) or the OneDrive recycle bin, so they can be brought back." });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Skip the deletions").onClick(() => this.finish(false)))
			.addButton((b) => b.setButtonText("Delete them").setClass("mod-warning").onClick(() => this.finish(true)));
	}
	private finish(v: boolean) { this.answered = true; this.done(v); this.close(); }
	onClose() { this.contentEl.empty(); if (!this.answered) this.done(false); }
}

export class OneDrive {
	/** Microsoft's addresses (properties so tests can point them at a local copy) */
	login = MS_LOGIN;
	graph = GRAPH;
	/** a code waiting to be typed in at microsoft.com/devicelogin */
	pending: { userCode: string; uri: string; expires: number } | null = null;
	error = "";
	onChange: (() => void) | null = null;
	private session = 0;
	private refreshing: Promise<string> | null = null;
	private note: Notice | null = null;

	constructor(private plugin: BitsAndBobs) {}

	get od() { return this.plugin.settings.sync.od; }
	get connected(): boolean { return !!this.od.refresh; }
	/** this vault's folder inside the app's OneDrive folder */
	get folder(): string { return this.od.folder || folderNameFor(this.plugin.app.vault.getName()); }
	private get pluginDir() { return this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`; }
	private get statePath() { return normalizePath(`${this.pluginDir}/onedrive-state.json`); }

	start() { this.plugin.register(() => { this.session++; }); }

	// ---------- connecting ----------

	private async form(url: string, data: Record<string, string>): Promise<Form> {
		const r = await requestUrl({ url, method: "POST", contentType: "application/x-www-form-urlencoded", body: new URLSearchParams(data).toString(), throw: false });
		let j: Record<string, unknown> = {};
		try { j = r.json as Record<string, unknown>; } catch { /* not JSON */ }
		return { status: r.status, j };
	}

	private str(v: unknown): string { return typeof v === "string" ? v : typeof v === "number" ? String(v) : ""; }

	private errText(j: Record<string, unknown>): string {
		const d = typeof j.error_description === "string" ? j.error_description.split("\r\n")[0] : "";
		return d || (typeof j.error === "string" ? j.error : "Couldn't reach Microsoft.");
	}

	/** Ask Microsoft for a code, show it, and wait for it to be typed in. */
	async beginConnect(clientId: string) {
		clientId = clientId.trim();
		if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(clientId)) {
			new Notice("That doesn't look like an application (client) ID. It looks like 12345678-90ab-cdef-1234-567890abcdef.");
			return;
		}
		this.od.clientId = clientId;
		await this.plugin.saveSettings();
		this.error = "";
		let res: Form;
		try { res = await this.form(`${this.login}/devicecode`, { client_id: clientId, scope: SCOPE }); }
		catch { this.fail("Couldn't reach Microsoft. Check your internet connection."); return; }
		if (res.status !== 200 || !res.j.device_code) { this.fail(this.errText(res.j)); return; }
		const sess = ++this.session;
		const interval = Math.max(1, Number(res.j.interval) || 5);
		this.pending = { userCode: this.str(res.j.user_code), uri: this.str(res.j.verification_uri) || "https://www.microsoft.com/link", expires: Date.now() + (Number(res.j.expires_in) || 900) * 1000 };
		this.onChange?.();
		void this.poll(sess, clientId, this.str(res.j.device_code), interval);
	}

	cancelConnect() { this.session++; this.pending = null; this.error = ""; this.onChange?.(); }

	private fail(msg: string) {
		this.pending = null;
		this.error = msg;
		new Notice(`OneDrive: ${msg}`);
		this.onChange?.();
	}

	private async poll(sess: number, clientId: string, deviceCode: string, interval: number) {
		while (this.session === sess && this.pending && Date.now() < this.pending.expires) {
			await wait(interval * 1000);
			if (this.session !== sess) return;
			let res: Form;
			try { res = await this.form(`${this.login}/token`, { grant_type: "urn:ietf:params:oauth:grant-type:device_code", client_id: clientId, device_code: deviceCode }); }
			catch { continue; } // offline for a moment: keep waiting
			if (res.status === 200 && res.j.refresh_token) {
				this.pending = null;
				await this.saveTokens(res.j);
				this.od.name = await this.whoAmI();
				if (!this.od.folder) this.od.folder = folderNameFor(this.plugin.app.vault.getName());
				await this.plugin.saveSettings();
				new Notice(`Connected to OneDrive${this.od.name ? ` as ${this.od.name}` : ""}.`);
				this.plugin.cloud.applyAuto();
				this.onChange?.();
				return;
			}
			const e = this.str(res.j.error);
			if (e === "authorization_pending") continue;
			if (e === "slow_down") { interval += 5; continue; }
			this.fail(e === "authorization_declined" ? "The sign-in was cancelled." : this.errText(res.j));
			return;
		}
		if (this.session === sess) this.fail("The code ran out of time. Press Connect OneDrive to get a new one.");
	}

	private async saveTokens(j: Record<string, unknown>) {
		this.od.access = typeof j.access_token === "string" ? j.access_token : "";
		this.od.expires = Date.now() + (Number(j.expires_in) || 3600) * 1000;
		if (typeof j.refresh_token === "string" && j.refresh_token) this.od.refresh = j.refresh_token;
		await this.plugin.saveSettings();
	}

	private async whoAmI(): Promise<string> {
		try {
			const r = await this.call("/me/drive?$select=owner");
			const d = r.json as { owner?: { user?: { displayName?: string } } };
			return d.owner?.user?.displayName ?? "";
		} catch { return ""; }
	}

	async disconnect() {
		this.session++;
		this.pending = null;
		Object.assign(this.od, { access: "", refresh: "", expires: 0, name: "" });
		await this.plugin.saveSettings();
		await this.dropState();
		this.plugin.cloud.applyAuto();
		this.onChange?.();
	}

	/** Forget what was in step, so the next sync is treated as a first sync (both versions kept, nothing deleted). */
	async dropState() {
		try { const a = this.plugin.app.vault.adapter; if (await a.exists(this.statePath)) await a.remove(this.statePath); } catch { /* nothing to remove */ }
	}

	/** Use a different OneDrive folder for this vault. */
	async setFolder(name: string) {
		name = folderNameFor(name.trim());
		if (name === this.folder) return;
		this.od.folder = name;
		await this.plugin.saveSettings();
		await this.dropState();
		this.onChange?.();
	}

	/** The vault folders that already exist in the app's OneDrive folder. */
	async listFolders(): Promise<string[]> {
		const out: string[] = [];
		let next: string | null = `${APPROOT}/children?$top=200&$select=name,folder`;
		while (next) {
			const r = await this.call(next);
			if (r.status === 404) break;
			this.check(r);
			const d = r.json as { value: GraphItem[]; "@odata.nextLink"?: string };
			for (const it of d.value) if (it.folder) out.push(it.name);
			next = d["@odata.nextLink"] ?? null;
		}
		return out.sort((a, b) => a.localeCompare(b));
	}

	// ---------- talking to OneDrive ----------

	private async token(force = false): Promise<string> {
		const od = this.od;
		if (!od.refresh) throw new OneDriveAuthError("OneDrive isn't connected. Connect it in Bits and Bobs settings.");
		if (!force && od.access && Date.now() < od.expires - 60_000) return od.access;
		// several files at once may ask at the same moment: renew only once
		if (!this.refreshing) this.refreshing = this.renew().finally(() => { this.refreshing = null; });
		return this.refreshing;
	}

	private async renew(): Promise<string> {
		const od = this.od;
		const res = await this.form(`${this.login}/token`, { grant_type: "refresh_token", client_id: od.clientId, refresh_token: od.refresh, scope: SCOPE });
		if (res.status === 200 && res.j.access_token) { await this.saveTokens(res.j); return od.access; }
		if (res.status === 400 || res.status === 401) {
			// Microsoft says the connection is over (password changed, access removed, and so on)
			od.access = ""; od.refresh = ""; od.expires = 0;
			await this.plugin.saveSettings();
			this.plugin.cloud.applyAuto();
			this.onChange?.();
			throw new OneDriveAuthError("Your OneDrive connection has ended. Connect it again in Bits and Bobs settings.");
		}
		throw new Error(`Microsoft said ${res.status}.`);
	}

	/** One request to Microsoft Graph (or a full address). Signs in again once if the token ran out, waits if asked to slow down, and tries again after a network hiccup. */
	async call(pathOrUrl: string, opts: { method?: string; body?: string | ArrayBuffer; contentType?: string; headers?: Record<string, string>; auth?: boolean } = {}): Promise<RequestUrlResponse> {
		const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.graph + pathOrUrl;
		let forced = false;
		for (let tries = 0; ; tries++) {
			const headers: Record<string, string> = { ...opts.headers };
			if (opts.auth !== false) headers.authorization = `Bearer ${await this.token(forced)}`;
			let r: RequestUrlResponse;
			try { r = await requestUrl({ url, method: opts.method ?? "GET", body: opts.body, contentType: opts.contentType, headers, throw: false }); }
			catch {
				if (tries < 4) { await wait(Math.min(20, 2 ** tries) * 1000); continue; }
				throw new Error("Couldn't reach OneDrive. Check your internet connection.");
			}
			if (r.status === 401 && opts.auth !== false && !forced) { forced = true; continue; }
			if ((r.status === 429 || r.status === 503 || r.status === 504) && tries < 4) {
				const ra = Number(r.headers["retry-after"]);
				await wait(Math.min(30, ra > 0 ? ra : 2 ** tries) * 1000);
				continue;
			}
			return r;
		}
	}

	private check(r: RequestUrlResponse) {
		if (r.status >= 400) {
			let msg = "";
			try { msg = (r.json as { error?: { message?: string } }).error?.message ?? ""; } catch { /* not JSON */ }
			throw new Error(`OneDrive said ${r.status}${msg ? `: ${msg}` : ""}`);
		}
	}

	// ---------- state ----------

	private async loadState(): Promise<ODState> {
		const empty: ODState = { folder: this.folder, synced: false, files: {}, cache: {} };
		try {
			const a = this.plugin.app.vault.adapter;
			if (!(await a.exists(this.statePath))) return empty;
			const st = JSON.parse(await a.read(this.statePath)) as ODState;
			// a different OneDrive folder: start fresh so nothing is deleted by mistake
			return st.folder === this.folder ? { ...empty, ...st } : empty;
		} catch { return empty; }
	}

	private async saveState(st: ODState) { await this.plugin.app.vault.adapter.write(this.statePath, JSON.stringify(st)); }

	private async localHash(lf: LocalFile, st: ODState): Promise<string> {
		const c = st.cache[lf.path];
		if (c && c[0] === lf.mtime && c[1] === lf.size) return c[2];
		const h = await sha1(await this.readLocal(lf));
		st.cache[lf.path] = [lf.mtime, lf.size, h];
		return h;
	}

	// ---------- what's in scope ----------

	private isConfig(path: string): boolean {
		const cfg = this.plugin.app.vault.configDir;
		return path === cfg || path.startsWith(cfg + "/");
	}

	/** Parts of the settings folder that stay on this device: window layout, caches, and this plugin's own sign-in and records. */
	private configExcluded(path: string): boolean {
		const cfg = this.plugin.app.vault.configDir;
		const rel = path.slice(cfg.length + 1);
		const dir = this.pluginDir;
		if (/^workspace[^/]*\.json$/.test(rel)) return true;
		if (rel === "cache" || rel.startsWith("cache/") || rel === ".trash" || rel.startsWith(".trash/")) return true;
		if (rel.endsWith(".DS_Store")) return true;
		if (path.startsWith(`${dir}/history/`)) return true; // file history stays on this device
		if (path.startsWith(`${dir}/dictionaries/`)) return true; // spelling dictionaries are downloaded again on each device
		return [`${dir}/data.json`, `${dir}/onedrive-state.json`, `${dir}/sync-state.json`, `${dir}/shares-state.json`].includes(path);
	}

	private wantFile(path: string): boolean {
		if (this.isConfig(path)) return this.plugin.settings.sync.config && !this.configExcluded(path);
		return this.plugin.cloud.inScope(path);
	}

	private wantFolder(path: string): boolean {
		if (this.isConfig(path)) return this.plugin.settings.sync.config && !this.configExcluded(path);
		return this.plugin.cloud.relevantFolder(path);
	}

	/** Files on this device: the vault's files, and the settings folder (which Obsidian doesn't list) if chosen. */
	private async listLocal(): Promise<Map<string, LocalFile>> {
		const out = new Map<string, LocalFile>();
		const vault = this.plugin.app.vault;
		for (const f of vault.getFiles()) if (this.wantFile(f.path)) out.set(f.path, { path: f.path, mtime: f.stat.mtime, size: f.stat.size, tfile: f });
		if (this.plugin.settings.sync.config) await this.walkConfig(vault.configDir, out);
		return out;
	}

	private async walkConfig(dir: string, out: Map<string, LocalFile>) {
		const a = this.plugin.app.vault.adapter;
		let l: { files: string[]; folders: string[] };
		try { l = await a.list(dir); } catch { return; }
		for (const file of l.files) {
			if (!this.wantFile(file)) continue;
			const st = await a.stat(file);
			if (st && st.type === "file") out.set(file, { path: file, mtime: st.mtime, size: st.size, tfile: null });
		}
		for (const folder of l.folders) if (this.wantFolder(folder)) await this.walkConfig(folder, out);
	}

	private async readLocal(lf: LocalFile): Promise<ArrayBuffer> {
		return lf.tfile ? this.plugin.app.vault.readBinary(lf.tfile) : this.plugin.app.vault.adapter.readBinary(lf.path);
	}

	/** Save data at a path on this device. Returns the new modified time and size. */
	private async writeLocal(path: string, data: ArrayBuffer, mtime: number, existing: TFile | null): Promise<{ mtime: number; size: number }> {
		const vault = this.plugin.app.vault, a = vault.adapter;
		if (this.isConfig(path)) {
			const slash = path.lastIndexOf("/");
			if (slash > 0) { try { await a.mkdir(path.slice(0, slash)); } catch { /* already there */ } }
			await a.writeBinary(path, data, { mtime });
			const st = await a.stat(path);
			return { mtime: st?.mtime ?? mtime, size: st?.size ?? data.byteLength };
		}
		let file: TFile | null = existing;
		if (!file) {
			const slash = path.lastIndexOf("/");
			if (slash > 0) {
				let folder = "";
				for (const part of path.slice(0, slash).split("/")) {
					folder = folder ? `${folder}/${part}` : part;
					if (!(vault.getAbstractFileByPath(folder) instanceof TFolder)) { try { await vault.createFolder(folder); } catch { /* made by another step */ } }
				}
			}
			const there = vault.getAbstractFileByPath(path);
			if (there instanceof TFile) file = there;
		}
		if (file) await vault.modifyBinary(file, data, { mtime });
		else file = await vault.createBinary(path, data, { mtime });
		return { mtime: file.stat.mtime, size: file.stat.size };
	}

	/** Move a file to the trash (Obsidian's own trash by default, as chosen in Obsidian's files settings; never deleted for good by this plugin). */
	private async trashLocal(lf: LocalFile) {
		if (lf.tfile) await this.plugin.app.fileManager.trashFile(lf.tfile);
		else await this.plugin.app.vault.adapter.trashLocal(lf.path);
	}

	// ---------- listing OneDrive ----------

	/** Every file to sync in this vault's OneDrive folder, by vault path. Folders are opened a few at a time. */
	private async listRemote(): Promise<Map<string, RemoteItem>> {
		const out = new Map<string, RemoteItem>();
		const root = this.folder;
		const fields = "id,name,size,eTag,file,folder,lastModifiedDateTime,@microsoft.graph.downloadUrl";
		const queue: string[] = [""];
		let active = 0;
		const walk = async (rel: string) => {
			const full = rel ? `${root}/${rel}` : root;
			let next: string | null = `${APPROOT}:/${enc(full)}:/children?$top=200&$select=${fields}`;
			while (next) {
				const r = await this.call(next);
				if (r.status === 404) return; // no such folder yet
				this.check(r);
				const d = r.json as { value: GraphItem[]; "@odata.nextLink"?: string };
				for (const it of d.value) {
					const path = rel ? `${rel}/${it.name}` : it.name;
					if (it.folder) { if (this.wantFolder(path)) queue.push(path); }
					else if (it.file && this.wantFile(path)) {
						const size = it.size ?? 0;
						out.set(path, {
							path, id: it.id, tag: it.eTag ?? "", size, mtime: it.lastModifiedDateTime ? Date.parse(it.lastModifiedDateTime) : Date.now(),
							sha1: (it.file.hashes?.sha1Hash ?? (size === 0 ? SHA1_EMPTY : "")).toLowerCase(), url: it["@microsoft.graph.downloadUrl"] ?? "",
						});
					}
				}
				next = d["@odata.nextLink"] ?? null;
			}
		};
		const worker = async () => {
			for (;;) {
				const rel = queue.shift();
				if (rel === undefined) { if (active === 0) return; await wait(15); continue; }
				active++;
				try { await walk(rel); } finally { active--; }
			}
		};
		await Promise.all(Array.from({ length: PARALLEL }, worker));
		return out;
	}

	// ---------- the sync ----------

	private progress(text: string) {
		if (!this.note) this.note = new Notice(text, 0);
		else this.note.setMessage(text);
	}
	private endProgress() { this.note?.hide(); this.note = null; }

	async syncFiles(res: SyncResult, manual: boolean) {
		const st = await this.loadState();
		res.first = !st.synced;
		try {
			const [remote, local] = await Promise.all([this.listRemote(), this.listLocal()]);

			// 1. what's on this device now (reads only files that changed since last time)
			const locals = [...local.values()];
			const hashes = new Map<string, string>();
			let checked = 0;
			await pool(locals, PARALLEL, async (lf) => {
				try {
					if (lf.size <= MAX_FILE) hashes.set(lf.path, await this.localHash(lf, st));
				} catch (e) { res.errors.push(`${lf.path}: ${(e as Error).message}`); }
				if (!(++checked % 200) && locals.length > 400) this.progress(`OneDrive: checking files (${checked} of ${locals.length})…`);
			});

			// 2. work out what to do for every file
			const paths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(st.files).filter((p) => this.wantFile(p))]);
			const actions = this.plan(paths, local, remote, hashes, st, res);

			// 3. a big batch of deletions is asked about (or skipped when nobody is looking)
			const deletes = actions.filter((a) => a.kind === "trashLocal" || a.kind === "deleteRemote");
			const tracked = Object.keys(st.files).length;
			let todo = actions;
			if (deletes.length > BIG_DELETE && deletes.length * 3 > tracked) {
				const text = `${deletes.length} of your ${tracked} synced files would be deleted (${deletes.filter((a) => a.kind === "trashLocal").length} here, ${deletes.filter((a) => a.kind === "deleteRemote").length} in OneDrive). That's a lot at once. Is that right?`;
				const yes = manual ? await new Promise<boolean>((done) => new ConfirmDeletes(this.plugin.app, text, done).open()) : false;
				if (!yes) {
					todo = actions.filter((a) => a.kind !== "trashLocal" && a.kind !== "deleteRemote");
					res.errors.push(`${deletes.length} deletions skipped to be safe. Press Sync now to review them.`);
				}
			}

			// 4. do it, a few files at a time
			const transfers = todo.filter((a) => a.kind !== "trashLocal" && a.kind !== "deleteRemote").length;
			let done = 0, saved = 0, saving = false;
			await pool(todo, PARALLEL, async (a) => {
				try { await this.run(a, st, res); }
				catch (e) {
					if (e instanceof SignedOutError) throw e;
					res.errors.push(`${a.path}: ${(e as Error).message}`);
				}
				done++;
				if (transfers >= 8) this.progress(`OneDrive: ${Math.min(done, todo.length)} of ${todo.length} files…`);
				if (done - saved >= 25 && !saving) { saving = true; saved = done; try { await this.saveState(st); } finally { saving = false; } }
			});
			for (const p of Object.keys(st.cache)) if (!local.has(p)) delete st.cache[p];
			st.synced = true;
		} finally {
			this.endProgress();
			await this.saveState(st);
		}
	}

	private plan(paths: Set<string>, local: Map<string, LocalFile>, remote: Map<string, RemoteItem>, hashes: Map<string, string>, st: ODState, res: SyncResult): Action[] {
		const actions: Action[] = [];
		for (const path of paths) {
			const lf = local.get(path) ?? null, r = remote.get(path) ?? null, base = st.files[path];
			if (lf && lf.size > MAX_FILE) { res.errors.push(`${path}: too big to sync`); continue; }
			if (lf && badName(path)) { res.errors.push(`${path}: OneDrive can't store a file with that name`); continue; }
			const l = lf ? hashes.get(path) ?? null : null;
			if (lf && l === null) continue; // couldn't be read this time
			const remoteChanged = (it: RemoteItem) => (base ? (it.sha1 ? it.sha1 !== base.rh : it.tag !== base.tag) : true);
			if (lf && r) {
				if (r.sha1 && l === r.sha1) { st.files[path] = { h: l, rh: r.sha1, tag: r.tag }; continue; }
				const localChanged = !base || l !== base.h;
				if (localChanged && remoteChanged(r)) actions.push({ kind: "conflict", path, lf, r });
				else if (localChanged) actions.push({ kind: "up", path, lf });
				else if (remoteChanged(r)) actions.push({ kind: "down", path, lf, r });
				else st.files[path] = { ...base, tag: r.tag };
			} else if (lf) {
				// not in OneDrive: deleted there (and not changed here), or new here
				if (base && l === base.h) actions.push({ kind: "trashLocal", path, lf });
				else actions.push({ kind: "up", path, lf });
			} else if (r) {
				// not here: deleted here (and not changed in OneDrive), or new in OneDrive
				if (base && !remoteChanged(r)) actions.push({ kind: "deleteRemote", path });
				else actions.push({ kind: "down", path, lf: null, r });
			} else delete st.files[path];
		}
		return actions;
	}

	private async run(a: Action, st: ODState, res: SyncResult) {
		switch (a.kind) {
			case "up": await this.upload(a.lf, st); res.up++; break;
			case "down": await this.download(a.path, a.lf?.tfile ?? null, a.r, st, true); res.down++; break;
			case "conflict":
				// changed in both places (or different at the very first sync): keep OneDrive's copy next to yours, then send yours
				await this.download(await this.plugin.cloud.conflictPath(a.path), null, a.r, st, false);
				await this.upload(a.lf, st);
				res.conflicts++;
				break;
			case "trashLocal":
				await this.trashLocal(a.lf);
				delete st.files[a.path]; delete st.cache[a.path]; res.removed++;
				break;
			case "deleteRemote": {
				const d = await this.call(`${APPROOT}:/${enc(`${this.folder}/${a.path}`)}:`, { method: "DELETE" });
				if (d.status !== 404) this.check(d);
				delete st.files[a.path]; res.removed++;
				break;
			}
		}
	}

	private async upload(lf: LocalFile, st: ODState) {
		const data = await this.readLocal(lf);
		const h = await sha1(data);
		const target = `${APPROOT}:/${enc(`${this.folder}/${lf.path}`)}:`;
		let item: GraphItem;
		if (data.byteLength <= SMALL) {
			const r = await this.call(`${target}/content?@microsoft.graph.conflictBehavior=replace`, { method: "PUT", body: data, contentType: "application/octet-stream" });
			this.check(r);
			item = r.json as GraphItem;
		} else {
			const s = await this.call(`${target}/createUploadSession`, { method: "POST", contentType: "application/json", body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "replace" } }) });
			this.check(s);
			const url = (s.json as { uploadUrl: string }).uploadUrl;
			let last: RequestUrlResponse | null = null;
			for (let pos = 0; pos < data.byteLength; pos += CHUNK) {
				const end = Math.min(pos + CHUNK, data.byteLength);
				const r = await this.call(url, { method: "PUT", auth: false, body: data.slice(pos, end), contentType: "application/octet-stream", headers: { "Content-Range": `bytes ${pos}-${end - 1}/${data.byteLength}` } });
				this.check(r);
				if (r.status !== 200 && r.status !== 201 && r.status !== 202) throw new Error(`OneDrive said ${r.status} while uploading`);
				last = r;
			}
			item = (last?.json ?? {}) as GraphItem;
		}
		st.files[lf.path] = { h, rh: (item.file?.hashes?.sha1Hash ?? h).toLowerCase(), tag: item.eTag ?? "" };
		st.cache[lf.path] = [lf.mtime, lf.size, h];
	}

	private async fetchBytes(r: RemoteItem): Promise<ArrayBuffer> {
		if (r.url) {
			try {
				const d = await requestUrl({ url: r.url, throw: false });
				if (d.status === 200) return d.arrayBuffer;
			} catch { /* try the other way */ }
		}
		const c = await this.call(`${APPROOT}:/${enc(`${this.folder}/${r.path}`)}:/content`);
		this.check(c);
		return c.arrayBuffer;
	}

	/** Save OneDrive's copy at `path`. `record` is false for a conflict copy, which is then sent up like any new file. */
	private async download(path: string, existing: TFile | null, r: RemoteItem, st: ODState, record: boolean) {
		const data = await this.fetchBytes(r);
		const now = await this.writeLocal(path, data, r.mtime, existing);
		if (!record) return;
		const h = await sha1(data);
		st.files[path] = { h, rh: r.sha1 || h, tag: r.tag };
		st.cache[path] = [now.mtime, now.size, h];
	}
}
