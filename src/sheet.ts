import { FileView, Menu, Modal, Notice, Platform, Setting, TFile, WorkspaceLeaf, setIcon, App, Component } from "obsidian";
import * as XLSX from "xlsx";
import type BitsAndBobs from "./main";
import { FErr, FUNCTIONS, V, addr, colName, parse, parseAddr, run } from "./formula";
import { insertInField, matchTool } from "./math";
import { CellFmt, ChartDef, ChartType, FILL_COLOURS, META_SHEET, NUMBER_FORMATS, TEXT_COLOURS, cleanFmt, displayValue, planFill, readMeta, shiftFormula, writeMeta, MetaPayload } from "./sheetmeta";
import { chartData, parseRange, renderChart, ChartTheme } from "./charts";

export const VIEW_SHEET = "math-studio-sheet";
export const EXT_SHEET = "xlsx";

interface SheetModel { name: string; raw: Map<string, string>; rows: number; cols: number; rowH: Map<number, number>; colW: Map<number, number>; fmt: Map<string, CellFmt>; charts: ChartDef[] }
export const newSheetModel = (name: string): SheetModel => ({ name, raw: new Map(), rows: MIN_ROWS, cols: MIN_COLS, rowH: new Map(), colW: new Map(), fmt: new Map(), charts: [] });

export const ROW_H = 28, COL_W = 96, MIN_ROWS = 200, MIN_COLS = 52;

/** Loads an .xlsx into simple models and computes formulas. */
export class Workbook {
	wb: XLSX.WorkBook;
	sheets: SheetModel[] = [];
	private cache = new Map<string, V>();
	private visiting = new Set<string>();

