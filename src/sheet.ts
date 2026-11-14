import { FileView, Menu, Modal, Notice, Platform, Setting, TFile, WorkspaceLeaf, setIcon, App, Component } from "obsidian";
import * as XLSX from "xlsx";
import type BitsAndBobs from "./main";
import { FErr, FUNCTIONS, V, addr, colName, parse, parseAddr, run } from "./formula";
import { insertInField, matchTool } from "./math";

export const VIEW_SHEET = "math-studio-sheet";
export const EXT_SHEET = "xlsx";

interface SheetModel { name: string; raw: Map<string, string>; rows: number; cols: number; rowH: Map<number, number>; colW: Map<number, number> }

export const ROW_H = 28, COL_W = 96;

/** Loads an .xlsx into simple models and computes formulas. */
export class Workbook {
	wb: XLSX.WorkBook;
	sheets: SheetModel[] = [];
	private cache = new Map<string, V>();
	private visiting = new Set<string>();

	constructor(data: ArrayBuffer | null) {
		this.wb = data && data.byteLength ? XLSX.read(new Uint8Array(data), { type: "array", cellFormula: true, cellDates: true, cellNF: true, cellStyles: true }) : XLSX.utils.book_new();
		if (!this.wb.SheetNames.length) XLSX.utils.book_append_sheet(this.wb, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
		for (const name of this.wb.SheetNames) {
			const ws = this.wb.Sheets[name];
			const raw = new Map<string, string>();
			let rows = 0, cols = 0;
			for (const key of Object.keys(ws)) {
				if (key[0] === "!") continue;
				const c = ws[key] as XLSX.CellObject;
				let v: string;
				if (c.f) v = "=" + c.f;
				else if (c.t === "d" && c.w) v = c.w;
				else if (c.t === "b") v = c.v ? "TRUE" : "FALSE";
				else if (c.v === undefined || c.v === null) continue;
				else v = c.t === "n" ? String(c.v) : String(c.v);
				raw.set(key, v);
				const p = parseAddr(key)!;
				rows = Math.max(rows, p.r + 1); cols = Math.max(cols, p.c + 1);
			}
			const rowH = new Map<number, number>(), colW = new Map<number, number>();
			(ws["!rows"] ?? []).forEach((r, i) => { const h = r?.hpx ?? (r?.hpt ? r.hpt * 96 / 72 : 0); if (h && !r.hidden) rowH.set(i, Math.round(h)); });
			(ws["!cols"] ?? []).forEach((c, i) => { const w = c?.wpx ?? (c?.wch ? c.wch * 7 + 5 : 0); if (w && !c.hidden) colW.set(i, Math.round(w)); });
			this.sheets.push({ name, raw, rows: Math.max(rows + 5, 40), cols: Math.max(cols + 2, 12), rowH, colW });
		}
	}

	sheet(name?: string) { return name ? this.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase()) : undefined; }
	invalidate() { this.cache.clear(); }

	value(sheet: SheetModel, ref: string): V {
		const key = sheet.name + "!" + ref;
		if (this.cache.has(key)) return this.cache.get(key)!;
		const raw = sheet.raw.get(ref);
		let v: V;
		if (raw === undefined || raw === "") v = "";
		else if (raw.startsWith("=") && raw.length > 1) {
			if (this.visiting.has(key)) return new FErr("#CIRCULAR!");
			this.visiting.add(key);
			try {
				const node = parse(raw.slice(1));
				v = run(node, {
					get: (sh, r) => { const s = sh ? this.sheet(sh) : sheet; return s ? this.value(s, r) : new FErr("#REF!"); },
					range: (sh, a, b) => {
						const s = sh ? this.sheet(sh) : sheet; const pa = parseAddr(a), pb = parseAddr(b);
						if (!s || !pa || !pb) throw new FErr("#REF!");
						const out: V[][] = [];
						for (let r = Math.min(pa.r, pb.r); r <= Math.max(pa.r, pb.r); r++) {
							const row: V[] = [];
							for (let c = Math.min(pa.c, pb.c); c <= Math.max(pa.c, pb.c); c++) row.push(this.value(s, addr(r, c)));
							out.push(row);
						}
						return out;
					},
				});
			} catch (e) {
				v = e instanceof FErr ? e : new FErr("#ERROR!");
			}
			this.visiting.delete(key);
		} else if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(raw.trim())) v = parseFloat(raw);
		else if (/^(true|false)$/i.test(raw)) v = raw.toUpperCase() === "TRUE";
		else v = raw;
		this.cache.set(key, v);
		return v;
	}

	toArrayBuffer(): ArrayBuffer {
		this.invalidate();
		const names = this.sheets.map((s) => s.name);
		// drop removed sheets, rename/keep existing ones (keeps column widths, merges)
		for (const n of Object.keys(this.wb.Sheets)) if (!names.includes(n)) delete this.wb.Sheets[n];
		this.wb.SheetNames = names;
		for (const s of this.sheets) {
			const ws: XLSX.WorkSheet = this.wb.Sheets[s.name] ?? {};
			for (const k of Object.keys(ws)) if (k[0] !== "!") delete ws[k];
			let maxR = 0, maxC = 0;
			for (const [ref, raw] of s.raw) {
				if (raw === "") continue;
				const p = parseAddr(ref)!; maxR = Math.max(maxR, p.r); maxC = Math.max(maxC, p.c);
				if (raw.startsWith("=")) {
					const v = this.value(s, ref);
					ws[ref] = v instanceof FErr ? { t: "s", f: raw.slice(1), v: v.code }
						: typeof v === "number" ? { t: "n", f: raw.slice(1), v } : typeof v === "boolean" ? { t: "b", f: raw.slice(1), v } : { t: "s", f: raw.slice(1), v: String(v) };
				} else {
					const v = this.value(s, ref);
					ws[ref] = typeof v === "number" ? { t: "n", v } : typeof v === "boolean" ? { t: "b", v } : { t: "s", v: raw };
				}
			}
			const rowsArr: XLSX.RowInfo[] = [], colsArr: XLSX.ColInfo[] = [];
			for (const [i, h] of s.rowH) rowsArr[i] = { hpx: h, hpt: Math.round(h * 72 / 96 * 100) / 100 };
			for (const [i, w] of s.colW) colsArr[i] = { wpx: w, wch: Math.max(1, Math.round((w - 5) / 7)) };
			if (rowsArr.length) ws["!rows"] = rowsArr; else delete ws["!rows"];
			if (colsArr.length) ws["!cols"] = colsArr; else delete ws["!cols"];
			ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
			this.wb.Sheets[s.name] = ws;
		}
		const out = XLSX.write(this.wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
		return out;
	}
}

