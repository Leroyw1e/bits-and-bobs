import { Component, ItemView, Notice, Platform, Plugin, TFile, TFolder, normalizePath, setIcon } from "obsidian";
import { BoardView, SlidesView, VIEW_BOARD, VIEW_SLIDES, EXT_BOARD, EXT_SLIDES, boardEmbed, newSlide } from "./views";
import { SheetView, VIEW_SHEET, EXT_SHEET, emptyXlsx, sheetEmbed } from "./sheet";
import { MATH_TOOLS, MathPalette, MathSuggest, MathTool, insertInEditor, insertInField, matchTool, setShortcutsEnabled, shortcutLabel } from "./math";
import { Board } from "./board";
import { BitsSettings, BitsSettingTab, DEFAULT_SETTINGS } from "./settings";

/** Commands added to the iPad / iPhone bottom toolbar. */
const TOOLBAR_TOOLS = ["math-palette", "inline-math", "power", "fraction", "sqrt", "subscript", "greek"];

export default class BitsAndBobs extends Plugin {
	settings!: BitsSettings;
	private registeredExts: string[] = [];
	private statusItems: HTMLElement[] = [];
	private homeObserver: MutationObserver | null = null;

	async onload() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
					if (!check) this.addDrawingToCanvas(view);
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
		if (st.symbolSearch) this.registerEditorSuggest(new MathSuggest(this.app));
		this.registerDomEvent(window, "keydown", (e) => this.onKey(e));

		this.app.workspace.onLayoutReady(() => {
			this.setupStatusBar();
			if (Platform.isMobile && st.mobileToolbar && !st.mobileToolbarAdded) this.addToMobileToolbar(true);
			this.setupHomeButtons();
			this.applyBodyClasses();
			if (st.embeds) this.registerEmbeds();
		});

		this.addSettingTab(new BitsSettingTab(this.app, this));
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

	applyBodyClasses() { document.body.toggleClass("bb-canvas-draw", this.settings.canvasDraw); }

	/** Re-load the plugin so feature switches take effect, then return to its settings. */
	async reload() {
		const plugins = (this.app as any).plugins;
		const setting = (this.app as any).setting;
		const id = this.manifest.id;
		if (!plugins?.disablePlugin) { new Notice("Restart Obsidian to apply this change."); return; }
		await plugins.disablePlugin(id);
		await plugins.enablePlugin(id);
		setting?.openTabById?.(id);
	}

	onunload() {
		this.homeObserver?.disconnect();
		document.querySelectorAll("[data-ms-home]").forEach((el) => el.remove());
		document.body.removeClass("bb-canvas-draw");
		const reg = (this.app as any).embedRegistry;
		try { if (this.registeredExts.length) reg?.unregisterExtensions?.(this.registeredExts); } catch { /* ignore */ }
	}

