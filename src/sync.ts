/**
 * Optional cloud sync with Leroy's Account sign-in.
 * Nothing here touches the network until someone signs in, and nothing syncs until they pick folders or files.
 *
 * Sign-in: open Account's sign-in page in the browser. When it's done, Account sends the browser to the sync
 * server's /connect page, which opens obsidian://bits-and-bobs-sync?code=... The code (with this device's
 * PKCE verifier) is swapped for a token that's kept in the plugin's data.
 */
import { Notice, TAbstractFile, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import type { RequestUrlResponse } from "obsidian";
import type BitsAndBobs from "./main";
import type { Citation } from "./citeformat";
import { CiteView, VIEW_CITE } from "./cite";

export const ACCOUNT_URL = "https://account.leroyw1e.workers.dev";
export const SYNC_URL = "https://obsidian.leroyw1e.workers.dev";
export const PROTOCOL_ACTION = "bits-and-bobs-sync";

export interface SyncUser { id: string; email: string; name: string }

export interface SyncSettings {
	token: string;
	user: SyncUser | null;
	expires: number;
	/** vault paths of folders or files to sync; "/" means the whole vault */
	paths: string[];
	citations: boolean;
	auto: boolean;
	lastSync: number;
}

export const DEFAULT_SYNC: SyncSettings = { token: "", user: null, expires: 0, paths: [], citations: true, auto: false, lastSync: 0 };

/** What the files looked like after the last sync, so changes on each side can be told apart. */
interface SyncState {
	user: string;
	/** path -> hash at the last sync */
	files: Record<string, string>;
	/** path -> [mtime, size, hash] so unchanged files aren't read again */
	cache: Record<string, [number, number, string]>;
	/** citation id -> JSON at the last sync */
	citations: Record<string, string>;
}

interface RemoteFile { hash: string; size: number; mtime: number; deleted: boolean }

export interface SyncResult { up: number; down: number; removed: number; conflicts: number; citations: boolean; errors: string[] }

const MAX_FILE = 60 * 1024 * 1024;
const AUTO_MINUTES = 5;

function b64u(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(data: ArrayBuffer): Promise<string> {
	const h = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
	return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

export class SignedOutError extends Error {}

export class CloudSync {
	/** sync server address (a property so tests can point it at a local copy) */
	base = SYNC_URL;
	private verifier = "";
	private running: Promise<SyncResult> | null = null;
	private autoTimer: number | null = null;
	private changeTimer: number | null = null;
	/** called when sign-in state or last-sync time changes, so the settings tab can redraw */
	onChange: (() => void) | null = null;

	constructor(private plugin: BitsAndBobs) {}

	get s(): SyncSettings { return this.plugin.settings.sync; }
	get signedIn(): boolean { return !!this.s.token; }
	get busy(): boolean { return !!this.running; }

	private get statePath(): string {
		return normalizePath(`${this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`}/sync-state.json`);
	}

	// ---------- sign in ----------

	start() {
		this.plugin.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
			if (params.code) void this.finishSignIn(params.code);
		});
		this.plugin.registerEvent(this.plugin.app.vault.on("modify", (f) => this.onLocalChange(f)));
		this.plugin.registerEvent(this.plugin.app.vault.on("create", (f) => this.onLocalChange(f)));
		this.plugin.registerEvent(this.plugin.app.vault.on("delete", (f) => this.onLocalChange(f)));
		this.plugin.registerEvent(this.plugin.app.vault.on("rename", (f) => this.onLocalChange(f)));
		this.plugin.register(() => this.stopAuto());
		this.plugin.app.workspace.onLayoutReady(() => {
			this.applyAuto();
			if (this.signedIn && this.s.auto && this.hasSomethingToSync()) window.setTimeout(() => void this.syncQuietly(), 4000);
		});
	}

	async beginSignIn() {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		this.verifier = b64u(bytes);
		const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(this.verifier))));
		const url = `${ACCOUNT_URL}/authorize?return_to=${encodeURIComponent(`${SYNC_URL}/connect`)}&code_challenge=${challenge}`;
		window.open(url);
	}

	/** Swap the one-time code from the browser for a token. Also used by the "paste a code" box. */
	async finishSignIn(code: string): Promise<boolean> {
		if (!this.verifier) {
			new Notice("Start signing in from Bits and Bobs settings first.");
			return false;
		}
		try {
			const r = await requestUrl({
				url: `${this.base}/api/connect`, method: "POST", contentType: "application/json",
				body: JSON.stringify({ code: code.trim(), code_verifier: this.verifier }), throw: false,
			});
			const d = r.json as { token?: string; expires?: number; user?: SyncUser; error?: string };
			if (r.status !== 200 || !d.token || !d.user) {
				new Notice(d.error ?? "Couldn't sign in with Keyring. Try again.");
				return false;
			}
			this.verifier = "";
			this.s.token = d.token;
			this.s.user = d.user;
			this.s.expires = d.expires ?? 0;
			await this.plugin.saveSettings();
			new Notice(`Signed in to Keyring as ${d.user.name || d.user.email}`);
			this.applyAuto();
			this.onChange?.();
			return true;
		} catch {
			new Notice("Couldn't reach the sync server. Check your internet connection.");
			return false;
		}
	}

	async signOut() {
		this.plugin.source.select("");
		const token = this.s.token;
		this.s.token = "";
		this.s.user = null;
		this.s.expires = 0;
		await this.plugin.saveSettings();
		this.stopAuto();
		this.onChange?.();
		if (token) {
			try { await requestUrl({ url: `${this.base}/api/signout`, method: "POST", headers: { authorization: `Bearer ${token}` }, throw: false }); } catch { /* offline: the token still expires */ }
		}
	}

	/** The server said the sign-in has ended. */
	async handleSignedOut() {
		this.s.token = "";
		this.s.user = null;
		await this.plugin.saveSettings();
		this.stopAuto();
		this.onChange?.();
	}

	// ---------- network ----------

	async api(path: string, opts: { method?: string; body?: string | ArrayBuffer; contentType?: string } = {}): Promise<RequestUrlResponse> {
		if (!this.s.token) throw new SignedOutError("Sign in with Keyring first.");
		const r = await requestUrl({
			url: this.base + path, method: opts.method ?? "GET", body: opts.body, contentType: opts.contentType,
			headers: { authorization: `Bearer ${this.s.token}` }, throw: false,
		});
		if (r.status === 401) {
			await this.handleSignedOut();
			throw new SignedOutError("Your Keyring sign-in has ended. Sign in again in Bits and Bobs settings.");
		}
		if (r.status >= 400) {
			let msg = `The sync server said ${r.status}.`;
			try { msg = (r.json as { error?: string }).error ?? msg; } catch { /* not JSON */ }
			throw new Error(msg);
		}
		return r;
	}

	async usage(): Promise<{ bytes: number; files: number; limit: number } | null> {
		try {
			const d = (await this.api("/api/me")).json as { usage: { bytes: number; files: number }; limit: number; user: SyncUser };
			if (d.user) { this.s.user = d.user; }
			return { ...d.usage, limit: d.limit };
		} catch { return null; }
	}

	async deleteEverything() {
		await this.api("/api/everything", { method: "DELETE" });
		this.plugin.settings.shares = [];
		await this.plugin.saveSettings();
		const st = await this.loadState();
		st.files = {};
		st.citations = {};
		await this.saveState(st);
	}

	// ---------- what to sync ----------

	hasSomethingToSync(): boolean { return this.s.paths.length > 0 || this.s.citations; }

	inScope(path: string): boolean {
		const cfg = this.plugin.app.vault.configDir;
		if (path === cfg || path.startsWith(cfg + "/")) return false;
		if (path.split("/").some((p) => p.startsWith("."))) return false;
		return this.s.paths.some((p) => p === "/" || path === p || path.startsWith(p + "/"));
	}

	private localFiles(): TFile[] {
		return this.plugin.app.vault.getFiles().filter((f) => this.inScope(f.path));
	}

	// ---------- auto sync ----------

	applyAuto() {
		this.stopAuto();
		if (!this.signedIn || !this.s.auto) return;
		this.autoTimer = window.setInterval(() => void this.syncQuietly(), AUTO_MINUTES * 60_000);
	}

	private stopAuto() {
		if (this.autoTimer !== null) window.clearInterval(this.autoTimer);
		if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
		this.autoTimer = this.changeTimer = null;
	}

	/** With auto sync on, sync about 30 seconds after you stop changing synced files. */
	private onLocalChange(f: TAbstractFile) {
		if (!this.signedIn || !this.s.auto || !this.inScope(f.path) || this.running) return;
		if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
		this.changeTimer = window.setTimeout(() => { this.changeTimer = null; void this.syncQuietly(); }, 30_000);
	}

	/** Called when the citation list changes, so auto sync can send it. */
	citationsChanged() {
		if (!this.signedIn || !this.s.auto || !this.s.citations || this.running) return;
		if (this.changeTimer !== null) window.clearTimeout(this.changeTimer);
		this.changeTimer = window.setTimeout(() => { this.changeTimer = null; void this.syncQuietly(); }, 30_000);
	}

	private async syncQuietly() {
		if (!this.signedIn || !this.hasSomethingToSync()) return;
		try {
			const r = await this.sync();
			if (r.conflicts) new Notice(`Bits and Bobs sync: ${r.conflicts} file${r.conflicts === 1 ? " was" : "s were"} changed on two devices. Both copies were kept.`);
			if (r.errors.length) console.warn("Bits and Bobs sync:", r.errors);
		} catch (e) {
			if (e instanceof SignedOutError) new Notice(e.message);
			else console.warn("Bits and Bobs sync failed", e);
		}
	}

	// ---------- the sync itself ----------

	sync(): Promise<SyncResult> {
		if (this.running) return this.running;
		this.running = this.doSync().finally(() => { this.running = null; this.onChange?.(); });
		this.onChange?.();
		return this.running;
	}

	private async loadState(): Promise<SyncState> {
		const empty: SyncState = { user: this.s.user?.id ?? "", files: {}, cache: {}, citations: {} };
		try {
			const a = this.plugin.app.vault.adapter;
			if (!(await a.exists(this.statePath))) return empty;
			const st = JSON.parse(await a.read(this.statePath)) as SyncState;
			// a different person signed in: start fresh so nothing is deleted by mistake
			if (st.user !== empty.user) return empty;
			return { ...empty, ...st };
		} catch { return empty; }
	}

	private async saveState(st: SyncState) {
		await this.plugin.app.vault.adapter.write(this.statePath, JSON.stringify(st));
	}

	private async localHash(f: TFile, st: SyncState): Promise<string> {
		const c = st.cache[f.path];
		if (c && c[0] === f.stat.mtime && c[1] === f.stat.size) return c[2];
		const h = await sha256(await this.plugin.app.vault.readBinary(f));
		st.cache[f.path] = [f.stat.mtime, f.stat.size, h];
		return h;
	}

	private async doSync(): Promise<SyncResult> {
		const res: SyncResult = { up: 0, down: 0, removed: 0, conflicts: 0, citations: false, errors: [] };
		const st = await this.loadState();

		if (this.s.paths.length) await this.syncFiles(st, res);
		await this.plugin.source.sync();
		try { await this.plugin.shares.syncAll(); } catch (e) { res.errors.push(`Shared links: ${(e as Error).message}`); }
		if (this.s.citations) {
			try { res.citations = await this.syncCitations(st); }
			catch (e) { if (e instanceof SignedOutError) throw e; res.errors.push(`Citations: ${(e as Error).message}`); }
		}

		await this.saveState(st);
		this.s.lastSync = Date.now();
		await this.plugin.saveSettings();
		return res;
	}

	private async syncFiles(st: SyncState, res: SyncResult) {
		const vault = this.plugin.app.vault;
		const remote = ((await this.api("/api/manifest")).json as { files: Record<string, RemoteFile> }).files;

		const local = new Map<string, TFile>();
		for (const f of this.localFiles()) local.set(f.path, f);

		const paths = new Set<string>();
		for (const p of local.keys()) paths.add(p);
		for (const [p, r] of Object.entries(remote)) if (this.inScope(p) && !r.deleted) paths.add(p);
		for (const p of Object.keys(st.files)) if (this.inScope(p)) paths.add(p);

		for (const path of paths) {
			try {
				const f = local.get(path);
				const r = remote[path] && !remote[path].deleted ? remote[path] : null;
				const base = st.files[path];
				if (f && f.stat.size > MAX_FILE) { res.errors.push(`${path}: too big to sync`); continue; }
				const l = f ? await this.localHash(f, st) : null;
				const rh = r ? r.hash : null;

				if (l === rh) {
					if (l) st.files[path] = l; else delete st.files[path];
					continue;
				}
				const localChanged = l !== (base ?? null);
				const remoteChanged = rh !== (base ?? null);

				if (localChanged && !remoteChanged) {
					if (f && l) { await this.upload(f); st.files[path] = l; res.up++; }
					else { await this.api(`/api/file?path=${encodeURIComponent(path)}`, { method: "DELETE" }); delete st.files[path]; res.removed++; }
				} else if (remoteChanged && !localChanged) {
					if (r) { await this.download(path, f ?? null, r); st.files[path] = r.hash; res.down++; }
					else if (f) { await this.plugin.app.fileManager.trashFile(f); delete st.files[path]; delete st.cache[path]; res.removed++; }
				} else {
					// changed on both sides
					if (f && r && l) {
						await this.download(this.conflictName(path), null, r, path);
						await this.upload(f);
						st.files[path] = l;
						res.conflicts++;
					} else if (f && l) {
						// deleted elsewhere but edited here: keep the edit
						await this.upload(f); st.files[path] = l; res.up++;
					} else if (r) {
						// deleted here but edited elsewhere: bring the edit back
						await this.download(path, null, r); st.files[path] = r.hash; res.down++;
					}
				}
			} catch (e) {
				if (e instanceof SignedOutError) throw e;
				res.errors.push(`${path}: ${(e as Error).message}`);
			}
		}
		// forget cache entries for files that no longer exist
		for (const p of Object.keys(st.cache)) if (!vault.getAbstractFileByPath(p)) delete st.cache[p];
	}

	private conflictName(path: string): string {
		const dot = path.lastIndexOf(".");
		const slash = path.lastIndexOf("/");
		const stem = dot > slash ? path.slice(0, dot) : path;
		const ext = dot > slash ? path.slice(dot) : "";
		const d = new Date();
		const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
		let name = `${stem} (other device ${stamp})${ext}`;
		for (let i = 2; this.plugin.app.vault.getAbstractFileByPath(name); i++) name = `${stem} (other device ${stamp} ${i})${ext}`;
		return name;
	}

	private async upload(f: TFile) {
		const data = await this.plugin.app.vault.readBinary(f);
		await this.api(`/api/file?path=${encodeURIComponent(f.path)}&mtime=${f.stat.mtime}`, { method: "PUT", body: data, contentType: "application/octet-stream" });
	}

	/** Save the cloud copy of `from` (normally the same path) into the vault at `path`. */
	private async download(path: string, existing: TFile | null, r: RemoteFile, from = path) {
		const vault = this.plugin.app.vault;
		const data = (await this.api(`/api/file?path=${encodeURIComponent(from)}`)).arrayBuffer;
		if (existing) { await vault.modifyBinary(existing, data, { mtime: r.mtime }); return; }
		const slash = path.lastIndexOf("/");
		if (slash > 0) await this.ensureFolder(path.slice(0, slash));
		const there = vault.getAbstractFileByPath(path);
		if (there instanceof TFile) await vault.modifyBinary(there, data, { mtime: r.mtime });
		else await vault.createBinary(path, data, { mtime: r.mtime });
	}

	private async ensureFolder(folder: string) {
		const vault = this.plugin.app.vault;
		const there = vault.getAbstractFileByPath(folder);
		if (there instanceof TFolder) return;
		try { await vault.createFolder(folder); } catch { /* made by another step */ }
	}

	// ---------- citations ----------

	/** the list that lives in Obsidian (Source lists sync with the Source website instead) */
	private getCitations(): Citation[] {
		const c = this.plugin.source.getLocal();
		return Array.isArray(c) ? c : [];
	}

	/** Merge the citation lists three ways: whichever side changed a citation since the last sync wins. */
	private async syncCitations(st: SyncState): Promise<boolean> {
		const remote = ((await this.api("/api/citations")).json as { items: Citation[] }).items ?? [];
		const local = this.getCitations();
		const L = new Map(local.map((c) => [c.id, JSON.stringify(c)]));
		const R = new Map(remote.map((c) => [c.id, JSON.stringify(c)]));
		const B = st.citations;
		const order = [...local.map((c) => c.id), ...remote.map((c) => c.id).filter((id) => !L.has(id))];
		const merged: Citation[] = [];
		const seen = new Set<string>();
		for (const id of order) {
			if (seen.has(id)) continue;
			seen.add(id);
			const l = L.get(id), r = R.get(id), b = B[id];
			let pick: string | undefined;
			if (l === r) pick = l;
			else if (l === b) pick = r;
			else if (r === b) pick = l;
			else pick = l ?? r;
			if (pick) merged.push(JSON.parse(pick) as Citation);
		}
		const out = JSON.stringify(merged);
		let changedHere = false;
		if (out !== JSON.stringify(remote)) await this.api("/api/citations", { method: "PUT", body: JSON.stringify({ items: merged }), contentType: "application/json" });
		if (out !== JSON.stringify(local)) {
			this.plugin.source.setLocal(merged);
			await this.plugin.saveSettings();
			for (const leaf of this.plugin.app.workspace.getLeavesOfType(VIEW_CITE)) {
				if (leaf.view instanceof CiteView) leaf.view.refresh();
			}
			changedHere = true;
		}
		st.citations = Object.fromEntries(merged.map((c) => [c.id, JSON.stringify(c)]));
		return changedHere;
	}
}

export const describeResult = (r: SyncResult): string => {
	const bits: string[] = [];
	if (r.up) bits.push(`${r.up} sent`);
	if (r.down) bits.push(`${r.down} received`);
	if (r.removed) bits.push(`${r.removed} removed`);
	if (r.conflicts) bits.push(`${r.conflicts} changed on two devices (both kept)`);
	if (r.citations) bits.push("citations updated");
	let s = bits.length ? `Synced: ${bits.join(", ")}.` : "Everything is up to date.";
	if (r.errors.length) s += ` ${r.errors.length} couldn't sync: ${r.errors.slice(0, 2).join("; ")}`;
	return s;
};