export function emptyXlsx(): ArrayBuffer {
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
	return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

export function display(v: V): string {
	if (v instanceof FErr) return v.code;
	if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
	if (typeof v === "number") {
		if (Number.isInteger(v)) return String(v);
		const s = Math.abs(v) >= 1e12 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(6) : String(Math.round(v * 1e10) / 1e10);
		return s;
	}
	return v;
}

export class SheetView extends FileView {
	book: Workbook | null = null;
	active = 0;
	sel = { r: 0, c: 0 };
	anchor = { r: 0, c: 0 };
	private gridWrap!: HTMLElement;
	private table!: HTMLTableElement;
	private fbar!: HTMLInputElement;
	private refLabel!: HTMLElement;
	private tabsEl!: HTMLElement;
	private editor: { input: HTMLInputElement; r: number; c: number; fromBar: boolean } | null = null;
	private saveTimer = 0;
	private writing = false;
	private undoStack: { sheet: number; raw: [string, string][] }[] = [];
	private redoStack: { sheet: number; raw: [string, string][] }[] = [];

	constructor(leaf: WorkspaceLeaf, private plugin: BitsAndBobs) { super(leaf); this.allowNoFile = false; }
	getViewType() { return VIEW_SHEET; }
	getIcon() { return "sheet"; }
	getDisplayText() { return this.file?.basename ?? "Spreadsheet"; }
	canAcceptExtension(ext: string) { return ext === EXT_SHEET; }

	async onOpen() {
		this.registerEvent(this.app.vault.on("modify", (f) => { if (f === this.file && !this.writing) this.onLoadFile(f as TFile); }));
	}

	async onLoadFile(file: TFile) {
		try {
			this.book = new Workbook(await this.app.vault.readBinary(file));
		} catch (e) {
			console.error(e);
			this.contentEl.empty();
			this.contentEl.createDiv({ cls: "ms-sheet-error", text: "This spreadsheet couldn't be opened. It may be password-protected or damaged." });
			return;
		}
		this.active = Math.min(this.active, this.book.sheets.length - 1);
		this.build();
	}
	async onUnloadFile(_file: TFile) { await this.flush(); }
	async onClose() { await this.flush(); }

	private get sheet() { return this.book!.sheets[this.active]; }

	// ---------- saving ----------
	private scheduleSave() {
		window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => this.flush(), 700);
	}
	private async flush() {
		if (!this.saveTimer || !this.book || !this.file) return;
		window.clearTimeout(this.saveTimer); this.saveTimer = 0;
		this.writing = true;
		try { await this.app.vault.modifyBinary(this.file, this.book.toArrayBuffer()); }
		catch (e) { console.error(e); new Notice("Couldn't save the spreadsheet"); }
		finally { window.setTimeout(() => (this.writing = false), 300); }
	}

	// ---------- edits ----------
	private pushUndo() {
		this.undoStack.push({ sheet: this.active, raw: [...this.sheet.raw] });
		if (this.undoStack.length > 100) this.undoStack.shift();
		this.redoStack = [];
	}
	undo() { this.commitEdit(); this.restore(this.undoStack, this.redoStack); }
	redo() { this.commitEdit(); this.restore(this.redoStack, this.undoStack); }
	private restore(from: typeof this.undoStack, to: typeof this.undoStack) {
		const s = from.pop(); if (!s || !this.book) return;
		to.push({ sheet: s.sheet, raw: [...this.book.sheets[s.sheet].raw] });
		this.book.sheets[s.sheet].raw = new Map(s.raw);
		this.active = s.sheet; this.changed(true);
	}
	setCell(r: number, c: number, raw: string, record = true) {
		if (record) this.pushUndo();
		const ref = addr(r, c);
		if (raw === "") this.sheet.raw.delete(ref); else this.sheet.raw.set(ref, raw);
		if (r >= this.sheet.rows - 2) this.sheet.rows = r + 10;
		if (c >= this.sheet.cols - 1) this.sheet.cols = c + 3;
	}
	private changed(rebuild = false) {
		this.book!.invalidate();
		if (rebuild) this.build(); else this.refreshValues();
		this.scheduleSave();
	}

	// ---------- UI ----------
	private build() {
		const c = this.contentEl;
		c.empty();
		c.addClass("ms-view", "ms-sheet");
		const tb = c.createDiv("ms-sheet-toolbar");
		const btn = (icon: string, label: string, fn: (e: MouseEvent) => void, text?: string) => {
			const b = tb.createEl("button", { cls: "ms-tb-btn clickable-icon", attr: { "aria-label": label } });
			setIcon(b, icon); if (text) b.createSpan({ cls: "ms-tb-text", text });
			b.onclick = fn; return b;
		};
		btn("sigma", "AutoSum (adds up the cells above)", () => this.autoSum(), "Sum");
		btn("superscript", "Power  x^y  (⌘⌥P)", () => this.insertFormula("^"));
		btn("radical", "Square root (⌘⌥R)", () => this.insertFormula("SQRT(¦)"));
		btn("function-square", "Insert a function", (e) => this.functionMenu(e), "f(x)");
		btn("rows-3", "Add 10 rows", () => { this.sheet.rows += 10; this.build(); });
		btn("columns-3", "Add a column", () => { this.sheet.cols += 1; this.build(); });
		btn("undo-2", "Undo (⌘Z)", () => this.restore(this.undoStack, this.redoStack));
		btn("redo-2", "Redo (⇧⌘Z)", () => this.restore(this.redoStack, this.undoStack));
		btn("clipboard-copy", "Copy selection as a Markdown table", () => this.copyMarkdown());
		const st = this.plugin.settings;
		const ac = btn("spell-check", "Autocorrect & keyboard predictions (on/off)", () => {
			st.sheetAutocorrect = !st.sheetAutocorrect; this.plugin.saveSettings();
			ac.toggleClass("is-active", st.sheetAutocorrect);
			this.applyTyping(this.fbar); if (this.editor) this.applyTyping(this.editor.input);
			new Notice(`Autocorrect & predictions ${st.sheetAutocorrect ? "on" : "off"}`);
		}, "Autocorrect");
		ac.toggleClass("is-active", st.sheetAutocorrect);
		const sg = btn("wand-2", "Suggest functions while typing a formula (on/off)", () => {
			st.sheetSuggest = !st.sheetSuggest; this.plugin.saveSettings();
			sg.toggleClass("is-active", st.sheetSuggest); this.hideSuggest();
			new Notice(`Formula suggestions ${st.sheetSuggest ? "on" : "off"}`);
		}, "Suggest");
		sg.toggleClass("is-active", st.sheetSuggest);

		const fb = c.createDiv("ms-formula-bar");
		this.refLabel = fb.createDiv("ms-ref-label");
		fb.createSpan({ cls: "ms-fx", text: "fx" });
		this.fbar = fb.createEl("input", { type: "text", cls: "ms-fbar", attr: { placeholder: "Type a value or a formula like =A1^2 + B1" } });
		this.applyTyping(this.fbar);
		this.fbar.onfocus = () => { if (!this.editor) this.startEdit(undefined, true); };
		this.fbar.oninput = () => { if (this.editor && this.editor.input !== this.fbar) this.editor.input.value = this.fbar.value; this.updateSuggest(this.fbar); };
		this.fbar.onkeydown = (e) => this.editKey(e, this.fbar);

		this.gridWrap = c.createDiv("ms-grid-wrap");
		this.gridWrap.tabIndex = 0;
		this.table = this.gridWrap.createEl("table", { cls: "ms-grid" });
		const s = this.sheet;
		const cg = this.table.createEl("colgroup");
		cg.createEl("col").style.width = "44px";
		for (let cc = 0; cc < s.cols; cc++) cg.createEl("col").style.width = (s.colW.get(cc) ?? COL_W) + "px";
		this.sizeTable();
		const head = this.table.createTHead().insertRow();
		head.createEl("th", { cls: "ms-corner" });
		for (let cc = 0; cc < s.cols; cc++) {
			const th = head.createEl("th", { text: colName(cc) }); th.dataset.c = String(cc);
			this.resizeHandle(th.createDiv({ cls: "ms-col-resize", attr: { "aria-label": "Drag to resize column · double-click to reset" } }), "col", cc);
		}
		const body = this.table.createTBody();
		for (let r = 0; r < s.rows; r++) {
			const tr = body.insertRow();
			if (s.rowH.has(r)) tr.style.setProperty("--rh", s.rowH.get(r) + "px");
			const rth = tr.createEl("th", { text: String(r + 1) }); rth.dataset.r = String(r);
			this.resizeHandle(rth.createDiv({ cls: "ms-row-resize", attr: { "aria-label": "Drag to resize row · double-click to reset" } }), "row", r);
			for (let cc = 0; cc < s.cols; cc++) {
				const td = tr.insertCell();
				td.dataset.r = String(r); td.dataset.c = String(cc);
			}
		}
		this.refreshValues();

		this.tabsEl = c.createDiv("ms-sheet-tabs");
		this.book!.sheets.forEach((sh, i) => {
			const t = this.tabsEl.createEl("button", { cls: "ms-sheet-tab" + (i === this.active ? " is-active" : ""), text: sh.name });
			t.onclick = () => { this.commitEdit(); this.active = i; this.sel = { r: 0, c: 0 }; this.anchor = { ...this.sel }; this.build(); };
			t.oncontextmenu = (e) => { e.preventDefault(); this.tabMenu(i, e); };
			t.ondblclick = () => this.tabMenu(i, null);
		});
		const add = this.tabsEl.createEl("button", { cls: "ms-sheet-tab ms-add-tab clickable-icon", attr: { "aria-label": "Add sheet" } });
		setIcon(add, "plus");
		add.onclick = () => {
			let n = this.book!.sheets.length + 1; while (this.book!.sheet("Sheet" + n)) n++;
			this.book!.sheets.push({ name: "Sheet" + n, raw: new Map(), rows: 40, cols: 12, rowH: new Map(), colW: new Map() });
			this.active = this.book!.sheets.length - 1; this.changed(true);
		};

		// events
		let dragging = false;
		this.table.onpointerdown = (e) => {
			const td = (e.target as HTMLElement).closest("td") as HTMLTableCellElement | null;
			const th = (e.target as HTMLElement).closest("th") as HTMLElement | null;
			if (td) {
				const r = +td.dataset.r!, cc = +td.dataset.c!;
				// clicking a cell while typing a formula inserts its address
				if (this.editor && this.editor.input.value.startsWith("=") && (r !== this.editor.r || cc !== this.editor.c)) {
					e.preventDefault();
					const inp = this.editor.input;
					insertInField(inp, addr(r, cc), "plain");
					if (inp !== this.fbar) this.fbar.value = inp.value;
					return;
				}
				this.commitEdit();
				if (e.shiftKey) this.sel = { r, c: cc }; else { this.sel = { r, c: cc }; this.anchor = { r, c: cc }; }
				dragging = e.pointerType === "mouse";
				this.drawSel();
				this.gridWrap.focus({ preventScroll: true });
			} else if (th?.dataset.c) { this.commitEdit(); const cc = +th.dataset.c; this.anchor = { r: 0, c: cc }; this.sel = { r: this.sheet.rows - 1, c: cc }; this.drawSel(); }
			else if (th?.dataset.r) { this.commitEdit(); const r = +th.dataset.r; this.anchor = { r, c: 0 }; this.sel = { r, c: this.sheet.cols - 1 }; this.drawSel(); }
		};
		this.table.onpointerover = (e) => {
			if (!dragging) return;
			const td = (e.target as HTMLElement).closest("td") as HTMLElement | null;
			if (td) { this.sel = { r: +td.dataset.r!, c: +td.dataset.c! }; this.drawSel(); }
		};
		this.registerDomEvent(window, "pointerup", () => (dragging = false));
		this.table.ondblclick = (e) => { if ((e.target as HTMLElement).closest("td")) this.startEdit(); };
		let lastTap = 0;
		this.table.addEventListener("touchend", (e) => { const now = Date.now(); if (now - lastTap < 350 && (e.target as HTMLElement).closest("td")) { e.preventDefault(); this.startEdit(); } lastTap = now; });
		this.gridWrap.onkeydown = (e) => this.gridKey(e);
		this.gridWrap.addEventListener("copy", (e) => { if (this.editor) return; e.preventDefault(); e.clipboardData?.setData("text/plain", this.selectionTSV(false)); });
		this.gridWrap.addEventListener("cut", (e) => { if (this.editor) return; e.preventDefault(); e.clipboardData?.setData("text/plain", this.selectionTSV(false)); this.clearSelection(); });
		this.gridWrap.addEventListener("paste", (e) => { if (this.editor) return; e.preventDefault(); this.paste(e.clipboardData?.getData("text/plain") ?? ""); });
		this.drawSel();
		this.gridWrap.focus({ preventScroll: true });
	}

	private sizeTable() {
		const s = this.sheet;
		let w = 44; for (let c = 0; c < s.cols; c++) w += s.colW.get(c) ?? COL_W;
		this.table.style.width = w + "px";
	}

	/** Drag the edge of a row number / column letter to resize it (mouse, finger or Pencil). */
	private resizeHandle(el: HTMLElement, kind: "row" | "col", i: number) {
		el.addEventListener("pointerdown", (e) => {
			e.preventDefault(); e.stopPropagation();
			try { el.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
			const s = this.sheet;
			const start = kind === "row" ? e.clientY : e.clientX;
			const orig = kind === "row" ? s.rowH.get(i) ?? ROW_H : s.colW.get(i) ?? COL_W;
			const col = this.table.querySelectorAll("col")[i + 1] as HTMLElement | undefined;
			const tr = this.table.tBodies[0].rows[i];
			document.body.addClass(kind === "row" ? "ms-resizing-row" : "ms-resizing-col");
			const move = (ev: PointerEvent) => {
				const size = Math.max(kind === "row" ? 16 : 30, Math.round(orig + (kind === "row" ? ev.clientY : ev.clientX) - start));
				if (kind === "row") { s.rowH.set(i, size); tr?.style.setProperty("--rh", size + "px"); }
				else { s.colW.set(i, size); if (col) col.style.width = size + "px"; this.sizeTable(); }
			};
			const up = () => {
				el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up);
				document.body.removeClass("ms-resizing-row", "ms-resizing-col");
				this.scheduleSave();
			};
			el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
		});
		el.addEventListener("dblclick", (e) => {
			e.stopPropagation();
			const s = this.sheet;
			if (kind === "row") { s.rowH.delete(i); this.table.tBodies[0].rows[i]?.style.removeProperty("--rh"); }
			else { s.colW.delete(i); const col = this.table.querySelectorAll("col")[i + 1] as HTMLElement | undefined; if (col) col.style.width = COL_W + "px"; this.sizeTable(); }
			this.scheduleSave();
		});
	}

	private refreshValues() {
		const s = this.sheet;
		const body = this.table.tBodies[0];
		for (let r = 0; r < s.rows; r++) {
			const tr = body.rows[r];
			for (let c = 0; c < s.cols; c++) {
				const td = tr.cells[c + 1];
				const v = this.book!.value(s, addr(r, c));
				td.setText(display(v));
				td.toggleClass("is-num", typeof v === "number");
				td.toggleClass("is-err", v instanceof FErr);
				td.toggleClass("is-formula", !!s.raw.get(addr(r, c))?.startsWith("="));
			}
		}
	}

	private range() {
		return { r1: Math.min(this.sel.r, this.anchor.r), r2: Math.max(this.sel.r, this.anchor.r), c1: Math.min(this.sel.c, this.anchor.c), c2: Math.max(this.sel.c, this.anchor.c) };
	}

	private drawSel() {
		const { r1, r2, c1, c2 } = this.range();
		this.table.querySelectorAll(".is-selected,.is-cursor").forEach((el) => el.removeClass("is-selected", "is-cursor"));
		const body = this.table.tBodies[0];
		for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) body.rows[r]?.cells[c + 1]?.addClass("is-selected");
		const cur = body.rows[this.sel.r]?.cells[this.sel.c + 1];
		cur?.addClass("is-cursor");
		cur?.scrollIntoView({ block: "nearest", inline: "nearest" });
		const one = r1 === r2 && c1 === c2;
		this.refLabel.setText(one ? addr(this.sel.r, this.sel.c) : `${addr(r1, c1)}:${addr(r2, c2)}`);
		if (!this.editor) this.fbar.value = this.sheet.raw.get(addr(this.sel.r, this.sel.c)) ?? "";
		this.table.tHead!.rows[0].querySelectorAll("th").forEach((th) => th.toggleClass("is-hl", !!th.dataset.c && +th.dataset.c >= c1 && +th.dataset.c <= c2));
		body.querySelectorAll("th").forEach((th) => th.toggleClass("is-hl", +th.dataset.r! >= r1 && +th.dataset.r! <= r2));
	}

	private move(dr: number, dc: number, extend = false) {
		const s = this.sheet;
		this.sel = { r: Math.max(0, Math.min(s.rows - 1, this.sel.r + dr)), c: Math.max(0, Math.min(s.cols - 1, this.sel.c + dc)) };
		if (!extend) this.anchor = { ...this.sel };
		if (this.sel.r >= s.rows - 1) { s.rows += 10; this.build(); return; }
		this.drawSel();
	}

	private gridKey(e: KeyboardEvent) {
		if (this.editor) return;
		const mod = Platform.isMacOS || Platform.isIosApp ? e.metaKey : e.ctrlKey;
		const t = matchTool(e);
		if (t) { e.preventDefault(); this.mathTool(t.id); return; }
		if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.restore(this.redoStack, this.undoStack) : this.restore(this.undoStack, this.redoStack); return; }
		if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); this.anchor = { r: 0, c: 0 }; this.sel = { r: this.sheet.rows - 1, c: this.sheet.cols - 1 }; this.drawSel(); return; }
		if (mod) return;
		switch (e.key) {
			case "ArrowUp": e.preventDefault(); this.move(-1, 0, e.shiftKey); return;
			case "ArrowDown": e.preventDefault(); this.move(1, 0, e.shiftKey); return;
			case "ArrowLeft": e.preventDefault(); this.move(0, -1, e.shiftKey); return;
			case "ArrowRight": e.preventDefault(); this.move(0, 1, e.shiftKey); return;
			case "Tab": e.preventDefault(); this.move(0, e.shiftKey ? -1 : 1); return;
			case "Enter": e.preventDefault(); this.startEdit(); return;
			case "F2": e.preventDefault(); this.startEdit(); return;
			case "Delete": case "Backspace": e.preventDefault(); this.clearSelection(); return;
		}
		if (e.key.length === 1 && !e.altKey) { e.preventDefault(); this.startEdit(e.key); }
	}

	private clearSelection() {
		const { r1, r2, c1, c2 } = this.range();
		this.pushUndo();
		for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) this.setCell(r, c, "", false);
		this.changed(); this.drawSel();
	}

	private startEdit(initial?: string, fromBar = false) {
		if (this.editor) return;
		const { r, c } = this.sel;
		const raw = initial ?? this.sheet.raw.get(addr(r, c)) ?? "";
		let input: HTMLInputElement;
		if (fromBar) input = this.fbar;
		else {
			const td = this.table.tBodies[0].rows[r].cells[c + 1];
			input = td.createEl("input", { cls: "ms-cell-edit", type: "text" });
			this.applyTyping(input);
			input.onkeydown = (e) => this.editKey(e, input);
			input.oninput = () => { this.fbar.value = input.value; this.updateSuggest(input); };
			input.onblur = () => window.setTimeout(() => { if (this.editor?.input === input && document.activeElement !== this.fbar) this.commitEdit(); }, 120);
			input.focus();
		}
		input.value = raw;
		this.fbar.value = raw;
		this.editor = { input, r, c, fromBar };
		if (fromBar) {
			this.fbar.onblur = () => window.setTimeout(() => { if (this.editor?.input === this.fbar && document.activeElement !== this.fbar) this.commitEdit(); }, 150);
		}
		input.setSelectionRange(input.value.length, input.value.length);
	}

	private editKey(e: KeyboardEvent, input: HTMLInputElement) {
		if (this.suggest && this.suggestKey(e, input)) { e.stopPropagation(); return; }
		const t = matchTool(e);
		if (t) { e.preventDefault(); this.mathTool(t.id, input); return; }
		if (e.key === "Enter") { e.preventDefault(); this.commitEdit(); this.move(e.shiftKey ? -1 : 1, 0); this.gridWrap.focus(); }
		else if (e.key === "Tab") { e.preventDefault(); this.commitEdit(); this.move(0, e.shiftKey ? -1 : 1); this.gridWrap.focus(); }
		else if (e.key === "Escape") { e.preventDefault(); this.cancelEdit(); this.gridWrap.focus(); }
		e.stopPropagation();
	}

	private commitEdit() {
		const ed = this.editor;
		if (!ed) return;
		this.hideSuggest();
		this.editor = null;
		const value = ed.input.value;
		if (!ed.fromBar) ed.input.remove();
		const ref = addr(ed.r, ed.c);
		if ((this.sheet.raw.get(ref) ?? "") !== value) { this.setCell(ed.r, ed.c, value); this.changed(); }
		else this.refreshValues();
		this.drawSel();
	}
	private cancelEdit() {
		const ed = this.editor; if (!ed) return;
		this.hideSuggest();
		this.editor = null;
		if (!ed.fromBar) ed.input.remove();
		this.drawSel();
	}

	// ---------- typing: autocorrect / predictions ----------
	/** Turns the keyboard's autocorrect, predictive text and spell-check on or off for a cell box. */
	private applyTyping(input: HTMLInputElement) {
		const on = this.plugin.settings.sheetAutocorrect;
		input.setAttr("autocorrect", on ? "on" : "off");
		input.setAttr("autocapitalize", on ? "sentences" : "off");
		input.setAttr("autocomplete", on ? "on" : "off");
		input.spellcheck = on;
		// re-focus so the iPad keyboard picks up the change straight away
		if (document.activeElement === input) { input.blur(); input.focus(); }
	}

	// ---------- formula suggestions ----------
	private suggest: { el: HTMLElement; items: string[]; i: number; start: number } | null = null;

	private updateSuggest(input: HTMLInputElement) {
		this.hideSuggest();
		if (!this.plugin.settings.sheetSuggest) return;
		const caret = input.selectionStart ?? input.value.length;
		const before = input.value.slice(0, caret);
		if (!before.startsWith("=")) return;
		const m = before.match(/(?:^=|[(,+\-*/^&=<>:\s])([A-Za-z][A-Za-z0-9]*)$/);
		if (!m || /^[A-Z]{1,3}\d+$/i.test(m[1])) return;
		const q = m[1].toUpperCase();
		const items = Object.keys(FUNCTIONS).filter((n) => n.startsWith(q)).slice(0, 8);
		if (!items.length || (items.length === 1 && items[0] === q && input.value[caret] === "(")) return;
		const el = this.contentEl.createDiv("ms-fn-suggest");
		const r = input.getBoundingClientRect(), host = this.contentEl.getBoundingClientRect();
		el.style.left = Math.max(0, r.left - host.left) + "px";
		el.style.top = r.bottom - host.top + 2 + "px";
		this.suggest = { el, items, i: 0, start: caret - m[1].length };
		items.forEach((n, i) => {
			const row = el.createDiv("ms-fn-suggest-row" + (i === 0 ? " is-selected" : ""));
			row.createSpan({ cls: "ms-fn-name", text: n });
			row.createSpan({ cls: "ms-fn-help", text: FUNCTIONS[n].help });
			row.onpointerdown = (e) => { e.preventDefault(); this.suggest!.i = i; this.acceptSuggest(input); };
		});
	}
	private suggestKey(e: KeyboardEvent, input: HTMLInputElement): boolean {
		const sg = this.suggest!;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			sg.i = (sg.i + (e.key === "ArrowDown" ? 1 : sg.items.length - 1)) % sg.items.length;
			Array.from(sg.el.children).forEach((c, j) => c.toggleClass("is-selected", j === sg.i));
			return true;
		}
		if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); this.acceptSuggest(input); return true; }
		if (e.key === "Escape") { e.preventDefault(); this.hideSuggest(); return true; }
		return false;
	}
	private acceptSuggest(input: HTMLInputElement) {
		const sg = this.suggest; if (!sg) return;
		const caret = input.selectionStart ?? input.value.length;
		const name = sg.items[sg.i];
		const hasParen = input.value[caret] === "(";
		input.setRangeText(name + (hasParen ? "" : "()"), sg.start, caret, "end");
		const pos = sg.start + name.length + 1;
		input.setSelectionRange(pos, pos);
		this.hideSuggest();
		if (input !== this.fbar) this.fbar.value = input.value;
		input.focus();
	}
	private hideSuggest() { this.suggest?.el.remove(); this.suggest = null; }

	// ---------- maths helpers ----------
	private insertFormula(snippet: string, input?: HTMLInputElement) {
		if (!this.editor) this.startEdit(snippet === "^" ? undefined : "=");
		const inp = input ?? this.editor!.input;
		insertInField(inp, snippet, "plain");
		if (inp !== this.fbar) this.fbar.value = inp.value;
	}
	private mathTool(id: string, input?: HTMLInputElement) {
		const map: Record<string, string> = { power: "^", sqrt: "SQRT(¦)", sum: "SUM(¦)", fraction: "(¦)/()", "inline-math": "", subscript: "" };
		if (id === "sum" && !this.editor) { this.autoSum(); return; }
		if (id === "math-palette" || id === "greek") { this.functionMenu(null); return; }
		const s = map[id];
		if (s) this.insertFormula(s, input);
	}

	private autoSum() {
		this.commitEdit();
		const { r, c } = this.sel;
		let top = r - 1;
		while (top >= 0 && typeof this.book!.value(this.sheet, addr(top, c)) === "number") top--;
		const formula = top < r - 1 ? `=SUM(${addr(top + 1, c)}:${addr(r - 1, c)})` : "=SUM()";
		this.startEdit(formula);
		if (formula === "=SUM()") this.editor!.input.setSelectionRange(5, 5);
	}

	private functionMenu(e: MouseEvent | null) {
		new FunctionPicker(this.app, (name) => this.insertFormula(name + "(¦)")).open();
	}

	// ---------- clipboard ----------
	private selectionTSV(markdown: boolean): string {
		const { r1, r2, c1, c2 } = this.range();
		const rows: string[][] = [];
		for (let r = r1; r <= r2; r++) {
			const row: string[] = [];
			for (let c = c1; c <= c2; c++) row.push(markdown ? display(this.book!.value(this.sheet, addr(r, c))).replace(/\|/g, "\\|") : this.sheet.raw.get(addr(r, c)) ?? "");
			rows.push(row);
		}
		if (!markdown) return rows.map((r) => r.join("\t")).join("\n");
		const head = rows[0], rest = rows.slice(1);
		return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rest.map((r) => `| ${r.join(" | ")} |`)].join("\n");
	}
	private async copyMarkdown() {
		const { r1, r2, c1, c2 } = this.range();
		if (r1 === r2 && c1 === c2) {
			// whole used area
			let mr = 0, mc = 0; for (const k of this.sheet.raw.keys()) { const p = parseAddr(k)!; mr = Math.max(mr, p.r); mc = Math.max(mc, p.c); }
			this.anchor = { r: 0, c: 0 }; this.sel = { r: mr, c: mc }; this.drawSel();
		}
		await navigator.clipboard.writeText(this.selectionTSV(true));
		new Notice("Copied as a Markdown table — paste it into any note.");
	}
	private paste(text: string) {
		if (!text) return;
		const rows = text.replace(/\r/g, "").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
		this.pushUndo();
		rows.forEach((row, i) => row.forEach((v, j) => this.setCell(this.sel.r + i, this.sel.c + j, v, false)));
		this.anchor = { ...this.sel };
		this.sel = { r: this.sel.r + rows.length - 1, c: this.sel.c + Math.max(...rows.map((r) => r.length)) - 1 };
		this.changed(true);
	}

	private tabMenu(i: number, e: MouseEvent | null) {
		const m = new Menu();
		m.addItem((it) => it.setTitle("Rename").setIcon("pencil").onClick(() => new RenameModal(this.app, this.book!.sheets[i].name, (name) => {
			if (!name || this.book!.sheets.some((s, j) => j !== i && s.name.toLowerCase() === name.toLowerCase())) { new Notice("That name is taken."); return; }
			const old = this.book!.sheets[i].name;
			this.book!.sheets[i].name = name;
			if (this.book!.wb.Sheets[old]) { this.book!.wb.Sheets[name] = this.book!.wb.Sheets[old]; delete this.book!.wb.Sheets[old]; }
			this.changed(true);
		}).open()));
		m.addItem((it) => it.setTitle("Delete sheet").setIcon("trash-2").setDisabled(this.book!.sheets.length < 2).onClick(() => {
			this.book!.sheets.splice(i, 1); this.active = Math.max(0, this.active - (i <= this.active ? 1 : 0)); this.changed(true);
		}));
		if (e) m.showAtMouseEvent(e);
		else { const r = this.tabsEl.children[i].getBoundingClientRect(); m.showAtPosition({ x: r.left, y: r.top }); }
	}
}