	constructor(data: ArrayBuffer | null) {
		this.wb = data && data.byteLength ? XLSX.read(new Uint8Array(data), { type: "array", cellFormula: true, cellDates: true, cellNF: true, cellStyles: true }) : XLSX.utils.book_new();
		if (!this.wb.SheetNames.length) XLSX.utils.book_append_sheet(this.wb, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
		const meta = readMeta(this.wb);
		if (!this.wb.SheetNames.length) XLSX.utils.book_append_sheet(this.wb, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
		for (const name of this.wb.SheetNames) {
			const ws = this.wb.Sheets[name];
			const raw = new Map<string, string>();
				const fmt = new Map<string, CellFmt>();
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
					if (c.t === "n" && c.z && c.z !== "General") fmt.set(key, { nf: String(c.z) });
					const p = parseAddr(key)!;
				rows = Math.max(rows, p.r + 1); cols = Math.max(cols, p.c + 1);
			}
			const rowH = new Map<number, number>(), colW = new Map<number, number>();
			(ws["!rows"] ?? []).forEach((r, i) => { const h = r?.hpx ?? (r?.hpt ? r.hpt * 96 / 72 : 0); if (h && !r.hidden) rowH.set(i, Math.round(h)); });
			(ws["!cols"] ?? []).forEach((c, i) => { const w = c?.wpx ?? (c?.wch ? c.wch * 7 + 5 : 0); if (w && !c.hidden) colW.set(i, Math.round(w)); });
			const saved = meta?.sheets[name];
				if (saved?.fmt) for (const [ref, f] of Object.entries(saved.fmt)) fmt.set(ref, f);
				this.sheets.push({ name, raw, rows: Math.max(rows + 5, MIN_ROWS), cols: Math.max(cols + 2, MIN_COLS), rowH, colW, fmt, charts: saved?.charts ?? [] });
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
					const nf = s.fmt.get(ref)?.nf;
						ws[ref] = v instanceof FErr ? { t: "s", f: raw.slice(1), v: v.code }
							: typeof v === "number" ? { t: "n", f: raw.slice(1), v, ...(nf ? { z: nf } : {}) } : typeof v === "boolean" ? { t: "b", f: raw.slice(1), v } : { t: "s", f: raw.slice(1), v: String(v) };
				} else {
					const v = this.value(s, ref);
					const nf = s.fmt.get(ref)?.nf;
						ws[ref] = typeof v === "number" ? { t: "n", v, ...(nf ? { z: nf } : {}) } : typeof v === "boolean" ? { t: "b", v } : { t: "s", v: raw };
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
		// colours, bold, alignment and charts live on a hidden sheet (Excel files can't hold them through this plugin)
		const payload: MetaPayload = { v: 1, sheets: {} };
		for (const s of this.sheets) {
			const fmt: Record<string, CellFmt> = {};
			for (const [ref, f] of s.fmt) { const c = cleanFmt(f); if (c) fmt[ref] = c; }
			if (Object.keys(fmt).length || s.charts.length) payload.sheets[s.name] = { ...(Object.keys(fmt).length ? { fmt } : {}), ...(s.charts.length ? { charts: s.charts } : {}) };
		}
		writeMeta(this.wb, payload);
		const out = XLSX.write(this.wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
		return out;
	}
}

export function emptyXlsx(): ArrayBuffer {
	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
	return XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

export function display(v: V, nf?: string): string {
	return displayValue(v, nf);
}

function displayLegacy(v: V): string {
	if (v instanceof FErr) return v.code;
	if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
	if (typeof v === "number") {
		if (Number.isInteger(v)) return String(v);
		const s = Math.abs(v) >= 1e12 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(6) : String(Math.round(v * 1e10) / 1e10);
		return s;
	}
	return v;
}

interface Snap { sheet: number; raw: [string, string][]; fmt: [string, CellFmt][]; charts: string }

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
	private undoStack: Snap[] = [];
	private redoStack: Snap[] = [];
	private chartsOpen = false;
	private chartsPane?: HTMLElement;
	private chartHosts = new Map<string, HTMLElement>();
	private fillHandle?: HTMLElement;
	private fillDrag: { target: { r1: number; r2: number; c1: number; c2: number }; dir: "down" | "up" | "left" | "right"; count: number } | null = null;

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
	private snap(sheetIndex = this.active): Snap {
		const s = this.book!.sheets[sheetIndex];
		return { sheet: sheetIndex, raw: [...s.raw], fmt: [...s.fmt], charts: JSON.stringify(s.charts) };
	}
	private pushUndo() {
		this.undoStack.push(this.snap());
		if (this.undoStack.length > 100) this.undoStack.shift();
		this.redoStack = [];
	}
	undo() { this.commitEdit(); this.restore(this.undoStack, this.redoStack); }
	redo() { this.commitEdit(); this.restore(this.redoStack, this.undoStack); }
	private restore(from: typeof this.undoStack, to: typeof this.undoStack) {
		const s = from.pop(); if (!s || !this.book) return;
		to.push(this.snap(s.sheet));
		const sh = this.book.sheets[s.sheet];
		sh.raw = new Map(s.raw); sh.fmt = new Map(s.fmt); sh.charts = JSON.parse(s.charts);
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
		btn("rows-3", "Add 50 rows", () => { this.sheet.rows += 50; this.build(); });
		btn("columns-3", "Add 10 columns", () => { this.sheet.cols += 10; this.build(); });
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
		if (st.sheetFormat) {
			tb.createSpan("ms-tb-sep");
			const bold = btn("bold", "Bold", () => this.applyFmt((f, on) => { if (on) f.b = 1; else delete f.b; }, (f) => !!f.b));
			const ital = btn("italic", "Italic", () => this.applyFmt((f, on) => { if (on) f.i = 1; else delete f.i; }, (f) => !!f.i));
			btn("baseline", "Text colour", (e) => this.colourPopup(e.currentTarget as HTMLElement, TEXT_COLOURS, (col) => this.applyFmt((f) => { if (col) f.c = col; else delete f.c; })));
			btn("paint-bucket", "Fill colour", (e) => this.colourPopup(e.currentTarget as HTMLElement, FILL_COLOURS, (col) => this.applyFmt((f) => { if (col) f.bg = col; else delete f.bg; })));
			for (const [al, icon, label] of [["l", "align-left", "Align left"], ["c", "align-center", "Centre"], ["r", "align-right", "Align right"]] as const) {
				btn(icon, label, () => this.applyFmt((f, on) => { if (on) f.al = al; else delete f.al; }, (f) => f.al === al));
			}
			btn("hash", "Number format", (e) => this.numberFormatMenu(e), "123");
			btn("eraser", "Clear formatting", () => this.applyFmt((f) => { for (const k of Object.keys(f)) delete (f as any)[k]; }));
			void bold; void ital;
		}
		if (st.sheetCharts) {
			tb.createSpan("ms-tb-sep");
			btn("bar-chart-3", "Make a chart from the selected cells", (e) => this.chartMenu(e), "Chart");
			const count = this.sheet.charts.length;
			const cb = btn("panel-right", "Show or hide charts", () => { this.chartsOpen = !this.chartsOpen; this.syncChartsPane(); cb.toggleClass("is-active", this.chartsOpen); }, count ? `Charts (${count})` : "Charts");
			cb.toggleClass("is-active", this.chartsOpen);
		}

		const fb = c.createDiv("ms-formula-bar");
		this.refLabel = fb.createDiv("ms-ref-label");
		fb.createSpan({ cls: "ms-fx", text: "fx" });
		this.fbar = fb.createEl("input", { type: "text", cls: "ms-fbar", attr: { placeholder: "Type a value or a formula like =A1^2 + B1" } });
		this.applyTyping(this.fbar);
		this.fbar.onfocus = () => { if (!this.editor) this.startEdit(undefined, true); };
		this.fbar.oninput = () => { if (this.editor && this.editor.input !== this.fbar) this.editor.input.value = this.fbar.value; this.updateSuggest(this.fbar); };
		this.fbar.onkeydown = (e) => this.editKey(e, this.fbar);

		const main = c.createDiv("ms-sheet-main");
		this.gridWrap = main.createDiv("ms-grid-wrap");
		this.gridWrap.tabIndex = 0;
		this.chartsPane = main.createDiv("ms-charts");
		this.fillHandle = undefined;
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
			this.book!.sheets.push(newSheetModel("Sheet" + n));
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
		this.buildChartPane();
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
				this.positionFill();
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
				const ref = addr(r, c);
				const f = s.fmt.get(ref);
				td.setText(displayValue(v, f?.nf));
				td.toggleClass("is-num", typeof v === "number");
				td.toggleClass("is-err", v instanceof FErr);
				td.toggleClass("is-formula", !!s.raw.get(ref)?.startsWith("="));
				const css: string[] = [];
				if (f) {
					if (f.b) css.push("font-weight:700");
					if (f.i) css.push("font-style:italic");
					if (f.c) css.push(`color:${f.c}`);
					if (f.bg) { css.push(`background:${f.bg}`); if (!f.c) css.push("color:#1e1e1e"); }
					if (f.al) css.push(`text-align:${f.al === "l" ? "left" : f.al === "c" ? "center" : "right"}`);
				}
				td.style.cssText = css.join(";");
			}
		}
		this.drawCharts();
	}

	// ---------- formatting ----------
	private fmtAt(r: number, c: number): CellFmt { return this.sheet.fmt.get(addr(r, c)) ?? {}; }

	/** Change the formatting of every selected cell. For on/off buttons, `isOn` says whether the cursor cell already has it. */
	private applyFmt(change: (f: CellFmt, on: boolean) => void, isOn?: (f: CellFmt) => boolean) {
		this.commitEdit();
		const { r1, r2, c1, c2 } = this.range();
		const on = isOn ? !isOn(this.fmtAt(this.sel.r, this.sel.c)) : true;
		this.pushUndo();
		for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
			const ref = addr(r, c);
			const f: CellFmt = { ...(this.sheet.fmt.get(ref) ?? {}) };
			change(f, on);
			const clean = cleanFmt(f);
			if (clean) this.sheet.fmt.set(ref, clean); else this.sheet.fmt.delete(ref);
		}
		this.changed();
		this.drawSel();
	}

