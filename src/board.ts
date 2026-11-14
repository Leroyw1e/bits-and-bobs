import { Component, MarkdownRenderer, Menu, Modal, Notice, Platform, Setting, TFile, FuzzySuggestModal, setIcon, App } from "obsidian";
import { getStroke } from "perfect-freehand";
import type BitsAndBobs from "./main";
import { MathPalette, insertInField, matchTool, MATH_GROUPS } from "./math";
import { recognizeShape, Pt2 } from "./shapes";
import { ChartSpec, openChartDialog, specToData, themeFromCss } from "./chartdialog";
import { renderChart } from "./charts";
import { parseGraphLine, GraphItem } from "./graphs";

// ---------- data ----------
export type Pt = [number, number, number];
export interface StrokeEl { id: string; type: "stroke"; pts: Pt[]; color: string; size: number; hl?: boolean; pen?: boolean }
export interface ShapeEl { id: string; type: "shape"; kind: "rect" | "ellipse" | "line" | "arrow" | "poly"; x: number; y: number; w: number; h: number; color: string; size: number; fill?: boolean; pts?: [number, number][] }
export interface TextEl { id: string; type: "text"; x: number; y: number; w: number; text: string; color: string; fs: number; align?: "left" | "center" | "right" }
export interface ImageEl { id: string; type: "image"; x: number; y: number; w: number; h: number; src: string }
export interface GraphEl { id: string; type: "graph"; x: number; y: number; w: number; h: number; fns: string[]; xmin: number; xmax: number; ymin: number; ymax: number }
export type ChartEl = { id: string; type: "chart"; x: number; y: number; w: number; h: number } & ChartSpec;
export type El = StrokeEl | ShapeEl | TextEl | ImageEl | GraphEl | ChartEl;
export type Bg = "plain" | "grid" | "dots" | "lines";
export interface BoardDoc { elements: El[]; bg?: Bg }

export type Tool = "select" | "lasso" | "trace" | "hand" | "pen" | "highlighter" | "eraser" | "text" | "rect" | "ellipse" | "line" | "arrow";

export const INKS = ["ink", "#e03131", "#1971c2", "#2f9e44", "#f08c00", "#9c36b5"];
export const HIGHLIGHTS = ["#ffd43b", "#8ce99a", "#faa2c1", "#74c0fc"];
const PEN_SIZES = [2, 4, 8, 14];
const HL_SIZES = [12, 20, 30, 44];
const GRAPH_COLOURS = ["#1971c2", "#e03131", "#2f9e44", "#9c36b5", "#f08c00"];

export const uid = () => Math.random().toString(36).slice(2, 10);
const paint = (c: string) => (c === "ink" ? "var(--ms-ink)" : c);
const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
	const e = document.createElementNS(SVGNS, tag);
	for (const k in attrs) e.setAttribute(k, String(attrs[k]));
	return e;
};

export function strokePath(el: StrokeEl): string {
	const outline = getStroke(el.pts, {
		size: el.size,
		thinning: el.hl ? 0 : el.pen ? 0.65 : 0.5,
		smoothing: 0.5,
		streamline: el.pen ? 0.35 : 0.5,
		simulatePressure: !el.pen && !el.hl,
		last: true,
	});
	if (!outline.length) return "";
	if (outline.length < 4) {
		const [x, y] = el.pts[0];
		const r = el.size / 2;
		return `M ${x - r} ${y} a ${r} ${r} 0 1 0 ${2 * r} 0 a ${r} ${r} 0 1 0 ${-2 * r} 0`;
	}
	const d = outline.reduce<(string | number)[]>(
		(acc, [x0, y0], i, arr) => {
			const [x1, y1] = arr[(i + 1) % arr.length];
			acc.push(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
			return acc;
		},
		["M", ...outline[0], "Q"],
	);
	d.push("Z");
	return d.map((v) => (typeof v === "number" ? v.toFixed(2) : v)).join(" ");
}

function distSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
	const dx = bx - ax, dy = by - ay;
	const l2 = dx * dx + dy * dy;
	let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inPoly(x: number, y: number, poly: Pt2[]) {
	let inside = false;
	for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
		const [xi, yi] = poly[i], [xj, yj] = poly[j];
		if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
	}
	return inside;
}

export interface BoardOpts {
	sourcePath: string;
	frame?: { w: number; h: number };
	readOnly?: boolean;
	compact?: boolean;
	onChange?: (doc: BoardDoc) => void;
	onOpenFull?: () => void;
}

interface Box { x: number; y: number; w: number; h: number }

/** A stroke that the pen has been held on, and that has been snapped to a clean shape. */
interface SnapState { shape: ShapeEl | null; stroke: StrokeEl | null; node: Element; line: boolean }

