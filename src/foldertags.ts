import { App, Modal, Notice, Setting, TFile } from "obsidian";

/** "School work/Maths" gives ["school-work", "maths"]. Names that can't be a tag (only numbers) are skipped. */
export function folderTags(path: string): string[] {
	const parts = path.split("/").slice(0, -1); // the folders, not the file name
	const tags: string[] = [];
	for (const name of parts) {
		const t = name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_\-/]/gu, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
		if (t && !/^\d+$/.test(t) && !tags.includes(t)) tags.push(t);
	}
	return tags;
}

const asList = (v: unknown): string[] =>
	Array.isArray(v) ? v.map((x) => String(x)) : typeof v === "string" ? v.split(/[,\s]+/).filter(Boolean) : [];

/**
 * Adds the note's folder tags, and when it moved, takes off the tags of the folders it left.
 * Other tags are never touched. Returns true if the note changed.
 */
export async function syncFolderTags(app: App, file: TFile, oldPath?: string): Promise<boolean> {
	if (file.extension !== "md") return false;
	const want = folderTags(file.path);
	const drop = oldPath ? folderTags(oldPath).filter((t) => !want.includes(t)) : [];
	if (!want.length && !drop.length) return false;
	const cache = app.metadataCache.getFileCache(file);
	const have = asList(cache?.frontmatter?.tags).map((t) => t.replace(/^#/, ""));
	const missing = want.filter((t) => !have.includes(t));
	const leaving = drop.filter((t) => have.includes(t));
	if (!missing.length && !leaving.length && cache) return false;
	let changed = false;
	await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
		const list = asList(fm.tags).map((t) => t.replace(/^#/, ""));
		const next = list.filter((t) => !drop.includes(t));
		for (const t of want) if (!next.includes(t)) next.push(t);
		if (next.join("\n") === list.join("\n")) return;
		changed = true;
		if (next.length) fm.tags = next;
		else delete fm.tags;
	});
	return changed;
}

/** Asks first, then tags every note in the vault with its folders. */
export class TagAllModal extends Modal {
	constructor(app: App) { super(app); }
	onOpen() {
		const notes = this.app.vault.getMarkdownFiles().filter((f) => folderTags(f.path).length);
		this.titleEl.setText("Tag notes with their folders");
		this.contentEl.createEl("p", { text: `This adds tags for the folders each note is in, to ${notes.length} note${notes.length === 1 ? "" : "s"}. For example, a note in School work/Maths gets #school-work and #maths. Tags already on a note are kept.` });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(`Tag ${notes.length} notes`).setCta().onClick(async () => {
				this.close();
				const busy = new Notice("Adding folder tags…", 0);
				let n = 0;
				for (const f of notes) { try { if (await syncFolderTags(this.app, f)) n++; } catch (e) { console.error(e); } }
				busy.hide();
				new Notice(n ? `Added folder tags to ${n} note${n === 1 ? "" : "s"}.` : "Every note already had its folder tags.");
			}));
	}
	onClose() { this.contentEl.empty(); }
}
