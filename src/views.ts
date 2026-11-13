import { Component, Menu, Notice, Platform, TextFileView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type BitsAndBobs from "./main";
import { Board, BoardDoc, El, parseBoard, serializeBoard, uid } from "./board";
import { LAYOUTS, LayoutPicker } from "./layouts";

export const VIEW_BOARD = "math-studio-board";
export const VIEW_SLIDES = "math-studio-slides";
export const EXT_BOARD = "mboard";
export const EXT_SLIDES = "mslides";

// ---------------- Board ----------------
export class BoardView extends TextFileView {
	board: Board | null = null;
	private lastData = "";
	constructor(leaf: WorkspaceLeaf, private plugin: BitsAndBobs) { super(leaf); }
	getViewType() { return VIEW_BOARD; }
	getIcon() { return "pen-tool"; }
	getDisplayText() { return this.file?.basename ?? "Board"; }
	canAcceptExtension(ext: string) { return ext === EXT_BOARD; }

	getViewData() { return this.board ? serializeBoard(this.board.doc) : this.lastData; }
	setViewData(data: string, clear: boolean) {
		if (this.board && data === this.lastData) return;
		this.lastData = data;
		const doc = parseBoard(data);
		if (this.board && !clear) { this.board.setDoc(doc, true); return; }
		if (this.board) this.removeChild(this.board);
		this.contentEl.empty();
		this.contentEl.addClass("ms-view");
		this.board = new Board(this.plugin, this.contentEl, doc, {
			sourcePath: this.file?.path ?? "",
			onChange: () => { this.lastData = serializeBoard(this.board!.doc); this.requestSave(); },
		});
		this.addChild(this.board);
	}
	clear() { /* new file loaded; setViewData(clear=true) rebuilds */ }
	async onClose() { if (this.board) this.removeChild(this.board); this.board = null; }
}

// ---------------- Slides ----------------
export interface Slide { id: string; elements: El[]; bg?: BoardDoc["bg"]; notes?: string; layout?: string }
export interface Deck { w: number; h: number; slides: Slide[] }

export function parseDeck(data: string): Deck {
	try {
		const d = JSON.parse(data || "{}");
		const slides: Slide[] = Array.isArray(d.slides) && d.slides.length ? d.slides : [newSlide("title")];
		return { w: d.w || 1600, h: d.h || 900, slides };
	} catch {
		return { w: 1600, h: 900, slides: [newSlide("title")] };
	}
}
const serializeDeck = (d: Deck) => JSON.stringify({ type: "math-studio-slides", version: 1, ...d });

export function newSlide(layout = "content"): Slide {
	const l = LAYOUTS.find((x) => x.id === layout) ?? LAYOUTS[1];
	return { id: uid(), elements: l.make(), bg: "plain", layout: l.id } as Slide;
}

export class SlidesView extends TextFileView {
	deck: Deck = parseDeck("");
	current = 0;
	board: Board | null = null;
	private lastData = "";
	private listEl!: HTMLElement;
	private mainEl!: HTMLElement;
	private thumbs: Component[] = [];
	private thumbTimer = 0;
	private notesEl!: HTMLTextAreaElement;
	constructor(leaf: WorkspaceLeaf, private plugin: BitsAndBobs) { super(leaf); }
	getViewType() { return VIEW_SLIDES; }
	getIcon() { return "presentation"; }
	getDisplayText() { return this.file?.basename ?? "Slides"; }
	canAcceptExtension(ext: string) { return ext === EXT_SLIDES; }
	getViewData() { return serializeDeck(this.deck); }
	clear() { /* handled in setViewData */ }

	setViewData(data: string, clear: boolean) {
		if (data === this.lastData && this.board) return;
		this.lastData = data;
		this.deck = parseDeck(data);
		if (clear || !this.board) { this.current = 0; this.build(); }
		else { this.current = Math.min(this.current, this.deck.slides.length - 1); this.loadSlide(); this.renderThumbs(); }
	}

	private markDirty() { this.lastData = serializeDeck(this.deck); this.requestSave(); }

	private build() {
		if (this.board) this.removeChild(this.board);
		const c = this.contentEl;
		c.empty();
		c.addClass("ms-view", "ms-slides");
		const side = c.createDiv("ms-slide-side");
		const sideBar = side.createDiv("ms-slide-sidebar-bar");
		const mk = (parent: HTMLElement, icon: string, label: string, fn: () => void, text?: string) => {
			const b = parent.createEl("button", { cls: "ms-tb-btn clickable-icon", attr: { "aria-label": label } });
			setIcon(b, icon); if (text) b.createSpan({ cls: "ms-tb-text", text });
			b.onclick = fn; return b;
		};
		mk(sideBar, "plus", "New slide (pick a layout)", () => this.pickLayout((id) => this.addSlide(this.current, id)), "Slide");
		mk(sideBar, "play", "Present (from this slide)", () => this.present(), "Present").addClass("mod-cta");
		this.listEl = side.createDiv("ms-slide-list");
		this.mainEl = c.createDiv("ms-slide-main");
		const holder = this.mainEl.createDiv("ms-slide-board");
		this.notesEl = this.mainEl.createEl("textarea", { cls: "ms-slide-notes", attr: { placeholder: "Speaker notes…", rows: "2" } });
		if (!this.plugin.settings.speakerNotes) this.notesEl.hide();
		this.notesEl.oninput = () => { this.deck.slides[this.current].notes = this.notesEl.value; this.markDirty(); };
		this.board = new Board(this.plugin, holder, { elements: [], bg: "plain" }, {
			sourcePath: this.file?.path ?? "",
			frame: { w: this.deck.w, h: this.deck.h },
			onChange: (doc) => {
				const s = this.deck.slides[this.current];
				s.elements = doc.elements; s.bg = doc.bg;
				this.markDirty();
				window.clearTimeout(this.thumbTimer);
				this.thumbTimer = window.setTimeout(() => this.renderThumbs(), 600);
			},
		});
		this.addChild(this.board);
		this.loadSlide();
		this.renderThumbs();
		this.registerDomEvent(this.listEl, "keydown", (e) => {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); this.go(this.current + (e.key === "ArrowDown" ? 1 : -1)); }
			if ((e.key === "Delete" || e.key === "Backspace") && this.deck.slides.length > 1) { e.preventDefault(); this.deleteSlide(this.current); }
		});
	}

	private loadSlide() {
		const s = this.deck.slides[this.current];
		this.board?.setDoc({ elements: s.elements, bg: s.bg ?? "plain" });
		if (this.notesEl) this.notesEl.value = s.notes ?? "";
	}

	private go(i: number) {
		if (i < 0 || i >= this.deck.slides.length) return;
		this.board?.commitText();
		this.current = i;
		this.loadSlide();
		this.listEl.querySelectorAll(".ms-thumb").forEach((t, j) => t.toggleClass("is-active", j === i));
		(this.listEl.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: "nearest" });
	}

	private renderThumbs() {
		this.thumbs.forEach((t) => this.removeChild(t));
		this.thumbs = [];
		this.listEl.empty();
		this.listEl.tabIndex = 0;
		this.deck.slides.forEach((s, i) => {
			const t = this.listEl.createDiv("ms-thumb" + (i === this.current ? " is-active" : ""));
			t.createDiv({ cls: "ms-thumb-num", text: String(i + 1) });
			const box = t.createDiv("ms-thumb-box");
			box.style.aspectRatio = `${this.deck.w} / ${this.deck.h}`;
			const b = new Board(this.plugin, box, { elements: s.elements, bg: s.bg }, { sourcePath: this.file?.path ?? "", frame: { w: this.deck.w, h: this.deck.h }, readOnly: true });
			this.addChild(b); this.thumbs.push(b);
			t.onclick = () => this.go(i);
			t.oncontextmenu = (e) => { e.preventDefault(); this.slideMenu(i, e); };
			// long-press on iPad
			let timer = 0;
			t.ontouchstart = (e) => { const touch = e.touches[0]; timer = window.setTimeout(() => this.slideMenu(i, { clientX: touch.clientX, clientY: touch.clientY } as MouseEvent), 550); };
			t.ontouchend = t.ontouchmove = () => window.clearTimeout(timer);
		});
	}

	private slideMenu(i: number, e: MouseEvent) {
		const m = new Menu();
		m.addItem((it) => it.setTitle("New slide after…").setIcon("plus").onClick(() => this.pickLayout((id) => this.addSlide(i, id))));
		m.addItem((it) => it.setTitle("Change layout… (replaces this slide)").setIcon("layout-template").onClick(() => this.pickLayout((id) => {
			const s = this.deck.slides[i]; const fresh = newSlide(id);
			s.elements = fresh.elements; s.layout = id;
			this.current = i; this.markDirty(); this.loadSlide(); this.renderThumbs();
		})));
		m.addItem((it) => it.setTitle("Duplicate").setIcon("copy").onClick(() => {
			const copy: Slide = JSON.parse(JSON.stringify(this.deck.slides[i])); copy.id = uid();
			copy.elements.forEach((el) => (el.id = uid()));
			this.deck.slides.splice(i + 1, 0, copy); this.markDirty(); this.current = i + 1; this.loadSlide(); this.renderThumbs();
		}));
		m.addItem((it) => it.setTitle("Move up").setIcon("arrow-up").setDisabled(i === 0).onClick(() => this.move(i, -1)));
		m.addItem((it) => it.setTitle("Move down").setIcon("arrow-down").setDisabled(i === this.deck.slides.length - 1).onClick(() => this.move(i, 1)));
		m.addSeparator();
		m.addItem((it) => it.setTitle("Delete slide").setIcon("trash-2").setDisabled(this.deck.slides.length < 2).onClick(() => this.deleteSlide(i)));
		m.showAtMouseEvent(e);
	}

	private pickLayout(done: (id: string) => void) {
		this.board?.commitText();
		new LayoutPicker(this.app, this.plugin, this.file?.path ?? "", (l) => done(l.id)).open();
	}

	private addSlide(after = this.current, layout = "content") {
		this.board?.commitText();
		this.deck.slides.splice(after + 1, 0, newSlide(layout));
		this.current = after + 1;
		this.markDirty(); this.loadSlide(); this.renderThumbs();
	}
	private move(i: number, d: number) {
		const s = this.deck.slides; const j = i + d;
		[s[i], s[j]] = [s[j], s[i]];
		this.current = j; this.markDirty(); this.loadSlide(); this.renderThumbs();
	}
	private deleteSlide(i: number) {
		if (this.deck.slides.length < 2) return;
		this.deck.slides.splice(i, 1);
		this.current = Math.min(this.current, this.deck.slides.length - 1);
		this.markDirty(); this.loadSlide(); this.renderThumbs();
	}

	present(start = this.current) {
		this.board?.commitText();
		new Presenter(this.plugin, this.deck, this.file?.path ?? "", start).open();
	}

	async onClose() { this.thumbs.forEach((t) => this.removeChild(t)); if (this.board) this.removeChild(this.board); this.board = null; }
}