	private colourPopup(anchor: HTMLElement, palette: string[], pick: (c: string) => void) {
		this.contentEl.querySelector(".ms-colour-pop")?.remove();
		const pop = this.contentEl.createDiv("ms-colour-pop");
		const r = anchor.getBoundingClientRect(), host = this.contentEl.getBoundingClientRect();
		pop.style.left = Math.max(4, r.left - host.left) + "px";
		pop.style.top = r.bottom - host.top + 4 + "px";
		for (const col of palette) {
			const b = pop.createEl("button", { cls: "ms-colour-sw" + (col ? "" : " is-none"), attr: { "aria-label": col || "Automatic (no colour)" } });
			if (col) b.style.background = col;
			b.onclick = () => { pop.remove(); pick(col); };
		}
		const close = (e: PointerEvent) => { if (!pop.contains(e.target as Node)) { pop.remove(); document.removeEventListener("pointerdown", close, true); } };
		window.setTimeout(() => document.addEventListener("pointerdown", close, true), 0);
	}

	private numberFormatMenu(e: MouseEvent) {
		const m = new Menu();
		const cur = this.fmtAt(this.sel.r, this.sel.c).nf ?? "";
		for (const f of NUMBER_FORMATS) m.addItem((it) => it.setTitle(f.label).setChecked(cur === f.nf).onClick(() => this.applyFmt((x) => { if (f.nf) x.nf = f.nf; else delete x.nf; })));
		m.showAtMouseEvent(e);
	}

