import { Component, Menu, Notice, Platform, TextFileView, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type BitsAndBobs from "./main";
import { Board, BoardDoc, El, StrokeEl, parseBoard, serializeBoard, strokePath, uid } from "./board";
import { LAYOUTS, LayoutPicker } from "./layouts";
import { FONTS, THEMES, themeFor, Theme } from "./themes";

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
export type Transition = "none" | "fade" | "slide" | "zoom" | "rise";
export type Reveal = "bullets" | "objects";
export interface Slide { id: string; elements: El[]; bg?: BoardDoc["bg"]; notes?: string; layout?: string; transition?: Transition; reveal?: Reveal }
export interface Deck { w: number; h: number; slides: Slide[]; theme?: string; font?: string }
const TRANSITIONS: [Transition, string][] = [["none", "None"], ["fade", "Fade"], ["slide", "Slide"], ["zoom", "Zoom"], ["rise", "Rise"]];

export function parseDeck(data: string): Deck {
	try {
		const d = JSON.parse(data || "{}") as Partial<Deck>;
		const slides: Slide[] = Array.isArray(d.slides) && d.slides.length ? d.slides : [newSlide("title")];
		return { w: d.w || 1600, h: d.h || 900, slides, theme: d.theme, font: d.font };
	} catch {
		return { w: 1600, h: 900, slides: [newSlide("title")] };
	}
}
export const serializeDeck = (d: Deck) => JSON.stringify({ type: "math-studio-slides", version: 1, ...d });

export function newSlide(layout = "content"): Slide {
	const l = LAYOUTS.find((x) => x.id === layout) ?? LAYOUTS[1];
	return { id: uid(), elements: l.make(), bg: "plain", layout: l.id };
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
		const mk = (parent: HTMLElement, icon: string, label: string, fn: (e: MouseEvent) => void, text?: string) => {
			const b = parent.createEl("button", { cls: "ms-tb-btn clickable-icon", attr: { "aria-label": label } });
			setIcon(b, icon); if (text) b.createSpan({ cls: "ms-tb-text", text });
			b.onclick = (e) => fn(e); return b;
		};
		mk(sideBar, "plus", "New slide (pick a layout)", () => this.pickLayout((id) => this.addSlide(this.current, id)), "Slide");
		mk(sideBar, "play", "Present (from this slide)", () => this.present(), "Present").addClass("mod-cta");
		if (this.plugin.settings.slideEffects) {
			mk(sideBar, "palette", "Theme: colours and fonts for the whole deck", (e) => this.themeMenu(e));
			mk(sideBar, "sparkles", "Effects: transitions and showing things one click at a time", (e) => this.effectsMenu(e));
		}
		this.listEl = side.createDiv("ms-slide-list");
		this.mainEl = c.createDiv("ms-slide-main");
		const holder = this.mainEl.createDiv("ms-slide-board");
		this.notesEl = this.mainEl.createEl("textarea", { cls: "ms-slide-notes", attr: { placeholder: "Speaker notes…", rows: "2" } });
		if (!this.plugin.settings.speakerNotes) this.notesEl.hide();
		this.notesEl.oninput = () => { this.deck.slides[this.current].notes = this.notesEl.value; this.markDirty(); };
		this.board = new Board(this.plugin, holder, { elements: [], bg: "plain" }, {
			sourcePath: this.file?.path ?? "",
			frame: { w: this.deck.w, h: this.deck.h },
				theme: this.theme(),
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
			box.setCssProps({ "--ms-aspect": `${this.deck.w} / ${this.deck.h}` });
			const b = new Board(this.plugin, box, { elements: s.elements, bg: s.bg }, { sourcePath: this.file?.path ?? "", frame: { w: this.deck.w, h: this.deck.h }, readOnly: true, theme: this.theme() });
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
			const copy = JSON.parse(JSON.stringify(this.deck.slides[i])) as Slide; copy.id = uid();
			copy.elements.forEach((el) => (el.id = uid()));
			this.deck.slides.splice(i + 1, 0, copy); this.markDirty(); this.current = i + 1; this.loadSlide(); this.renderThumbs();
		}));
		m.addItem((it) => it.setTitle("Move up").setIcon("arrow-up").setDisabled(i === 0).onClick(() => this.move(i, -1)));
		m.addItem((it) => it.setTitle("Move down").setIcon("arrow-down").setDisabled(i === this.deck.slides.length - 1).onClick(() => this.move(i, 1)));
		m.addSeparator();
		m.addItem((it) => it.setTitle("Delete slide").setIcon("trash-2").setDisabled(this.deck.slides.length < 2).onClick(() => this.deleteSlide(i)));
		m.showAtMouseEvent(e);
	}

		private theme() { return this.plugin.settings.slideEffects ? themeFor(this.deck.theme, this.deck.font) : null; }

	private themeMenu(e: MouseEvent) {
		const m = new Menu();
		m.addItem((it) => it.setTitle("Theme: Match Obsidian").setChecked(!this.deck.theme).onClick(() => this.setLook({ theme: undefined })));
		for (const t of THEMES) m.addItem((it) => it.setTitle("Theme: " + t.name).setChecked(this.deck.theme === t.id).onClick(() => this.setLook({ theme: t.id })));
		m.addSeparator();
		m.addItem((it) => it.setTitle("Font: from the theme").setChecked(!this.deck.font).onClick(() => this.setLook({ font: undefined })));
		for (const f of FONTS) m.addItem((it) => it.setTitle("Font: " + f.name).setChecked(this.deck.font === f.id).onClick(() => this.setLook({ font: f.id })));
		m.showAtMouseEvent(e);
	}
	private setLook(change: { theme?: string; font?: string }) {
		this.board?.commitText();
		if ("theme" in change) this.deck.theme = change.theme;
		if ("font" in change) this.deck.font = change.font;
		this.markDirty();
		this.build();
	}

	private effectsMenu(e: MouseEvent) {
		const s = this.deck.slides[this.current];
		const m = new Menu();
		for (const [id, name] of TRANSITIONS) m.addItem((it) => it.setTitle("Transition into this slide: " + name).setChecked((s.transition ?? "none") === id).onClick(() => { s.transition = id; this.markDirty(); }));
		m.addItem((it) => it.setTitle("Use this transition on every slide").setIcon("copy").onClick(() => { this.deck.slides.forEach((x) => (x.transition = s.transition)); this.markDirty(); new Notice("Transition applied to every slide."); }));
		m.addSeparator();
		m.addItem((it) => it.setTitle("Show everything at once").setChecked(!s.reveal).onClick(() => { s.reveal = undefined; this.markDirty(); }));
		m.addItem((it) => it.setTitle("Show bullets one click at a time").setChecked(s.reveal === "bullets").onClick(() => { s.reveal = "bullets"; this.markDirty(); }));
		m.addItem((it) => it.setTitle("Show each object one click at a time").setChecked(s.reveal === "objects").onClick(() => { s.reveal = "objects"; this.markDirty(); }));
		m.addItem((it) => it.setTitle("Use this on every slide").setIcon("copy").onClick(() => { this.deck.slides.forEach((x) => (x.reveal = s.reveal)); this.markDirty(); new Notice("Applied to every slide."); }));
		m.showAtMouseEvent(e);
	}

	private pickLayout(done: (id: string) => void) {
		this.board?.commitText();
		new LayoutPicker(this.app, this.plugin, this.file?.path ?? "", (l) => done(l.id), this.theme()).open();
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
		new Presenter(this.plugin, this.deck, this.file?.path ?? "", start, this.theme()).open();
	}

	async onClose() { this.thumbs.forEach((t) => this.removeChild(t)); if (this.board) this.removeChild(this.board); this.board = null; }
}