type Action =
	| { kind: "draw"; el: StrokeEl; node: SVGPathElement; holdTimer: number; ax: number; ay: number; snap: SnapState | null }
	| { kind: "lasso"; pts: Pt2[]; node: SVGPolygonElement; svg: SVGSVGElement }
	| { kind: "trace" }
	| { kind: "erase"; removed: boolean }
	| { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
	| { kind: "pinch"; d0: number; cx: number; cy: number; vx: number; vy: number; z: number }
	| { kind: "move"; sx: number; sy: number; orig: Map<string, string>; moved: boolean }
	| { kind: "resize"; id: string; sx: number; sy: number; orig: string }
	| { kind: "marquee"; sx: number; sy: number; box: HTMLElement; add: boolean }
	| { kind: "shape"; el: ShapeEl; sx: number; sy: number };

export class Board extends Component {
	root: HTMLElement;
	viewport: HTMLElement;
	world: HTMLElement;
	selLayer: HTMLElement;
	toolbar?: HTMLElement;
	doc: BoardDoc;
	vx = 0; vy = 0; z = 1;
	tool: Tool = "pen";
	color = "ink";
	hlColor = HIGHLIGHTS[0];
	penSize = 4;
	hlSize = 20;
	selection = new Set<string>();
	private nodes = new Map<string, Element>();
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private pointers = new Map<number, { x: number; y: number; type: string }>();
	private action: Action | null = null;
	private penSeen = false;
	private lastTap = { t: 0, x: 0, y: 0 };
	private spaceDown = false;
	private editing: { el: TextEl; ta: HTMLTextAreaElement } | null = null;
	private fitted = false;
	private userZoomed = false;
	private toolButtons = new Map<string, HTMLElement>();
	private swatchRow?: HTMLElement;
	private sizeRow?: HTMLElement;
	private renderToken = 0;
	private traceLayer?: HTMLElement;

	constructor(private plugin: BitsAndBobs, host: HTMLElement, doc: BoardDoc, private opts: BoardOpts) {
		super();
		this.doc = doc;
		const s = plugin.settings;
		this.tool = opts.readOnly ? "hand" : "pen";
		this.penSize = s.penSize;
		this.root = host.createDiv({ cls: "ms-board" + (opts.readOnly ? " is-static" : "") + (opts.compact ? " is-compact" : "") + (opts.frame ? " has-frame" : "") });
		if (!opts.readOnly) {
			this.root.tabIndex = 0;
			this.buildToolbar();
		}
		this.viewport = this.root.createDiv("ms-viewport");
		this.world = this.viewport.createDiv("ms-world");
		this.selLayer = createDiv("ms-sel-layer");
	}

	onload() {
		const ro = new ResizeObserver(() => {
			const r = this.viewport.getBoundingClientRect();
			if (!r.width || !r.height) return;
			if (!this.fitted || (this.opts.frame && !this.userZoomed)) { this.fit(); this.fitted = true; }
		});
		ro.observe(this.viewport);
		this.register(() => ro.disconnect());
		this.renderAll();
		if (this.opts.readOnly) return;

		const vp = this.viewport;
		this.registerDomEvent(vp, "pointerdown", (e) => this.onDown(e));
		this.registerDomEvent(vp, "pointermove", (e) => this.onMove(e));
		this.registerDomEvent(vp, "pointerup", (e) => this.onUp(e));
		this.registerDomEvent(vp, "pointercancel", (e) => this.onUp(e, true));
		this.registerDomEvent(vp, "contextmenu", (e) => { if (this.tool !== "select") e.preventDefault(); });
		// Stop iOS from scrolling / magnifying while drawing with the Pencil
		this.registerDomEvent(vp, "touchstart", (e) => { if (!this.editing) e.preventDefault(); }, { passive: false });
		this.registerDomEvent(vp, "touchmove", (e) => e.preventDefault(), { passive: false });
		this.registerDomEvent(vp, "wheel", (e) => this.onWheel(e), { passive: false });
		this.registerDomEvent(this.root, "keydown", (e) => this.onKey(e));
		this.registerDomEvent(this.root, "keyup", (e) => { if (e.code === "Space") { this.spaceDown = false; this.root.removeClass("is-panning"); } });
		this.registerDomEvent(this.root, "paste", (e) => this.onPaste(e));
		this.registerDomEvent(vp, "dragover", (e) => e.preventDefault());
		this.registerDomEvent(vp, "drop", (e) => this.onDrop(e));
	}

	onunload() {
		if (this.editing) this.commitText();
		this.root.remove();
	}

	// ---------- public ----------
	setDoc(doc: BoardDoc, keepView = false) {
		if (this.editing) { this.editing.ta.remove(); this.editing = null; }
		this.doc = doc;
		this.selection.clear();
		this.undoStack = []; this.redoStack = [];
		this.renderAll();
		if (!keepView) { this.userZoomed = false; this.fit(); }
	}

	fit() {
		const r = this.viewport.getBoundingClientRect();
		if (!r.width || !r.height) return;
		let box: Box | null = null;
		if (this.opts.frame) box = { x: 0, y: 0, w: this.opts.frame.w, h: this.opts.frame.h };
		else {
			for (const el of this.doc.elements) {
				const b = this.bbox(el);
				if (!box) { box = b; continue; }
				const x = Math.min(box.x, b.x), y = Math.min(box.y, b.y);
				box = { x, y, w: Math.max(box.x + box.w, b.x + b.w) - x, h: Math.max(box.y + box.h, b.y + b.h) - y };
			}
		}
		if (!box) { this.z = 1; this.vx = 0; this.vy = 0; this.applyView(); return; }
		const pad = this.opts.frame ? (this.opts.readOnly ? 0 : 24) : 40;
		const z = Math.min((r.width - pad * 2) / Math.max(box.w, 1), (r.height - pad * 2) / Math.max(box.h, 1), this.opts.frame ? 10 : 1.5);
		this.z = Math.max(0.05, z);
		this.vx = (r.width - box.w * this.z) / 2 - box.x * this.z;
		this.vy = (r.height - box.h * this.z) / 2 - box.y * this.z;
		this.applyView();
	}

	// ---------- rendering ----------
	applyView() {
		this.world.style.transform = `translate(${this.vx}px, ${this.vy}px) scale(${this.z})`;
		this.root.style.setProperty("--ms-z", String(this.z));
		const bg = this.doc.bg ?? "plain";
		const target = this.opts.frame ? null : this.viewport;
		if (target) {
			target.dataset.bg = bg;
			const step = 32 * this.z;
			target.style.backgroundSize = `${step}px ${step}px`;
			target.style.backgroundPosition = `${this.vx}px ${this.vy}px`;
		}
	}

	renderAll() {
		const token = ++this.renderToken;
		this.world.empty();
		this.nodes.clear();
		if (this.opts.frame) {
			const f = this.world.createDiv("ms-frame");
			f.style.width = this.opts.frame.w + "px";
			f.style.height = this.opts.frame.h + "px";
			f.dataset.bg = this.doc.bg ?? "plain";
		}
		for (const el of this.doc.elements) this.world.appendChild(this.makeNode(el, token));
		this.world.appendChild(this.selLayer);
		this.applyView();
		this.drawSelection();
	}

	private makeNode(el: El, token = this.renderToken): Element {
		let node: Element;
		if (el.type === "stroke") {
			const svg = svgEl("svg", { class: "ms-svg" + (el.hl ? " is-hl" : "") });
			const p = svgEl("path", { d: strokePath(el) });
			p.style.fill = el.hl ? el.color : paint(el.color);
			svg.appendChild(p);
			node = svg;
		} else if (el.type === "shape") {
			node = this.shapeSvg(el);
		} else if (el.type === "text") {
			const d = createDiv("ms-text");
			this.placeText(d, el);
			MarkdownRenderer.render(this.plugin.app, el.text || " ", d, this.opts.sourcePath, this).then(() => {
				if (token !== this.renderToken) return;
				if (this.selection.has(el.id)) this.drawSelection();
			});
			node = d;
		} else if (el.type === "image") {
			const d = createDiv("ms-image");
			d.style.cssText = `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
			const img = d.createEl("img", { attr: { draggable: "false", alt: "" } });
			img.src = this.resolveImage(el.src);
			if (isHeic(el.src.split(".").pop() ?? "", "") && !this.opts.readOnly) img.onerror = () => this.convertHeicImage(el);
			node = d;
		} else {
			node = el.type === "chart" ? this.chartNode(el) : this.graphNode(el);
		}
		(node as HTMLElement).dataset.id = el.id;
		this.nodes.set(el.id, node);
		return node;
	}

	private placeText(d: HTMLElement, el: TextEl) {
		d.style.cssText = `left:${el.x}px;top:${el.y}px;width:${el.w}px;font-size:${el.fs}px;color:${paint(el.color)};text-align:${el.align ?? "left"}`;
	}

	private shapeSvg(el: ShapeEl): SVGSVGElement {
		const svg = svgEl("svg", { class: "ms-svg" });
		const stroke = paint(el.color);
		const common = { "stroke-width": el.size, "stroke-linecap": "round", "stroke-linejoin": "round", fill: "none" };
		const x = Math.min(el.x, el.x + el.w), y = Math.min(el.y, el.y + el.h), w = Math.abs(el.w), h = Math.abs(el.h);
		let s: SVGElement;
		if (el.kind === "rect") s = svgEl("rect", { ...common, x, y, width: w, height: h, rx: 4 });
		else if (el.kind === "ellipse") s = svgEl("ellipse", { ...common, cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 });
		else if (el.kind === "poly" && el.pts) s = svgEl("polygon", { ...common, points: el.pts.map((q) => q.join(",")).join(" ") });
		else {
			const g = svgEl("g", common);
			g.appendChild(svgEl("line", { x1: el.x, y1: el.y, x2: el.x + el.w, y2: el.y + el.h }));
			if (el.kind === "arrow") {
				const ang = Math.atan2(el.h, el.w), L = 10 + el.size * 2.5;
				const ex = el.x + el.w, ey = el.y + el.h;
				g.appendChild(svgEl("polyline", { points: `${ex - L * Math.cos(ang - 0.45)},${ey - L * Math.sin(ang - 0.45)} ${ex},${ey} ${ex - L * Math.cos(ang + 0.45)},${ey - L * Math.sin(ang + 0.45)}` }));
			}
			s = g;
		}
		s.style.stroke = stroke;
		if (el.fill && (el.kind === "rect" || el.kind === "ellipse" || el.kind === "poly")) { s.style.fill = stroke; s.style.fillOpacity = "0.15"; }
		svg.appendChild(s);
		return svg;
	}

	private graphNode(el: GraphEl): HTMLElement {
		const d = createDiv("ms-graph");
		d.style.cssText = `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
		const svg = svgEl("svg", { viewBox: `0 0 ${el.w} ${el.h}`, width: el.w, height: el.h });
		const sx = (x: number) => ((x - el.xmin) / (el.xmax - el.xmin)) * el.w;
		const sy = (y: number) => el.h - ((y - el.ymin) / (el.ymax - el.ymin)) * el.h;
		// grid
		const stepFor = (span: number) => { const raw = span / 10; const p = Math.pow(10, Math.floor(Math.log10(raw))); return [1, 2, 5, 10].map((m) => m * p).find((s) => s >= raw) ?? p * 10; };
		const gx = stepFor(el.xmax - el.xmin), gy = stepFor(el.ymax - el.ymin);
		const grid = svgEl("g", { class: "ms-graph-grid" });
		for (let x = Math.ceil(el.xmin / gx) * gx; x <= el.xmax; x += gx) grid.appendChild(svgEl("line", { x1: sx(x), y1: 0, x2: sx(x), y2: el.h }));
		for (let y = Math.ceil(el.ymin / gy) * gy; y <= el.ymax; y += gy) grid.appendChild(svgEl("line", { x1: 0, y1: sy(y), x2: el.w, y2: sy(y) }));
		svg.appendChild(grid);
		const shadeG = svgEl("g");
		svg.appendChild(shadeG);
		const axes = svgEl("g", { class: "ms-graph-axes" });
		if (el.ymin <= 0 && el.ymax >= 0) axes.appendChild(svgEl("line", { x1: 0, y1: sy(0), x2: el.w, y2: sy(0) }));
		if (el.xmin <= 0 && el.xmax >= 0) axes.appendChild(svgEl("line", { x1: sx(0), y1: 0, x2: sx(0), y2: el.h }));
		svg.appendChild(axes);
		const labels = svgEl("g", { class: "ms-graph-labels" });
		const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
		const ly = Math.min(Math.max(sy(0) + 13, 13), el.h - 3), lx = Math.min(Math.max(sx(0) + 3, 3), el.w - 30);
		for (let x = Math.ceil(el.xmin / gx) * gx; x <= el.xmax; x += gx) if (Math.abs(x) > gx / 2) { const t = svgEl("text", { x: sx(x) + 2, y: ly }); t.textContent = fmt(x); labels.appendChild(t); }
		for (let y = Math.ceil(el.ymin / gy) * gy; y <= el.ymax; y += gy) if (Math.abs(y) > gy / 2) { const t = svgEl("text", { x: lx, y: sy(y) - 2 }); t.textContent = fmt(y); labels.appendChild(t); }
		svg.appendChild(labels);
		const items = this.graphItems(el);
		const legend = d.createDiv("ms-graph-legend");
		const N = Math.max(240, Math.round(el.w));
		const clampY = (y: number) => Math.max(-1e4, Math.min(1e4, sy(y)));
		/** Runs of the curve that are finite, as arrays of screen points. */
		const runs = (f: (x: number) => number): [number, number][][] => {
			const out: [number, number][][] = []; let cur: [number, number][] = []; let prev = NaN;
			for (let k = 0; k <= N; k++) {
				const x = el.xmin + ((el.xmax - el.xmin) * k) / N, y = f(x);
				const jump = isFinite(prev) && isFinite(y) && Math.abs(y - prev) > (el.ymax - el.ymin) * 2;
				if (!isFinite(y) || jump) { if (cur.length) out.push(cur); cur = []; }
				if (isFinite(y)) cur.push([sx(x), clampY(y)]);
				prev = y;
			}
			if (cur.length) out.push(cur);
			return out;
		};
		const line = (pts: [number, number][]) => pts.map((q, i) => `${i ? "L" : "M"}${q[0].toFixed(1)} ${q[1].toFixed(1)}`).join(" ");
		el.fns.forEach((src, i) => {
			const item = items[i];
			const colour = GRAPH_COLOURS[i % GRAPH_COLOURS.length];
			const row = legend.createDiv("ms-graph-legend-item");
			row.style.color = colour;
			if (!item) { row.setText("⚠ " + src); return; }
			row.setText(item.label.length > 34 ? item.label.slice(0, 33) + "…" : item.label);
			if (item.kind === "curve" || item.kind === "shade") {
				const rs = runs(item.f);
				if (item.kind === "shade") {
					const edge = item.above ? 0 : el.h;
					for (const r of rs) {
						const d2 = `${line(r)} L${r[r.length - 1][0].toFixed(1)} ${edge} L${r[0][0].toFixed(1)} ${edge} Z`;
						const sh = svgEl("path", { d: d2, class: "ms-graph-shade" });
						sh.style.fill = colour;
						shadeG.appendChild(sh);
					}
				}
				const p = svgEl("path", { d: rs.map(line).join(" "), class: "ms-graph-curve" });
				p.style.stroke = colour;
				if (item.kind === "shade" && item.strict) p.setAttribute("stroke-dasharray", "7 5");
				svg.appendChild(p);
			} else if (item.kind === "vline") {
				const v = svgEl("line", { x1: sx(item.x), y1: 0, x2: sx(item.x), y2: el.h, class: "ms-graph-curve" });
				v.style.stroke = colour;
				svg.appendChild(v);
			} else {
				for (const pt of item.pts) {
					const c = svgEl("circle", { cx: sx(pt.x), cy: sy(pt.y), r: 5, class: "ms-graph-point" });
					c.style.fill = colour;
					svg.appendChild(c);
					const t = svgEl("text", { x: sx(pt.x) + 8, y: sy(pt.y) - 7, class: "ms-graph-point-label" });
					t.textContent = pt.name ? `${pt.name} (${fmt(pt.x)}, ${fmt(pt.y)})` : `(${fmt(pt.x)}, ${fmt(pt.y)})`;
					t.style.fill = colour;
					svg.appendChild(t);
				}
			}
		});
		d.prepend(svg);
		return d;
	}

	/** One parsed item per line of the graph's editor (null for lines that can't be read). */
	graphItems(el: GraphEl): (GraphItem | null)[] { return el.fns.map((src) => parseGraphLine(src)); }

	// ---------- tracing a graph: drag over it to read values ----------
	private clearTrace() { this.traceLayer?.remove(); this.traceLayer = undefined; }

	private traceAt(x: number, y: number) {
		this.clearTrace();
		const g = [...this.doc.elements].reverse().find((e) => e.type === "graph" && x >= e.x && x <= e.x + e.w && y >= e.y && y <= e.y + e.h) as GraphEl | undefined;
		if (!g) return;
		const items = this.graphItems(g);
		const sx = (v: number) => ((v - g.xmin) / (g.xmax - g.xmin)) * g.w;
		const sy = (v: number) => g.h - ((v - g.ymin) / (g.ymax - g.ymin)) * g.h;
		let gx = g.xmin + ((x - g.x) / g.w) * (g.xmax - g.xmin);
		const snapR = 14 / this.z;
		let snapped: { x: number; y: number; name: string } | null = null;
		for (const it of items) if (it?.kind === "points") for (const p of it.pts) if (Math.abs(g.x + sx(p.x) - x) < snapR && Math.abs(g.y + sy(p.y) - y) < snapR) { snapped = p; gx = p.x; }
		const fmtv = (v: number) => String(Math.round(v * 1000) / 1000);
		const layer = this.world.createDiv("ms-trace");
		layer.style.cssText = `left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px`;
		const svg = svgEl("svg", { viewBox: `0 0 ${g.w} ${g.h}`, width: g.w, height: g.h });
		svg.appendChild(svgEl("line", { x1: sx(gx), y1: 0, x2: sx(gx), y2: g.h, class: "ms-trace-line" }));
		const read = layer.createDiv("ms-trace-read");
		read.createDiv({ cls: "ms-trace-x", text: `x = ${fmtv(gx)}` });
		items.forEach((it, i) => {
			if (!it) return;
			const colour = GRAPH_COLOURS[i % GRAPH_COLOURS.length];
			if (it.kind === "curve" || it.kind === "shade") {
				const v = it.f(gx);
				if (!Number.isFinite(v)) return;
				const row = read.createDiv({ text: `y = ${fmtv(v)}` });
				row.style.color = colour;
				const c = svgEl("circle", { cx: sx(gx), cy: Math.max(-50, Math.min(g.h + 50, sy(v))), r: 5, class: "ms-trace-dot" });
				c.style.fill = colour;
				svg.appendChild(c);
			}
		});
		if (snapped) read.createDiv({ cls: "ms-trace-x", text: snapped.name ? `${snapped.name} (${fmtv(snapped.x)}, ${fmtv(snapped.y)})` : `(${fmtv(snapped.x)}, ${fmtv(snapped.y)})` });
		layer.prepend(svg);
		// keep the readout a constant size on screen and inside the graph
		const left = sx(gx) > g.w * 0.6;
		read.style.cssText = `transform:scale(${1 / this.z});transform-origin:${left ? "top right" : "top left"};${left ? `right:${g.w - sx(gx) + 8 / this.z}px` : `left:${sx(gx) + 8 / this.z}px`};top:${8 / this.z}px`;
		this.traceLayer = layer;
	}

	// ---------- charts you type the numbers into ----------
	private chartNode(el: ChartEl): HTMLElement {
		const d = createDiv("ms-chartel");
		d.style.cssText = `left:${el.x}px;top:${el.y}px;width:${el.w}px;height:${el.h}px`;
		d.appendChild(renderChart({ type: el.kind, title: el.title }, specToData(el), themeFromCss(this.root), el.w, el.h, { ymin: el.ymin, ymax: el.ymax, xLabel: el.xLabel, yLabel: el.yLabel, transparent: true }));
		return d;
	}

	newChart() {
		openChartDialog(this.plugin.app, null, (spec) => {
			const p = this.freeSpot(480, 340);
			const el: ChartEl = { id: uid(), type: "chart", x: p.x, y: p.y, w: 480, h: 340, ...spec };
			this.add(el);
			this.setTool("select");
			this.selection = new Set([el.id]);
			this.drawSelection();
		});
	}

	editChart(el: ChartEl) {
		openChartDialog(this.plugin.app, el, (spec) => {
			this.snapshot();
			Object.assign(el, spec);
			this.refreshNode(el);
			this.drawSelection();
			this.changed();
		});
	}

	private refreshNode(el: El) {
		const old = this.nodes.get(el.id);
		const fresh = this.makeNode(el);
		if (old) old.replaceWith(fresh); else this.world.insertBefore(fresh, this.selLayer);
	}

	private resolveImage(src: string) {
		const f = this.plugin.app.vault.getAbstractFileByPath(src);
		return f instanceof TFile ? this.plugin.app.vault.getResourcePath(f) : src;
	}

	bbox(el: El): Box {
		if (el.type === "stroke") {
			let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
			for (const [x, y] of el.pts) { if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
			const r = el.size / 2;
			return { x: x1 - r, y: y1 - r, w: x2 - x1 + 2 * r, h: y2 - y1 + 2 * r };
		}
		if (el.type === "shape") return { x: Math.min(el.x, el.x + el.w), y: Math.min(el.y, el.y + el.h), w: Math.abs(el.w), h: Math.abs(el.h) };
		if (el.type === "text") {
			const n = this.nodes.get(el.id) as HTMLElement | undefined;
			return { x: el.x, y: el.y, w: el.w, h: Math.max(n?.offsetHeight || 0, el.fs * 1.6) };
		}
		return { x: el.x, y: el.y, w: el.w, h: el.h };
	}

	private hit(el: El, x: number, y: number, tol: number): boolean {
		if (el.type === "stroke") {
			const r = el.size / 2 + tol;
			const p = el.pts;
			if (p.length === 1) return Math.hypot(p[0][0] - x, p[0][1] - y) < r;
			for (let i = 1; i < p.length; i++) if (distSeg(x, y, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]) < r) return true;
			return false;
		}
		if (el.type === "shape" && (el.kind === "line" || el.kind === "arrow")) return distSeg(x, y, el.x, el.y, el.x + el.w, el.y + el.h) < el.size / 2 + tol;
		if (el.type === "shape" && !el.fill && this.tool === "eraser") {
			const b = this.bbox(el);
			const inside = x > b.x - tol && x < b.x + b.w + tol && y > b.y - tol && y < b.y + b.h + tol;
			const deep = x > b.x + tol && x < b.x + b.w - tol && y > b.y + tol && y < b.y + b.h - tol;
			return inside && !deep;
		}
		const b = this.bbox(el);
		return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
	}

	private topHit(x: number, y: number): El | null {
		const tol = 6 / this.z;
		for (let i = this.doc.elements.length - 1; i >= 0; i--) if (this.hit(this.doc.elements[i], x, y, tol)) return this.doc.elements[i];
		return null;
	}

	private unionBox(els: El[]): Box {
		let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
		for (const el of els) { const b = this.bbox(el); x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y); x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h); }
		return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
	}

	drawSelection() {
		this.selLayer.empty();
		const els = this.doc.elements.filter((e) => this.selection.has(e.id));
		for (const el of els) {
			const b = this.bbox(el);
			const r = this.selLayer.createDiv("ms-sel-box");
			r.style.cssText = `left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px`;
		}
		if (els.length > 1) {
			const u = this.unionBox(els);
			const g = this.selLayer.createDiv("ms-sel-group");
			g.style.cssText = `left:${u.x}px;top:${u.y}px;width:${u.w}px;height:${u.h}px`;
		}
		if (els.length === 1 && els[0].type !== "stroke" && !(els[0].type === "shape" && els[0].kind === "poly")) {
			const b = this.bbox(els[0]);
			const h = this.selLayer.createDiv("ms-sel-handle");
			h.style.cssText = `left:${b.x + b.w}px;top:${b.y + b.h}px`;
		}
		this.syncToolbar();
	}

	// ---------- history ----------
	private snapshot() {
		this.undoStack.push(JSON.stringify(this.doc.elements));
		if (this.undoStack.length > 200) this.undoStack.shift();
		this.redoStack = [];
	}
	private changed() { this.opts.onChange?.(this.doc); }
	undo() {
		const s = this.undoStack.pop(); if (!s) return;
		this.redoStack.push(JSON.stringify(this.doc.elements));
		this.doc.elements = JSON.parse(s); this.selection.clear(); this.renderAll(); this.changed();
	}
	redo() {
		const s = this.redoStack.pop(); if (!s) return;
		this.undoStack.push(JSON.stringify(this.doc.elements));
		this.doc.elements = JSON.parse(s); this.selection.clear(); this.renderAll(); this.changed();
	}
	add(el: El) {
		this.snapshot();
		this.doc.elements.push(el);
		this.world.insertBefore(this.makeNode(el), this.selLayer);
		this.changed();
	}
	deleteSelection() {
		if (!this.selection.size) return;
		this.snapshot();
		this.doc.elements = this.doc.elements.filter((e) => {
			if (!this.selection.has(e.id)) return true;
			this.nodes.get(e.id)?.remove(); this.nodes.delete(e.id); return false;
		});
		this.selection.clear(); this.drawSelection(); this.changed();
	}
	duplicateSelection() {
		const copies = this.doc.elements.filter((e) => this.selection.has(e.id)).map((e) => this.offset(JSON.parse(JSON.stringify(e)), 24, 24));
		if (!copies.length) return;
		this.snapshot();
		this.selection.clear();
		for (const c of copies) { c.id = uid(); this.doc.elements.push(c); this.world.insertBefore(this.makeNode(c), this.selLayer); this.selection.add(c.id); }
		this.drawSelection(); this.changed();
	}
	private offset<T extends El>(el: T, dx: number, dy: number): T {
		if (el.type === "stroke") el.pts = el.pts.map(([x, y, p]) => [x + dx, y + dy, p] as Pt);
		else {
			el.x += dx; el.y += dy;
			if (el.type === "shape" && el.pts) el.pts = el.pts.map(([px, py]) => [px + dx, py + dy] as [number, number]);
		}
		return el;
	}

	// ---------- coordinates ----------
	private local(e: { clientX: number; clientY: number }) {
		const r = this.viewport.getBoundingClientRect();
		return { sx: e.clientX - r.left, sy: e.clientY - r.top };
	}
	private toWorld(e: { clientX: number; clientY: number }) {
		const { sx, sy } = this.local(e);
		return { x: (sx - this.vx) / this.z, y: (sy - this.vy) / this.z };
	}
	private viewCentre() {
		const r = this.viewport.getBoundingClientRect();
		return { x: (r.width / 2 - this.vx) / this.z, y: (r.height / 2 - this.vy) / this.z };
	}
	zoomAt(sx: number, sy: number, factor: number) {
		const nz = Math.max(0.1, Math.min(8, this.z * factor));
		this.vx = sx - ((sx - this.vx) * nz) / this.z;
		this.vy = sy - ((sy - this.vy) * nz) / this.z;
		this.z = nz;
		this.userZoomed = true;
		this.applyView();
	}

	// ---------- pointer input ----------
	private fingerPans(e: PointerEvent) {
		if (e.pointerType !== "touch") return false;
		const s = this.plugin.settings;
		if (!s.fingerDraws) return true;
		return s.pencilOnlyAfterPen && this.penSeen;
	}

	private onDown(e: PointerEvent) {
		if (this.editing && this.editing.ta.contains(e.target as Node)) return;
		e.stopPropagation();
		if (e.pointerType === "pen" && !this.penSeen) { this.penSeen = true; }
		if (this.editing) this.commitText();
		if (document.activeElement !== this.root) this.root.focus({ preventScroll: true });
		try { this.viewport.setPointerCapture(e.pointerId); } catch { /* ignore */ }
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

		// Two fingers: pinch-zoom (cancels a finger stroke that started a moment ago)
		const touches = [...this.pointers.values()].filter((p) => p.type === "touch");
		if (touches.length === 2) {
			if (this.action?.kind === "draw") { window.clearTimeout(this.action.holdTimer); (this.action.snap?.node ?? this.action.node.closest("svg"))?.remove(); }
			const [a, b] = touches;
			const mid = this.local({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
			this.action = { kind: "pinch", d0: Math.hypot(a.x - b.x, a.y - b.y), cx: mid.sx, cy: mid.sy, vx: this.vx, vy: this.vy, z: this.z };
			return;
		}
		if (this.pointers.size > 1) return;

		const { x, y } = this.toWorld(e);
		// double-click / double-tap (works for mouse, finger and Pencil)
		const now = Date.now();
		const dbl = now - this.lastTap.t < 380 && Math.hypot(e.clientX - this.lastTap.x, e.clientY - this.lastTap.y) < 24;
		this.lastTap = { t: dbl ? 0 : now, x: e.clientX, y: e.clientY };
		if (dbl && (this.tool === "select" || this.tool === "text")) { this.onDouble(e); return; }
		if (this.tool === "hand" || this.spaceDown || e.button === 1 || this.fingerPans(e)) {
			this.action = { kind: "pan", sx: e.clientX, sy: e.clientY, vx: this.vx, vy: this.vy };
			this.root.addClass("is-panning");
			return;
		}
		if (e.button === 2) return;
		const barrelEraser = e.pointerType === "pen" && (e.buttons & 32) !== 0;
		const tool: Tool = barrelEraser ? "eraser" : this.tool;

		if (tool === "pen" || tool === "highlighter") {
			const hl = tool === "highlighter";
			const isPen = e.pointerType === "pen" && e.pressure > 0 && this.plugin.settings.pressure;
			const el: StrokeEl = { id: uid(), type: "stroke", pts: [[x, y, isPen ? e.pressure : 0.5]], color: hl ? this.hlColor : this.color, size: hl ? this.hlSize : this.penSize, ...(hl ? { hl: true } : {}), ...(isPen && !hl ? { pen: true } : {}) };
			const svg = svgEl("svg", { class: "ms-svg" + (hl ? " is-hl" : "") });
			const node = svgEl("path", { d: strokePath(el) });
			node.style.fill = hl ? el.color : paint(el.color);
			svg.appendChild(node);
			this.world.insertBefore(svg, this.selLayer);
			const act = { kind: "draw" as const, el, node, holdTimer: 0, ax: e.clientX, ay: e.clientY, snap: null };
			this.action = act;
			this.armHold(act);
		} else if (tool === "lasso") {
			const sel = this.doc.elements.filter((d) => this.selection.has(d.id));
			if (sel.length) { const u = this.unionBox(sel); if (x >= u.x && x <= u.x + u.w && y >= u.y && y <= u.y + u.h) { this.startMove(x, y); return; } }
			this.selection.clear(); this.drawSelection();
			const svg = svgEl("svg", { class: "ms-svg" });
			const node = svgEl("polygon", { points: `${x},${y}`, class: "ms-lasso-line" });
			svg.appendChild(node);
			this.world.insertBefore(svg, this.selLayer);
			this.action = { kind: "lasso", pts: [[x, y]], node, svg };
		} else if (tool === "trace") {
			this.traceAt(x, y);
			this.action = { kind: "trace" };
		} else if (tool === "eraser") {
			this.snapshot();
			this.action = { kind: "erase", removed: false };
			this.eraseAt(x, y);
		} else if (tool === "text") {
			const hit = this.topHit(x, y);
			if (hit?.type === "text") this.editText(hit);
			else this.newText(x, y, "");
		} else if (tool === "select") {
			this.selectDown(e, x, y);
		} else {
			const el: ShapeEl = { id: uid(), type: "shape", kind: tool, x, y, w: 0, h: 0, color: this.color, size: Math.max(2, this.penSize / 1.5) };
			const node = this.shapeSvg(el);
			(node as unknown as HTMLElement).dataset.id = el.id;
			this.nodes.set(el.id, node);
			this.world.insertBefore(node, this.selLayer);
			this.action = { kind: "shape", el, sx: x, sy: y };
		}
	}

	private startMove(x: number, y: number) {
		const orig = new Map<string, string>();
		for (const el of this.doc.elements) if (this.selection.has(el.id)) orig.set(el.id, JSON.stringify(el));
		this.action = { kind: "move", sx: x, sy: y, orig, moved: false };
		this.drawSelection();
	}

	// ---------- hold the pen still at the end of a stroke to snap it to a clean shape ----------
	private armHold(a: Extract<Action, { kind: "draw" }>) {
		window.clearTimeout(a.holdTimer);
		if (!this.plugin.settings.shapeSnap || a.snap) return;
		a.holdTimer = window.setTimeout(() => this.trySnap(a), this.plugin.settings.snapHoldMs);
	}

	private trySnap(a: Extract<Action, { kind: "draw" }>) {
		if (this.action !== a || a.snap) return;
		const r = recognizeShape(a.el.pts.map((p) => [p[0], p[1]] as Pt2));
		if (!r) return;
		const svg = a.node.closest("svg");
		if (!svg) return;
		if (a.el.hl) {
			// a highlighter stroke only snaps to a straight line (for underlining)
			if (r.kind !== "line") return;
			a.el.pts = [[r.x1, r.y1, 0.5], [r.x2, r.y2, 0.5]];
			a.node.setAttribute("d", strokePath(a.el));
			a.snap = { shape: null, stroke: a.el, node: svg, line: true };
			return;
		}
		const base = { id: uid(), type: "shape" as const, color: a.el.color, size: Math.max(2, a.el.size * 0.85) };
		let shape: ShapeEl;
		if (r.kind === "line") shape = { ...base, kind: "line", x: r.x1, y: r.y1, w: r.x2 - r.x1, h: r.y2 - r.y1 };
		else if (r.kind === "poly") {
			const xs = r.pts.map((q) => q[0]), ys = r.pts.map((q) => q[1]);
			shape = { ...base, kind: "poly", pts: r.pts, x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
		} else shape = { ...base, kind: r.kind, x: r.x, y: r.y, w: r.w, h: r.h };
		const node = this.shapeSvg(shape);
		(node as unknown as HTMLElement).dataset.id = shape.id;
		svg.replaceWith(node);
		a.snap = { shape, stroke: null, node, line: r.kind === "line" };
		this.root.addClass("is-snapped");
		window.setTimeout(() => this.root.removeClass("is-snapped"), 220);
	}

	private selectDown(e: PointerEvent, x: number, y: number) {
		// resize handle?
		if (this.selection.size === 1) {
			const el = this.doc.elements.find((d) => this.selection.has(d.id));
			if (el && el.type !== "stroke" && !(el.type === "shape" && el.kind === "poly")) {
					const b = this.bbox(el);
					if (Math.hypot(x - (b.x + b.w), y - (b.y + b.h)) < 14 / this.z) {
					this.action = { kind: "resize", id: el.id, sx: x, sy: y, orig: JSON.stringify(el) };
					return;
				}
			}
		}
		// pressing inside a multi-item selection (for example after a lasso) moves all of it
		if (this.selection.size > 1 && !e.shiftKey) {
			const u = this.unionBox(this.doc.elements.filter((d) => this.selection.has(d.id)));
			if (x >= u.x && x <= u.x + u.w && y >= u.y && y <= u.y + u.h) { this.startMove(x, y); return; }
		}
		const hit = this.topHit(x, y);
		if (hit) {
			if (!this.selection.has(hit.id)) { if (!e.shiftKey) this.selection.clear(); this.selection.add(hit.id); }
			else if (e.shiftKey) { this.selection.delete(hit.id); this.drawSelection(); return; }
			this.startMove(x, y);
		} else {
			if (!e.shiftKey) this.selection.clear();
			const box = this.selLayer.createDiv("ms-marquee");
			this.action = { kind: "marquee", sx: x, sy: y, box, add: e.shiftKey };
			this.drawSelection();
			this.selLayer.appendChild(box);
		}
	}

	private onMove(e: PointerEvent) {
		if (!this.pointers.has(e.pointerId)) {
			// hovering (mouse, or Apple Pencil hover) reads values off a graph
			if (this.tool === "trace" && !this.opts.readOnly && (e.pointerType === "mouse" || e.pointerType === "pen")) { const w = this.toWorld(e); this.traceAt(w.x, w.y); }
			return;
		}
		this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
		const a = this.action;
		if (!a) return;
		if (a.kind === "pinch") {
			const t = [...this.pointers.values()].filter((p) => p.type === "touch");
			if (t.length < 2) return;
			const d = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
			const mid = this.local({ clientX: (t[0].x + t[1].x) / 2, clientY: (t[0].y + t[1].y) / 2 });
			const nz = Math.max(0.1, Math.min(8, a.z * (d / a.d0)));
			// keep the world point under the original midpoint under the current midpoint
			const wx = (a.cx - a.vx) / a.z, wy = (a.cy - a.vy) / a.z;
			this.z = nz; this.vx = mid.sx - wx * nz; this.vy = mid.sy - wy * nz;
			this.userZoomed = true;
			this.applyView();
			return;
		}
		if (a.kind === "pan") {
			this.vx = a.vx + (e.clientX - a.sx); this.vy = a.vy + (e.clientY - a.sy);
			this.userZoomed = true;
			this.applyView();
			return;
		}
		if (a.kind === "draw") {
			if (a.snap) {
				// after snapping, a line's far end follows the pen so you can aim it
				if (!a.snap.line) return;
				const { x, y } = this.toWorld(e);
				if (a.snap.shape) {
					const s = a.snap.shape;
					let ex = x, ey = y;
					const ang = (((Math.atan2(y - s.y, x - s.x) * 180) / Math.PI) % 180 + 180) % 180;
					if (ang < 3 || ang > 177) ey = s.y; else if (Math.abs(ang - 90) < 3) ex = s.x;
					s.w = ex - s.x; s.h = ey - s.y;
					const fresh = this.shapeSvg(s);
					(fresh as unknown as HTMLElement).dataset.id = s.id;
					a.snap.node.replaceWith(fresh); a.snap.node = fresh;
				} else if (a.snap.stroke) {
					const st = a.snap.stroke;
					st.pts = [st.pts[0], [x, Math.abs(y - st.pts[0][1]) * this.z < 6 ? st.pts[0][1] : y, 0.5]];
					a.node.setAttribute("d", strokePath(st));
				}
				return;
			}
			const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
			for (const ev of evs.length ? evs : [e]) {
				const { x, y } = this.toWorld(ev);
				a.el.pts.push([x, y, a.el.pen ? Math.max(0.05, ev.pressure) : 0.5]);
			}
			a.node.setAttribute("d", strokePath(a.el));
			// still moving? restart the hold timer
			if (Math.hypot(e.clientX - a.ax, e.clientY - a.ay) > 3) { a.ax = e.clientX; a.ay = e.clientY; this.armHold(a); }
			return;
		}
		if (a.kind === "lasso") {
			const { x, y } = this.toWorld(e);
			a.pts.push([x, y]);
			a.node.setAttribute("points", a.pts.map((q) => q.join(",")).join(" "));
			return;
		}
		if (a.kind === "trace") { const w = this.toWorld(e); this.traceAt(w.x, w.y); return; }
		const { x, y } = this.toWorld(e);
		if (a.kind === "erase") { this.eraseAt(x, y); return; }
		if (a.kind === "shape") {
			let w = x - a.sx, h = y - a.sy;
			if (e.shiftKey) {
				if (a.el.kind === "rect" || a.el.kind === "ellipse") { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
				else { const ang = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4), len = Math.hypot(w, h); w = len * Math.cos(ang); h = len * Math.sin(ang); }
			}
			a.el.w = w; a.el.h = h;
			const fresh = this.shapeSvg(a.el);
			(fresh as unknown as HTMLElement).dataset.id = a.el.id;
			this.nodes.get(a.el.id)?.replaceWith(fresh); this.nodes.set(a.el.id, fresh);
			return;
		}
		if (a.kind === "move") {
			const dx = x - a.sx, dy = y - a.sy;
			if (!a.moved && Math.hypot(dx, dy) * this.z < 3) return;
			if (!a.moved) { this.undoStack.push(JSON.stringify(this.doc.elements.map((el) => (a.orig.has(el.id) ? JSON.parse(a.orig.get(el.id)!) : el)))); this.redoStack = []; a.moved = true; }
			this.doc.elements = this.doc.elements.map((el) => {
				if (!a.orig.has(el.id)) return el;
				const moved = this.offset(JSON.parse(a.orig.get(el.id)!) as El, dx, dy);
				const n = this.nodes.get(el.id) as HTMLElement;
				if (el.type === "stroke" || el.type === "shape") this.refreshNode(moved);
				else if (n) { n.style.left = (moved as TextEl).x + "px"; n.style.top = (moved as TextEl).y + "px"; }
				return moved;
			});
			this.drawSelection();
			return;
		}
		if (a.kind === "resize") {
			const el = this.doc.elements.find((d) => d.id === a.id);
			if (!el || el.type === "stroke") return;
			const o = JSON.parse(a.orig) as Exclude<El, StrokeEl | TextEl> | TextEl;
			const dx = x - a.sx, dy = y - a.sy;
			if (el.type === "text") { el.w = Math.max(40, (o as TextEl).w + dx); (this.nodes.get(el.id) as HTMLElement).style.width = el.w + "px"; }
			else {
				const oo = o as ImageEl;
				let w = oo.w + dx, h = oo.h + dy;
				if (el.type === "image" || (e.shiftKey && el.type !== "shape")) { const ratio = oo.h / oo.w; w = Math.max(20, w); h = w * ratio; }
				el.w = el.type === "shape" ? w : Math.max(20, w); el.h = el.type === "shape" ? h : Math.max(20, h);
				if (el.type === "image") { const n = this.nodes.get(el.id) as HTMLElement; n.style.width = el.w + "px"; n.style.height = el.h + "px"; }
				else this.refreshNode(el);
			}
			this.drawSelection();
			return;
		}
		if (a.kind === "marquee") {
			const bx = Math.min(a.sx, x), by = Math.min(a.sy, y), bw = Math.abs(x - a.sx), bh = Math.abs(y - a.sy);
			a.box.style.cssText = `left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px`;
		}
	}

	private onUp(e: PointerEvent, cancelled = false) {
		this.pointers.delete(e.pointerId);
		const a = this.action;
		if (!a) return;
		if (a.kind === "pinch") { if (this.pointers.size === 0) this.action = null; return; }
		this.action = null;
		this.root.removeClass("is-panning");
		if (a.kind === "draw") {
			window.clearTimeout(a.holdTimer);
			(a.snap?.node ?? a.node.closest("svg"))?.remove();
			if (cancelled && a.el.pts.length < 3) return;
			if (a.snap?.shape) this.add(a.snap.shape);
			else this.add(a.el);
		} else if (a.kind === "lasso") {
			a.svg.remove();
			const poly = a.pts;
			if (poly.length > 5) {
				for (const el of this.doc.elements) {
					if (el.type === "stroke") {
						let inside = 0; for (const q of el.pts) if (inPoly(q[0], q[1], poly)) inside++;
						if (inside / el.pts.length >= 0.5) this.selection.add(el.id);
					} else {
						const b = this.bbox(el);
						if (inPoly(b.x + b.w / 2, b.y + b.h / 2, poly)) this.selection.add(el.id);
					}
				}
			}
			this.drawSelection();
		} else if (a.kind === "trace") {
			// the readout stays until you touch something else
		} else if (a.kind === "erase") {
			if (a.removed) this.changed(); else this.undoStack.pop();
		} else if (a.kind === "shape") {
			this.nodes.get(a.el.id)?.remove(); this.nodes.delete(a.el.id);
			if (Math.hypot(a.el.w, a.el.h) * this.z < 4) return;
			this.add(a.el);
		} else if (a.kind === "move") {
			if (a.moved) this.changed();
		} else if (a.kind === "resize") {
			const el = this.doc.elements.find((d) => d.id === a.id);
			if (el && JSON.stringify(el) !== a.orig) {
				this.undoStack.push(JSON.stringify(this.doc.elements.map((d) => (d.id === a.id ? JSON.parse(a.orig) : d)))); this.redoStack = [];
				if (el.type === "text" || el.type === "graph") this.refreshNode(el);
				this.drawSelection();
				this.changed();
			}
		} else if (a.kind === "marquee") {
			const x1 = parseFloat(a.box.style.left) || 0, y1 = parseFloat(a.box.style.top) || 0;
			const x2 = x1 + (parseFloat(a.box.style.width) || 0), y2 = y1 + (parseFloat(a.box.style.height) || 0);
			a.box.remove();
			if (x2 - x1 > 2 || y2 - y1 > 2) {
				for (const el of this.doc.elements) { const b = this.bbox(el); if (b.x >= x1 && b.y >= y1 && b.x + b.w <= x2 && b.y + b.h <= y2) this.selection.add(el.id); }
			}
			this.drawSelection();
		}
	}

	private eraseAt(x: number, y: number) {
		const tol = Math.max(6, this.penSize * 2) / this.z;
		const keep: El[] = [];
		for (const el of this.doc.elements) {
			if ((el.type === "stroke" || el.type === "shape") && this.hit(el, x, y, tol)) {
				this.nodes.get(el.id)?.remove(); this.nodes.delete(el.id);
				if (this.action?.kind === "erase") this.action.removed = true;
			} else keep.push(el);
		}
		this.doc.elements = keep;
	}

	private onDouble(e: MouseEvent) {
		const { x, y } = this.toWorld(e);
		const hit = this.topHit(x, y);
		if (hit?.type === "text") this.editText(hit);
		else if (hit?.type === "graph") this.editGraph(hit);
		else if (hit?.type === "chart") this.editChart(hit);
		else if (!hit && this.tool === "select") this.newText(x, y, "");
	}

	private onWheel(e: WheelEvent) {
		if (this.opts.compact && !e.ctrlKey && !e.metaKey) return; // let notes / Canvas scroll
		e.preventDefault();
		e.stopPropagation();
		const { sx, sy } = this.local(e);
		if (e.ctrlKey || e.metaKey) this.zoomAt(sx, sy, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.01)));
		else { this.vx -= e.deltaX; this.vy -= e.deltaY; this.userZoomed = true; this.applyView(); }
	}

	// ---------- keyboard ----------
	private onKey(e: KeyboardEvent) {
		if (this.editing) return;
		const mod = Platform.isMacOS || Platform.isIosApp ? e.metaKey : e.ctrlKey;
		const tool = matchTool(e);
		if (tool) {
			e.preventDefault(); e.stopPropagation();
			if (tool.special === "fraction") this.plugin.doFraction();
			else if (tool.action) this.openPalette(tool.action === "greek" ? 1 : 0);
			else this.newMath(tool.insert!);
			return;
		}
		if (mod && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
		if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); this.redo(); return; }
		if (mod && e.key.toLowerCase() === "a") { e.preventDefault(); this.doc.elements.forEach((el) => this.selection.add(el.id)); this.setTool("select"); this.drawSelection(); return; }
		if (mod && e.key.toLowerCase() === "d") { e.preventDefault(); this.duplicateSelection(); return; }
		if (mod && (e.key === "=" || e.key === "+")) { e.preventDefault(); const r = this.viewport.getBoundingClientRect(); this.zoomAt(r.width / 2, r.height / 2, 1.25); return; }
		if (mod && e.key === "-") { e.preventDefault(); const r = this.viewport.getBoundingClientRect(); this.zoomAt(r.width / 2, r.height / 2, 0.8); return; }
		if (mod || e.altKey) return;
		if ((e.key === "Delete" || e.key === "Backspace") && this.selection.size) { e.preventDefault(); this.deleteSelection(); return; }
		if (e.key === "Escape") { this.selection.clear(); this.drawSelection(); return; }
		if (e.code === "Space") { e.preventDefault(); this.spaceDown = true; this.root.addClass("is-panning"); return; }
		const map: Record<string, Tool> = { v: "select", s: "lasso", c: "trace", p: "pen", h: "highlighter", e: "eraser", t: "text", r: "rect", o: "ellipse", l: "line", a: "arrow" };
		const k = e.key.toLowerCase();
		if (map[k]) {
			const st = this.plugin.settings;
			const off = (k === "h" && !st.tbHighlighter) || ("rola".includes(k) && !st.tbShapes) || (k === "s" && !st.tbLasso) || (k === "c" && !st.tbTrace);
			if (!off) { e.preventDefault(); this.setTool(map[k]); }
			return;
		}
		if (k === "m" && this.plugin.settings.tbMaths) { e.preventDefault(); this.newMath("$$\n¦\n$$"); return; }
		if (k === "g" && this.plugin.settings.tbGraph) { e.preventDefault(); this.newGraph(); return; }
		if (k === "i" && this.plugin.settings.tbImages) { e.preventDefault(); this.pickImage(); return; }
		if (k === "0") { e.preventDefault(); this.userZoomed = false; this.fit(); return; }
		if (k === "[" || k === "]") { e.preventDefault(); this.bumpSize(k === "]" ? 1 : -1); return; }
		if (/^[1-6]$/.test(k)) { e.preventDefault(); this.setColour(INKS[parseInt(k) - 1]); return; }
	}

	// ---------- text & maths ----------
	newText(x: number, y: number, text: string, caret?: number) {
		const el: TextEl = { id: uid(), type: "text", x, y, w: 360, text, color: this.color, fs: this.opts.frame ? 32 : 18 };
		this.add(el);
		this.editText(el, caret);
	}

	/** Centre of the view, nudged so new items don't land exactly on top of each other. */
	private freeSpot(w: number, h: number) {
		const c = this.viewCentre();
		let x = c.x - w / 2, y = c.y - h / 2;
		for (let i = 0; i < 20; i++) {
			const clash = this.doc.elements.some((el) => { const b = this.bbox(el); return x < b.x + b.w && x + w > b.x && y < b.y + b.h && y + h > b.y; });
			if (!clash) break;
			y += 60; x += 30;
		}
		return { x, y };
	}

	newMath(snippet: string) {
		let s = snippet;
		if (!s.startsWith("$")) s = "$$\n" + (s.includes("¦") ? s : s + "¦") + "\n$$";
		const caret = s.indexOf("¦");
		const p = this.freeSpot(300, 60);
		this.newText(p.x, p.y, s.replace("¦", ""), caret);
	}

	editText(el: TextEl, caret?: number) {
		if (this.editing) this.commitText();
		this.selection.clear(); this.drawSelection();
		const node = this.nodes.get(el.id) as HTMLElement | undefined;
		if (node) node.style.visibility = "hidden";
		const ta = this.world.createEl("textarea", { cls: "ms-text-edit" });
		ta.value = el.text;
		ta.style.cssText = `left:${el.x}px;top:${el.y}px;width:${el.w}px;font-size:${el.fs}px;color:${paint(el.color)};text-align:${el.align ?? "left"}`;
		ta.placeholder = "Type… use $x^2$ for maths";
		const grow = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };
		ta.oninput = grow;
		ta.onkeydown = (e) => {
			e.stopPropagation();
			const t = matchTool(e);
			if (t) {
				e.preventDefault();
				if (t.special === "fraction") this.plugin.doFraction();
				else if (t.action) this.openPalette(t.action === "greek" ? 1 : 0);
				else insertInField(ta, t.insert!);
				return;
			}
			if (e.key === "Escape") { e.preventDefault(); this.commitText(); this.root.focus(); }
		};
		ta.onpointerdown = (e) => e.stopPropagation();
		this.editing = { el, ta };
		this.root.addClass("is-editing");
		setTimeout(() => {
			ta.focus({ preventScroll: true });
			const p = caret ?? ta.value.length;
			ta.setSelectionRange(p, p);
			grow();
		}, 0);
	}

	commitText() {
		const ed = this.editing;
		if (!ed) return;
		this.editing = null;
		this.root.removeClass("is-editing");
		const { el, ta } = ed;
		const text = ta.value;
		ta.remove();
		if (!text.trim()) {
			this.doc.elements = this.doc.elements.filter((d) => d.id !== el.id);
			this.nodes.get(el.id)?.remove(); this.nodes.delete(el.id);
			this.changed();
			return;
		}
		if (text !== el.text) { this.snapshot(); el.text = text; this.changed(); }
		this.refreshNode(el);
	}

	/** The symbols menu opens in the left sidebar; picking one adds it to the text you're typing, or makes a new maths box. */
	openPalette(group = 0) {
		void this.plugin.openSymbols(group);
	}

	// ---------- graphs ----------
	newGraph() {
		const p = this.freeSpot(440, 320);
		const el: GraphEl = { id: uid(), type: "graph", x: p.x, y: p.y, w: 440, h: 320, fns: ["x^2"], xmin: -5, xmax: 5, ymin: -5, ymax: 5 };
		this.add(el);
		this.editGraph(el, true);
	}
	editGraph(el: GraphEl, isNew = false) {
		new GraphModal(this.plugin.app, el, (upd) => {
			if (!upd) { if (isNew && !el.fns.some((f) => f.trim())) { this.selection = new Set([el.id]); this.deleteSelection(); } return; }
			this.snapshot();
			Object.assign(el, upd);
			this.refreshNode(el); this.drawSelection(); this.changed();
		}).open();
	}

	// ---------- images ----------
	pickImage() {
		const m = new Menu();
		m.addItem((i) => i.setTitle(Platform.isMobile ? "Photos or camera" : "From this computer").setIcon("upload").onClick(() => this.pickFromDevice()));
		m.addItem((i) => i.setTitle("From the vault").setIcon("vault").onClick(() => {
			new ImagePicker(this.plugin.app, (f) => this.placeVaultImage(f)).open();
		}));
		const btn = this.toolButtons.get("image");
		if (btn) { const r = btn.getBoundingClientRect(); m.showAtPosition({ x: r.left, y: r.bottom }); }
		else { const r = this.viewport.getBoundingClientRect(); m.showAtPosition({ x: r.left + 40, y: r.top + 40 }); }
	}
	private pickFromDevice() {
		const input = createEl("input", { attr: { type: "file", accept: "image/*,.heic,.heif", multiple: "" } });
		input.onchange = async () => { for (const f of Array.from(input.files ?? [])) await this.importFile(f); };
		input.click();
	}
	async importFile(f: File, at?: { x: number; y: number }) {
		let ext = (f.name.split(".").pop() || f.type.split("/")[1] || "png").toLowerCase();
		const heic = isHeic(ext, f.type);
		if (!f.type.startsWith("image/") && !heic) return;
		const base = (f.name && f.name !== "image.png" ? f.name.replace(/\.[^.]+$/, "") : "Pasted image " + new Date().toISOString().replace(/\D/g, "").slice(0, 14));
		try {
			let data = await f.arrayBuffer();
			if (heic) {
				// iPhone photos: most apps (and Obsidian on Mac/Windows) can't show HEIC, so store a JPEG
				const jpg = await heicToJpeg(data, diskPathOfUpload(f));
				if (!jpg) { new Notice("This HEIC photo can't be converted on this device. Save it as a JPEG first."); return; }
				data = jpg; ext = "jpg";
			}
			const path = await this.plugin.app.fileManager.getAvailablePathForAttachment(`${base}.${ext}`, this.opts.sourcePath);
			const file = await this.plugin.app.vault.createBinary(path, data);
			await this.placeImage(file.path, this.plugin.app.vault.getResourcePath(file), at);
		} catch (err) {
			console.error(err);
			new Notice("Couldn't add that image.");
		}
	}
	/** Place an image that's already in the vault (HEIC photos get a JPEG copy first). */
	private async placeVaultImage(f: TFile, at?: { x: number; y: number }) {
		const vault = this.plugin.app.vault;
		if (!isHeic(f.extension, "")) return this.placeImage(f.path, vault.getResourcePath(f), at);
		const jpg = await heicToJpeg(await vault.readBinary(f), diskPathOf(this.plugin.app, f));
		if (!jpg) { new Notice("This HEIC photo can't be converted on this device. Save it as a JPEG first."); return; }
		const base = f.path.replace(/\.[^.]+$/, "");
		let path = `${base}.jpg`;
		for (let i = 1; vault.getAbstractFileByPath(path); i++) path = `${base} ${i}.jpg`;
		const file = await vault.createBinary(path, jpg);
		return this.placeImage(file.path, vault.getResourcePath(file), at);
	}

	/** Swap a HEIC image already on the board for a JPEG copy (the original stays in the vault). */
	private converting = new Set<string>();
	private async convertHeicImage(el: ImageEl) {
		if (this.converting.has(el.id)) return;
		this.converting.add(el.id);
		const vault = this.plugin.app.vault;
		const src = vault.getAbstractFileByPath(el.src);
		if (!(src instanceof TFile)) return;
		const jpg = await heicToJpeg(await vault.readBinary(src), diskPathOf(this.plugin.app, src));
		if (!jpg) { new Notice(`${src.name} is a HEIC photo, which can't be shown on this device.`); return; }
		const base = src.path.replace(/\.[^.]+$/, "");
		let path = `${base}.jpg`;
		for (let i = 1; vault.getAbstractFileByPath(path); i++) path = `${base} ${i}.jpg`;
		const file = await vault.createBinary(path, jpg);
		el.src = file.path;
		// the box was a 400 × 300 placeholder; match the photo's real shape
		await new Promise<void>((res) => {
			const img = new Image();
			img.onload = () => { if (img.naturalWidth) el.h = el.w * (img.naturalHeight / img.naturalWidth); res(); };
			img.onerror = () => res();
			img.src = vault.getResourcePath(file);
		});
		this.refreshNode(el);
		this.drawSelection();
		this.changed();
	}

	private placeImage(src: string, url: string, at?: { x: number; y: number }) {
		return new Promise<void>((resolve) => {
			const img = new Image();
			const done = (w: number, h: number) => {
				const max = this.opts.frame ? 700 : 480;
				const s = Math.min(1, max / Math.max(w, h));
				const c = at ?? this.viewCentre();
				const el: ImageEl = { id: uid(), type: "image", x: c.x - (w * s) / 2, y: c.y - (h * s) / 2, w: w * s, h: h * s, src };
				this.add(el);
				this.setTool("select");
				this.selection = new Set([el.id]); this.drawSelection();
				resolve();
			};
			img.onload = () => done(img.naturalWidth || 400, img.naturalHeight || 300);
			img.onerror = () => done(400, 300);
			img.src = url;
		});
	}
	private onPaste(e: ClipboardEvent) {
		if (this.editing) return;
		const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
		if (files.length) { e.preventDefault(); files.forEach((f) => this.importFile(f)); return; }
		const text = e.clipboardData?.getData("text/plain");
		if (text) { e.preventDefault(); const c = this.viewCentre(); this.newText(c.x - 150, c.y, text); this.commitText(); }
	}
	private onDrop(e: DragEvent) {
		e.preventDefault();
		const at = this.toWorld(e);
		const files = Array.from(e.dataTransfer?.files ?? []);
		if (files.length) { files.forEach((f) => this.importFile(f, at)); return; }
		// dragged from Obsidian's file list
		const dm = (this.plugin.app as any).dragManager?.draggable;
		const f: TFile | undefined = dm?.file ?? dm?.files?.[0];
		if (f instanceof TFile && /^(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i.test(f.extension)) this.placeVaultImage(f, at);
	}

	// ---------- toolbar ----------
	setTool(t: Tool) {
		if (this.editing) this.commitText();
		this.tool = t;
		if (t !== "select" && t !== "lasso") { this.selection.clear(); this.drawSelection(); }
		if (t !== "trace") this.clearTrace();
		this.root.dataset.tool = t;
		this.syncToolbar();
	}
	setColour(c: string) {
		const sel = this.doc.elements.filter((e) => this.selection.has(e.id) && "color" in e && !(e.type === "stroke" && e.hl)) as (StrokeEl | ShapeEl | TextEl)[];
		if (sel.length) { this.snapshot(); sel.forEach((e) => { e.color = c; this.refreshNode(e); }); this.changed(); }
		if (this.tool === "highlighter") { if (HIGHLIGHTS.includes(c)) this.hlColor = c; }
		else { this.color = c; if (this.tool === "eraser" || this.tool === "select" && !sel.length || this.tool === "hand") this.setTool("pen"); }
		this.syncToolbar();
	}
	private bumpSize(dir: number) {
		const list = this.tool === "highlighter" ? HL_SIZES : PEN_SIZES;
		const cur = this.tool === "highlighter" ? this.hlSize : this.penSize;
		const i = Math.max(0, Math.min(list.length - 1, list.indexOf(cur) + dir));
		if (this.tool === "highlighter") this.hlSize = list[i]; else this.penSize = list[i];
		this.syncToolbar();
	}

	private buildToolbar() {
		const tb = (this.toolbar = this.root.createDiv("ms-toolbar"));
		const compact = !!this.opts.compact;
		const group = () => tb.createDiv("ms-tb-group");
		const btn = (g: HTMLElement, key: string, icon: string, label: string, fn: () => void, text?: string) => {
			const b = g.createEl("button", { cls: "ms-tb-btn clickable-icon", attr: { "aria-label": label, "data-tooltip-position": "bottom" } });
			setIcon(b, icon);
			if (text) b.createSpan({ cls: "ms-tb-text", text });
			b.onclick = (e) => { e.preventDefault(); fn(); };
			b.onpointerdown = (e) => e.stopPropagation();
			this.toolButtons.set(key, b);
			return b;
		};
		const st = this.plugin.settings;
		let g = group();
		btn(g, "select", "mouse-pointer-2", "Select & move (V)", () => this.setTool("select"));
		if (st.tbLasso) btn(g, "lasso", "lasso-select", "Lasso: circle things to select them (S)", () => this.setTool("lasso"));
		if (!compact) btn(g, "hand", "hand", "Pan (hold Space)", () => this.setTool("hand"));
		g = group();
		btn(g, "pen", "pen-tool", "Pen (P)", () => this.setTool("pen"));
		if (st.tbHighlighter) btn(g, "highlighter", "highlighter", "Highlighter (H)", () => this.setTool("highlighter"));
		btn(g, "eraser", "eraser", "Eraser (E)", () => this.setTool("eraser"));
		g = group();
		btn(g, "text", "type", "Text (T)", () => this.setTool("text"));
		if (st.tbMaths) {
			btn(g, "math", "sigma", "Maths box (M)", () => this.newMath("$$\n¦\n$$"));
			btn(g, "palette", "pi", "Maths symbols", () => this.openPalette());
		}
		if (st.tbChart) btn(g, "chart", "bar-chart-3", "Make a bar, line or pie chart from numbers you type", () => this.newChart());
		if (st.tbGraph) {
			btn(g, "graph", "line-chart", "Graph a function (G)", () => this.newGraph());
			if (st.tbTrace) btn(g, "trace", "crosshair", "Read values off a graph: drag over it (C)", () => this.setTool("trace"));
		}
		if (!compact && st.tbShapes) {
			g = group();
			btn(g, "rect", "square", "Rectangle (R)", () => this.setTool("rect"));
			btn(g, "ellipse", "circle", "Circle (O)", () => this.setTool("ellipse"));
			btn(g, "line", "minus", "Line (L)", () => this.setTool("line"));
			btn(g, "arrow", "move-up-right", "Arrow (A)", () => this.setTool("arrow"));
		}
		if (st.tbImages) { g = group(); btn(g, "image", "image-plus", "Add image (I)", () => this.pickImage()); }
		this.swatchRow = tb.createDiv("ms-tb-group ms-swatches");
		if (!compact) this.sizeRow = tb.createDiv("ms-tb-group ms-sizes");
		g = group();
		btn(g, "undo", "undo-2", "Undo (⌘Z)", () => this.undo());
		btn(g, "redo", "redo-2", "Redo (⇧⌘Z)", () => this.redo());
		btn(g, "delete", "trash-2", "Delete selected", () => this.deleteSelection());
		g = group();
		btn(g, "fit", "maximize", "Fit to screen (0)", () => { this.userZoomed = false; this.fit(); });
		btn(g, "more", "more-horizontal", "More", () => this.moreMenu());
		if (this.opts.onOpenFull) btn(g, "open", "maximize-2", "Open full board", () => this.opts.onOpenFull!());
		this.root.dataset.tool = this.tool;
		this.syncToolbar();
	}

	private moreMenu() {
		const m = new Menu();
		const bgs: [Bg, string][] = [["plain", "Plain"], ["grid", "Grid (maths paper)"], ["dots", "Dots"], ["lines", "Lined paper"]];
		for (const [bg, label] of bgs) m.addItem((i) => i.setTitle("Background: " + label).setChecked((this.doc.bg ?? "plain") === bg).onClick(() => { this.doc.bg = bg; this.renderAll(); this.changed(); }));
		m.addSeparator();
		m.addItem((i) => i.setTitle(this.selection.size ? "Duplicate selection" : "Duplicate (select something first)").setIcon("copy").setDisabled(!this.selection.size).onClick(() => this.duplicateSelection()));
		m.addItem((i) => i.setTitle("Bring selection to front").setIcon("bring-to-front").setDisabled(!this.selection.size).onClick(() => this.reorder(true)));
		m.addItem((i) => i.setTitle("Send selection to back").setIcon("send-to-back").setDisabled(!this.selection.size).onClick(() => this.reorder(false)));
		m.addItem((i) => i.setTitle("Fill shapes").setIcon("paint-bucket").setDisabled(!this.selection.size).onClick(() => {
			const shapes = this.doc.elements.filter((e) => this.selection.has(e.id) && e.type === "shape") as ShapeEl[];
			if (!shapes.length) return;
			this.snapshot(); shapes.forEach((s) => { s.fill = !s.fill; this.refreshNode(s); }); this.changed();
		}));
		const texts = () => this.doc.elements.filter((e) => this.selection.has(e.id) && e.type === "text") as TextEl[];
		for (const [a, label, icon] of [["left", "Align text left", "align-left"], ["center", "Centre text", "align-center"], ["right", "Align text right", "align-right"]] as const) {
			m.addItem((i) => i.setTitle(label).setIcon(icon).setDisabled(!texts().length).onClick(() => { this.snapshot(); texts().forEach((t) => { t.align = a; this.refreshNode(t); }); this.changed(); }));
		}
		m.addItem((i) => i.setTitle("Bigger text").setIcon("a-large-small").setDisabled(!texts().length).onClick(() => { this.snapshot(); texts().forEach((t) => { t.fs = Math.round(t.fs * 1.25); this.refreshNode(t); }); this.drawSelection(); this.changed(); }));
		m.addItem((i) => i.setTitle("Smaller text").setIcon("a-large-small").setDisabled(!texts().length).onClick(() => { this.snapshot(); texts().forEach((t) => { t.fs = Math.max(8, Math.round(t.fs / 1.25)); this.refreshNode(t); }); this.drawSelection(); this.changed(); }));
		m.addSeparator();
		m.addItem((i) => i.setTitle("Clear everything").setIcon("trash").onClick(() => {
			if (!this.doc.elements.length) return;
			this.snapshot(); this.doc.elements = []; this.selection.clear(); this.renderAll(); this.changed();
			new Notice("Cleared — undo with ⌘Z");
		}));
		const r = this.toolButtons.get("more")!.getBoundingClientRect();
		m.showAtPosition({ x: r.left, y: r.bottom });
	}

	private reorder(front: boolean) {
		this.snapshot();
		const sel = this.doc.elements.filter((e) => this.selection.has(e.id));
		const rest = this.doc.elements.filter((e) => !this.selection.has(e.id));
		this.doc.elements = front ? [...rest, ...sel] : [...sel, ...rest];
		this.renderAll(); this.changed();
	}

	private syncToolbar() {
		if (!this.toolbar) return;
		for (const [k, b] of this.toolButtons) b.toggleClass("is-active", k === this.tool);
		const del = this.toolButtons.get("delete");
		if (del) del.toggleClass("is-hidden", !this.selection.size);
		if (this.swatchRow) {
			this.swatchRow.empty();
			const hl = this.tool === "highlighter";
			for (const c of hl ? HIGHLIGHTS : INKS) {
				const s = this.swatchRow.createEl("button", { cls: "ms-swatch", attr: { "aria-label": c === "ink" ? "Ink" : c } });
				s.style.setProperty("--sw", paint(c));
				s.toggleClass("is-active", c === (hl ? this.hlColor : this.color));
				s.onclick = () => this.setColour(c);
				s.onpointerdown = (e) => e.stopPropagation();
			}
		}
		if (this.sizeRow) {
			this.sizeRow.empty();
			const hl = this.tool === "highlighter";
			const list = hl ? HL_SIZES : PEN_SIZES;
			list.forEach((sz, i) => {
				const s = this.sizeRow!.createEl("button", { cls: "ms-size", attr: { "aria-label": `Size ${i + 1}` } });
				s.createSpan().style.cssText = `width:${4 + i * 4}px;height:${4 + i * 4}px`;
				s.toggleClass("is-active", sz === (hl ? this.hlSize : this.penSize));
				s.onclick = () => { if (hl) this.hlSize = sz; else this.penSize = sz; this.syncToolbar(); };
				s.onpointerdown = (e) => e.stopPropagation();
			});
		}
	}
}

