import { App, ItemView, Modal, Notice, Setting, SuggestModal, TFile, WorkspaceLeaf, requestUrl, setIcon } from "obsidian";
import type BitsAndBobs from "./main";
import { Citation, CiteStyle, KIND_NAMES, STYLE_NAMES, SourceKind, formatCitation, inText, sortKey, toHtml, toPlain } from "./citeformat";
import { parseDeck, serializeDeck, EXT_SLIDES } from "./views";
import { uid } from "./board";

export const VIEW_CITE = "bits-citations";

const today = () => {
	const d = new Date(), p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
export const blankCitation = (kind: SourceKind = "website"): Citation => ({
	id: uid(), kind, authors: [], title: "", container: "", publisher: "", year: "", month: "", day: "", url: "", accessed: today(),
	edition: "", volume: "", issue: "", pages: "", doi: "", place: "",
});

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CONTAINER_LABEL: Record<SourceKind, string> = { website: "Website name", book: "", journal: "Journal name", video: "Channel name", news: "Newspaper or magazine" };

/** A citation maker in its own tab: fill in a source, pick a style, copy them all or add them to slides. */
export class CiteView extends ItemView {
	private form: Citation = blankCitation();
	private editing = false;
	private formEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: BitsAndBobs) { super(leaf); }
	getViewType() { return VIEW_CITE; }
	getDisplayText() { return "Citations"; }
	getIcon() { return "quote"; }

	private get style(): CiteStyle { return this.plugin.settings.citeStyle; }
	private get list(): Citation[] { return this.plugin.settings.citations; }
	private save() { void this.plugin.saveSettings(); this.plugin.source.localEdit(); }
	private styleSel!: HTMLSelectElement;
	private pickEl!: HTMLElement;
	/** redraw after cloud sync changes the list */
	refresh() {
		if (this.styleSel) this.styleSel.value = this.style;
		this.renderPicker();
		this.renderList();
	}

	/** The list picker (In Obsidian, or one of your Source lists) and the sync status. */
	private renderPicker() {
		const el = this.pickEl, src = this.plugin.source;
		if (!el) return;
		el.empty();
		if (!src.signedIn || !this.plugin.settings.cloud) return;
		const st = this.plugin.settings.source;
		const sel = el.createEl("select", { cls: "dropdown bb-cite-pick", attr: { "aria-label": "Citation list" } });
		sel.createEl("option", { value: "", text: "In Obsidian" });
		if (st.lists.length) {
			const g = sel.createEl("optgroup", { attr: { label: "Source lists" } });
			for (const l of st.lists) g.createEl("option", { value: l.id, text: `${l.name || "Untitled list"} (${l.items.length})` });
		}
		sel.createEl("option", { value: "__new", text: "New Source list…" });
		sel.value = st.active;
		sel.onchange = () => {
			if (sel.value === "__new") {
				sel.value = st.active;
				new NameModal(this.app, (name) => src.newList(name)).open();
				return;
			}
			src.select(sel.value);
		};
		if (st.active) {
			const del = el.createEl("button", { cls: "clickable-icon bb-cite-iconbtn", attr: { "aria-label": "Delete this list" } });
			setIcon(del, "trash-2");
			del.onclick = () => {
				const l = src.activeList;
				if (!l) return;
				new ConfirmDelete(this.app, l.name || "Untitled list", () => src.deleteList(l.id)).open();
			};
		}
		const status = el.createSpan({ cls: "bb-cite-sync" });
		const text: Record<string, string> = { ok: "Synced", saving: "Saving…", offline: "Offline", signin: "Sign in to Keyring to sync" };
		status.setText(st.active || src.status !== "ok" ? text[src.status] : "");
		status.toggleClass("is-offline", src.status === "offline");
		const again = el.createEl("button", { cls: "clickable-icon bb-cite-iconbtn", attr: { "aria-label": "Sync with Source now" } });
		setIcon(again, "refresh-cw");
		again.onclick = () => { void src.sync(); };
	}

	async onOpen() {
		const c = this.contentEl;
		c.empty();
		c.addClass("bb-cite");
		const top = c.createDiv("bb-cite-top");
		top.createEl("h2", { text: "Citations" });
		const styleSel = top.createEl("select", { cls: "dropdown bb-cite-style", attr: { "aria-label": "Referencing style" } });
		for (const [k, v] of Object.entries(STYLE_NAMES)) styleSel.createEl("option", { value: k, text: v });
		styleSel.value = this.style;
		this.styleSel = styleSel;
		this.pickEl = top.createDiv("bb-cite-picker");
		this.renderPicker();
		if (!this.unsub) this.unsub = this.plugin.source.onChange(() => this.refresh());
		if (this.plugin.source.signedIn) void this.plugin.source.sync();
		styleSel.onchange = () => { this.plugin.settings.citeStyle = styleSel.value as CiteStyle; this.save(); this.renderPreview(); this.renderList(); };

		const body = c.createDiv("bb-cite-body");
		this.formEl = body.createDiv("bb-cite-form");
		const listSide = body.createDiv("bb-cite-listside");
		const listBar = listSide.createDiv("bb-cite-listbar");
		this.countEl = listBar.createSpan({ cls: "bb-cite-count" });
		const btn = (icon: string, text: string, fn: () => void, cta = false) => {
			const b = listBar.createEl("button", { cls: cta ? "mod-cta" : "" });
			setIcon(b.createSpan("bb-cite-btn-icon"), icon);
			b.createSpan({ text });
			b.onclick = fn;
			return b;
		};
		btn("copy", "Copy all", () => { void this.copyAll(); }, true);
		btn("presentation", "Add to slides", () => this.addToSlides());
		btn("file-text", "Add to note", () => { void this.addToNote(); });
		btn("trash-2", "Clear all", () => {
			if (!this.list.length) return;
			const keep = this.list.slice();
			this.plugin.settings.citations = [];
			this.save(); this.renderList();
			let n: Notice | null = null;
			const msg = createFragment((frag) => {
				frag.appendText("All citations cleared. ");
				const undo = frag.createEl("a", { text: "Undo", href: "#" });
				undo.onclick = (e) => { e.preventDefault(); this.plugin.settings.citations = keep; this.save(); this.renderList(); n?.hide(); };
			});
			n = new Notice(msg, 8000);
		});
		this.listEl = listSide.createDiv("bb-cite-list");
		this.renderForm();
		this.renderList();
	}

	private unsub: (() => void) | null = null;
	async onClose() { this.unsub?.(); this.unsub = null; this.contentEl.empty(); }

	/** Opens a citation for changing (used by the list's edit button). */
	private edit(c: Citation) {
		this.form = JSON.parse(JSON.stringify(c)) as Citation;
		this.editing = true;
		this.renderForm();
		this.formEl.scrollIntoView({ block: "start", behavior: "smooth" });
	}

	private renderForm() {
		const f = this.form, el = this.formEl;
		el.empty();
		const kinds = el.createDiv("bb-cite-kinds");
		(Object.keys(KIND_NAMES) as SourceKind[]).forEach((k) => {
			const b = kinds.createEl("button", { text: KIND_NAMES[k], cls: f.kind === k ? "is-active" : "" });
			b.onclick = () => { f.kind = k; this.renderForm(); };
		});

		const field = (label: string, key: keyof Citation, ph = "", wide = false) => {
			const w = el.createDiv("bb-cite-field" + (wide ? " is-wide" : ""));
			w.createEl("label", { text: label });
			const i = w.createEl("input", { type: "text", attr: { placeholder: ph } });
			i.value = String(f[key] ?? "");
			i.oninput = () => { (f[key] as string) = i.value; this.renderPreview(); };
			return i;
		};

		if (f.kind !== "book") {
			const row = el.createDiv("bb-cite-urlrow");
			const w = row.createDiv("bb-cite-field is-wide");
			w.createEl("label", { text: f.kind === "video" ? "Video link" : "Web address" });
			const url = w.createEl("input", { type: "url", attr: { placeholder: "https://…" } });
			url.value = f.url;
			url.oninput = () => { f.url = url.value.trim(); this.renderPreview(); };
			const fill = row.createEl("button", { text: "Fill in from link" });
			fill.onclick = async () => {
				if (!/^https?:\/\//i.test(f.url)) { new Notice("Paste a web address first."); return; }
				fill.disabled = true; fill.setText("Looking it up…");
				try { await fillFromLink(f); this.renderForm(); new Notice("Filled in. Check the details before adding."); }
				catch (e) { console.error(e); new Notice("Couldn't read that page. Type the details in instead."); fill.disabled = false; fill.setText("Fill in from link"); }
			};
		}

		const aw = el.createDiv("bb-cite-field is-wide");
		aw.createEl("label", { text: f.group ? "Organisation" : "Authors (one per line)" });
		const authors = aw.createEl("textarea", { attr: { rows: "2", placeholder: f.group ? "World Health Organization" : "Jane Smith\nAhmed Khan" } });
		authors.value = f.authors.join("\n");
		authors.oninput = () => { f.authors = authors.value.split("\n"); this.renderPreview(); };
		const grp = aw.createEl("label", { cls: "bb-cite-check" });
		const gcb = grp.createEl("input", { type: "checkbox" });
		gcb.checked = !!f.group;
		grp.appendText(" The author is a group or organisation");
		gcb.onchange = () => { f.group = gcb.checked || undefined; this.renderForm(); };

		field("Title", "title", f.kind === "book" ? "The book's title" : "Title of the page or article", true);
		if (CONTAINER_LABEL[f.kind]) field(CONTAINER_LABEL[f.kind], "container");
		if (f.kind === "book" || f.kind === "website") field("Publisher", "publisher", f.kind === "website" ? "optional" : "");
		if (f.kind === "book") { field("Place published", "place", "e.g. Sydney (Harvard and Chicago)"); field("Edition", "edition", "e.g. 2"); }
		if (f.kind === "journal") { field("Volume", "volume"); field("Issue", "issue"); field("Pages", "pages", "e.g. 12–19"); field("DOI", "doi", "optional"); }

		const dw = el.createDiv("bb-cite-field is-wide");
		dw.createEl("label", { text: f.kind === "book" ? "Year published" : "Date published (leave empty if there isn't one)" });
		const dr = dw.createDiv("bb-cite-date");
		if (f.kind !== "book") {
			const day = dr.createEl("input", { type: "number", attr: { placeholder: "Day", min: "1", max: "31" } });
			day.value = f.day; day.oninput = () => { f.day = day.value; this.renderPreview(); };
			const mon = dr.createEl("select", { cls: "dropdown" });
			mon.createEl("option", { value: "", text: "Month" });
			MONTHS.forEach((m, i) => mon.createEl("option", { value: String(i + 1), text: m }));
			mon.value = f.month; mon.onchange = () => { f.month = mon.value; this.renderPreview(); };
		}
		const yr = dr.createEl("input", { type: "number", attr: { placeholder: "Year", min: "1000", max: "2999" } });
		yr.value = f.year; yr.oninput = () => { f.year = yr.value; this.renderPreview(); };

		if (f.kind === "website") {
			const w = el.createDiv("bb-cite-field");
			w.createEl("label", { text: "Date you looked at it" });
			const acc = w.createEl("input", { type: "date" });
			acc.value = f.accessed; acc.oninput = () => { f.accessed = acc.value; this.renderPreview(); };
		}

		el.createDiv({ cls: "bb-cite-label", text: "Preview" });
		this.previewEl = el.createDiv("bb-cite-preview");
		const actions = el.createDiv("bb-cite-actions");
		const add = actions.createEl("button", { cls: "mod-cta", text: this.editing ? "Save changes" : "Add citation" });
		add.onclick = () => this.commit();
		const clear = actions.createEl("button", { text: this.editing ? "Cancel" : "Clear" });
		clear.onclick = () => { this.form = blankCitation(f.kind); this.editing = false; this.renderForm(); };
		this.renderPreview();
	}

	private renderPreview() {
		if (!this.previewEl) return;
		const f = this.form;
		this.previewEl.empty();
		if (!f.title.trim()) { this.previewEl.createSpan({ cls: "bb-cite-faint", text: "Type a title to see the citation." }); return; }
		renderRef(this.previewEl, formatCitation(this.clean(f), this.style));
		this.previewEl.createDiv({ cls: "bb-cite-intext", text: `In your writing: ${toPlain(inText(this.clean(f), this.style))}` });
	}

	private clean(f: Citation): Citation {
		return { ...f, authors: f.authors.map((a) => a.trim()).filter(Boolean), title: f.title.trim() };
	}

	private commit() {
		const f = this.clean(this.form);
		if (!f.title) { new Notice("Add a title first."); return; }
		const i = this.list.findIndex((c) => c.id === f.id);
		if (i >= 0) this.list[i] = f; else this.list.push(f);
		this.save();
		this.form = blankCitation(f.kind);
		this.editing = false;
		this.renderForm();
		this.renderList();
		new Notice(i >= 0 ? "Citation saved." : "Citation added.");
	}

	/** the reference list, in alphabetical order */
	private sorted(): { c: Citation; md: string }[] {
		return this.list.map((c) => ({ c, md: formatCitation(c, this.style) })).sort((a, b) => sortKey(a.md).localeCompare(sortKey(b.md)));
	}

	private renderList() {
		const items = this.sorted();
		this.countEl.setText(items.length ? `${items.length} citation${items.length === 1 ? "" : "s"} · ${STYLE_NAMES[this.style]}` : "No citations yet");
		this.listEl.empty();
		if (!items.length) { this.listEl.createDiv({ cls: "bb-cite-empty", text: "Fill in a source on the left and press Add citation. Your list stays here until you clear it." }); return; }
		for (const { c, md } of items) {
			const row = this.listEl.createDiv("bb-cite-item");
			const text = row.createDiv("bb-cite-ref");
			renderRef(text, md);
			row.createDiv({ cls: "bb-cite-intext", text: toPlain(inText(c, this.style)) });
			const tools = row.createDiv("bb-cite-tools");
			const t = (icon: string, label: string, fn: () => void) => {
				const b = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
				setIcon(b, icon);
				b.onclick = fn;
			};
			t("copy", "Copy this citation", () => { void copyRich([md]).then(() => new Notice("Copied.")); });
			t("quote", "Copy the in-text citation", () => { void navigator.clipboard.writeText(toPlain(inText(c, this.style))).then(() => new Notice("Copied.")); });
			t("pencil", "Change", () => this.edit(c));
			t("trash-2", "Delete", () => { this.plugin.settings.citations = this.list.filter((x) => x.id !== c.id); this.save(); this.renderList(); });
		}
	}

	private async copyAll() {
		const items = this.sorted();
		if (!items.length) { new Notice("There are no citations to copy yet."); return; }
		await copyRich(items.map((x) => x.md));
		new Notice(`Copied ${items.length} citation${items.length === 1 ? "" : "s"}. Paste into your work and the italics come too.`);
	}

	private async addToNote() {
		const items = this.sorted();
		if (!items.length) { new Notice("There are no citations yet."); return; }
		const block = `## References\n\n${items.map((x) => x.md).join("\n\n")}\n`;
		new NotePicker(this.app, (target) => {
			void this.app.vault.process(target, (t) => t.replace(/\s*$/, "") + "\n\n" + block).then(() => {
				new Notice(`Added the references to the end of ${target.basename}.`);
				void this.app.workspace.getLeaf("tab").openFile(target);
			});
		}).open();
	}

	private addToSlides() {
		const items = this.sorted();
		if (!items.length) { new Notice("There are no citations yet."); return; }
		new DeckPicker(this.app, async (deck) => {
			const file = deck ?? (await this.plugin.createFile("slides", false));
			if (!file) return;
			const PER = 6;
			let made = 0;
			await this.app.vault.process(file, (data) => {
				const d = parseDeck(data);
				for (let i = 0; i < items.length; i += PER) {
					const chunk = items.slice(i, i + PER);
					const title = items.length > PER ? `## References (${i / PER + 1})` : "## References";
					d.slides.push({
						id: uid(), bg: "plain", layout: "content",
						elements: [
							{ id: uid(), type: "text", x: 100, y: 60, w: 1400, text: title, color: "ink", fs: 40 },
							{ id: uid(), type: "text", x: 100, y: 170, w: 1400, text: chunk.map((x) => x.md).join("\n\n"), color: "ink", fs: 22 },
						],
					});
					made++;
				}
				return serializeDeck(d);
			});
			await this.app.workspace.getLeaf("tab").openFile(file);
			new Notice(`Added ${made} References slide${made === 1 ? "" : "s"} to ${file.basename}.`);
		}).open();
	}
}

/** Copies as rich text (italics kept in Word, Google Docs, PowerPoint) with plain text as a fallback. */
async function copyRich(mds: string[]) {
	const html = mds.map((m) => `<p style="margin-left:0.5in;text-indent:-0.5in">${toHtml(m)}</p>`).join("");
	const plain = mds.map(toPlain).join("\n\n");
	try {
		await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([plain], { type: "text/plain" }) })]);
	} catch {
		await navigator.clipboard.writeText(plain);
	}
}

