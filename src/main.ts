import { Component, Editor, EditorPosition, ItemView, MarkdownView, Notice, Platform, Plugin, TFile, TFolder, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import { BoardView, SlidesView, VIEW_BOARD, VIEW_SLIDES, EXT_BOARD, EXT_SLIDES, boardEmbed, newSlide, parseDeck } from "./views";
import { SheetView, VIEW_SHEET, EXT_SHEET, emptyXlsx, sheetEmbed } from "./sheet";
import { MATH_TOOLS, MathItem, MathPalette, MathSuggest, MathTool, insertInEditor, insertInField, insideMath, matchTool, setShortcutsEnabled, shortcutLabel } from "./math";
import { Board } from "./board";
import { BitsSettings, BitsSettingTab, DEFAULT_SETTINGS } from "./settings";
import { SuperTyper } from "./superscript";
import { operatorFor, piBlocked, rewriteTyping } from "./typing";
import { solveLine } from "./autosolve";
import { convertUnits } from "./units";
import { ghostExtension, setGhost } from "./ghost";
import { CanvasLike, EmbedFactory, VaultConfig, internal } from "./internal";
import { themeFor } from "./themes";
import type { EditorView } from "@codemirror/view";
import { SymbolsView, VIEW_SYMBOLS } from "./symbolsview";
import { fractionInEditor, fractionInField, fractionNewBox } from "./fraction";
import { openChartDialog, specToData } from "./chartdialog";
import { renderChart, svgToPng } from "./charts";
import { TagAllModal, syncFolderTags } from "./foldertags";
import { setupImageTools } from "./imagetools";
import { CiteView, VIEW_CITE } from "./cite";
import { CloudSync, DEFAULT_OD, DEFAULT_SYNC } from "./sync";
import { OneDrive } from "./onedrive";
import { DEFAULT_SOURCE, SourceLists, type SourceState } from "./sourcelists";
import { ShareModal, Shares } from "./share";
import { shareKind } from "./sharecapture";
import { PdfPicker, dropFolder, isPhoto, noPdfs, noteFromDroppedPdf, noteFromDroppedPhotos, noteFromPdf } from "./pdfnote";

/** Commands added to the iPad / iPhone bottom toolbar. */
const TOOLBAR_TOOLS = ["math-palette", "inline-math", "power", "fraction", "sqrt", "subscript", "greek"];

export default class BitsAndBobs extends Plugin {
	settings!: BitsSettings;
	cloud = new CloudSync(this);
	onedrive = new OneDrive(this);
	source = new SourceLists(this);
	shares = new Shares(this);
	private registeredExts: string[] = [];
	private statusItems: HTMLElement[] = [];
	private homeObserver: MutationObserver | null = null;
	private superTyper = new SuperTyper();
	/** the note or board you were last typing in (the symbols sidebar puts things there) */
	private lastTarget: WorkspaceLeaf | null = null;

	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<BitsSettings> | null);
		this.settings.sync = Object.assign({}, DEFAULT_SYNC, this.settings.sync);
		this.settings.sync.paths = [...this.settings.sync.paths];
		this.settings.sync.od = Object.assign({}, DEFAULT_OD, this.settings.sync.od);
		this.settings.shares = Array.isArray(this.settings.shares) ? this.settings.shares.map((l) => ({ ...l })) : [];
		this.settings.source = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SOURCE)) as SourceState, this.settings.source);
		const st = this.settings;
		setShortcutsEnabled(st.mathShortcuts);

		if (st.boards) {
			this.registerView(VIEW_BOARD, (leaf) => new BoardView(leaf, this));
			this.registerExtensions([EXT_BOARD], VIEW_BOARD);
			if (st.ribbon) this.addRibbonIcon("pen-tool", "New drawing board", () => this.createFile("board"));
			this.addCommand({ id: "new-board", name: "New drawing board", icon: "pen-tool", callback: () => this.createFile("board") });
			this.addCommand({
				id: "canvas-drawing", name: "Add a drawing card to this canvas", icon: "pen-tool",
				checkCallback: (check) => {
					const view = this.app.workspace.getActiveViewOfType(ItemView);
					if (!view || view.getViewType() !== "canvas") return false;
					if (!check) void this.addDrawingToCanvas(view);
					return true;
				},
			});
			this.addCommand({
				id: "insert-board", name: "Insert a new drawing into this note", icon: "pen-tool",
				editorCallback: async (editor, ctx) => {
					const f = await this.createFile("board", false, ctx.file?.parent?.path);
					if (f) editor.replaceSelection(`![[${f.path}]]\n`);
				},
			});
		}
		if (st.slides) {
			this.registerView(VIEW_SLIDES, (leaf) => new SlidesView(leaf, this));
			this.registerExtensions([EXT_SLIDES], VIEW_SLIDES);
			if (st.ribbon) this.addRibbonIcon("presentation", "New slides", () => this.createFile("slides"));
			this.addCommand({ id: "new-slides", name: "New slides", icon: "presentation", callback: () => this.createFile("slides") });
			this.addCommand({
				id: "present", name: "Present slides", icon: "play",
				checkCallback: (check) => {
					const v = this.app.workspace.getActiveViewOfType(SlidesView);
					if (!v) return false;
					if (!check) v.present(0);
					return true;
				},
			});
		}
		if (st.sheets) {
			this.registerView(VIEW_SHEET, (leaf) => new SheetView(leaf, this));
			try { this.registerExtensions([EXT_SHEET], VIEW_SHEET); }
			catch { new Notice("Bits and Bobs: another plugin already opens .xlsx files. Turn off Spreadsheets in settings to hide this message."); }
			if (st.ribbon) this.addRibbonIcon("sheet", "New spreadsheet", () => this.createFile("sheet"));
			this.addCommand({ id: "new-sheet", name: "New spreadsheet (.xlsx)", icon: "sheet", callback: () => this.createFile("sheet") });
		}

		// maths: commands (no default hotkeys — the shortcuts are handled below and can be turned off)
		for (const t of MATH_TOOLS) this.addMathCommand(t);
		this.registerEditorExtension(ghostExtension());
		if (st.symbolSearch) this.registerEditorSuggest(new MathSuggest(this.app));
		this.registerDomEvent(window, "keydown", (e) => this.onKey(e));
		// ⌘Z / ⇧⌘Z (Ctrl+Z / Ctrl+Y on Windows) whenever a board, deck or spreadsheet is the active tab
		this.registerDomEvent(window, "keydown", (e) => this.onUndoKey(e), { capture: true });
		// a chart you type the numbers into, put into a note as a picture
		this.addCommand({
			id: "insert-chart", name: "Insert a chart into this note", icon: "bar-chart-3",
			editorCallback: (editor, ctx) => {
				openChartDialog(this.app, null, async (spec) => {
					try {
						const W = 760, H = 500;
						const svg = renderChart({ type: spec.kind, title: spec.title }, specToData(spec), { fg: "#1e1e1e", muted: "#666666", grid: "#e3e3e3", bg: "#ffffff" }, W, H, { ymin: spec.ymin, ymax: spec.ymax, xLabel: spec.xLabel, yLabel: spec.yLabel });
						const name = (spec.title || "Chart").replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "Chart";
						const path = await this.app.fileManager.getAvailablePathForAttachment(`${name}.png`, ctx.file?.path ?? "");
						const file = await this.app.vault.createBinary(path, await svgToPng(svg, W, H));
						editor.replaceSelection(`![[${file.path}|480]]\n`);
					} catch (e) {
						console.error(e);
						new Notice("Couldn't make that chart.");
					}
				});
			},
		});
		// the symbols menu lives in the left sidebar
		this.registerView(VIEW_SYMBOLS, (leaf) => new SymbolsView(leaf, this));
		if (st.citeTool) {
			this.registerView(VIEW_CITE, (leaf) => new CiteView(leaf, this));
			if (st.ribbon) this.addRibbonIcon("quote", "Citations", () => { void this.openCitations(); });
			this.addCommand({ id: "open-citations", name: "Open citations", icon: "quote", callback: () => { void this.openCitations(); } });
		}
		this.addCommand({ id: "open-symbols", name: "Open the symbols menu", icon: "pi", callback: () => this.openSymbols(0) });
		this.registerEvent(this.app.workspace.on("active-leaf-change", (leaf) => this.trackTarget(leaf)));
		// type ^ for small raised numbers, and = to solve a sum
		this.registerDomEvent(activeDocument, "beforeinput", (e) => this.onBeforeInput(e), { capture: true });
		this.registerDomEvent(activeDocument, "keydown", (e) => this.onTypingKey(e), { capture: true });
		this.registerDomEvent(activeDocument, "pointerdown", () => this.superTyper.reset(), { capture: true });
		// pictures in notes: wrap text around them and drag them to move
		setupImageTools(this, () => this.settings.imageTools);
		// tags for the folders a note is in, kept up to date when notes are made or moved
		this.addCommand({ id: "tag-all-with-folders", name: "Tag all notes with their folders", icon: "tags", callback: () => new TagAllModal(this.app).open() });
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on("create", (f) => {
				if (this.settings.folderTags && f instanceof TFile && f.extension === "md") window.setTimeout(() => { void syncFolderTags(this.app, f).catch((e) => console.error(e)); }, 300);
			}));
			this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
				if (!this.settings.folderTags || !(f instanceof TFile) || f.extension !== "md") return;
				if (oldPath.split("/").slice(0, -1).join("/") === (f.parent?.path === "/" ? "" : f.parent?.path ?? "")) return; // renamed, not moved
				void syncFolderTags(this.app, f, oldPath).catch((e) => console.error(e));
			}));
		});
		// a PDF dropped onto the file list becomes a note
		this.registerDomEvent(activeDocument, "drop", (e) => this.onFileListDrop(e), { capture: true });
		this.addCommand({
			id: "note-from-pdf", name: "Make a note from a PDF", icon: "file-text",
			callback: () => { if (!noPdfs(this.app)) new PdfPicker(this.app, (f) => { void this.makePdfNote(f); }).open(); },
		});
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (!(file instanceof TFile) || file.extension.toLowerCase() !== "pdf" || !this.settings.pdfNotes) return;
			menu.addItem((i) => i.setTitle("Make a note from this PDF").setIcon("file-text").onClick(() => { void this.makePdfNote(file); }));
		}));
		this.addCommand({ id: "undo", name: "Undo on board, slide or spreadsheet", icon: "undo-2", checkCallback: (check) => this.undoRedo(false, check) });
		this.addCommand({ id: "redo", name: "Redo on board, slide or spreadsheet", icon: "redo-2", checkCallback: (check) => this.undoRedo(true, check) });

		this.app.workspace.onLayoutReady(() => {
			this.trackTarget(this.app.workspace.getMostRecentLeaf());
			this.setupStatusBar();
			if (Platform.isMobile && st.mobileToolbar && !st.mobileToolbarAdded) this.addToMobileToolbar(true);
			this.setupHomeButtons();
			this.applyBodyClasses();
			if (st.embeds) this.registerEmbeds();
		});

		this.addSettingTab(new BitsSettingTab(this.app, this));
		this.cloud.start();
		this.onedrive.start();
		this.source.start();
		this.shares.start();
		this.addCommand({
			id: "share-file", name: "Share this file as a link", icon: "share-2",
			checkCallback: (check) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || !shareKind(f)) return false;
				if (!check) this.openShare(f);
				return true;
			},
		});
		this.registerEvent(this.app.workspace.on("file-menu", (menu, f) => {
			if (!(f instanceof TFile) || !shareKind(f)) return;
			menu.addItem((i) => i.setTitle("Share as a link").setIcon("share-2").setSection("action").onClick(() => this.openShare(f)));
		}));
	}

	private onUndoKey(e: KeyboardEvent) {
		const mod = Platform.isMacOS || Platform.isIosApp ? e.metaKey : e.ctrlKey;
		if (!mod || e.altKey) return;
		const k = e.key.toLowerCase();
		const redo = (k === "z" && e.shiftKey) || (k === "y" && !e.shiftKey && !Platform.isMacOS);
		if (k !== "z" && !redo) return;
		// typing in a text box or cell keeps the normal text undo
		const a = activeDocument.activeElement;
		if (a?.instanceOf(HTMLTextAreaElement) || a?.instanceOf(HTMLInputElement) || (a?.instanceOf(HTMLElement) && a.isContentEditable)) return;
		if (a?.instanceOf(HTMLElement) && a.closest(".modal-container")) return;
		if (this.undoRedo(redo, false)) { e.preventDefault(); e.stopPropagation(); }
	}

	/** Undo or redo in the active board, slide deck or spreadsheet. Returns false if none is active. */
	private undoRedo(redo: boolean, check: boolean): boolean {
		const ws = this.app.workspace;
		const board = ws.getActiveViewOfType(BoardView)?.board ?? ws.getActiveViewOfType(SlidesView)?.board;
		const sheet = ws.getActiveViewOfType(SheetView);
		if (!board && !sheet) return false;
		if (check) return true;
		if (board) redo ? board.redo() : board.undo();
		else if (sheet) redo ? sheet.redo() : sheet.undo();
		return true;
	}

	/** Maths shortcuts in notes and text boxes (boards and spreadsheets handle their own first). */
	private onKey(e: KeyboardEvent) {
		const t = matchTool(e);
		if (!t) return;
		const target = e.target as HTMLElement | null;
		const inEditor = !!target?.closest?.(".cm-editor");
		if (!inEditor && !this.activeField()) return;
		e.preventDefault();
		this.runTool(t);
	}

	applyShortcuts(on: boolean) { setShortcutsEnabled(on); }

	applyBodyClasses() { activeDocument.body.toggleClass("bb-canvas-draw", this.settings.canvasDraw); }

	/** Re-load the plugin so feature switches take effect, then return to its settings. */
	async reload() {
		const { plugins, setting } = internal(this.app);
		const id = this.manifest.id;
		if (!plugins?.disablePlugin || !plugins.enablePlugin) { new Notice("Restart Obsidian to apply this change."); return; }
		await plugins.disablePlugin(id);
		await plugins.enablePlugin(id);
		setting?.openTabById?.(id);
	}

	onunload() {
		this.homeObserver?.disconnect();
		activeDocument.querySelectorAll("[data-ms-home]").forEach((el) => el.remove());
		activeDocument.body.removeClass("bb-canvas-draw");
		const reg = internal(this.app).embedRegistry;
		try { if (this.registeredExts.length) reg?.unregisterExtensions?.(this.registeredExts); } catch { /* ignore */ }
	}

	async saveSettings() { await this.saveData(this.settings); }

	openShare(file: TFile) { new ShareModal(this.app, this, file).open(); }

	// ---------- maths commands ----------
	private addMathCommand(t: MathTool) {
		this.addCommand({
			id: t.id,
			name: t.name,
			icon: t.icon,
			checkCallback: (check) => {
				const editor = this.app.workspace.activeEditor?.editor;
				const field = this.activeField();
				if (!editor && !field && t.action === undefined) return false;
				if (!check) this.runTool(t);
				return true;
			},
		});
	}

	private activeField(): HTMLTextAreaElement | HTMLInputElement | null {
		const a = activeDocument.activeElement;
		if (a?.instanceOf(HTMLElement) && a.closest(".ms-sheet, .ms-graph-modal")) return null; // these handle their own shortcuts
		return a?.instanceOf(HTMLTextAreaElement) || (a?.instanceOf(HTMLInputElement) && a.type === "text") ? a : null;
	}

	runTool(t: MathTool) {
		const editor = this.app.workspace.activeEditor?.editor;
		const field = this.activeField();
		if (t.special === "fraction") { this.doFraction(); return; }
		if (t.action) { void this.openSymbols(t.action === "greek" ? 1 : 0); return; }
		if (field) insertInField(field, t.insert!);
		else if (editor) insertInEditor(editor, t.insert!);
	}

	// ---------- the symbols menu in the left sidebar ----------
	private trackTarget(leaf: WorkspaceLeaf | null) {
		const v = leaf?.view;
		if (leaf && (v instanceof MarkdownView || v instanceof BoardView || v instanceof SlidesView)) this.lastTarget = leaf;
	}

	async openSymbols(group = 0) {
		const ws = this.app.workspace;
		if (this.settings.symbolsSidebar) {
			let leaf: WorkspaceLeaf | null = ws.getLeavesOfType(VIEW_SYMBOLS)[0] ?? null;
			if (!leaf) {
				leaf = ws.getLeftLeaf(false);
				await leaf?.setViewState({ type: VIEW_SYMBOLS, active: true });
			}
			if (leaf) {
				if (leaf.view instanceof SymbolsView) leaf.view.setGroup(group);
				const back = this.lastTarget;
				await ws.revealLeaf(leaf);
				// hand the cursor back so you can carry on typing where you were
				if (back && !Platform.isPhone) ws.setActiveLeaf(back, { focus: true });
				return;
			}
		}
		new MathPalette(this.app, (item) => this.insertSymbol(item), group).open();
	}

	/** Put a symbol where you were last typing: a board's text box, a note, or a new maths box on a board. */
	insertSymbol(item: MathItem) {
		if (item.special === "fraction") { this.doFraction(); return; }
		const a = activeDocument.activeElement;
		if (a?.instanceOf(HTMLTextAreaElement) && a.classList.contains("ms-text-edit")) { insertInField(a, item.insert); return; }
		const view = this.lastTarget?.view;
		if (view instanceof MarkdownView && view.editor) { insertInEditor(view.editor, item.insert); return; }
		if (view instanceof BoardView || view instanceof SlidesView) { view.board?.newMath(item.insert); return; }
		const editor = this.app.workspace.activeEditor?.editor;
		if (editor) { insertInEditor(editor, item.insert); return; }
		new Notice("Click into a note or a board first, then pick a symbol.");
	}

	/** Fraction: the top and bottom are typed into a small box, so there are no braces to get wrong. */
	doFraction() {
		const a = activeDocument.activeElement;
		if (a?.instanceOf(HTMLTextAreaElement) && a.classList.contains("ms-text-edit")) { fractionInField(this.app, a); return; }
		const view = this.lastTarget?.view;
		if (view instanceof MarkdownView && view.editor) { fractionInEditor(this.app, view.editor); return; }
		if (view instanceof BoardView || view instanceof SlidesView) { const b = view.board; if (b) fractionNewBox(this.app, (s) => b.newMath(s)); return; }
		const editor = this.app.workspace.activeEditor?.editor;
		if (editor) { fractionInEditor(this.app, editor); return; }
		new Notice("Click into a note or a board first.");
	}

	// ---------- typing: ^ gives small raised numbers, = solves a sum ----------
	private inCode(editor: Editor, cur: EditorPosition): boolean {
		const lines = editor.getRange({ line: 0, ch: 0 }, cur).split("\n");
		let fence = false;
		for (let i = 0; i < lines.length - 1; i++) if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
		if (fence) return true;
		if ((lines[lines.length - 1].match(/`/g) ?? []).length % 2 === 1) return true;
		if (lines.length > 1 && lines[0].trim() === "---") { for (let i = 1; i < lines.length - 1; i++) if (lines[i].trim() === "---") return false; return true; }
		return false;
	}

	/** the last × or ÷ made from * or /, so Backspace can turn it back */
	private lastOp: { line: number; ch: number; sym: string; orig: string } | null = null;

	/** where a π was deleted: typing pi there again keeps it as plain "pi" */
	private noPi: { line: number; ch: number } | null = null;

	private onTypingKey(e: KeyboardEvent) {
		if (e.key === "Backspace" && !e.metaKey && !e.altKey && !e.ctrlKey && (e.target as HTMLElement | null)?.closest?.(".cm-content")) {
			const ed = this.app.workspace.activeEditor?.editor;
			const at = ed?.getCursor();
			if (ed && at && !ed.somethingSelected() && at.ch > 0 && ed.getLine(at.line).charAt(at.ch - 1) === "π") this.noPi = { line: at.line, ch: at.ch - 1 };
		}
		const op = this.lastOp;
		if (op && !["Shift", "Alt", "CapsLock", "Meta", "Control"].includes(e.key)) {
			this.lastOp = null;
			if (e.key === "Backspace" && !e.metaKey && !e.altKey && !e.ctrlKey) {
				const editor = this.app.workspace.activeEditor?.editor;
				const cur = editor?.getCursor();
				if (editor && cur && !editor.somethingSelected() && cur.line === op.line && cur.ch === op.ch && editor.getRange({ line: cur.line, ch: cur.ch - op.sym.length }, cur) === op.sym) {
					e.preventDefault(); e.stopPropagation();
					editor.replaceRange(op.orig, { line: cur.line, ch: cur.ch - op.sym.length }, cur);
					return;
				}
			}
		}
		if (!this.superTyper.active) return;
		if (e.key === "Backspace" && this.superTyper.pending) { e.preventDefault(); e.stopPropagation(); this.superTyper.reset(); return; } // cancels the ^
		if (e.metaKey || e.ctrlKey || (e.key.length > 1 && !["Shift", "Alt", "CapsLock"].includes(e.key))) this.superTyper.reset();
	}

	private onBeforeInput(e: InputEvent) {
		const st = this.settings;
		if (e.inputType !== "insertText" || !e.data || e.data.length !== 1) { this.superTyper.reset(); return; }
		if (!(e.target as HTMLElement | null)?.closest?.(".cm-content")) { this.superTyper.reset(); return; }
		const c = e.data;
		const wantsSuper = st.superscriptTyping && (this.superTyper.active || c === "^");
		const wantsSolve = st.autoSolve && c === "=";
		const wantsRewrite = st.typeShortcuts && /[ )=>-]/.test(c);
		const wantsOp = st.realOperators && (c === "*" || c === "/");
		const wantsPi = st.typePi && !/[A-Za-z_]/.test(c) && !this.superTyper.active;
		if (!wantsSuper && !wantsSolve && !wantsRewrite && !wantsOp && !wantsPi) return;
		const editor = this.app.workspace.activeEditor?.editor;
		if (!editor || editor.somethingSelected()) { this.superTyper.reset(); return; }
		const cur = editor.getCursor();
		const line = editor.getLine(cur.line).slice(0, cur.ch);
		const skip = () => insideMath(editor.getRange({ line: 0, ch: 0 }, cur)) || this.inCode(editor, cur);

		// "pi" on its own becomes π once the next character is typed (so "pie" and "spin" are left alone)
		if (wantsPi && /(^|[^A-Za-z_\\])pi$/.test(line) && !this.inCode(editor, cur) && !piBlocked(line) && !(this.noPi && this.noPi.line === cur.line && this.noPi.ch === cur.ch - 2)) {
			e.preventDefault(); e.stopPropagation();
			const math = insideMath(editor.getRange({ line: 0, ch: 0 }, cur));
			const sym = math ? "\\pi " : "π";
			editor.replaceRange(sym, { line: cur.line, ch: cur.ch - 2 }, cur);
			editor.setCursor({ line: cur.line, ch: cur.ch - 2 + sym.length });
			// now type the character itself, letting the other rules (× ÷, =, fractions) see it
			if (math && c === " ") return;
			let taken = false;
			this.onBeforeInput({ inputType: "insertText", data: c, target: e.target, preventDefault: () => (taken = true), stopPropagation: () => {} } as unknown as InputEvent);
			if (!taken) {
				const at = editor.getCursor();
				// step over a bracket Obsidian already closed, instead of adding a second one
				if (/[)\]}]/.test(c) && editor.getLine(at.line).charAt(at.ch) === c) editor.setCursor({ line: at.line, ch: at.ch + 1 });
				else editor.replaceSelection(c);
			}
			return;
		}

		if (wantsSuper) {
			// only a ^ stuck to a number, letter or bracket (not a block id or a footnote)
			const canStart = !this.superTyper.active && /[0-9A-Za-zͰ-Ͽ)\]]$/.test(line) && !skip();
			const r = this.superTyper.handle(c, canStart);
			if (r) {
				if (r.swallow) { e.preventDefault(); e.stopPropagation(); }
				if (r.insert) editor.replaceSelection(r.insert);
				return;
			}
		}
		if (wantsOp && !this.superTyper.active && !skip()) {
			const op = operatorFor(line, c);
			if (op) {
				e.preventDefault(); e.stopPropagation();
				editor.replaceRange(op.insert, { line: cur.line, ch: cur.ch - op.remove }, cur);
				const end = cur.ch - op.remove + op.insert.length;
				editor.setCursor({ line: cur.line, ch: end });
				if (op.insert.length === 1) this.lastOp = { line: cur.line, ch: end, sym: op.insert, orig: c };
				return;
			}
		}
		if (wantsRewrite && !this.superTyper.active && !this.inCode(editor, cur)) {
			const rw = rewriteTyping(line, c, insideMath(editor.getRange({ line: 0, ch: 0 }, cur)));
			if (rw) {
				e.preventDefault(); e.stopPropagation();
				// Obsidian closes brackets as you type, so the ")" we are replacing may already be there
				const autoClosed = c === ")" && editor.getLine(cur.line).charAt(cur.ch) === ")";
				editor.replaceRange(rw.insert, { line: cur.line, ch: cur.ch - rw.remove }, autoClosed ? { line: cur.line, ch: cur.ch + 1 } : cur);
				editor.setCursor({ line: cur.line, ch: cur.ch - rw.remove + rw.insert.length });
				return;
			}
		}
		if (wantsSolve) {
			const answer = solveLine(line) ?? convertUnits(line);
			if (answer === null || skip()) return;
			if (st.autoSolveGhost) {
				// let the "=" go in, then show the answer faded after it; Tab uses it
				const view = (editor as unknown as { cm?: EditorView }).cm;
				const at = editor.posToOffset(cur) + 1;
				const text = (/\s$/.test(line) ? " " : "") + answer;
				window.setTimeout(() => {
					if (view && view.state.doc.sliceString(at - 1, at) === "=" && view.state.selection.main.head === at) view.dispatch({ effects: setGhost.of({ pos: at, text }) });
				}, 0);
				return;
			}
			e.preventDefault(); e.stopPropagation();
			editor.replaceSelection("=" + (/\s$/.test(line) ? " " : "") + answer);
		}
	}

	// ---------- citations ----------
	async openCitations() {
		const ws = this.app.workspace;
		const existing = ws.getLeavesOfType(VIEW_CITE)[0];
		const leaf = existing ?? ws.getLeaf("tab");
		if (!existing) await leaf.setViewState({ type: VIEW_CITE, active: true });
		await ws.revealLeaf(leaf);
	}

	// ---------- PDFs into notes ----------
	private onFileListDrop(e: DragEvent) {
		const st = this.settings;
		if (!st.pdfNotes && !st.photoNotes) return;
		const target = e.target as HTMLElement | null;
		if (!target?.closest?.(".nav-files-container")) return;
		const files = Array.from(e.dataTransfer?.files ?? []);
		const isPdf = (f: File) => /\.pdf$/i.test(f.name) || f.type === "application/pdf";
		const pdfs = st.pdfNotes ? files.filter(isPdf) : [];
		const photos = st.photoNotes ? files.filter((f) => !isPdf(f) && isPhoto(f)) : [];
		if (!files.length || pdfs.length + photos.length !== files.length) return; // anything else is imported by Obsidian as usual
		e.preventDefault(); e.stopPropagation();
		const folder = dropFolder(this.app, target);
		void (async () => {
			if (photos.length) {
				const busy = new Notice(photos.length > 1 ? `Making a note from ${photos.length} photos…` : `Making a note from ${photos[0].name}…`, 0);
				try {
					const note = await noteFromDroppedPhotos(this.app, photos, folder);
					busy.hide();
					if (!pdfs.length) await this.app.workspace.getLeaf(false).openFile(note);
					else new Notice(`Made ${note.basename}.`);
				} catch (err) {
					busy.hide();
					console.error(err);
					new Notice("Couldn't make a note from those photos.");
				}
			}
			for (const f of pdfs) {
				const busy = new Notice(`Making a note from ${f.name}…`, 0);
				try {
					const note = await noteFromDroppedPdf(this.app, f, folder, this.settings.pdfNoteStyle);
					busy.hide();
					if (pdfs.length === 1 && !photos.length) await this.app.workspace.getLeaf(false).openFile(note);
					else new Notice(`Made ${note.basename}.`);
				} catch (err) {
					busy.hide();
					console.error(err);
					new Notice(`Couldn't make a note from ${f.name}.`);
				}
			}
		})();
	}

	private async makePdfNote(pdf: TFile) {
		const busy = new Notice(`Making a note from ${pdf.name}…`, 0);
		try {
			const note = await noteFromPdf(this.app, pdf, pdf.parent && pdf.parent.path !== "/" ? pdf.parent.path : "", this.settings.pdfNoteStyle);
			busy.hide();
			await this.app.workspace.getLeaf(false).openFile(note);
		} catch (err) {
			busy.hide();
			console.error(err);
			new Notice(`Couldn't make a note from ${pdf.name}.`);
		}
	}

	// ---------- bottom row: Mac status bar ----------
	setupStatusBar() {
		this.statusItems.forEach((e) => e.remove());
		this.statusItems = [];
		if (!this.settings.statusBar || Platform.isMobile) return;
		const bar = this.addStatusBarItem();
		bar.addClass("ms-statusbar");
		this.statusItems.push(bar);
		for (const id of ["math-palette", "inline-math", "power", "subscript", "fraction", "sqrt", "sum", "integral", "greek"]) {
			const t = MATH_TOOLS.find((x) => x.id === id)!;
			const tip = this.settings.mathShortcuts ? `${t.name}  (${shortcutLabel(t)})` : t.name;
			const b = bar.createSpan({ cls: "ms-sb-btn", attr: { "aria-label": tip, "data-tooltip-position": "top" } });
			setIcon(b, t.icon);
			// keep focus in the note so the symbol goes where the cursor is
			b.onmousedown = (e) => e.preventDefault();
			b.onclick = () => this.runTool(t);
		}
	}

	// ---------- bottom row: iPad / iPhone toolbar ----------
	addToMobileToolbar(silent = false) {
		const vault = this.app.vault as unknown as VaultConfig;
		try {
			const current = (vault.getConfig?.("mobileToolbarCommands") as string[] | undefined) ?? [];
			const ids = TOOLBAR_TOOLS.map((id) => `${this.manifest.id}:${id}`).filter((id) => !current.includes(id));
			if (ids.length) vault.setConfig?.("mobileToolbarCommands", [...current, ...ids]);
			this.settings.mobileToolbarAdded = true;
			void this.saveSettings();
			if (!silent || ids.length) new Notice("Maths buttons added to the mobile toolbar.");
		} catch (e) {
			console.error(e);
			new Notice("Couldn't add the buttons automatically. Settings → Toolbar lets you add the Bits and Bobs commands.");
		}
	}
	removeFromMobileToolbar() {
		const vault = this.app.vault as unknown as VaultConfig;
		try {
			const current = (vault.getConfig?.("mobileToolbarCommands") as string[] | undefined) ?? [];
			vault.setConfig?.("mobileToolbarCommands", current.filter((id) => !id.startsWith(this.manifest.id + ":")));
			new Notice("Maths buttons removed from the bottom toolbar.");
		} catch (e) { console.error(e); }
	}

	// ---------- Home + AI plugin: add buttons to its home screen ----------
	setupHomeButtons() {
		this.homeObserver?.disconnect();
		activeDocument.querySelectorAll("[data-ms-home]").forEach((el) => el.remove());
		if (!this.settings.homeButtons) return;
		const inject = () => {
			// "Dashboard" style: the row of chips (New note, New canvas, AI chat, Settings)
			activeDocument.querySelectorAll<HTMLElement>(".hlh-dash-quick").forEach((row) => {
				if (row.querySelector("[data-ms-home]")) return;
				const settings = Array.from(row.children).find((c) => c.getAttribute("aria-label") === "Settings");
				for (const [kind, icon, label] of HOME_ITEMS) {
					const b = createEl("button", { cls: "hlh-dash-chip", attr: { "aria-label": label, "data-ms-home": kind } });
					setIcon(b.createSpan("hlh-dash-chip-icon"), icon);
					b.createSpan({ text: label });
					b.onclick = () => this.createFile(kind);
					row.insertBefore(b, settings ?? null);
				}
			});
			// "Modern" style: the big action cards
			activeDocument.querySelectorAll<HTMLElement>(".hlh-actions").forEach((row) => {
				if (row.querySelector("[data-ms-home]")) return;
				const settings = Array.from(row.children).find((c) => c.querySelector(".hlh-action-label")?.textContent === "Settings");
				for (const [kind, icon, label, sub, hue] of HOME_ITEMS) {
					const b = createEl("button", { cls: `hlh-action hlh-hue-${hue}`, attr: { "data-ms-home": kind } });
					setIcon(b.createSpan("hlh-action-icon"), icon);
					const txt = b.createSpan("hlh-action-text");
					txt.createSpan({ cls: "hlh-action-label", text: label });
					txt.createSpan({ cls: "hlh-action-sub", text: sub });
					b.onclick = () => this.createFile(kind);
					row.insertBefore(b, settings ?? null);
				}
			});
		};
		inject();
		let queued = false;
		this.homeObserver = new MutationObserver(() => {
			if (queued) return;
			queued = true;
			window.requestAnimationFrame(() => { queued = false; inject(); });
		});
		this.homeObserver.observe(activeDocument.body, { childList: true, subtree: true });
	}

	// ---------- embeds: show boards inside notes and Canvas ----------
	private registerEmbeds() {
		const reg = internal(this.app).embedRegistry;
		if (!reg?.registerExtension) return;
		const make = (fn: (container: HTMLElement, file: TFile, c: Component) => void): EmbedFactory => (ctx, file) => {
			const c = new EmbedComponent(() => fn(ctx.containerEl, file, c));
			return c;
		};
		const safe = (ext: string, factory: EmbedFactory) => {
			try { if (!reg.isExtensionRegistered?.(ext)) { reg.registerExtension?.(ext, factory); this.registeredExts.push(ext); } }
			catch { /* another plugin handles this file type */ }
		};
		if (this.settings.boards) safe(EXT_BOARD, make((el, f, c) => boardEmbed(this, el, f, c)));
		if (this.settings.sheets) safe(EXT_SHEET, make((el, f, c) => { sheetEmbed(this, el, f, c).catch((e) => { console.error(e); el.setText("Couldn't preview this spreadsheet."); }); }));
		if (this.settings.slides) safe(EXT_SLIDES, make((el, f, c) => { void this.slidesEmbed(el, f, c); }));
	}

	private async slidesEmbed(el: HTMLElement, file: TFile, c: Component) {
		el.addClass("ms-embed", "ms-slides-embed");
		const deck = parseDeck(await this.app.vault.read(file));
		const s = deck.slides[0];
		const bar = el.createDiv("ms-embed-bar");
		bar.createSpan({ text: `${file.basename} · ${deck.slides.length} slides` });
		const open = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open slides" } });
		setIcon(open, "maximize-2");
		open.onclick = () => { void this.app.workspace.getLeaf("tab").openFile(file); };
		if (!s) return;
		const box = el.createDiv("ms-slides-embed-box");
		box.setCssProps({ "--ms-aspect": `${deck.w} / ${deck.h}` });
		c.addChild(new Board(this, box, { elements: s.elements, bg: s.bg }, { sourcePath: file.path, frame: { w: deck.w, h: deck.h }, readOnly: true, theme: this.settings.slideEffects ? themeFor(deck.theme, deck.font) : null }));
	}

	private async addDrawingToCanvas(view: ItemView) {
		const canvas = (view as unknown as { canvas?: CanvasLike }).canvas;
		const canvasFile = (view as unknown as { file?: TFile }).file;
		const f = await this.createFile("board", false, canvasFile?.parent?.path);
		if (!f || !canvas) return;
		try {
			const centre = canvas.posCenter?.() ?? { x: 0, y: 0 };
			canvas.createFileNode?.({ file: f, pos: { x: centre.x - 320, y: centre.y - 220 }, size: { width: 640, height: 440 }, save: true, focus: false });
			canvas.requestSave?.();
		} catch (e) {
			console.error(e);
			new Notice(`Created ${f.name}. Drag it from the file list onto the Canvas.`);
		}
	}

	// ---------- files ----------
	async createFile(kind: "board" | "slides" | "sheet", open = true, folder?: string): Promise<TFile | null> {
		const ext = kind === "board" ? EXT_BOARD : kind === "slides" ? EXT_SLIDES : EXT_SHEET;
		const base = kind === "board" ? "Drawing" : kind === "slides" ? "Slides" : "Spreadsheet";
		let dir = folder ?? this.settings.newFileFolder;
		if (folder === undefined && !dir) dir = this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "").path;
		dir = dir === "/" ? "" : dir;
		if (dir && !(this.app.vault.getAbstractFileByPath(dir) instanceof TFolder)) await this.app.vault.createFolder(dir).catch(() => {});
		let path = normalizePath(`${dir ? dir + "/" : ""}${base}.${ext}`);
		for (let i = 1; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${dir ? dir + "/" : ""}${base} ${i}.${ext}`);
		let file: TFile;
		try {
			if (kind === "sheet") file = await this.app.vault.createBinary(path, emptyXlsx());
			else if (kind === "slides") file = await this.app.vault.create(path, JSON.stringify({ type: "math-studio-slides", version: 1, w: 1600, h: 900, slides: [newSlide("title")] }));
			else file = await this.app.vault.create(path, JSON.stringify({ type: "math-studio-board", version: 1, bg: this.settings.defaultBg, elements: [] }));
		} catch (e) {
			console.error(e); new Notice("Couldn't create the file."); return null;
		}
		if (open) await this.app.workspace.getLeaf(Platform.isMobile ? false : "tab").openFile(file);
		return file;
	}
}

const HOME_ITEMS: ["board" | "slides" | "sheet", string, string, string, string][] = [
	["board", "pen-tool", "New drawing", "Pencil & maths", "pink"],
	["slides", "presentation", "New slides", "Presentation", "blue"],
	["sheet", "sheet", "New spreadsheet", "Excel file", "green"],
];

/** Minimal component Obsidian's embed system expects (it calls loadFile). */
class EmbedComponent extends Component {
	private done = false;
	constructor(private render: () => void) { super(); }
	loadFile() { if (!this.done) { this.done = true; this.render(); } }
	onload() { window.setTimeout(() => this.loadFile(), 0); }
}
