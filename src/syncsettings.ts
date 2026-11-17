import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import type BitsAndBobs from "./main";
import { describeResult, SignedOutError } from "./sync";

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
	const s = plugin.settings.sync;
	const save = () => plugin.saveSettings();

	new Setting(containerEl).setName("Cloud sync").setHeading();

	if (!cloud.signedIn) {
		new Setting(containerEl)
			.setName("Sign in with your account")
			.setDesc("Sign in to copy the folders and files you choose, and your citations, to the cloud so they show up on your other devices. Nothing is sent until you sign in and choose what to sync.")
			.addButton((b) => b.setButtonText("Sign in").setCta().onClick(() => void cloud.beginSignIn()));
		let code = "";
		new Setting(containerEl)
			.setName("Obsidian didn't open after signing in?")
			.setDesc("Paste the code shown on the sign-in page.")
			.addText((t) => t.setPlaceholder("Code").onChange((v) => { code = v; }))
			.addButton((b) => b.setButtonText("Use code").onClick(async () => {
				if (code.trim() && (await cloud.finishSignIn(code))) redraw();
			}));
		return;
	}

	const who = s.user ? (s.user.name ? `${s.user.name} (${s.user.email})` : s.user.email) : "your account";
	const acct = new Setting(containerEl).setName(`Signed in as ${who}`).setDesc("Checking how much you've stored…")
		.addButton((b) => b.setButtonText("Sign out").onClick(async () => { await cloud.signOut(); redraw(); }));
	void cloud.usage().then((u) => { if (u) acct.setDesc(`${u.files} file${u.files === 1 ? "" : "s"} in the cloud, using ${size(u.bytes)} of ${size(u.limit)}.`); else acct.setDesc(""); });

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

	new Setting(containerEl).setName("Sync citations").setDesc("Keep your citation list the same on all your devices.")
		.addToggle((t) => t.setValue(s.citations).onChange(async (v) => { s.citations = v; await save(); }));

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
	new Setting(containerEl).setName("Delete everything in the cloud")
		.setDesc("Removes your synced files and citations from the cloud. Files on this device are kept.")
		.addButton((b) => b.setButtonText("Delete").setClass("mod-warning").onClick(() => new ConfirmModal(app, "Delete your cloud copy?",
			"Your synced files and citations will be removed from the cloud. Nothing on this device is deleted, but other devices won't get updates until you sync again.",
			"Delete", () => {
				void cloud.deleteEverything().then(() => { new Notice("Cloud copy deleted."); redraw(); }, (e) => new Notice(`Couldn't delete: ${(e as Error).message}`));
			}).open()));
}
