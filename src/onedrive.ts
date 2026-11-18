/**
 * Optional OneDrive file sync, as an alternative to Keyring cloud sync.
 * The files go straight between this device and Microsoft; nothing passes through any other server.
 *
 * Sign-in: Microsoft's "device code" flow. The plugin shows a short code, you type it at
 * microsoft.com/devicelogin, and the plugin keeps a refresh token (in plugin data) to stay connected.
 * That needs an app (client ID) you register once yourself at entra.microsoft.com; see the README.
 *
 * Files live in the app's own OneDrive folder (OneDrive > Apps > the app's name), mirroring vault paths.
 * What was in step on both sides at the last sync is kept in onedrive-state.json, so a change on one side
 * is told apart from a change on both sides. If both changed, both copies are kept.
 */
import { Notice, RequestUrlResponse, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
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

export class OneDriveAuthError extends SignedOutError {}

type Form = { status: number; j: Record<string, unknown> };
interface RemoteItem { path: string; id: string; tag: string; size: number; sha1: string; mtime: number; url: string }
interface FileState { /** local content hash at the last sync */ h: string; /** OneDrive's hash at the last sync */ rh: string; tag: string }
interface ODState { files: Record<string, FileState>; cache: Record<string, [number, number, string]> }
interface GraphItem {
	name: string; id: string; eTag?: string; size?: number; lastModifiedDateTime?: string;
	file?: { hashes?: { sha1Hash?: string } }; folder?: object; "@microsoft.graph.downloadUrl"?: string;
}

const enc = (p: string) => p.split("/").map(encodeURIComponent).join("/");

async function sha1(data: ArrayBuffer): Promise<string> {
	const h = new Uint8Array(await crypto.subtle.digest("SHA-1", data));
	return Array.from(h, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** OneDrive can't store some names. */
function badName(path: string): boolean {
	return path.split("/").some((seg) =>
		/["*:<>?\\|]/.test(seg) || /[. ]$/.test(seg) || seg.startsWith(" ") || seg.length > 255 || seg.startsWith("~$") ||
		seg === "desktop.ini" || seg.includes("_vti_") || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(seg));
}

const wait = (ms: number) => new Promise<void>((res) => window.setTimeout(res, ms));

export class OneDrive {
	/** Microsoft's addresses (properties so tests can point them at a local copy) */
	login = MS_LOGIN;
	graph = GRAPH;
	/** a code waiting to be typed in at microsoft.com/devicelogin */
	pending: { userCode: string; uri: string; expires: number } | null = null;
	error = "";
	onChange: (() => void) | null = null;
	private session = 0;

	constructor(private plugin: BitsAndBobs) {}

	get od() { return this.plugin.settings.sync.od; }
	get connected(): boolean { return !!this.od.refresh; }
	private get statePath() {
		return normalizePath(`${this.plugin.manifest.dir ?? `${this.plugin.app.vault.configDir}/plugins/${this.plugin.manifest.id}`}/onedrive-state.json`);
	}

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
		try { const a = this.plugin.app.vault.adapter; if (await a.exists(this.statePath)) await a.remove(this.statePath); } catch { /* nothing to remove */ }
		this.plugin.cloud.applyAuto();
		this.onChange?.();
	}

	// ---------- talking to OneDrive ----------

	private async token(force = false): Promise<string> {
		const od = this.od;
		if (!od.refresh) throw new OneDriveAuthError("OneDrive isn't connected. Connect it in Bits and Bobs settings.");
		if (!force && od.access && Date.now() < od.expires - 60_000) return od.access;
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

	/** One request to Microsoft Graph (or a full address). Signs in again once if the token ran out, and waits if asked to slow down. */
	async call(pathOrUrl: string, opts: { method?: string; body?: string | ArrayBuffer; contentType?: string; headers?: Record<string, string>; auth?: boolean } = {}): Promise<RequestUrlResponse> {
		const url = pathOrUrl.startsWith("http") ? pathOrUrl : this.graph + pathOrUrl;
		let forced = false;
		for (let tries = 0; ; tries++) {
			const headers: Record<string, string> = { ...opts.headers };
			if (opts.auth !== false) headers.authorization = `Bearer ${await this.token(forced)}`;
			const r = await requestUrl({ url, method: opts.method ?? "GET", body: opts.body, contentType: opts.contentType, headers, throw: false });
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
		const empty: ODState = { files: {}, cache: {} };
		try {
			const a = this.plugin.app.vault.adapter;
			if (!(await a.exists(this.statePath))) return empty;
			return { ...empty, ...(JSON.parse(await a.read(this.statePath)) as ODState) };
		} catch { return empty; }
	}

	private async saveState(st: ODState) { await this.plugin.app.vault.adapter.write(this.statePath, JSON.stringify(st)); }

	private async localHash(f: TFile, st: ODState): Promise<string> {
		const c = st.cache[f.path];
		if (c && c[0] === f.stat.mtime && c[1] === f.stat.size) return c[2];
		const h = await sha1(await this.plugin.app.vault.readBinary(f));
		st.cache[f.path] = [f.stat.mtime, f.stat.size, h];
		return h;
	}

	// ---------- listing ----------

	/** Every file in scope in the app folder, by vault path. Only folders that could hold chosen files are opened. */
	private async listRemote(): Promise<Map<string, RemoteItem>> {
		const out = new Map<string, RemoteItem>();
		const cloud = this.plugin.cloud;
		const fields = "id,name,size,eTag,file,folder,lastModifiedDateTime,@microsoft.graph.downloadUrl";
		const walk = async (folder: string) => {
			let next: string | null = `${folder ? `${APPROOT}:/${enc(folder)}:/children` : `${APPROOT}/children`}?$top=200&$select=${fields}`;
			while (next) {
				const r = await this.call(next);
				if (r.status === 404) return;
				this.check(r);
				const d = r.json as { value: GraphItem[]; "@odata.nextLink"?: string };
				for (const it of d.value) {
					const path = folder ? `${folder}/${it.name}` : it.name;
					if (it.folder) { if (cloud.relevantFolder(path)) await walk(path); }
					else if (it.file && cloud.inScope(path)) {
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
		await walk("");
		return out;
	}

	// ---------- the sync ----------

	async syncFiles(res: SyncResult) {
		const cloud = this.plugin.cloud, vault = this.plugin.app.vault;
		const st = await this.loadState();
		try {
			const remote = await this.listRemote();
			const local = new Map<string, TFile>();
			for (const f of vault.getFiles()) if (cloud.inScope(f.path)) local.set(f.path, f);
			const paths = new Set<string>([...local.keys(), ...remote.keys(), ...Object.keys(st.files).filter((p) => cloud.inScope(p))]);
			for (const path of paths) {
				try { await this.one(path, local.get(path) ?? null, remote.get(path) ?? null, st, res); }
				catch (e) {
					if (e instanceof SignedOutError) throw e;
					res.errors.push(`${path}: ${(e as Error).message}`);
				}
			}
			for (const p of Object.keys(st.cache)) if (!vault.getAbstractFileByPath(p)) delete st.cache[p];
		} finally {
			await this.saveState(st);
		}
	}

	private async one(path: string, f: TFile | null, r: RemoteItem | null, st: ODState, res: SyncResult) {
		const base = st.files[path];
		if (f && f.stat.size > MAX_FILE) { res.errors.push(`${path}: too big to sync`); return; }
		if (f && badName(path)) { res.errors.push(`${path}: OneDrive can't store a file with that name`); return; }
		const l = f ? await this.localHash(f, st) : null;
		const remoteChanged = (it: RemoteItem) => (base ? (it.sha1 ? it.sha1 !== base.rh : it.tag !== base.tag) : true);

		if (f && r) {
			if (r.sha1 && l === r.sha1) { st.files[path] = { h: l, rh: r.sha1, tag: r.tag }; return; }
			const localChanged = !base || l !== base.h;
			if (localChanged && remoteChanged(r)) {
				// changed in both places: keep the OneDrive copy next to yours, then send yours
				await this.download(this.plugin.cloud.conflictName(path), null, r, st, false);
				await this.upload(f, st);
				res.conflicts++;
			} else if (localChanged) { await this.upload(f, st); res.up++; }
			else if (remoteChanged(r)) { await this.download(path, f, r, st, true); res.down++; }
			else st.files[path] = { ...base, tag: r.tag };
			return;
		}
		if (f && !r) {
			if (base && l === base.h) {
				// deleted on OneDrive and not changed here
				await this.plugin.app.fileManager.trashFile(f);
				delete st.files[path]; delete st.cache[path]; res.removed++;
			} else { await this.upload(f, st); res.up++; }
			return;
		}
		if (!f && r) {
			if (base && !remoteChanged(r)) {
				// deleted here and not changed on OneDrive
				const d = await this.call(`${APPROOT}:/${enc(path)}:`, { method: "DELETE" });
				if (d.status !== 404) this.check(d);
				delete st.files[path]; res.removed++;
			} else { await this.download(path, null, r, st, true); res.down++; }
			return;
		}
		delete st.files[path];
	}

	private async upload(f: TFile, st: ODState) {
		const data = await this.plugin.app.vault.readBinary(f);
		const h = await sha1(data);
		const target = `${APPROOT}:/${enc(f.path)}:`;
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
		st.files[f.path] = { h, rh: (item.file?.hashes?.sha1Hash ?? h).toLowerCase(), tag: item.eTag ?? "" };
		st.cache[f.path] = [f.stat.mtime, f.stat.size, h];
	}

	private async fetchBytes(r: RemoteItem): Promise<ArrayBuffer> {
		if (r.url) {
			const d = await requestUrl({ url: r.url, throw: false });
			if (d.status === 200) return d.arrayBuffer;
		}
		const c = await this.call(`${APPROOT}:/${enc(r.path)}:/content`);
		this.check(c);
		return c.arrayBuffer;
	}

	/** Save OneDrive's copy at `path`. `record` is false for a conflict copy, which is then sent up like any new file. */
	private async download(path: string, existing: TFile | null, r: RemoteItem, st: ODState, record: boolean) {
		const vault = this.plugin.app.vault;
		const data = await this.fetchBytes(r);
		let file: TFile;
		if (existing) { await vault.modifyBinary(existing, data, { mtime: r.mtime }); file = existing; }
		else {
			const slash = path.lastIndexOf("/");
			if (slash > 0) {
				const folder = path.slice(0, slash);
				if (!(vault.getAbstractFileByPath(folder) instanceof TFolder)) { try { await vault.createFolder(folder); } catch { /* made by another step */ } }
			}
			const there = vault.getAbstractFileByPath(path);
			if (there instanceof TFile) { await vault.modifyBinary(there, data, { mtime: r.mtime }); file = there; }
			else file = await vault.createBinary(path, data, { mtime: r.mtime });
		}
		if (!record) return;
		const h = await sha1(data);
		st.files[path] = { h, rh: r.sha1 || h, tag: r.tag };
		st.cache[path] = [file.stat.mtime, file.stat.size, h];
	}
}
