import {
	App, Editor, EditorPosition, EditorSuggest, EditorSuggestContext, EditorSuggestTriggerInfo,
	Modal, Platform, TFile, finishRenderMath, renderMath, setIcon,
} from "obsidian";

/** "¦" marks where the cursor lands (and where selected text goes). */
export interface MathItem { name: string; tex: string; insert: string; label?: string; special?: "fraction" }
export interface MathGroup { name: string; icon: string; items: MathItem[] }

const I = (name: string, tex: string, insert?: string, label?: string): MathItem => ({ name, tex, insert: insert ?? tex + " ¦", label });

export const MATH_GROUPS: MathGroup[] = [
	{
		name: "Basics", icon: "superscript", items: [
			I("power", "x^{y}", "^{¦}", "x to the y"),
			I("squared", "x^{2}", "^{2}¦", "squared"),
			I("cubed", "x^{3}", "^{3}¦", "cubed"),
			I("subscript", "x_{n}", "_{¦}", "subscript"),
			{ ...I("frac", "\\frac{a}{b}", "\\frac{¦}{}", "fraction"), special: "fraction" },
			I("sqrt", "\\sqrt{x}", "\\sqrt{¦}", "square root"),
			I("nroot", "\\sqrt[n]{x}", "\\sqrt[¦]{}", "nth root"),
			I("pm", "\\pm"), I("mp", "\\mp"), I("times", "\\times"), I("div", "\\div"), I("cdot", "\\cdot"),
			I("neq", "\\neq"), I("approx", "\\approx"), I("equiv", "\\equiv"), I("leq", "\\leq"), I("geq", "\\geq"),
			I("ll", "\\ll"), I("gg", "\\gg"), I("propto", "\\propto"), I("infty", "\\infty"),
			I("abs", "\\left| x \\right|", "\\left| ¦ \\right|", "absolute value"),
			I("paren", "\\left( x \\right)", "\\left( ¦ \\right)", "big brackets"),
			I("degree", "x^{\\circ}", "^{\\circ}¦", "degrees"),
			I("percent", "\\%", "\\%¦"),
			I("text", "\\text{abc}", "\\text{¦}", "words in maths"),
		],
	},
	{
		name: "Greek", icon: "omega", items: [
			"alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi",
			"pi", "rho", "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
			"Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega",
		].map((g) => I(g, "\\" + g, "\\" + g + "¦")),
	},
	{
		name: "Calculus", icon: "sigma", items: [
			I("sum", "\\sum_{i=1}^{n}", "\\sum_{i=1}^{n} ¦", "sum"),
			I("prod", "\\prod_{i=1}^{n}", "\\prod_{i=1}^{n} ¦", "product"),
			I("int", "\\int_{a}^{b}", "\\int_{a}^{b} ¦ \\,dx", "integral"),
			I("iint", "\\iint", "\\iint ¦ \\,dA"),
			I("oint", "\\oint", "\\oint ¦"),
			I("lim", "\\lim_{x \\to a}", "\\lim_{x \\to ¦}", "limit"),
			I("deriv", "\\frac{d}{dx}", "\\frac{d}{dx}¦", "derivative"),
			I("dydx", "\\frac{dy}{dx}", "\\frac{dy}{dx}¦"),
			I("partial", "\\frac{\\partial f}{\\partial x}", "\\frac{\\partial ¦}{\\partial x}", "partial"),
			I("nabla", "\\nabla"), I("prime", "f'(x)", "'¦"),
			I("vec", "\\vec{v}", "\\vec{¦}", "vector"),
			I("hat", "\\hat{x}", "\\hat{¦}"), I("bar", "\\bar{x}", "\\bar{¦}", "mean"), I("dot", "\\dot{x}", "\\dot{¦}"),
			I("to", "\\to"), I("e", "e^{x}", "e^{¦}", "e to the x"),
		],
	},
	{
		name: "Functions", icon: "function-square", items: [
			...["sin", "cos", "tan", "csc", "sec", "cot", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "ln", "log", "exp", "max", "min", "det"].map((f) => I(f, `\\${f}(x)`, `\\${f}(¦)`)),
			I("logb", "\\log_{b}(x)", "\\log_{¦}()", "log base b"),
			I("floor", "\\lfloor x \\rfloor", "\\lfloor ¦ \\rfloor"), I("ceil", "\\lceil x \\rceil", "\\lceil ¦ \\rceil"),
			I("binom", "\\binom{n}{k}", "\\binom{¦}{}", "n choose k"),
			I("factorial", "n!", "!¦"),
			I("cases", "f(x)=\\begin{cases} a & x>0 \\\\ b & x\\le 0 \\end{cases}", "\\begin{cases} ¦ & \\text{if } \\\\  & \\text{otherwise} \\end{cases}", "piecewise"),
		],
	},
	{
		name: "Matrices", icon: "grid-3x3", items: [
			I("pmatrix", "\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}", "\\begin{pmatrix} ¦ &  \\\\  &  \\end{pmatrix}", "2×2 matrix"),
			I("pmatrix3", "\\begin{pmatrix} a & b & c \\\\ d & e & f \\\\ g & h & i \\end{pmatrix}", "\\begin{pmatrix} ¦ &  &  \\\\  &  &  \\\\  &  &  \\end{pmatrix}", "3×3 matrix"),
			I("bmatrix", "\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}", "\\begin{bmatrix} ¦ &  \\\\  &  \\end{bmatrix}"),
			I("vmatrix", "\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix}", "\\begin{vmatrix} ¦ &  \\\\  &  \\end{vmatrix}", "determinant"),
			I("column", "\\begin{pmatrix} x \\\\ y \\end{pmatrix}", "\\begin{pmatrix} ¦ \\\\  \\end{pmatrix}", "column vector"),
			I("aligned", "\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}", "\\begin{aligned} ¦ &=  \\\\  &=  \\end{aligned}", "line up equations"),
		],
	},
	{
		name: "Sets & logic", icon: "brackets", items: [
			I("in", "\\in"), I("notin", "\\notin"), I("subset", "\\subset"), I("subseteq", "\\subseteq"), I("cup", "\\cup"), I("cap", "\\cap"),
			I("emptyset", "\\emptyset"), I("setminus", "\\setminus"),
			I("R", "\\mathbb{R}", "\\mathbb{R}¦", "real numbers"), I("N", "\\mathbb{N}", "\\mathbb{N}¦", "natural numbers"),
			I("Z", "\\mathbb{Z}", "\\mathbb{Z}¦", "integers"), I("Q", "\\mathbb{Q}", "\\mathbb{Q}¦", "rationals"), I("C", "\\mathbb{C}", "\\mathbb{C}¦", "complex"),
			I("forall", "\\forall"), I("exists", "\\exists"), I("neg", "\\neg"), I("land", "\\land"), I("lor", "\\lor"),
			I("implies", "\\implies"), I("iff", "\\iff"), I("therefore", "\\therefore"), I("because", "\\because"),
			I("set", "\\{ x \\mid x > 0 \\}", "\\{ ¦ \\mid  \\}", "set builder"),
		],
	},
	{
		name: "Geometry & arrows", icon: "triangle", items: [
			I("angle", "\\angle"), I("triangle", "\\triangle"), I("perp", "\\perp"), I("parallel", "\\parallel"), I("cong", "\\cong"), I("sim", "\\sim"),
			I("circ", "\\circ"), I("overline", "\\overline{AB}", "\\overline{¦}", "line segment"), I("overrightarrow", "\\overrightarrow{AB}", "\\overrightarrow{¦}", "ray / vector"),
			I("rightarrow", "\\rightarrow"), I("leftarrow", "\\leftarrow"), I("leftrightarrow", "\\leftrightarrow"),
			I("Rightarrow", "\\Rightarrow"), I("Leftarrow", "\\Leftarrow"), I("Leftrightarrow", "\\Leftrightarrow"),
			I("uparrow", "\\uparrow"), I("downarrow", "\\downarrow"), I("mapsto", "\\mapsto"),
		],
	},
];