	// ---------- drag to fill ----------
	private positionFill() {
		if (!this.plugin.settings.sheetFill) { this.fillHandle?.remove(); this.fillHandle = undefined; return; }
		const { r2, c2 } = this.range();
		const td = this.table.tBodies[0].rows[r2]?.cells[c2 + 1];
		if (!td || this.editor) { this.fillHandle?.addClass("is-hidden"); return; }
		if (!this.fillHandle) {
			const h = (this.fillHandle = this.gridWrap.createDiv({ cls: "ms-fill-handle", attr: { "aria-label": "Drag to fill" } }));
			h.addEventListener("pointerdown", (e) => this.startFill(e));
		}
		this.fillHandle.removeClass("is-hidden");
		const t = td.getBoundingClientRect(), w = this.gridWrap.getBoundingClientRect();
		this.fillHandle.style.left = t.right - w.left + this.gridWrap.scrollLeft - 6 + "px";
		this.fillHandle.style.top = t.bottom - w.top + this.gridWrap.scrollTop - 6 + "px";
	}

	private startFill(e: PointerEvent) {
		e.preventDefault(); e.stopPropagation();
		this.commitEdit();
		const h = this.fillHandle!;
		try { h.setPointerCapture(e.pointerId); } catch { /* not a live pointer */ }
		const src = this.range();
		const clearPreview = () => this.table.querySelectorAll(".is-fill-preview").forEach((x) => x.removeClass("is-fill-preview"));
		const move = (ev: PointerEvent) => {
			const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
			const td = el?.closest("td") as HTMLElement | null;
			if (!td) return;
			const tr = +td.dataset.r!, tc = +td.dataset.c!;
			const dr = tr > src.r2 ? tr - src.r2 : tr < src.r1 ? tr - src.r1 : 0;
			const dc = tc > src.c2 ? tc - src.c2 : tc < src.c1 ? tc - src.c1 : 0;
			clearPreview();
			if (!dr && !dc) { this.fillDrag = null; return; }
			let dir: "down" | "up" | "left" | "right", count: number, target: { r1: number; r2: number; c1: number; c2: number };
			if (Math.abs(dr) >= Math.abs(dc)) {
				dir = dr > 0 ? "down" : "up"; count = Math.abs(dr);
				target = dr > 0 ? { r1: src.r2 + 1, r2: src.r2 + dr, c1: src.c1, c2: src.c2 } : { r1: src.r1 + dr, r2: src.r1 - 1, c1: src.c1, c2: src.c2 };
			} else {
				dir = dc > 0 ? "right" : "left"; count = Math.abs(dc);
				target = dc > 0 ? { r1: src.r1, r2: src.r2, c1: src.c2 + 1, c2: src.c2 + dc } : { r1: src.r1, r2: src.r2, c1: src.c1 + dc, c2: src.c1 - 1 };
			}
			this.fillDrag = { target, dir, count };
			const body = this.table.tBodies[0];
			for (let r = target.r1; r <= target.r2; r++) for (let c = target.c1; c <= target.c2; c++) body.rows[r]?.cells[c + 1]?.addClass("is-fill-preview");
		};
		const up = () => {
			h.removeEventListener("pointermove", move); h.removeEventListener("pointerup", up); h.removeEventListener("pointercancel", up);
			clearPreview();
			const d = this.fillDrag; this.fillDrag = null;
			if (d) this.doFill(src, d.dir, d.count);
		};
		h.addEventListener("pointermove", move); h.addEventListener("pointerup", up); h.addEventListener("pointercancel", up);
	}