type InkTool = "none" | "pen" | "highlighter" | "laser";
const INK_PEN = ["#e03131", "#1971c2", "#2f9e44", "#ffffff", "#f08c00"];
const INK_HL = ["#ffd43b", "#8ce99a", "#faa2c1", "#74c0fc"];
const SVG_NS = "http://www.w3.org/2000/svg";

/** Full-screen presentation. Arrow keys / space / tap / swipe to move, and you can draw on the slide while presenting. */
export class Presenter extends Component {
	private el!: HTMLElement;
	private board: Board | null = null;
	private i: number;
	private counter!: HTMLElement;
	// drawing while presenting
	private inkTool: InkTool = "none";
	private penColor = INK_PEN[0];
	private hlColor = INK_HL[0];
	private inkLayer!: HTMLElement;
	private inkSvg!: SVGSVGElement;
	private laser!: HTMLElement;
	private laserTrail!: SVGPathElement;
	private trail: { x: number; y: number; t: number }[] = [];
	private trailFrame = 0;
	private ink = new Map<number, StrokeEl[]>();
	private penSeen = false;
	private inkBtns = new Map<string, HTMLElement>();
	private swatchBar!: HTMLElement;
	private bar!: HTMLElement;

	private units: HTMLElement[] = [];
	private shown = 0;
	private ready = false;