export const ALL_ITEMS: MathItem[] = MATH_GROUPS.flatMap((g) => g.items);

/** Math tools that get keyboard shortcuts and bottom-row buttons. */
export interface MathTool { id: string; name: string; icon: string; key: string; shift?: boolean; insert?: string; action?: "palette" | "greek"; special?: "fraction" }
export const MATH_TOOLS: MathTool[] = [
	{ id: "inline-math", name: "Inline maths  $x$", icon: "dollar-sign", key: "M", shift: true, insert: "$¦$" },
	{ id: "math-block", name: "Maths block  $$ $$", icon: "square-function", key: "E", insert: "$$\n¦\n$$" },
	{ id: "power", name: "Power  x^y", icon: "superscript", key: "P", insert: "^{¦}" },
	{ id: "subscript", name: "Subscript  x_n", icon: "subscript", key: "B", insert: "_{¦}" },
	{ id: "fraction", name: "Fraction  a/b", icon: "divide", key: "Q", insert: "\\frac{¦}{}", special: "fraction" },
	{ id: "sqrt", name: "Square root  √", icon: "radical", key: "R", insert: "\\sqrt{¦}" },
	{ id: "sum", name: "Sum  Σ", icon: "sigma", key: "S", insert: "\\sum_{i=1}^{n} ¦" },
	{ id: "integral", name: "Integral  ∫", icon: "spline", key: "N", insert: "\\int_{a}^{b} ¦ \\,dx" },
	{ id: "limit", name: "Limit", icon: "arrow-right-to-line", key: "L", insert: "\\lim_{x \\to ¦}" },
	{ id: "matrix", name: "Matrix", icon: "grid-3x3", key: "X", insert: "\\begin{pmatrix} ¦ &  \\\\  &  \\end{pmatrix}" },
	{ id: "math-palette", name: "Open maths symbols", icon: "pi", key: "K", action: "palette" },
	{ id: "greek", name: "Greek letters", icon: "omega", key: "G", action: "greek" },
];