	/** Continue what's in the selected cells into `count` more cells (numbers count on, "Item 1" counts on, formulas copy with their references moved). */
	private doFill(src: { r1: number; r2: number; c1: number; c2: number }, dir: "down" | "up" | "left" | "right", count: number) {
		const s = this.sheet;
		this.pushUndo();
		const vertical = dir === "down" || dir === "up";
		const back = dir === "up" || dir === "left";
		const lines = vertical ? src.c2 - src.c1 + 1 : src.r2 - src.r1 + 1;
		const len = vertical ? src.r2 - src.r1 + 1 : src.c2 - src.c1 + 1;
		const at = (line: number, i: number) => vertical ? { r: src.r1 + i, c: src.c1 + line } : { r: src.r1 + line, c: src.c1 + i };
		for (let line = 0; line < lines; line++) {
			const refs = Array.from({ length: len }, (_, i) => { const p = at(line, i); return addr(p.r, p.c); });
			const raws = refs.map((ref) => s.raw.get(ref) ?? "");
			const plan = planFill(raws, count, back);
			plan.forEach((step, k) => {
				const i = back ? -1 - k : len + k;
				const p = at(line, i);
				if (p.r < 0 || p.c < 0) return;
				let raw: string, from: number;
				if (step.raw !== undefined) { raw = step.raw; from = back ? 0 : len - 1; }
				else { from = step.from!; const sr = raws[from]; raw = sr.startsWith("=") ? shiftFormula(sr, vertical ? step.shift! : 0, vertical ? 0 : step.shift!) : sr; }
				this.setCell(p.r, p.c, raw, false);
				const f = s.fmt.get(refs[from]);
				if (f) s.fmt.set(addr(p.r, p.c), { ...f }); else s.fmt.delete(addr(p.r, p.c));
			});
		}
		const last = back ? (vertical ? { r1: src.r1 - count, r2: src.r2, c1: src.c1, c2: src.c2 } : { r1: src.r1, r2: src.r2, c1: src.c1 - count, c2: src.c2 }) : (vertical ? { r1: src.r1, r2: src.r2 + count, c1: src.c1, c2: src.c2 } : { r1: src.r1, r2: src.r2, c1: src.c1, c2: src.c2 + count });
		this.anchor = { r: Math.max(0, last.r1), c: Math.max(0, last.c1) };
		this.sel = { r: last.r2, c: last.c2 };
		this.changed(true);
	}

	// ---------- charts ----------
	private chartTheme(): ChartTheme {
		const cs = getComputedStyle(document.body);
		const get = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
		return { fg: get("--text-normal", "#222"), muted: get("--text-muted", "#777"), grid: get("--background-modifier-border", "#ddd"), bg: get("--background-primary", "#fff") };
	}

	private gridValues(range: string): V[][] | null {
		const p = parseRange(range);
		if (!p) return null;
		const out: V[][] = [];
		for (let r = p.r1; r <= p.r2; r++) { const row: V[] = []; for (let c = p.c1; c <= p.c2; c++) row.push(this.book!.value(this.sheet, addr(r, c))); out.push(row); }
		return out;
	}

