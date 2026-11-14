import { ItemView, Platform, WorkspaceLeaf, finishRenderMath, loadMathJax, renderMath, setIcon } from "obsidian";
import type BitsAndBobs from "./main";
import { ALL_ITEMS, MATH_GROUPS, MathItem } from "./math";

export const VIEW_SYMBOLS = "bits-symbols";

/** The maths symbols menu, docked in the left sidebar. Tap a symbol to put it where you were typing. */
export class SymbolsView extends ItemView {
	private group = 0;
	private query = "";
	private tabs!: HTMLElement;
	private grid!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: BitsAndBobs) { super(leaf); }
	getViewType() { return VIEW_SYMBOLS; }
	getDisplayText() { return "Symbols"; }
	getIcon() { return "pi"; }

	async onOpen() {
		await loadMathJax(); // the symbols are drawn with Obsidian's maths renderer, which loads on first use
		const c = this.contentEl;
		c.empty();
		c.addClass("bb-symbols");
		const search = c.createEl("input", { type: "search", cls: "bb-symbols-search", attr: { placeholder: "Search symbols" } });
		search.oninput = () => { this.query = search.value.trim().toLowerCase(); this.draw(); };
		search.onkeydown = (e) => { if (e.key === "Enter") (this.grid.querySelector("button") as HTMLButtonElement | null)?.click(); };
		this.tabs = c.createDiv("bb-symbols-tabs");
		this.grid = c.createDiv("bb-symbols-grid");
		c.createDiv({ cls: "bb-symbols-tip", text: "Click where you want it, then tap a symbol. In a note, type \\ and a name for a quick search." });
		this.draw();
	}

	setGroup(i: number) {
		this.group = Math.max(0, Math.min(MATH_GROUPS.length - 1, i));
		this.draw();
	}

	private draw() {
		if (!this.grid) return;
		this.tabs.empty(); this.grid.empty();
		this.tabs.toggleClass("is-hidden", !!this.query);
		MATH_GROUPS.forEach((g, i) => {
			const t = this.tabs.createEl("button", { cls: "bb-symbols-tab" + (i === this.group ? " is-active" : ""), attr: { "aria-label": g.name } });
			setIcon(t.createSpan(), g.icon);
			t.createSpan({ text: g.name });
			this.keepFocus(t);
			t.onclick = () => { this.group = i; this.draw(); };
		});
		const items = this.query
			? ALL_ITEMS.filter((i) => i.name.toLowerCase().includes(this.query) || (i.label ?? "").toLowerCase().includes(this.query) || i.tex.toLowerCase().includes(this.query))
			: MATH_GROUPS[this.group].items;
		if (!items.length) this.grid.createDiv({ cls: "bb-symbols-empty", text: "No symbols match." });
		for (const item of items) this.addButton(item);
		finishRenderMath();
	}

	private addButton(item: MathItem) {
		const b = this.grid.createEl("button", { cls: "bb-symbol", attr: { "aria-label": item.label ?? item.name } });
		const tex = b.createDiv("bb-symbol-tex");
		try { tex.appendChild(renderMath(item.tex, false)); } catch { tex.setText(item.tex); }
		b.createDiv({ cls: "bb-symbol-name", text: item.label ?? item.name });
		this.keepFocus(b);
		b.onclick = () => this.plugin.insertSymbol(item);
	}

	/** Pressing a button here must not take the cursor away from the note or board you're typing in. */
	private keepFocus(el: HTMLElement) {
		el.addEventListener("mousedown", (e) => e.preventDefault());
		if (Platform.isMobile) el.addEventListener("touchstart", (e) => { if (e.cancelable) e.preventDefault(); }, { passive: false });
	}
}