export function shortcutLabel(t: MathTool): string {
	const mod = Platform.isMacOS || Platform.isIosApp ? "⌘" : "Ctrl+";
	const alt = Platform.isMacOS || Platform.isIosApp ? "⌥" : "Alt+";
	return t.shift ? `${mod}${Platform.isMacOS || Platform.isIosApp ? "⇧" : "Shift+"}${t.key}` : `${mod}${alt}${t.key}`;
}

/** Match a key event against the math shortcuts (used in board text boxes and sheet cells). */
let shortcutsOn = true;
export function setShortcutsEnabled(on: boolean) { shortcutsOn = on; }

export function matchTool(e: KeyboardEvent): MathTool | null {
	if (!shortcutsOn) return null;
	if (e.defaultPrevented) return null; // Obsidian's hotkey already handled it
	const mod = Platform.isMacOS || Platform.isIosApp ? e.metaKey : e.ctrlKey;
	if (!mod) return null;
	for (const t of MATH_TOOLS) {
		if (e.code !== "Key" + t.key) continue;
		if (t.shift ? e.shiftKey && !e.altKey : e.altKey && !e.shiftKey) return t;
	}
	return null;
}

// ---------- inserting ----------

export function insideMath(before: string): boolean {
	const blocks = (before.match(/\$\$/g) || []).length;
	if (blocks % 2 === 1) return true;
	const line = before.slice(before.lastIndexOf("\n") + 1).replace(/\\\$/g, "").replace(/\$\$/g, "");
	return (line.match(/\$/g) || []).length % 2 === 1;
}

function prepare(snippet: string, selected: string, wrap: boolean): { text: string; caret: number } {
	let s = snippet.includes("¦") ? snippet : snippet + "¦";
	const isMathWrapper = s.startsWith("$");
	if (wrap && !isMathWrapper) s = "$" + s + "$";
	const at = s.indexOf("¦");
	const text = s.slice(0, at) + selected + s.slice(at + 1);
	return { text, caret: at + selected.length };
}

/** For x^y / x_n typed outside maths, pull the word before the cursor (the "x") into the maths. */
const BASE = /[A-Za-z0-9\u0370-\u03ff)\]}]+$/;

export function insertInEditor(editor: Editor, snippet: string) {
	let from = editor.getCursor("from");
	const before = editor.getRange({ line: 0, ch: 0 }, from);
	const outside = !insideMath(before);
	if (!outside && snippet.startsWith("$")) return; // already in maths
	if (outside && /^[\^_]/.test(snippet) && !editor.somethingSelected()) {
		const m = editor.getLine(from.line).slice(0, from.ch).match(BASE);
		if (m) { const start = { line: from.line, ch: from.ch - m[0].length }; editor.setSelection(start, from); from = start; snippet = m[0] + snippet; editor.replaceSelection(""); }
	}
	const { text, caret } = prepare(snippet, editor.getSelection(), outside);
	editor.replaceSelection(text);
	editor.setCursor(editor.offsetToPos(editor.posToOffset(from) + caret));
	editor.focus();
}