/** Full-screen presentation. Arrow keys / space / tap / swipe to move. */
export class Presenter extends Component {
	private el!: HTMLElement;
	private board: Board | null = null;
	private i: number;
	private counter!: HTMLElement;
	constructor(private plugin: BitsAndBobs, private deck: Deck, private sourcePath: string, start: number) { super(); this.i = start; }
	open() {
		this.el = document.body.createDiv("ms-present");
		const stage = this.el.createDiv("ms-present-stage");
		const bar = this.el.createDiv("ms-present-bar");
		const b = (icon: string, label: string, fn: () => void) => { const x = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } }); setIcon(x, icon); x.onclick = (e) => { e.stopPropagation(); fn(); }; };
		b("chevron-left", "Previous", () => this.go(this.i - 1));
		this.counter = bar.createSpan("ms-present-count");
		b("chevron-right", "Next", () => this.go(this.i + 1));
		b("x", "Exit (Esc)", () => this.close());
		super.load();
		this.registerDomEvent(document, "keydown", (e) => {
			if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); this.go(this.i + 1); }
			else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); this.go(this.i - 1); }
			else if (e.key === "Escape") { e.preventDefault(); this.close(); }
		}, { capture: true });
		let sx = 0, sy = 0;
		this.registerDomEvent(stage, "pointerdown", (e) => { sx = e.clientX; sy = e.clientY; });
		this.registerDomEvent(stage, "pointerup", (e) => {
			const dx = e.clientX - sx, dy = e.clientY - sy;
			if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) this.go(this.i + (dx < 0 ? 1 : -1));
			else if (Math.hypot(dx, dy) < 8 && e.pointerType !== "pen") this.go(this.i + (e.clientX > window.innerWidth / 3 ? 1 : -1));
		});
		this.registerDomEvent(document, "fullscreenchange", () => { if (!document.fullscreenElement && this.el.isConnected && !Platform.isMobile) this.close(); });
		if (!Platform.isMobile && this.plugin.settings.presentFullscreen) this.el.requestFullscreen?.().catch(() => {});
		this.show();
	}
	private show() {
		const stage = this.el.querySelector(".ms-present-stage") as HTMLElement;
		if (this.board) this.removeChild(this.board);
		stage.empty();
		const s = this.deck.slides[this.i];
		this.board = new Board(this.plugin, stage, { elements: s.elements, bg: s.bg }, { sourcePath: this.sourcePath, frame: { w: this.deck.w, h: this.deck.h }, readOnly: true });
		this.addChild(this.board);
		this.counter.setText(`${this.i + 1} / ${this.deck.slides.length}`);
	}
	private go(i: number) {
		if (i >= this.deck.slides.length) { this.close(); return; }
		if (i < 0) return;
		this.i = i; this.show();
	}
	close() {
		if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
		this.unload();
		this.el.remove();
	}
}

export function boardEmbed(plugin: BitsAndBobs, container: HTMLElement, file: TFile, parent: Component) {
	container.addClass("ms-embed");
	let board: Board | null = null;
	let lastSaved = "";
	let timer = 0;
	const load = async () => {
		const data = await plugin.app.vault.read(file);
		if (data === lastSaved && board) return;
		lastSaved = data;
		if (board) { board.setDoc(parseBoard(data), true); return; }
		board = new Board(plugin, container, parseBoard(data), {
			sourcePath: file.path,
			compact: true,
			onOpenFull: () => plugin.app.workspace.getLeaf("tab").openFile(file),
			onChange: (doc) => {
				window.clearTimeout(timer);
				timer = window.setTimeout(async () => { lastSaved = serializeBoard(doc); await plugin.app.vault.process(file, () => lastSaved); }, 600);
			},
		});
		parent.addChild(board);
	};
	parent.registerEvent(plugin.app.vault.on("modify", (f) => { if (f === file) load(); }));
	parent.register(() => { if (timer && board) { window.clearTimeout(timer); const data = serializeBoard(board.doc); plugin.app.vault.process(file, () => data); } });
	load().catch((e) => { console.error(e); new Notice("Couldn't open board"); });
}