class RenameModal extends Modal {
	constructor(app: App, private value: string, private done: (v: string) => void) { super(app); }
	onOpen() {
		this.titleEl.setText("Rename sheet");
		new Setting(this.contentEl).addText((t) => {
			t.setValue(this.value).onChange((v) => (this.value = v.trim()));
			t.inputEl.onkeydown = (e) => { if (e.key === "Enter") { this.close(); this.done(this.value); } };
			setTimeout(() => t.inputEl.select(), 30);
		}).addButton((b) => b.setButtonText("Save").setCta().onClick(() => { this.close(); this.done(this.value); }));
	}
}

class FunctionPicker extends Modal {
	constructor(app: App, private pick: (name: string) => void) { super(app); }
	onOpen() {
		this.titleEl.setText("Insert a function");
		const search = this.contentEl.createEl("input", { type: "search", cls: "ms-palette-search", attr: { placeholder: "Search functions (power, root, average…)" } });
		const list = this.contentEl.createDiv("ms-fn-list");
		const draw = () => {
			list.empty();
			const q = search.value.toLowerCase();
			Object.entries(FUNCTIONS).filter(([n, f]) => !q || n.toLowerCase().includes(q) || f.help.toLowerCase().includes(q)).forEach(([n, f]) => {
				const row = list.createEl("button", { cls: "ms-fn-row" });
				row.createSpan({ cls: "ms-fn-name", text: n });
				row.createSpan({ cls: "ms-fn-help", text: f.help });
				row.onclick = () => { this.close(); this.pick(n); };
			});
		};
		search.oninput = draw;
		search.onkeydown = (e) => { if (e.key === "Enter") (list.querySelector("button") as HTMLButtonElement | null)?.click(); };
		draw();
		if (!Platform.isMobile) search.focus();
	}
	onClose() { this.contentEl.empty(); }
}