	async saveSettings() { await this.saveData(this.settings); }

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
		const a = document.activeElement;
		if (a instanceof HTMLElement && a.closest(".ms-sheet, .ms-graph-modal")) return null; // these handle their own shortcuts
		return a instanceof HTMLTextAreaElement || (a instanceof HTMLInputElement && a.type === "text") ? a : null;
	}

	runTool(t: MathTool) {
		const editor = this.app.workspace.activeEditor?.editor;
		const field = this.activeField();
		if (t.action) {
			const board = this.app.workspace.getActiveViewOfType(BoardView)?.board;
			if (board && !field) { board.openPalette(t.action === "greek" ? 1 : 0); return; }
			new MathPalette(this.app, (item) => {
				if (field && field.isConnected) insertInField(field, item.insert);
				else if (editor) insertInEditor(editor, item.insert);
				else new Notice("Click into a note first, then pick a symbol.");
			}, t.action === "greek" ? 1 : 0).open();
			return;
		}
		if (field) insertInField(field, t.insert!);
		else if (editor) insertInEditor(editor, t.insert!);
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
			const b = bar.createEl("span", { cls: "ms-sb-btn", attr: { "aria-label": tip, "data-tooltip-position": "top" } });
			setIcon(b, t.icon);
			// keep focus in the note so the symbol goes where the cursor is
			b.onmousedown = (e) => e.preventDefault();
			b.onclick = () => this.runTool(t);
		}
	}

	// ---------- bottom row: iPad / iPhone toolbar ----------
	addToMobileToolbar(silent = false) {
		const vault = this.app.vault as any;
		try {
			const current: string[] = vault.getConfig?.("mobileToolbarCommands") ?? [];
			const ids = TOOLBAR_TOOLS.map((id) => `${this.manifest.id}:${id}`).filter((id) => !current.includes(id));
			if (ids.length) vault.setConfig("mobileToolbarCommands", [...current, ...ids]);
			this.settings.mobileToolbarAdded = true;
			this.saveSettings();
			if (!silent || ids.length) new Notice("Maths buttons added to the mobile toolbar.");
		} catch (e) {
			console.error(e);
			new Notice("Couldn't add the buttons automatically. Settings → Toolbar lets you add the Bits and Bobs commands.");
		}
	}
	removeFromMobileToolbar() {
		const vault = this.app.vault as any;
		try {
			const current: string[] = vault.getConfig?.("mobileToolbarCommands") ?? [];
			vault.setConfig("mobileToolbarCommands", current.filter((id) => !id.startsWith(this.manifest.id + ":")));
			new Notice("Maths buttons removed from the bottom toolbar.");
		} catch (e) { console.error(e); }
	}

	// ---------- Home + AI plugin: add buttons to its home screen ----------
	setupHomeButtons() {
		this.homeObserver?.disconnect();
		document.querySelectorAll("[data-ms-home]").forEach((el) => el.remove());
		if (!this.settings.homeButtons) return;
		const inject = () => {
			// "Dashboard" style: the row of chips (New note, New canvas, AI chat, Settings)
			document.querySelectorAll<HTMLElement>(".hlh-dash-quick").forEach((row) => {
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
			document.querySelectorAll<HTMLElement>(".hlh-actions").forEach((row) => {
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
			requestAnimationFrame(() => { queued = false; inject(); });
		});
		this.homeObserver.observe(document.body, { childList: true, subtree: true });
	}

	// ---------- embeds: show boards inside notes and Canvas ----------
	private registerEmbeds() {
		const reg = (this.app as any).embedRegistry;
		if (!reg?.registerExtension) return;
		const make = (fn: (container: HTMLElement, file: TFile, c: Component) => void) => (ctx: any, file: TFile) => {
			const c = new EmbedComponent(() => fn(ctx.containerEl, file, c));
			return c;
		};
		const safe = (ext: string, factory: any) => {
			try { if (!reg.isExtensionRegistered?.(ext)) { reg.registerExtension(ext, factory); this.registeredExts.push(ext); } }
			catch { /* another plugin handles this file type */ }
		};
		if (this.settings.boards) safe(EXT_BOARD, make((el, f, c) => boardEmbed(this, el, f, c)));
		if (this.settings.sheets) safe(EXT_SHEET, make((el, f, c) => { sheetEmbed(this, el, f, c).catch((e) => { console.error(e); el.setText("Couldn't preview this spreadsheet."); }); }));
		if (this.settings.slides) safe(EXT_SLIDES, make((el, f, c) => this.slidesEmbed(el, f, c)));
	}

	private async slidesEmbed(el: HTMLElement, file: TFile, c: Component) {
		el.addClass("ms-embed", "ms-slides-embed");
		const deck = JSON.parse((await this.app.vault.read(file)) || "{}");
		const s = deck.slides?.[0];
		const bar = el.createDiv("ms-embed-bar");
		bar.createSpan({ text: `${file.basename} · ${deck.slides?.length ?? 0} slides` });
		const open = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open slides" } });
		setIcon(open, "maximize-2");
		open.onclick = () => this.app.workspace.getLeaf("tab").openFile(file);
		if (!s) return;
		const box = el.createDiv("ms-slides-embed-box");
		box.style.aspectRatio = `${deck.w || 1600} / ${deck.h || 900}`;
		c.addChild(new Board(this, box, { elements: s.elements, bg: s.bg }, { sourcePath: file.path, frame: { w: deck.w || 1600, h: deck.h || 900 }, readOnly: true }));
	}

	private async addDrawingToCanvas(view: ItemView) {
		const canvas = (view as any).canvas;
		const canvasFile: TFile | undefined = (view as any).file;
		const f = await this.createFile("board", false, canvasFile?.parent?.path);
		if (!f || !canvas) return;
		try {
			const centre = canvas.posCenter?.() ?? { x: 0, y: 0 };
			canvas.createFileNode({ file: f, pos: { x: centre.x - 320, y: centre.y - 220 }, size: { width: 640, height: 440 }, save: true, focus: false });
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