	constructor(private plugin: BitsAndBobs, private deck: Deck, private sourcePath: string, start: number, private theme: Theme | null = null) { super(); this.i = start; }

	open() {
		this.el = activeDocument.body.createDiv("ms-present");
		const stage = this.el.createDiv("ms-present-stage");
		const draw = this.plugin.settings.presentDraw;
		if (draw) this.buildInkLayer();
		const bar = (this.bar = this.el.createDiv("ms-present-bar"));
		const b = (icon: string, label: string, fn: () => void, key?: string) => {
			const x = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
			setIcon(x, icon);
			x.onclick = (e) => { e.stopPropagation(); fn(); };
			if (key) this.inkBtns.set(key, x);
			return x;
		};
		b("chevron-left", "Previous", () => this.step(-1));
		this.counter = bar.createSpan("ms-present-count");
		b("chevron-right", "Next", () => this.step(1));
		if (draw) {
			bar.createSpan("ms-present-sep");
			b("pen-tool", "Pen (P)", () => this.setInk("pen"), "pen");
			b("highlighter", "Highlighter (H)", () => this.setInk("highlighter"), "highlighter");
			b("target", "Laser pointer (L)", () => this.setInk("laser"), "laser");
			b("eraser", "Clear drawing on this slide (C)", () => this.clearInk());
			this.swatchBar = bar.createSpan("ms-present-swatches");
		}
		bar.createSpan("ms-present-sep");
		b("x", "Exit (Esc)", () => this.close());
		super.load();
		this.registerDomEvent(activeDocument, "keydown", (e) => {
			const k = e.key.toLowerCase();
			if (["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); this.step(1); }
			else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); this.step(-1); }
			else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (this.inkTool !== "none") this.setInk("none"); else this.close(); }
			else if (draw && !e.metaKey && !e.ctrlKey && !e.altKey && ["p", "h", "l", "c", "e"].includes(k)) {
				e.preventDefault(); e.stopPropagation();
				if (k === "c" || k === "e") this.clearInk();
				else { const t: InkTool = k === "p" ? "pen" : k === "h" ? "highlighter" : "laser"; this.setInk(this.inkTool === t ? "none" : t); }
			}
		}, { capture: true });
		let sx = 0, sy = 0;
		this.registerDomEvent(stage, "pointerdown", (e) => { sx = e.clientX; sy = e.clientY; });
		this.registerDomEvent(stage, "pointerup", (e) => {
			const dx = e.clientX - sx, dy = e.clientY - sy;
			if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) this.step(dx < 0 ? 1 : -1);
			else if (Math.hypot(dx, dy) < 8 && e.pointerType !== "pen") this.step(e.clientX > window.innerWidth / 3 ? 1 : -1);
		});
		this.registerDomEvent(activeDocument, "fullscreenchange", () => { if (!activeDocument.fullscreenElement && this.el.isConnected && !Platform.isMobile) this.close(); });
		if (!Platform.isMobile && this.plugin.settings.presentFullscreen) this.el.requestFullscreen?.().catch(() => {});
		this.show();
		this.syncInk();
	}

	// ---------- drawing on top of the slide ----------
	private buildInkLayer() {
		this.inkLayer = this.el.createDiv("ms-present-ink");
		this.inkSvg = activeDocument.createElementNS(SVG_NS, "svg");
		this.inkSvg.addClass("ms-present-ink-svg");
		this.inkLayer.appendChild(this.inkSvg);
		this.laserTrail = activeDocument.createElementNS(SVG_NS, "path");
		this.laserTrail.addClass("ms-laser-trail");
		this.inkSvg.appendChild(this.laserTrail);
		this.laser = this.inkLayer.createDiv("ms-laser");
		let cur: { el: StrokeEl; path: SVGPathElement } | null = null;
		const pos = (e: PointerEvent) => { const r = this.inkLayer.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
		const moveLaser = (e: PointerEvent) => {
			const { x, y } = pos(e);
			this.laser.setCssProps({ left: x + "px", top: y + "px" }); this.laser.addClass("is-on");
			this.trail.push({ x, y, t: performance.now() });
			if (!this.trailFrame) this.trailFrame = window.requestAnimationFrame(() => this.drawTrail());
		};
		this.registerDomEvent(this.inkLayer, "pointerdown", (e) => {
			e.preventDefault(); e.stopPropagation();
			if (e.pointerType === "pen") this.penSeen = true;
			if (this.inkTool === "laser") { moveLaser(e); return; }
			if (e.pointerType === "touch" && this.penSeen) return; // palm: ignore once a pen is in use
			try { this.inkLayer.setPointerCapture(e.pointerId); } catch { /* ignore */ }
			const { x, y } = pos(e);
			const hl = this.inkTool === "highlighter";
			const isPen = e.pointerType === "pen" && e.pressure > 0 && this.plugin.settings.pressure;
			const el: StrokeEl = { id: uid(), type: "stroke", pts: [[x, y, isPen ? e.pressure : 0.5]], color: hl ? this.hlColor : this.penColor, size: hl ? 26 : 5, ...(hl ? { hl: true } : {}), ...(isPen && !hl ? { pen: true } : {}) };
			cur = { el, path: this.addInkPath(el) };
		});
		this.registerDomEvent(this.inkLayer, "pointermove", (e) => {
			if (this.inkTool === "laser") { moveLaser(e); return; }
			if (!cur) return;
			for (const ev of typeof e.getCoalescedEvents === "function" && e.getCoalescedEvents().length ? e.getCoalescedEvents() : [e]) {
				const { x, y } = pos(ev);
				cur.el.pts.push([x, y, cur.el.pen ? Math.max(0.05, ev.pressure) : 0.5]);
			}
			cur.path.setAttribute("d", strokePath(cur.el));
		});
		const end = () => {
			if (cur) { const list = this.ink.get(this.i) ?? []; list.push(cur.el); this.ink.set(this.i, list); cur = null; }
		};
		this.registerDomEvent(this.inkLayer, "pointerup", end);
		this.registerDomEvent(this.inkLayer, "pointercancel", end);
		this.registerDomEvent(this.inkLayer, "pointerleave", () => { if (this.inkTool === "laser") this.laser.removeClass("is-on"); });
	}

	private addInkPath(el: StrokeEl) {
		const g = activeDocument.createElementNS(SVG_NS, "path");
		g.setAttribute("d", strokePath(el));
		g.setCssStyles({ fill: el.color });
		if (el.hl) g.addClass("is-hl");
		this.inkSvg.insertBefore(g, this.laserTrail);
		return g;
	}

	private drawTrail() {
		this.trailFrame = 0;
		const now = performance.now();
		this.trail = this.trail.filter((p) => now - p.t < 450);
		this.laserTrail.setAttribute("d", this.trail.length > 1 ? this.trail.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") : "");
		if (this.trail.length) this.trailFrame = window.requestAnimationFrame(() => this.drawTrail());
	}

	private renderInk() {
		if (!this.inkSvg) return;
		this.inkSvg.querySelectorAll("path:not(.ms-laser-trail)").forEach((n) => n.remove());
		for (const el of this.ink.get(this.i) ?? []) this.addInkPath(el);
	}

	private clearInk() {
		this.ink.delete(this.i);
		this.renderInk();
	}

	private setInk(t: InkTool) {
		this.inkTool = t;
		this.syncInk();
	}

	private syncInk() {
		if (!this.inkLayer) return;
		this.inkLayer.toggleClass("is-active", this.inkTool !== "none");
		this.inkLayer.dataset.tool = this.inkTool;
		this.el.toggleClass("is-inking", this.inkTool !== "none");
		for (const [k, b] of this.inkBtns) b.toggleClass("is-active", k === this.inkTool);
		if (this.inkTool !== "laser") { this.laser.removeClass("is-on"); this.trail = []; this.laserTrail.setAttribute("d", ""); }
		this.swatchBar.empty();
		const colours = this.inkTool === "pen" ? INK_PEN : this.inkTool === "highlighter" ? INK_HL : [];
		for (const c of colours) {
			const sw = this.swatchBar.createEl("button", { cls: "ms-present-swatch", attr: { "aria-label": c } });
			sw.setCssStyles({ background: c });
			sw.toggleClass("is-active", c === (this.inkTool === "pen" ? this.penColor : this.hlColor));
			sw.onclick = (e) => { e.stopPropagation(); if (this.inkTool === "pen") this.penColor = c; else this.hlColor = c; this.syncInk(); };
		}
	}

		private show(full = false, back = false) {
		const stage = this.el.querySelector(".ms-present-stage") as HTMLElement;
		if (this.board) this.removeChild(this.board);
		stage.empty();
		const s = this.deck.slides[this.i];
		const effects = this.plugin.settings.slideEffects;
		const b = new Board(this.plugin, stage, { elements: s.elements, bg: s.bg }, { sourcePath: this.sourcePath, frame: { w: this.deck.w, h: this.deck.h }, readOnly: true, theme: this.theme });
		this.board = b;
		this.addChild(b);
		this.units = []; this.shown = 0; this.ready = false;
		if (effects && s.transition && s.transition !== "none") b.root.addClass("ms-tr-" + s.transition, back ? "is-back" : "is-fwd");
		if (effects && s.reveal) void b.whenRendered().then(() => { if (this.board === b) this.prepareReveal(s, b, full); });
		else this.ready = true;
		this.counter.setText(`${this.i + 1} / ${this.deck.slides.length}`);
		this.renderInk();
	}
		/** the things that appear one click at a time on this slide */
	private prepareReveal(s: Slide, b: Board, full: boolean) {
		let units: HTMLElement[];
		if (s.reveal === "bullets") units = Array.from(b.world.querySelectorAll<HTMLElement>(".ms-text li"));
		else {
			const first = s.elements[0];
			const skip = first && first.type === "text" && /^\s*#/.test(first.text) ? first.id : "";
			units = Array.from(b.world.querySelectorAll<HTMLElement>(":scope > [data-id]")).filter((n) => n.dataset.id !== skip);
		}
		this.units = units;
		this.shown = full ? units.length : 0;
		if (!full) units.forEach((u) => u.addClass("ms-step-hidden"));
		this.ready = true;
	}

	/** next / previous click: reveals the next thing on the slide, or moves to another slide */
	private step(d: 1 | -1) {
		if (d === 1) {
			if (this.ready && this.shown < this.units.length) {
				const u = this.units[this.shown++];
				u.removeClass("ms-step-hidden");
				u.addClass("ms-step-in");
				return;
			}
			this.go(this.i + 1);
		} else {
			if (this.ready && this.shown > 0) { this.units[--this.shown].addClass("ms-step-hidden"); return; }
			this.go(this.i - 1, true);
		}
	}

	private go(i: number, back = false) {
		if (i >= this.deck.slides.length) { this.close(); return; }
		if (i < 0) return;
		this.i = i; this.show(back, back);
	}
	close() {
		if (this.trailFrame) window.cancelAnimationFrame(this.trailFrame);
		if (activeDocument.fullscreenElement) activeDocument.exitFullscreen().catch(() => {});
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
			onOpenFull: () => { void plugin.app.workspace.getLeaf("tab").openFile(file); },
			onChange: (doc) => {
				window.clearTimeout(timer);
				timer = window.setTimeout(() => { lastSaved = serializeBoard(doc); void plugin.app.vault.process(file, () => lastSaved); }, 600);
			},
		});
		parent.addChild(board);
	};
	parent.registerEvent(plugin.app.vault.on("modify", (f) => { if (f === file) void load(); }));
	parent.register(() => { if (timer && board) { window.clearTimeout(timer); const data = serializeBoard(board.doc); void plugin.app.vault.process(file, () => data); } });
	load().catch((e) => { console.error(e); new Notice("Couldn't open board"); });
}
