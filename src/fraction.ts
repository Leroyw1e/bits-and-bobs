import { App, Editor, Modal, finishRenderMath, loadMathJax, renderMath } from "obsidian";
import { insideMath } from "./math";

// Fractions without the braces: you fill in a top and a bottom, and the LaTeX is written for you.

class FractionModal extends Modal {
	private done = false;
	constructor(app: App, private init: { top?: string; bottom?: string }, private onDone: (top: string, bottom: string) => void) { super(app); }

	onOpen() {
		this.titleEl.setText("Fraction");
		this.modalEl.addClass("bb-frac-modal");
		const wrap = this.contentEl.createDiv("bb-frac");
		const top = wrap.createEl("input", { type: "text", cls: "bb-frac-input", attr: { placeholder: "Top", "aria-label": "Top" } });
		wrap.createDiv("bb-frac-bar");
		const bottom = wrap.createEl("input", { type: "text", cls: "bb-frac-input", attr: { placeholder: "Bottom", "aria-label": "Bottom" } });
		top.value = this.init.top ?? "";
		bottom.value = this.init.bottom ?? "";
		const preview = this.contentEl.createDiv("bb-frac-preview");
		const draw = () => {
			preview.empty();
			try {
				preview.appendChild(renderMath("\\frac{" + (top.value.trim() || "\\square") + "}{" + (bottom.value.trim() || "\\square") + "}", true));
				void finishRenderMath();
			} catch { /* the preview is only a convenience */ }
		};
		const insert = () => {
			if (this.done) return;
			this.done = true;
			this.close();
			this.onDone(top.value.trim(), bottom.value.trim());
		};
		top.oninput = draw;
		bottom.oninput = draw;
		top.onkeydown = (e) => { if (e.key === "Enter" || e.key === "ArrowDown") { e.preventDefault(); bottom.focus(); } };
		bottom.onkeydown = (e) => {
			if (e.key === "Enter") { e.preventDefault(); insert(); }
			else if (e.key === "ArrowUp") { e.preventDefault(); top.focus(); }
		};
		const row = this.contentEl.createDiv("bb-frac-actions");
		row.createEl("button", { cls: "mod-cta", text: "Insert" }).onclick = insert;
		this.contentEl.createDiv({ cls: "setting-item-description bb-frac-tip", text: "Type the top, press Enter, type the bottom, press Enter." });
		void loadMathJax().then(draw);
		window.setTimeout(() => (this.init.top ? bottom : top).focus(), 30);
	}

	onClose() { this.contentEl.empty(); }
}

export function openFractionDialog(app: App, init: { top?: string; bottom?: string }, done: (top: string, bottom: string) => void) {
	new FractionModal(app, init, done).open();
}

const NUM_OR_GROUP = /(-?\d+(?:\.\d+)?|\([^()]*\))$/;
const MATH_TOKEN = /(-?\d+(?:\.\d+)?|\\[A-Za-z]+|[A-Za-z]+\d*|\([^()]*\))$/;
const stripParens = (s: string) => (/^\(.*\)$/.test(s) ? s.slice(1, -1) : s);
const SLASH = /^\s*(.+?)\s*\/\s*(.+?)\s*$/;

/** In a note: a number or bracket just before the cursor becomes the top, and a selected "3/4" becomes a fraction straight away. */
export function fractionInEditor(app: App, editor: Editor) {
	const from = editor.getCursor("from"), to = editor.getCursor("to");
	const sel = editor.getSelection();
	const inMath = insideMath(editor.getRange({ line: 0, ch: 0 }, from));
	let start = from, top = "";
	const finish = (t: string, b: string) => {
		const tex = "\\frac{" + t + "}{" + b + "}";
		const text = inMath ? tex : "$" + tex + "$";
		editor.replaceRange(text, start, to);
		editor.setCursor(editor.offsetToPos(editor.posToOffset(start) + text.length));
		editor.focus();
	};
	if (sel) {
		const m = !sel.includes("\n") ? sel.match(SLASH) : null;
		if (m) { finish(m[1], m[2]); return; }
		top = sel.trim();
	} else {
		const line = editor.getLine(from.line).slice(0, from.ch);
		const m = line.match(inMath ? MATH_TOKEN : NUM_OR_GROUP);
		if (m) { start = { line: from.line, ch: from.ch - m[0].length }; top = stripParens(m[0]); }
	}
	openFractionDialog(app, { top }, finish);
}

/** In a text box (for example on a board). */
export function fractionInField(app: App, el: HTMLTextAreaElement | HTMLInputElement) {
	const s0 = el.selectionStart ?? el.value.length, e0 = el.selectionEnd ?? s0;
	const inMath = insideMath(el.value.slice(0, s0));
	let start = s0, top = "";
	const finish = (t: string, b: string) => {
		const tex = "\\frac{" + t + "}{" + b + "}";
		el.setRangeText(inMath ? tex : "$" + tex + "$", start, e0, "end");
		el.focus();
		el.dispatchEvent(new Event("input", { bubbles: true }));
	};
	const sel = el.value.slice(s0, e0);
	if (sel) {
		const m = !sel.includes("\n") ? sel.match(SLASH) : null;
		if (m) { finish(m[1], m[2]); return; }
		top = sel.trim();
	} else {
		const m = el.value.slice(0, s0).match(inMath ? MATH_TOKEN : NUM_OR_GROUP);
		if (m) { start = s0 - m[0].length; top = stripParens(m[0]); }
	}
	openFractionDialog(app, { top }, finish);
}

/** Nothing being typed in (for example a drawing board): make a new maths box holding the fraction. */
export function fractionNewBox(app: App, insert: (snippet: string) => void) {
	openFractionDialog(app, {}, (t, b) => insert("$$\n\\frac{" + t + "}{" + b + "}¦\n$$"));
}