/** Insert into a textarea/input. mode "math" wraps in $ when outside maths; "plain" inserts as-is. */
export function insertInField(el: HTMLTextAreaElement | HTMLInputElement, snippet: string, mode: "math" | "plain" = "math") {
	let start = el.selectionStart ?? el.value.length;
	const end = el.selectionEnd ?? start;
	const wrap = mode === "math" && !insideMath(el.value.slice(0, start));
	if (mode === "math" && !wrap && snippet.startsWith("$")) return; // already in maths
	let selected = el.value.slice(start, end);
	if (wrap && start === end && /^[\^_]/.test(snippet)) {
		const m = el.value.slice(0, start).match(BASE);
		if (m) { start -= m[0].length; snippet = m[0] + snippet; selected = ""; }
	}
	const { text, caret } = prepare(snippet, selected, wrap);
	el.setRangeText(text, start, end, "end");
	el.setSelectionRange(start + caret, start + caret);
	el.focus();
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

// ---------- palette ----------

function preview(container: HTMLElement, tex: string) {
	try { container.appendChild(renderMath(tex, false)); } catch { container.setText(tex); }
}

export class MathPalette extends Modal {
	private group = 0;
	constructor(app: App, private onPick: (item: MathItem) => void, startGroup = 0) {
		super(app);
		this.group = startGroup;
	}
	onOpen() {
		this.modalEl.addClass("ms-palette-modal");
		this.titleEl.setText("Maths symbols");
		const { contentEl } = this;
		const search = contentEl.createEl("input", { type: "search", cls: "ms-palette-search", attr: { placeholder: "Search (e.g. fraction, alpha, integral)" } });
		const tabs = contentEl.createDiv("ms-palette-tabs");
		const grid = contentEl.createDiv("ms-palette-grid");
		const tips = contentEl.createDiv("ms-palette-tips");
		tips.setText("Tip: type \\ in a note to search symbols as you write.");

		const draw = () => {
			grid.empty();
			const q = search.value.trim().toLowerCase();
			const items = q
				? ALL_ITEMS.filter((i) => i.name.toLowerCase().includes(q) || (i.label ?? "").toLowerCase().includes(q) || i.tex.toLowerCase().includes(q))
				: MATH_GROUPS[this.group].items;
			tabs.toggleClass("is-hidden", !!q);
			items.forEach((item, idx) => {
				const b = grid.createEl("button", { cls: "ms-palette-btn", attr: { "aria-label": item.label ?? item.name } });
				preview(b.createDiv("ms-palette-tex"), item.tex);
				b.createDiv({ cls: "ms-palette-name", text: item.label ?? item.name });
				b.onclick = () => { this.close(); this.onPick(item); };
				if (q && idx === 0) b.addClass("is-first");
			});
			void finishRenderMath();
		};
		MATH_GROUPS.forEach((g, i) => {
			const t = tabs.createEl("button", { cls: "ms-palette-tab" + (i === this.group ? " is-active" : "") });
			setIcon(t.createSpan(), g.icon);
			t.createSpan({ text: g.name });
			t.onclick = () => { this.group = i; tabs.querySelectorAll(".ms-palette-tab").forEach((el, j) => el.toggleClass("is-active", j === i)); draw(); };
		});
		search.oninput = draw;
		search.onkeydown = (e) => {
			if (e.key === "Enter") { grid.querySelector("button")?.click(); }
		};
		draw();
		if (!Platform.isMobile) search.focus();
	}
	onClose() { this.contentEl.empty(); }
}

// ---------- "\" autocomplete in notes ----------

export class MathSuggest extends EditorSuggest<MathItem> {
	constructor(app: App) { super(app); this.limit = 30; }
	onTrigger(cursor: EditorPosition, editor: Editor, _file: TFile | null): EditorSuggestTriggerInfo | null {
		const line = editor.getLine(cursor.line).slice(0, cursor.ch);
		const m = line.match(/\\([A-Za-z]{1,20})$/);
		if (!m) return null;
		return { start: { line: cursor.line, ch: cursor.ch - m[0].length }, end: cursor, query: m[1] };
	}
	getSuggestions(ctx: EditorSuggestContext): MathItem[] {
		const q = ctx.query.toLowerCase();
		const starts = ALL_ITEMS.filter((i) => i.name.toLowerCase().startsWith(q));
		const contains = ALL_ITEMS.filter((i) => !starts.includes(i) && ((i.label ?? "").toLowerCase().includes(q) || i.name.toLowerCase().includes(q)));
		// exact-case match first (so \Delta vs \delta behave)
		return [...starts.sort((a, b) => (b.name.startsWith(ctx.query) ? 1 : 0) - (a.name.startsWith(ctx.query) ? 1 : 0) || a.name.length - b.name.length), ...contains];
	}
	renderSuggestion(item: MathItem, el: HTMLElement) {
		el.addClass("ms-suggest");
		preview(el.createDiv("ms-suggest-tex"), item.tex);
		el.createDiv({ cls: "ms-suggest-name", text: item.label ? `${item.name} — ${item.label}` : item.name });
		void finishRenderMath();
	}
	selectSuggestion(item: MathItem) {
		if (!this.context) return;
		const { editor, start, end } = this.context;
		editor.replaceRange("", start, end);
		editor.setCursor(start);
		insertInEditor(editor, item.insert);
	}
}