	/** The block of filled-in cells around a cell, like Excel's "current region". */
	private currentRegion(r: number, c: number) {
		const s = this.sheet;
		const has = (rr: number, cc: number) => rr >= 0 && cc >= 0 && (s.raw.get(addr(rr, cc)) ?? "") !== "";
		let start = has(r, c) ? { r, c } : null;
		if (!start) for (const [dr, dc] of [[-1, 0], [0, -1], [1, 0], [0, 1]]) if (has(r + dr, c + dc)) { start = { r: r + dr, c: c + dc }; break; }
		if (!start) return null;
		let r1 = start.r, r2 = start.r, c1 = start.c, c2 = start.c, grew = true;
		const any = (ra: number, rb: number, ca: number, cb: number) => { for (let i = ra; i <= rb; i++) for (let j = ca; j <= cb; j++) if (has(i, j)) return true; return false; };
		while (grew) {
			grew = false;
			if (any(r1 - 1, r1 - 1, c1 - 1, c2 + 1)) { r1--; grew = true; }
			if (any(r2 + 1, r2 + 1, c1 - 1, c2 + 1)) { r2++; grew = true; }
			if (any(r1 - 1, r2 + 1, c1 - 1, c1 - 1)) { c1--; grew = true; }
			if (any(r1 - 1, r2 + 1, c2 + 1, c2 + 1)) { c2++; grew = true; }
			r1 = Math.max(0, r1); c1 = Math.max(0, c1);
		}
		return { r1, r2, c1, c2 };
	}

	private chartMenu(e: MouseEvent) {
		const m = new Menu();
		const types: [ChartType, string, string][] = [["bar", "Bar chart", "bar-chart-3"], ["line", "Line chart", "line-chart"], ["pie", "Pie chart", "pie-chart"], ["scatter", "Scatter (x and y numbers)", "scatter-chart"]];
		for (const [t, label, icon] of types) m.addItem((it) => it.setTitle(label).setIcon(icon).onClick(() => this.createChart(t)));
		m.showAtMouseEvent(e);
	}

	private createChart(type: ChartType) {
		this.commitEdit();
		const sel = this.range();
		const one = sel.r1 === sel.r2 && sel.c1 === sel.c2;
		const reg = one ? this.currentRegion(sel.r1, sel.c1) : sel;
		if (!reg) { new Notice("Type some numbers in cells first, then select them and press Chart."); return; }
		this.pushUndo();
		const def: ChartDef = { id: Math.random().toString(36).slice(2, 9), type, title: `Chart ${this.sheet.charts.length + 1}`, range: `${addr(reg.r1, reg.c1)}:${addr(reg.r2, reg.c2)}` };
		this.sheet.charts.push(def);
		this.chartsOpen = true;
		this.changed(true);
	}

	private syncChartsPane() { this.chartsPane?.toggleClass("is-open", this.chartsOpen); }