/** Read-only preview of a spreadsheet, used when a .xlsx is embedded in a note. */
export async function sheetEmbed(plugin: BitsAndBobs, container: HTMLElement, file: TFile, parent: Component) {
	container.addClass("ms-embed", "ms-sheet-embed");
	const render = async () => {
		container.empty();
		const book = new Workbook(await plugin.app.vault.readBinary(file));
		const s = book.sheets[0];
		let mr = 0, mc = 0; for (const k of s.raw.keys()) { const p = parseAddr(k)!; mr = Math.max(mr, p.r); mc = Math.max(mc, p.c); }
		const bar = container.createDiv("ms-embed-bar");
		bar.createSpan({ text: `${file.basename} · ${s.name}` });
		const open = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open spreadsheet" } });
		setIcon(open, "maximize-2");
		open.onclick = () => plugin.app.workspace.getLeaf("tab").openFile(file);
		const t = container.createDiv("ms-grid-wrap").createEl("table", { cls: "ms-grid" });
		const head = t.createTHead().insertRow(); head.createEl("th");
		for (let c = 0; c <= Math.min(mc, 25); c++) head.createEl("th", { text: colName(c) });
		const body = t.createTBody();
		for (let r = 0; r <= Math.min(mr, 49); r++) {
			const tr = body.insertRow(); tr.createEl("th", { text: String(r + 1) });
			for (let c = 0; c <= Math.min(mc, 25); c++) { const v = book.value(s, addr(r, c)); const td = tr.insertCell(); td.setText(display(v)); td.toggleClass("is-num", typeof v === "number"); }
		}
	};
	parent.registerEvent(plugin.app.vault.on("modify", (f) => { if (f === file) render(); }));
	await render();
}