// ---------- helpers: modals ----------

class ImagePicker extends FuzzySuggestModal<TFile> {
	constructor(app: App, private pick: (f: TFile) => void) { super(app); this.setPlaceholder("Pick an image from your vault"); }
	getItems() { return this.app.vault.getFiles().filter((f) => /^(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i.test(f.extension)); }
	getItemText(f: TFile) { return f.path; }
	onChooseItem(f: TFile) { this.pick(f); }
}

class GraphModal extends Modal {
	private saved = false;
	constructor(app: App, private el: GraphEl, private done: (upd: Partial<GraphEl> | null) => void) { super(app); }
	onOpen() {
		this.titleEl.setText("Graph");
		const { contentEl } = this;
		contentEl.addClass("ms-graph-modal");
		contentEl.createDiv({ cls: "setting-item-description", text: "One item per line. Curves: x^2 - 3, 2sin(x), sqrt(x), 1/x, e^x. Shaded areas: y > x^2 or y <= 2x + 1. Vertical lines: x = 3. Points: (1, 2) or (2, 5) A." });
		const ta = contentEl.createEl("textarea", { cls: "ms-graph-input" });
		ta.value = this.el.fns.join("\n");
		ta.rows = 4;
		const status = contentEl.createDiv("ms-graph-status");
		const check = () => {
			const bad = ta.value.split("\n").filter((l) => l.trim() && !parseGraphLine(l));
			status.setText(bad.length ? "Can't read: " + bad.join(", ") : "");
		};
		ta.oninput = check;
		ta.onkeydown = (e) => { const t = matchTool(e); if (t?.id === "power") { e.preventDefault(); insertInField(ta, "^", "plain"); } else if (t?.id === "sqrt") { e.preventDefault(); insertInField(ta, "sqrt(¦)", "plain"); } };
		const quick = contentEl.createDiv("ms-graph-quick");
		for (const [label, ins] of [["xʸ", "^"], ["√", "sqrt(¦)"], ["π", "pi"], ["sin", "sin(¦)"], ["cos", "cos(¦)"], ["tan", "tan(¦)"], ["ln", "ln(¦)"], ["|x|", "abs(¦)"], ["eˣ", "e^(¦)"], ["y >", "y > ¦"], ["y <", "y < ¦"], ["x =", "x = ¦"], ["(x, y)", "(¦, )"]]) {
			const b = quick.createEl("button", { text: label });
			b.onclick = () => insertInField(ta, ins, "plain");
		}
		const nums = { xmin: this.el.xmin, xmax: this.el.xmax, ymin: this.el.ymin, ymax: this.el.ymax };
		const range = new Setting(contentEl).setName("Range").setDesc("x from / to, y from / to");
		(Object.keys(nums) as (keyof typeof nums)[]).forEach((k) => range.addText((t) => { t.inputEl.type = "number"; t.inputEl.addClass("ms-num"); t.setValue(String(nums[k])).onChange((v) => { const n = parseFloat(v); if (!isNaN(n)) nums[k] = n; }); }));
		new Setting(contentEl).addButton((b) => b.setButtonText("Done").setCta().onClick(() => {
			if (nums.xmax <= nums.xmin || nums.ymax <= nums.ymin) { new Notice("The 'to' value must be bigger than 'from'."); return; }
			this.saved = true;
			this.done({ fns: ta.value.split("\n").map((s) => s.trim()).filter(Boolean), ...nums });
			this.close();
		}));
		check();
		setTimeout(() => ta.focus(), 50);
	}
	onClose() { if (!this.saved) this.done(null); this.contentEl.empty(); }
}

// ---------- HEIC (iPhone photo) support ----------
export const isHeic = (ext: string, type: string) => /^hei[cf]$/i.test(ext) || /image\/hei[cf]/i.test(type);

/** Draw an image (URL) onto a canvas, trimming fully transparent edges, and return a JPEG. */
async function toJpeg(url: string, maxSide: number, trim: boolean): Promise<ArrayBuffer | null> {
	const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
	let sx = 0, sy = 0, sw = img.naturalWidth, sh = img.naturalHeight;
	if (!sw || !sh) return null;
	if (trim) {
		const t = createEl("canvas"); t.width = sw; t.height = sh;
		const tc = t.getContext("2d")!; tc.drawImage(img, 0, 0);
		const a = tc.getImageData(0, 0, sw, sh).data;
		let x1 = sw, y1 = sh, x2 = -1, y2 = -1;
		for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (a[(y * sw + x) * 4 + 3] > 8) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
		if (x2 < 0) return null;
		sx = x1; sy = y1; sw = x2 - x1 + 1; sh = y2 - y1 + 1;
	}
	const s = Math.min(1, maxSide / Math.max(sw, sh));
	const c = createEl("canvas");
	c.width = Math.round(sw * s); c.height = Math.round(sh * s);
	const ctx = c.getContext("2d")!;
	ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
	ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
	const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/jpeg", 0.9));
	return blob ? blob.arrayBuffer() : null;
}

/** Convert a HEIC photo to JPEG. Uses the browser's own decoder first (works on iPad and iPhone),
 *  then, on macOS desktop, the system's Quick Look decoder (needs the file's path on disk).
 *  Returns null if neither can read it. */
export async function heicToJpeg(buf: ArrayBuffer, diskPath?: string, maxSide = 2560): Promise<ArrayBuffer | null> {
	const url = URL.createObjectURL(new Blob([buf], { type: "image/heic" }));
	try { const out = await toJpeg(url, maxSide, false); if (out) return out; }
	catch { /* this browser can't decode HEIC */ }
	finally { URL.revokeObjectURL(url); }
	if (Platform.isDesktopApp && Platform.isMacOS && diskPath) {
		try {
			// Quick Look returns exactly the size asked for, so ask for the photo's real shape
			const dim = heicSize(buf);
			const ratio = dim ? dim.w / dim.h : 4 / 3;
			const size = ratio >= 1 ? { width: maxSide, height: Math.round(maxSide / ratio) } : { width: Math.round(maxSide * ratio), height: maxSide };
			const ni = (window as any).require?.("electron")?.nativeImage;
			const thumb = await ni?.createThumbnailFromPath?.(diskPath, size);
			if (thumb && !thumb.isEmpty()) return await toJpeg(thumb.toDataURL(), maxSide, false);
		} catch { /* not available */ }
	}
	return null;
}

/** Read a HEIC file's displayed width and height (largest "ispe" box, turned by any "irot" rotation). */
export function heicSize(buf: ArrayBuffer): { w: number; h: number } | null {
	const b = new Uint8Array(buf), v = new DataView(buf);
	const limit = Math.min(b.length - 16, 1 << 20); // the boxes we need live near the start
	let best: { w: number; h: number } | null = null, rot = 0;
	for (let i = 4; i < limit; i++) {
		if (b[i] === 0x69 && b[i + 1] === 0x73 && b[i + 2] === 0x70 && b[i + 3] === 0x65) { // "ispe"
			const w = v.getUint32(i + 8), h = v.getUint32(i + 12);
			if (w && h && w < 100000 && h < 100000 && (!best || w * h > best.w * best.h)) best = { w, h };
		} else if (b[i] === 0x69 && b[i + 1] === 0x72 && b[i + 2] === 0x6f && b[i + 3] === 0x74) { // "irot"
			rot = b[i + 4] & 3;
		}
	}
	if (!best) return null;
	return rot % 2 ? { w: best.h, h: best.w } : best;
}

/** Where a vault file lives on disk (desktop only). */
function diskPathOf(app: App, f: TFile): string | undefined {
	try { return (app.vault.adapter as any).getFullPath?.(f.path); } catch { return undefined; }
}
/** Where a picked/dropped file lives on disk (desktop only). */
function diskPathOfUpload(f: File): string | undefined {
	try { return (window as any).require?.("electron")?.webUtils?.getPathForFile?.(f) || (f as any).path || undefined; } catch { return undefined; }
}

export function parseBoard(data: string): BoardDoc {
	try {
		const d = JSON.parse(data || "{}");
		return { elements: Array.isArray(d.elements) ? d.elements : [], bg: d.bg ?? "grid" };
	} catch {
		return { elements: [], bg: "grid" };
	}
}
export const serializeBoard = (d: BoardDoc) => JSON.stringify({ type: "math-studio-board", version: 1, bg: d.bg, elements: d.elements });
export { MATH_GROUPS };
