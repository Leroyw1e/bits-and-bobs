import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type BitsAndBobs from "./main";
import { describeResult, SignedOutError } from "./sync";
import { linkRow } from "./share";

/** Pick a folder or file in the vault to sync. */
class PathPicker extends FuzzySuggestModal<string> {
	constructor(app: App, private taken: string[], private onPick: (p: string) => void) {
		super(app);
		this.setPlaceholder("Type to find a folder or file to sync");
	}
	getItems(): string[] {
		const out: string[] = [];
		if (!this.taken.includes("/")) out.push("/");
		for (const f of this.app.vault.getAllLoadedFiles()) {
			if (f.path === "/" || this.taken.includes(f.path)) continue;
			if (f instanceof TFolder || f instanceof TFile) out.push(f.path);
		}
		return out;
	}
	getItemText(p: string): string {
		if (p === "/") return "Whole vault";
		return this.app.vault.getAbstractFileByPath(p) instanceof TFolder ? `${p}/` : p;
	}
	onChooseItem(p: string) { this.onPick(p); }
}

class ConfirmModal extends Modal {
	constructor(app: App, private title: string, private body: string, private yes: string, private run: () => void) { super(app); }
	onOpen() {
		this.setTitle(this.title);
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.yes).setClass("mod-warning").onClick(() => { this.close(); this.run(); }));
	}
	onClose() { this.contentEl.empty(); }
}

const ago = (t: number): string => {
	if (!t) return "never";
	const s = (Date.now() - t) / 1000;
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
	return new Date(t).toLocaleString();
};

const size = (n: number): string => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);

/** The "Cloud sync" part of the settings tab. `redraw` re-renders the whole tab. */
export function renderSyncSettings(containerEl: HTMLElement, plugin: BitsAndBobs, redraw: () => void) {
	const app = plugin.app;
	const cloud = plugin.cloud;
	const od = plugin.onedrive;
	const s = plugin.settings.sync;
	const save = () => plugin.saveSettings();
	od.onChange = redraw;

	new Setting(containerEl).setName("Cloud sync").setHeading();

	// ---- Keyring (citations, shared links, and files if chosen)
	if (!cloud.signedIn) {
		new Setting(containerEl)
			.setName("Sign in with Keyring")
			.setDesc("Needed for share links and syncing citations, and to keep files in the Keyring cloud. Nothing is sent until you sign in and choose what to sync.")
			.addButton((b) => b.setButtonText("Sign in with Keyring").setCta().onClick(() => void cloud.beginSignIn()));
		let code = "";
		new Setting(containerEl)
			.setName("Obsidian didn't open after signing in?")
			.setDesc("Paste the code shown on the sign-in page.")
			.addText((t) => t.setPlaceholder("Code").onChange((v) => { code = v; }))
			.addButton((b) => b.setButtonText("Use code").onClick(async () => {
				if (code.trim() && (await cloud.finishSignIn(code))) redraw();
			}));
	} else {
		const who = s.user ? (s.user.name ? `${s.user.name} (${s.user.email})` : s.user.email) : "you";
		const acct = new Setting(containerEl).setName(`Signed in to Keyring as ${who}`).setDesc(s.provider === "keyring" ? "Checking how much you've stored…" : "")
			.addButton((b) => b.setButtonText("Sign out").onClick(async () => { await cloud.signOut(); redraw(); }));
		if (s.provider === "keyring") void cloud.usage().then((u) => { if (u) acct.setDesc(`${u.files} file${u.files === 1 ? "" : "s"} in the cloud, using ${size(u.bytes)} of ${size(u.limit)}.`); else acct.setDesc(""); });
	}

	// ---- where synced files go
	new Setting(containerEl).setName("Keep synced files in")
		.setDesc("Your files go to the Keyring cloud, or straight to your own OneDrive. Citations and share links always use Keyring.")
		.addDropdown((d) => d.addOptions({ keyring: "Keyring cloud", onedrive: "OneDrive" }).setValue(s.provider).onChange(async (v) => {
			s.provider = v === "onedrive" ? "onedrive" : "keyring";
			await save();
			cloud.applyAuto();
			redraw();
		}));

	if (s.provider === "onedrive") renderOneDrive(containerEl, plugin, redraw);

	if (cloud.filesReady) {
		// what to sync
		new Setting(containerEl)
			.setName("Folders and files to sync")
			.setDesc(s.paths.length ? "Everything inside a chosen folder is synced, including new files." : "Nothing is synced yet. Add a folder or file to start.")
			.addButton((b) => b.setButtonText("Add").onClick(() => new PathPicker(app, s.paths, (p) => {
				s.paths = p === "/" ? ["/"] : [...s.paths.filter((x) => !p.startsWith(x + "/") && !x.startsWith(p + "/")), p].sort();
				void save().then(redraw);
			}).open()));
		for (const p of s.paths) {
			const label = p === "/" ? "Whole vault" : app.vault.getAbstractFileByPath(p) instanceof TFolder ? `${p}/` : p;
			new Setting(containerEl).setClass("bb-sync-path").setName(label)
				.addExtraButton((b) => b.setIcon("x").setTooltip("Stop syncing this").onClick(async () => {
					s.paths = s.paths.filter((x) => x !== p);
					await save();
					redraw();
				}));
		}
	}

	if (cloud.signedIn) {
		new Setting(containerEl).setName("Sync citations").setDesc("Keep your citation list the same on all your devices.")
			.addToggle((t) => t.setValue(s.citations).onChange(async (v) => { s.citations = v; await save(); }));
	}

	if (cloud.active) {
		new Setting(containerEl).setName("Sync automatically").setDesc("Sync when Obsidian opens, every 5 minutes, and shortly after you change a synced file.")
			.addToggle((t) => t.setValue(s.auto).onChange(async (v) => { s.auto = v; await save(); cloud.applyAuto(); }));

		const status = new Setting(containerEl).setName("Sync now")
			.setDesc(cloud.busy ? "Syncing…" : `Last synced ${ago(s.lastSync)}.`)
			.addButton((b) => {
				b.setButtonText(cloud.busy ? "Syncing…" : "Sync now").setCta().setDisabled(cloud.busy || !cloud.hasSomethingToSync()).onClick(async () => {
					b.setDisabled(true).setButtonText("Syncing…");
					status.setDesc("Syncing…");
					try {
						const r = await cloud.sync();
						new Notice(describeResult(r));
					} catch (e) {
						new Notice(e instanceof SignedOutError ? e.message : `Sync failed: ${(e as Error).message}`);
					}
					redraw();
				});
			});
	}

	if (!cloud.signedIn) return;

	// shared links
	new Setting(containerEl).setName("Shared links").setHeading();
	const shareBox = containerEl.createDiv();
	const drawShares = () => {
		shareBox.empty();
		const links = plugin.shares.links;
		if (!links.length) {
			shareBox.createDiv({ cls: "setting-item-description ms-note", text: "No shared links yet. Right-click a note, board, deck, spreadsheet, PDF or picture and choose Share as a link." });
			return;
		}
		for (const l of links) linkRow(shareBox, plugin, l, drawShares, true);
	};
	drawShares();
	void plugin.shares.refresh().then(drawShares, () => { /* offline */ });

	new Setting(containerEl).setName("Delete everything in the cloud")
		.setDesc("Removes your synced files, citations and shared links from the Keyring cloud. Files on this device, and anything in OneDrive, are kept.")
		.addButton((b) => b.setButtonText("Delete").setClass("mod-warning").onClick(() => new ConfirmModal(app, "Delete your cloud copy?",
			"Your files, citations and shared links in the Keyring cloud will be removed, and the links will stop working. Nothing on this device is deleted, but other devices won't get updates until you sync again.",
			"Delete", () => {
				void cloud.deleteEverything().then(() => { new Notice("Cloud copy deleted."); redraw(); }, (e) => new Notice(`Couldn't delete: ${(e as Error).message}`));
			}).open()));
}