/** Shows a reference with its *italic* parts in italics, without using HTML strings. */
function renderRef(el: HTMLElement, md: string) {
	const parts = md.split(/\*([^*]+)\*/);
	parts.forEach((p, i) => { if (i % 2) el.createEl("i", { text: p }); else if (p) el.appendText(p); });
}

class NotePicker extends SuggestModal<TFile> {
	constructor(app: App, private pick: (f: TFile) => void) { super(app); this.setPlaceholder("Add the references to the end of which note?"); }
	getSuggestions(q: string) {
		const recent = this.app.workspace.getLastOpenFiles();
		const notes = this.app.vault.getMarkdownFiles().filter((f) => f.path.toLowerCase().includes(q.toLowerCase()));
		const rank = (f: TFile) => { const i = recent.indexOf(f.path); return i < 0 ? 999 : i; };
		return notes.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path)).slice(0, 50);
	}
	renderSuggestion(f: TFile, el: HTMLElement) { el.setText(f.path); }
	onChooseSuggestion(f: TFile) { this.pick(f); }
}

class DeckPicker extends SuggestModal<TFile | null> {
	constructor(app: App, private pick: (f: TFile | null) => unknown) { super(app); this.setPlaceholder("Add the references to which slides?"); }
	getSuggestions(q: string) {
		const decks = this.app.vault.getFiles().filter((f) => f.extension === EXT_SLIDES && f.path.toLowerCase().includes(q.toLowerCase()));
		return [null, ...decks];
	}
	renderSuggestion(f: TFile | null, el: HTMLElement) { el.setText(f ? f.path : "New slides"); }
	onChooseSuggestion(f: TFile | null) { this.pick(f); }
}