	private buildChartPane() {
		const pane = this.chartsPane;
		if (!pane) return;
		pane.empty(); this.chartHosts.clear();
		this.syncChartsPane();
		const s = this.sheet;
		if (!this.plugin.settings.sheetCharts) return;
		if (!s.charts.length) {
			pane.createDiv({ cls: "ms-charts-empty", text: "No charts yet. Select some cells and press Chart." });
			return;
		}
		for (const def of s.charts) {
			const card = pane.createDiv("ms-chart-card");
			const head = card.createDiv("ms-chart-head");
			const title = head.createEl("input", { type: "text", cls: "ms-chart-title", attr: { placeholder: "Chart title" } });
			title.value = def.title;
			title.oninput = () => { def.title = title.value; this.drawCharts(); this.scheduleSave(); };
			const type = head.createEl("select", { cls: "dropdown ms-chart-type" });
			for (const [v, l] of [["bar", "Bar"], ["line", "Line"], ["pie", "Pie"], ["scatter", "Scatter"]]) type.createEl("option", { value: v, text: l });
			type.value = def.type;
			type.onchange = () => { this.pushUndo(); def.type = type.value as ChartType; this.drawCharts(); this.scheduleSave(); };
			const row = card.createDiv("ms-chart-row");
			row.createSpan({ text: "Cells" });
			const range = row.createEl("input", { type: "text", cls: "ms-chart-range" });
			range.value = def.range;
			range.onchange = () => {
				const p = parseRange(range.value);
				if (!p) { new Notice("Use cells like A1:C6."); range.value = def.range; return; }
				this.pushUndo(); def.range = `${addr(p.r1, p.c1)}:${addr(p.r2, p.c2)}`; range.value = def.range; this.drawCharts(); this.scheduleSave();
			};
			const pick = row.createEl("button", { cls: "ms-chart-btn", attr: { "aria-label": "Use the cells I have selected" }, text: "Use selection" });
			pick.onclick = () => { const r = this.range(); this.pushUndo(); def.range = `${addr(r.r1, r.c1)}:${addr(r.r2, r.c2)}`; range.value = def.range; this.drawCharts(); this.scheduleSave(); };
			const save = row.createEl("button", { cls: "ms-chart-btn clickable-icon", attr: { "aria-label": "Save as an image in your vault" } });
			setIcon(save, "image-down");
			save.onclick = () => this.saveChartImage(def);
			const del = row.createEl("button", { cls: "ms-chart-btn clickable-icon", attr: { "aria-label": "Delete chart" } });
			setIcon(del, "trash-2");
			del.onclick = () => { this.pushUndo(); s.charts = s.charts.filter((c) => c.id !== def.id); this.changed(true); };
			this.chartHosts.set(def.id, card.createDiv("ms-chart-svg"));
		}
		this.drawCharts();
	}

	/** Redraw every chart's picture from the current cell values. */
	private drawCharts() {
		if (!this.chartsPane || !this.plugin.settings.sheetCharts) return;
		const theme = this.chartTheme();
		for (const def of this.sheet.charts) {
			const host = this.chartHosts.get(def.id);
			if (!host) continue;
			host.empty();
			const grid = this.gridValues(def.range);
			if (!grid) { host.setText("Can't read those cells."); continue; }
			host.appendChild(renderChart(def, chartData(grid, def.type), theme));
		}
	}

	private async saveChartImage(def: ChartDef) {
		const grid = this.gridValues(def.range);
		if (!grid || !this.file) return;
		try {
			const svg = renderChart(def, chartData(grid, def.type), { fg: "#1e1e1e", muted: "#666666", grid: "#e3e3e3", bg: "#ffffff" }, 800, 520);
			const xml = new XMLSerializer().serializeToString(svg);
			const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml); });
			const c = createEl("canvas"); c.width = 1600; c.height = 1040;
			c.getContext("2d")!.drawImage(img, 0, 0, 1600, 1040);
			const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
			if (!blob) throw new Error("no image");
			const name = (def.title || "Chart").replace(/[\\/:*?"<>|#^\[\]]/g, "").trim() || "Chart";
			const path = await this.app.fileManager.getAvailablePathForAttachment(`${name}.png`, this.file.path);
			const file = await this.app.vault.createBinary(path, await blob.arrayBuffer());
			try { await navigator.clipboard.writeText(`![[${file.path}]]`); } catch { /* clipboard not available */ }
			new Notice(`Saved ${file.name}. A link is on your clipboard, and you can add it to a note, board or slide as an image.`);
		} catch (e) {
			console.error(e);
			new Notice("Couldn't save that chart as an image.");
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
		this.positionFill();
	}

	private move(dr: number, dc: number, extend = false) {
		const s = this.sheet;
		this.sel = { r: Math.max(0, Math.min(s.rows - 1, this.sel.r + dr)), c: Math.max(0, Math.min(s.cols - 1, this.sel.c + dc)) };
		if (!extend) this.anchor = { ...this.sel };
		// moving to the last row or column adds more, so the sheet never runs out
		const grow = this.sel.r >= s.rows - 1 || this.sel.c >= s.cols - 1;
		if (this.sel.r >= s.rows - 1) s.rows += 20;
		if (this.sel.c >= s.cols - 1) s.cols += 10;
		if (grow) { this.build(); return; }
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
		this.fillHandle?.addClass("is-hidden");
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