/** Connect to or disconnect from OneDrive. */
function renderOneDrive(containerEl: HTMLElement, plugin: BitsAndBobs, redraw: () => void) {
	const od = plugin.onedrive;
	const cfg = plugin.settings.sync.od;
	if (od.connected) {
		new Setting(containerEl).setName(`Connected to OneDrive${cfg.name ? ` as ${cfg.name}` : ""}`)
			.setDesc("Your files are kept in the OneDrive folder Apps, then the name you gave your app. Disconnecting doesn't delete anything.")
			.addButton((b) => b.setButtonText("Disconnect").onClick(() => { void od.disconnect().then(redraw); }));
		return;
	}
	if (od.pending) {
		const p = od.pending;
		const box = new Setting(containerEl).setName(`Your code: ${p.userCode}`)
			.setDesc(`Open ${p.uri.replace(/^https:\/\//, "")}, type this code, and sign in with your Microsoft account. This page updates by itself when you're done.`);
		box.addButton((b) => b.setButtonText("Open the page").setCta().onClick(() => { window.open(p.uri); }));
		box.addButton((b) => b.setButtonText("Copy code").onClick(() => { void navigator.clipboard.writeText(p.userCode).then(() => new Notice("Code copied.")); }));
		box.addButton((b) => b.setButtonText("Cancel").onClick(() => od.cancelConnect()));
		return;
	}
	let id = cfg.clientId;
	const idRow = new Setting(containerEl).setName("OneDrive app ID")
		.setDesc("Microsoft needs an app ID (a client ID) once, which you make for free at entra.microsoft.com. The README has the steps. It looks like 12345678-90ab-cdef-1234-567890abcdef.")
		.addText((t) => t.setPlaceholder("Application (client) ID").setValue(id).onChange((v) => { id = v; }));
	idRow.addButton((b) => b.setButtonText("Connect OneDrive").setCta().onClick(() => { void od.beginConnect(id); }));
	if (od.error) containerEl.createDiv({ cls: "setting-item-description bb-od-error", text: od.error });
}