// ---------- fill in from a web address ----------
async function fillFromLink(f: Citation) {
	// start fresh, so nothing is left over from an earlier page
	Object.assign(f, { authors: [], group: undefined, title: "", container: "", publisher: "", year: "", month: "", day: "", doi: "", volume: "", issue: "", pages: "" });
	const res = await requestUrl({ url: f.url, headers: { "User-Agent": "Mozilla/5.0 (citation lookup)" } });
	const doc = new DOMParser().parseFromString(res.text, "text/html");
	const meta = (...names: string[]) => {
		for (const n of names) {
			const els = Array.from(doc.querySelectorAll<HTMLMetaElement>(`meta[name="${n}" i], meta[property="${n}" i], meta[itemprop="${n}" i]`));
			const v = els.map((e) => e.content?.trim()).filter(Boolean);
			if (v.length) return v;
		}
		return [];
	};
	// structured data (JSON-LD) many news and blog sites include
	let ld: Record<string, unknown> = {};
	for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
		try {
			const j = JSON.parse(s.textContent ?? "") as unknown;
			const all = (Array.isArray(j) ? j : [j]).flatMap((x: unknown) => ((x as { "@graph"?: unknown[] })["@graph"] ?? [x]) as Record<string, unknown>[]);
			const hit = all.find((x) => typeof x?.["@type"] === "string" && /Article|BlogPosting|WebPage|VideoObject|Book/i.test(x["@type"]));
			if (hit) { ld = hit; break; }
		} catch { /* not valid JSON */ }
	}
	const ldList = (() => { const a = ld.author; return (Array.isArray(a) ? a : a ? [a] : []) as unknown[]; })();
	const ldAuthors = ldList.map((x) => (typeof x === "string" ? x : (x as { name?: string })?.name ?? "")).filter(Boolean);
	const ldGroup = ldList.length > 0 && ldList.every((x) => typeof x === "object" && (() => { const t = (x as { "@type"?: unknown })["@type"]; return typeof t === "string" && /Organi[sz]ation/i.test(t); })());

	const host = new URL(f.url).hostname.replace(/^www\./, "");
	let site = meta("og:site_name", "application-name", "citation_journal_title")[0] ?? "";
	let title = meta("citation_title", "og:title", "twitter:title")[0] ?? (typeof ld.headline === "string" ? ld.headline : "") ?? "";
	if (!title) title = doc.querySelector("title")?.textContent?.trim() ?? "";
	if (site) title = title.replace(new RegExp(`\\s*[|\\-–—]\\s*${site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i"), "");
	// "Photosynthesis - Wikipedia": the end is the site's name when it matches the web address
	const tail = /\s+[|\-–—]\s+([^|\-–—]{2,40})$/.exec(title);
	if (tail && host.replace(/\W/g, "").includes(tail[1].split(/\s+/)[0].toLowerCase().replace(/\W/g, ""))) {
		if (!site) site = tail[1].trim();
		title = title.slice(0, tail.index).trim();
	}
	const authors = meta("citation_author").length ? meta("citation_author") : ldAuthors.length ? ldAuthors : meta("author", "article:author", "parsely-author").filter((a) => !/^https?:/i.test(a));
	const date = meta("citation_publication_date", "citation_date", "article:published_time", "datePublished", "uploadDate", "date", "pubdate", "dc.date")[0] ?? (typeof ld.datePublished === "string" ? ld.datePublished : "");

	if (/youtube\.com|youtu\.be/.test(host)) {
		f.kind = "video";
		const channel = doc.querySelector<HTMLLinkElement>('span[itemprop="author"] link[itemprop="name"]')?.getAttribute("content") ?? "";
		if (channel) { f.container = channel; f.authors = [channel]; f.group = true; }
	} else {
		if (authors.length) { f.authors = authors.slice(0, 20); f.group = authors === ldAuthors && ldGroup ? true : undefined; }
		f.container = site || f.container || host;
	}
	if (title) f.title = title;
	const m = /^(\d{4})(?:[-/](\d{1,2}))?(?:[-/](\d{1,2}))?/.exec(date);
	if (m) { f.year = m[1]; f.month = m[2] ? String(parseInt(m[2], 10)) : ""; f.day = m[3] ? String(parseInt(m[3], 10)) : ""; }
	const doi = meta("citation_doi", "dc.identifier")[0];
	if (doi && /10\.\d{4,}/.test(doi)) { f.doi = doi.replace(/^doi:/i, ""); f.kind = "journal"; }
	if (f.kind === "journal") {
		f.volume = meta("citation_volume")[0] ?? f.volume;
		f.issue = meta("citation_issue")[0] ?? f.issue;
		const fp = meta("citation_firstpage")[0], lp = meta("citation_lastpage")[0];
		if (fp) f.pages = lp ? `${fp}–${lp}` : fp;
	}
	const pub = meta("citation_publisher", "dc.publisher")[0];
	if (pub) f.publisher = pub;
	f.accessed = today();
}

/** Ask for a name for a new Source list. */
class NameModal extends Modal {
	constructor(app: App, private done: (name: string) => void) { super(app); }
	onOpen() {
		this.setTitle("New Source list");
		let name = "";
		const go = () => { if (name.trim()) { this.close(); this.done(name); } };
		new Setting(this.contentEl).setName("Name").addText((t) => {
			t.setPlaceholder("Example: History essay").onChange((v) => { name = v; });
			t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
			window.setTimeout(() => t.inputEl.focus(), 0);
		});
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Make list").setCta().onClick(go));
	}
	onClose() { this.contentEl.empty(); }
}

class ConfirmDelete extends Modal {
	constructor(app: App, private name: string, private run: () => void) { super(app); }
	onOpen() {
		this.setTitle(`Delete "${this.name}"?`);
		this.contentEl.createEl("p", { text: "This list and its citations are deleted here and on the Source website." });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Delete").setClass("mod-warning").onClick(() => { this.close(); this.run(); }));
	}
	onClose() { this.contentEl.empty(); }
}
