import { ItemView, MarkdownView, Notice, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type BitsAndBobs from "./main";
import { SPELL_LANGS } from "./spell";
import type { Mistake } from "./spell";
import { TextStats, analyse, countWords, easeLabel, maskNonProse, minutes } from "./textstats";

export const VIEW_EDITOR = "bits-editor";

const num = (n: number) => n.toLocaleString();

interface Group { word: string; spots: Mistake[] }

/** The Editor tab: how long a note is, how easy it is to read, and what's misspelled with the corrections. */
export class EditorPanel extends ItemView {
	private md: MarkdownView | null = null;
	private stats: TextStats | null = null;
	private groups: Group[] = [];
	private ignored = new Set<string>();
	private sel = "";
	private selEl: HTMLElement | null = null;
	private next = new Map<string, number>();
	private gen = 0;
	private jobs: (() => void)[] = [];
	private running = false;
	private refreshSoon = debounce(() => { void this.refresh(); }, 350, true);

	constructor(leaf: WorkspaceLeaf, private plugin: BitsAndBobs) { super(leaf); }
	getViewType() { return VIEW_EDITOR; }
	getDisplayText() { return "Editor"; }
	getIcon() { return "pencil-line"; }

	async onOpen() {
		const ws = this.app.workspace;
		this.contentEl.addClass("bb-editor");
		this.plugin.speller.onChange = () => this.refreshSoon();
		this.registerEvent(ws.on("active-leaf-change", (leaf) => { if (leaf?.view instanceof MarkdownView) { this.md = leaf.view; this.sel = ""; } this.refreshSoon(); }));
		this.registerEvent(ws.on("editor-change", (_ed, info) => { if (info.file && info.file === this.md?.file) this.refreshSoon(); }));
		this.registerEvent(ws.on("file-open", () => this.refreshSoon()));
		this.registerEvent(ws.on("layout-change", () => this.refreshSoon()));
		this.registerEvent(this.app.vault.on("modify", (f) => { if (f === this.md?.file) this.refreshSoon(); }));
		// the selection has no event of its own, so look for it a couple of times a second
		this.registerInterval(window.setInterval(() => {
			const s = this.md?.editor?.getSelection() ?? "";
			if (s !== this.sel) { this.sel = s; this.drawSelection(); }
		}, 400));
		await this.refresh();
	}

	async onClose() { this.plugin.speller.onChange = null; this.gen++; }

	/** The note being written in: the one in front, or the last one that was. */
	private pickMd(): MarkdownView | null {
		const ws = this.app.workspace;
		const active = ws.getActiveViewOfType(MarkdownView);
		if (active) return active;
		const leaves = ws.getLeavesOfType("markdown");
		if (this.md && leaves.some((l) => l.view === this.md)) return this.md;
		return (ws.getMostRecentLeaf()?.view instanceof MarkdownView ? (ws.getMostRecentLeaf()!.view as MarkdownView) : null) ?? (leaves[0]?.view as MarkdownView | undefined) ?? null;
	}

	private async refresh() {
		const md = this.pickMd();
		if (md !== this.md) this.sel = "";
		this.md = md;
		const st = this.plugin.settings;
		let text = "";
		if (md?.file) text = md.editor ? md.editor.getValue() : await this.app.vault.cachedRead(md.file);
		this.stats = md ? analyse(text) : null;
		this.groups = [];
		if (md && st.spellOn) {
			const sp = this.plugin.speller;
			if (sp.state === "idle") void sp.load();
			if (sp.state === "ready") {
				const by = new Map<string, Mistake[]>();
				for (const m of sp.find(text)) {
					if (this.ignored.has(m.word.toLowerCase())) continue;
					(by.get(m.word) ?? by.set(m.word, []).get(m.word)!).push(m);
				}
				this.groups = [...by].map(([word, spots]) => ({ word, spots })).sort((a, b) => a.spots[0].from - b.spots[0].from);
			}
		}
		this.render();
	}

	// ---------- drawing ----------

	private render() {
		const c = this.contentEl;
		const top = c.scrollTop;
		this.gen++;
		this.jobs = [];
		c.empty();
		const md = this.md, s = this.stats;
		const head = c.createDiv("bb-ed-head");
		head.createDiv({ cls: "bb-ed-file", text: md?.file?.basename ?? "Editor" });
		if (!md || !s) {
			c.createDiv({ cls: "bb-ed-empty", text: "Open a note to see its words and spelling here." });
			return;
		}
		const st = this.plugin.settings;

		// words
		const hero = c.createDiv("bb-ed-hero");
		hero.createDiv({ cls: "bb-ed-big", text: num(s.words) });
		hero.createDiv({ cls: "bb-ed-bigl", text: s.words === 1 ? "word" : "words" });
		const goalRow = c.createDiv("bb-ed-goal");
		if (st.wordGoal > 0) {
			const pct = Math.min(100, Math.round((s.words / st.wordGoal) * 100));
			const bar = goalRow.createDiv("bb-ed-bar");
			bar.createDiv({ cls: "bb-ed-bar-fill" + (pct >= 100 ? " is-done" : "") }).setCssProps({ width: `${pct}%` });
			goalRow.createDiv({ cls: "bb-ed-goal-text", text: pct >= 100 ? `Goal reached: ${num(s.words)} of ${num(st.wordGoal)}` : `${num(s.words)} of ${num(st.wordGoal)} (${num(st.wordGoal - s.words)} to go)` });
		}
		const goalIn = goalRow.createEl("input", { type: "number", cls: "bb-ed-goal-in", attr: { placeholder: "Word goal", min: "0", "aria-label": "Word goal" } });
		goalIn.value = st.wordGoal ? String(st.wordGoal) : "";
		goalIn.onchange = () => { st.wordGoal = Math.max(0, Math.floor(Number(goalIn.value) || 0)); void this.plugin.saveSettings().then(() => this.render()); };

		this.selEl = c.createDiv("bb-ed-sel");
		this.drawSelection();

		const grid = c.createDiv("bb-ed-grid");
		const card = (label: string, value: string) => { const x = grid.createDiv("bb-ed-card"); x.createDiv({ cls: "bb-ed-val", text: value }); x.createDiv({ cls: "bb-ed-lbl", text: label }); };
		card("Characters", num(s.chars));
		card("No spaces", num(s.charsNoSpaces));
		card("Sentences", num(s.sentences));
		card("Paragraphs", num(s.paragraphs));
		card("Reading time", minutes(s.readingMin));
		card("Speaking time", minutes(s.speakingMin));
		card("Words per sentence", s.sentences ? s.avgSentence.toFixed(1) : "–");
		card("Different words", num(s.unique));

		// readability
		if (s.words >= 5) {
			const sec = this.section(c, "How easy to read");
			const e = easeLabel(s.ease);
			const meter = sec.createDiv("bb-ed-meter");
			meter.createDiv({ cls: "bb-ed-meter-fill is-" + e.tone }).setCssProps({ width: `${Math.round(s.ease)}%` });
			const line = sec.createDiv("bb-ed-ease");
			line.createSpan({ cls: "bb-ed-ease-label is-" + e.tone, text: e.label });
			line.createSpan({ cls: "bb-ed-muted", text: `  ·  score ${Math.round(s.ease)}/100  ·  school grade ${s.grade.toFixed(1)}` });
			if (s.longestSentence >= 35) sec.createDiv({ cls: "bb-ed-muted", text: `Your longest sentence has ${s.longestSentence} words. Short ones are easier to follow.` });
		}
		if (s.topWords.length) {
			const sec = this.section(c, "Words you use a lot");
			const chips = sec.createDiv("bb-ed-chips");
			for (const [w, n] of s.topWords) chips.createSpan({ cls: "bb-ed-chip", text: `${w} ${n}` });
		}

		this.drawSpelling(c);
		c.scrollTop = top;
	}

	private section(c: HTMLElement, title: string): HTMLElement {
		const sec = c.createDiv("bb-ed-section");
		sec.createDiv({ cls: "bb-ed-title", text: title });
		return sec;
	}

	private drawSelection() {
		const el = this.selEl;
		if (!el) return;
		el.empty();
		const s = this.sel;
		el.toggleClass("is-on", !!s.trim());
		if (!s.trim()) return;
		const prose = maskNonProse(s);
		el.createSpan({ cls: "bb-ed-sel-n", text: num(countWords(prose)) });
		el.createSpan({ text: ` selected ${countWords(prose) === 1 ? "word" : "words"}  ·  ${num(s.length)} characters` });
	}

	private drawSpelling(c: HTMLElement) {
		const st = this.plugin.settings, sp = this.plugin.speller;
		const sec = c.createDiv("bb-ed-section bb-ed-spell");
		const head = sec.createDiv("bb-ed-spell-head");
		head.createDiv({ cls: "bb-ed-title", text: "Spelling" });
		if (st.spellOn && sp.state === "ready") head.createSpan({ cls: "bb-ed-badge" + (this.groups.length ? " is-warn" : " is-ok"), text: this.groups.length ? `${num(this.groups.reduce((n, g) => n + g.spots.length, 0))}` : "✓" });
		const tools = head.createDiv("bb-ed-spell-tools");
		const lang = tools.createEl("select", { cls: "dropdown", attr: { "aria-label": "Spelling language" } });
		for (const [k, v] of Object.entries(SPELL_LANGS)) lang.createEl("option", { value: k, text: v });
		lang.value = st.spellLang;
		lang.onchange = () => { st.spellLang = lang.value; void this.plugin.saveSettings(); sp.reset(); void sp.load(lang.value); };
		const onoff = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": st.spellOn ? "Turn spell check off" : "Turn spell check on" } });
		setIcon(onoff, st.spellOn ? "spell-check" : "eye-off");
		onoff.onclick = () => { st.spellOn = !st.spellOn; void this.plugin.saveSettings(); void this.refresh(); };

		if (!st.spellOn) { sec.createDiv({ cls: "bb-ed-muted", text: "Spell check is off." }); return; }
		if (sp.state === "loading" || sp.state === "idle") { sec.createDiv({ cls: "bb-ed-muted", text: `Getting the ${SPELL_LANGS[st.spellLang] ?? st.spellLang} dictionary ready…` }); return; }
		if (sp.state === "error") {
			sec.createDiv({ cls: "bb-ed-error", text: sp.error });
			sec.createEl("button", { text: "Try again" }).onclick = () => { sp.reset(); void sp.load(); };
			return;
		}
		if (!this.groups.length) {
			sec.createDiv({ cls: "bb-ed-good", text: "No spelling mistakes found." });
		}
		const gen = this.gen;
		for (const g of this.groups) {
			const row = sec.createDiv("bb-ed-miss");
			const top = row.createDiv("bb-ed-miss-top");
			const w = top.createEl("button", { cls: "bb-ed-word", text: g.word, attr: { "aria-label": "Show in the note" } });
			w.onclick = () => { void this.goTo(g); };
			if (g.spots.length > 1) top.createSpan({ cls: "bb-ed-count", text: `× ${g.spots.length}` });
			const acts = top.createDiv("bb-ed-acts");
			const act = (icon: string, label: string, fn: () => void) => { const b = acts.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } }); setIcon(b, icon); b.onclick = fn; };
			act("eye-off", "Ignore for now", () => { this.ignored.add(g.word.toLowerCase()); void this.refresh(); });
			act("book-plus", "Add to my words", () => { sp.addWord(g.word); new Notice(`Added "${g.word}" to your words.`); void this.refresh(); });
			const sugs = row.createDiv("bb-ed-sugs");
			const fill = () => {
				if (gen !== this.gen) return;
				sugs.empty();
				const list = sp.peek(g.word);
				if (!list) { sugs.createSpan({ cls: "bb-ed-muted", text: "Finding corrections…" }); return; }
				if (!list.length) { sugs.createSpan({ cls: "bb-ed-muted", text: "No suggestions" }); return; }
				for (const s of list) {
					const b = sugs.createEl("button", { cls: "bb-ed-sug", text: s, attr: { "aria-label": g.spots.length > 1 ? `Replace all ${g.spots.length}` : "Replace" } });
					b.onclick = () => this.fix(g.word, s);
				}
				if (g.spots.length > 1) sugs.createSpan({ cls: "bb-ed-muted bb-ed-all", text: `replaces all ${g.spots.length}` });
			};
			fill();
			if (!sp.peek(g.word)) this.queue(() => { sp.suggest(g.word); fill(); });
		}
		if (this.ignored.size) {
			const b = sec.createEl("button", { cls: "bb-ed-link", text: `Show ${this.ignored.size} ignored word${this.ignored.size === 1 ? "" : "s"} again` });
			b.onclick = () => { this.ignored.clear(); void this.refresh(); };
		}
	}

	/** Work out corrections one word at a time so the panel stays quick. */
	private queue(job: () => void) {
		this.jobs.push(job);
		if (this.running) return;
		this.running = true;
		const go = () => {
			const j = this.jobs.shift();
			if (!j) { this.running = false; return; }
			j();
			window.setTimeout(go, 0);
		};
		window.setTimeout(go, 0);
	}

	// ---------- changing the note ----------

	private async editable(): Promise<MarkdownView | null> {
		const md = this.md;
		if (!md?.editor) return null;
		if (md.getMode() === "preview") await md.setState({ ...md.getState(), mode: "source" }, { history: false });
		return md;
	}

	private async goTo(g: Group) {
		const md = await this.editable();
		if (!md) return;
		const ed = md.editor;
		const spots = this.plugin.speller.find(ed.getValue()).filter((m) => m.word === g.word);
		if (!spots.length) { void this.refresh(); return; }
		const i = (this.next.get(g.word) ?? 0) % spots.length;
		this.next.set(g.word, i + 1);
		const m = spots[i];
		void this.app.workspace.revealLeaf(md.leaf);
		ed.setSelection(ed.offsetToPos(m.from), ed.offsetToPos(m.to));
		ed.scrollIntoView({ from: ed.offsetToPos(m.from), to: ed.offsetToPos(m.to) }, true);
		ed.focus();
	}

	/** Put the correction in. A word that appears several times is changed everywhere. */
	private fix(word: string, replacement: string) {
		const ed = this.md?.editor;
		if (!ed) return;
		const spots = this.plugin.speller.find(ed.getValue()).filter((m) => m.word === word);
		if (!spots.length) { new Notice("That word isn't in the note any more."); void this.refresh(); return; }
		ed.transaction({ changes: spots.map((m) => ({ from: ed.offsetToPos(m.from), to: ed.offsetToPos(m.to), text: replacement })) });
		void this.refresh();
	}
}
