import { V, parseAddr } from "./formula";
import type { ChartDef } from "./sheetmeta";

export const CHART_COLOURS = ["#1971c2", "#e03131", "#2f9e44", "#f08c00", "#9c36b5", "#0c8599", "#c2255c", "#5c940d"];

export interface ChartData { cats: string[]; series: { name: string; values: number[] }[]; xs: number[] | null }
export interface ChartTheme { fg: string; muted: string; grid: string; bg: string }

const SVGNS = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string) => {
	const e = document.createElementNS(SVGNS, tag);
	for (const k in attrs) e.setAttribute(k, String(attrs[k]));
	if (text !== undefined) e.textContent = text;
	return e;
};

/** Splits "A1:C5" into corner cells. */
export function parseRange(range: string): { r1: number; c1: number; r2: number; c2: number } | null {
	const [a, b] = range.toUpperCase().replace(/\$/g, "").split(":");
	const pa = parseAddr(a), pb = parseAddr(b ?? a);
	if (!pa || !pb) return null;
	return { r1: Math.min(pa.r, pb.r), r2: Math.max(pa.r, pb.r), c1: Math.min(pa.c, pb.c), c2: Math.max(pa.c, pb.c) };
}

const isText = (v: V) => typeof v === "string" && v.trim() !== "" && isNaN(Number(v));

/**
 * Turns a block of cells into chart data. A text first row names the series,
 * and a text first column names the categories (like Excel does).
 */
export function chartData(grid: V[][], type: ChartDef["type"]): ChartData {
	if (!grid.length || !grid[0].length) return { cats: [], series: [], xs: null };
	const rows = grid.length, cols = grid[0].length;
	const hasNum = (r: V[]) => r.some((v) => typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !isNaN(Number(v))));
	// a first row of words above a row with numbers is a header
	const header = rows > 1 && grid[0].every((v) => isText(v) || v === "") && grid[0].some(isText) && hasNum(grid[1]);
	const first = header ? 1 : 0;
	const body = grid.slice(first);
	const labelCol = cols > 1 && body.length > 0 && body.every((r) => isText(r[0]) || r[0] === "") && body.some((r) => isText(r[0]));
	const num = (v: V) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !isNaN(Number(v)) ? Number(v) : NaN);

	// scatter: first column holds the x values
	if (type === "scatter" && cols > 1 && !labelCol) {
		const xs = body.map((r) => num(r[0]));
		const series: ChartData["series"] = [];
		for (let c = 1; c < cols; c++) series.push({ name: header ? String(grid[0][c] || `Series ${c}`) : `Series ${c}`, values: body.map((r) => num(r[c])) });
		return { cats: xs.map(String), series, xs };
	}

	const startCol = labelCol ? 1 : 0;
	const cats = body.map((r, i) => (labelCol ? String(r[0]) : String(i + 1)));
	const series: ChartData["series"] = [];
	for (let c = startCol; c < cols; c++) {
		const name = header && grid[0][c] !== "" && grid[0][c] !== undefined ? String(grid[0][c]) : `Series ${c - startCol + 1}`;
		series.push({ name, values: body.map((r) => num(r[c])) });
	}
	return { cats, series, xs: null };
}

function niceTicks(min: number, max: number, target = 5) {
	if (min === max) { max = min + 1; if (min > 0) min = 0; }
	const span = max - min, raw = span / target;
	const mag = Math.pow(10, Math.floor(Math.log10(raw)));
	const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
	const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
	const ticks: number[] = [];
	for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
	return { lo, hi, ticks };
}

const fmt = (n: number) => (Math.abs(n) >= 1e6 || (Math.abs(n) < 0.001 && n !== 0) ? n.toExponential(1) : String(+n.toPrecision(6)));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Draws a chart into a new SVG (colours are written in directly, so it can also be saved as an image). */
export function renderChart(def: ChartDef, data: ChartData, theme: ChartTheme, W = 520, H = 340): SVGSVGElement {
	const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, xmlns: SVGNS });
	svg.appendChild(el("rect", { x: 0, y: 0, width: W, height: H, fill: theme.bg }));
	const font = "-apple-system, system-ui, 'Segoe UI', Roboto, sans-serif";
	const text = (x: number, y: number, s: string, o: { anchor?: string; size?: number; weight?: string; fill?: string; rotate?: number } = {}) => {
		const t = el("text", { x, y, "text-anchor": o.anchor ?? "start", "font-size": o.size ?? 12, "font-weight": o.weight ?? "400", fill: o.fill ?? theme.fg, "font-family": font }, s);
		if (o.rotate) t.setAttribute("transform", `rotate(${o.rotate} ${x} ${y})`);
		svg.appendChild(t);
	};
	if (def.title) text(W / 2, 24, clip(def.title, 60), { anchor: "middle", size: 15, weight: "600" });
	const top = def.title ? 40 : 14;
	const hasData = data.series.length > 0 && data.series.some((s) => s.values.some((v) => !isNaN(v)));
	if (!hasData) { text(W / 2, H / 2, "No numbers to chart in this range", { anchor: "middle", fill: theme.muted }); return svg; }

	// ---------- pie ----------
	if (def.type === "pie") {
		const s = data.series[0];
		const items = s.values.map((v, i) => ({ v: isNaN(v) ? 0 : Math.max(0, v), name: data.cats[i] ?? String(i + 1) })).filter((x) => x.v > 0);
		const total = items.reduce((a, b) => a + b.v, 0);
		if (!total) { text(W / 2, H / 2, "Pie charts need positive numbers", { anchor: "middle", fill: theme.muted }); return svg; }
		const legendW = 150, cx = (W - legendW) / 2 + 10, cy = top + (H - top - 10) / 2, R = Math.min((W - legendW - 30) / 2, (H - top - 24) / 2);
		let ang = -Math.PI / 2;
		items.forEach((it, i) => {
			const a2 = ang + (it.v / total) * Math.PI * 2;
			const x1 = cx + R * Math.cos(ang), y1 = cy + R * Math.sin(ang), x2 = cx + R * Math.cos(a2), y2 = cy + R * Math.sin(a2);
			const large = a2 - ang > Math.PI ? 1 : 0;
			const d = items.length === 1 ? `M ${cx - R} ${cy} a ${R} ${R} 0 1 0 ${2 * R} 0 a ${R} ${R} 0 1 0 ${-2 * R} 0` : `M ${cx} ${cy} L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`;
			svg.appendChild(el("path", { d, fill: CHART_COLOURS[i % CHART_COLOURS.length], stroke: theme.bg, "stroke-width": 2 }));
			const pct = (it.v / total) * 100;
			if (pct >= 5) { const mid = (ang + a2) / 2; text(cx + R * 0.62 * Math.cos(mid), cy + R * 0.62 * Math.sin(mid) + 4, `${Math.round(pct)}%`, { anchor: "middle", size: 12, weight: "600", fill: "#ffffff" }); }
			ang = a2;
		});
		const lx = W - legendW + 4;
		items.slice(0, 14).forEach((it, i) => {
			const y = top + 10 + i * 20;
			svg.appendChild(el("rect", { x: lx, y: y - 9, width: 11, height: 11, rx: 2, fill: CHART_COLOURS[i % CHART_COLOURS.length] }));
			text(lx + 17, y, `${clip(it.name, 14)}  ${fmt(it.v)}`, { size: 11 });
		});
		return svg;
	}

	// ---------- bar / line / scatter ----------
	const multi = data.series.length > 1;
	const legendH = multi ? 22 : 0;
	const L = 52, R = 16, B = (def.type === "scatter" ? 34 : data.cats.length > 8 ? 56 : 38) + legendH, T = top;
	const pw = W - L - R, ph = H - T - B;
	const all = data.series.flatMap((s) => s.values).filter((v) => !isNaN(v));
	let ymin = Math.min(...all), ymax = Math.max(...all);
	if (def.type === "bar") { ymin = Math.min(0, ymin); ymax = Math.max(0, ymax); }
	const yt = niceTicks(ymin, ymax);
	const sy = (v: number) => T + ph - ((v - yt.lo) / (yt.hi - yt.lo)) * ph;
	for (const t of yt.ticks) {
		svg.appendChild(el("line", { x1: L, x2: L + pw, y1: sy(t), y2: sy(t), stroke: theme.grid, "stroke-width": 1 }));
		text(L - 6, sy(t) + 4, fmt(t), { anchor: "end", size: 11, fill: theme.muted });
	}
	svg.appendChild(el("line", { x1: L, x2: L, y1: T, y2: T + ph, stroke: theme.muted, "stroke-width": 1 }));
	if (yt.lo <= 0 && yt.hi >= 0) svg.appendChild(el("line", { x1: L, x2: L + pw, y1: sy(0), y2: sy(0), stroke: theme.muted, "stroke-width": 1.2 }));

	if (def.type === "scatter" && data.xs) {
		const xv = data.xs.filter((v) => !isNaN(v));
		const xt = niceTicks(Math.min(...xv), Math.max(...xv));
		const sx = (v: number) => L + ((v - xt.lo) / (xt.hi - xt.lo)) * pw;
		for (const t of xt.ticks) { svg.appendChild(el("line", { x1: sx(t), x2: sx(t), y1: T, y2: T + ph, stroke: theme.grid, "stroke-width": 1 })); text(sx(t), T + ph + 16, fmt(t), { anchor: "middle", size: 11, fill: theme.muted }); }
		data.series.forEach((s, si) => s.values.forEach((v, i) => { const x = data.xs![i]; if (!isNaN(v) && !isNaN(x)) svg.appendChild(el("circle", { cx: sx(x), cy: sy(v), r: 4.5, fill: CHART_COLOURS[si % CHART_COLOURS.length], stroke: theme.bg, "stroke-width": 1.5 })); }));
	} else {
		const n = data.cats.length || 1;
		const slot = pw / n;
		const stepLabel = Math.ceil(n / Math.max(1, Math.floor(pw / (data.cats.length > 8 ? 26 : 56))));
		data.cats.forEach((c, i) => {
			if (i % stepLabel) return;
			const x = L + slot * (i + 0.5);
			if (data.cats.length > 8) text(x, T + ph + 14, clip(c, 12), { anchor: "end", size: 11, fill: theme.muted, rotate: -40 });
			else text(x, T + ph + 16, clip(c, 12), { anchor: "middle", size: 11, fill: theme.muted });
		});
		if (def.type === "bar") {
			const groupW = slot * 0.78, bw = groupW / data.series.length;
			data.series.forEach((s, si) => s.values.forEach((v, i) => {
				if (isNaN(v)) return;
				const x = L + slot * i + (slot - groupW) / 2 + bw * si;
				const y0 = sy(0), y1 = sy(v);
				svg.appendChild(el("rect", { x, y: Math.min(y0, y1), width: Math.max(1, bw - 1.5), height: Math.max(1, Math.abs(y1 - y0)), rx: 2, fill: CHART_COLOURS[si % CHART_COLOURS.length] }));
				if (n * data.series.length <= 12) text(x + (bw - 1.5) / 2, v >= 0 ? y1 - 4 : y1 + 12, fmt(v), { anchor: "middle", size: 10, fill: theme.muted });
			}));
		} else {
			data.series.forEach((s, si) => {
				const colour = CHART_COLOURS[si % CHART_COLOURS.length];
				let d = "", pen = false;
				s.values.forEach((v, i) => { if (isNaN(v)) { pen = false; return; } d += `${pen ? "L" : "M"}${(L + slot * (i + 0.5)).toFixed(1)} ${sy(v).toFixed(1)} `; pen = true; });
				svg.appendChild(el("path", { d, fill: "none", stroke: colour, "stroke-width": 2.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
				s.values.forEach((v, i) => { if (!isNaN(v)) svg.appendChild(el("circle", { cx: L + slot * (i + 0.5), cy: sy(v), r: n > 30 ? 2 : 3.8, fill: colour, stroke: theme.bg, "stroke-width": 1.5 })); });
			});
		}
	}
	if (multi) {
		let x = L;
		data.series.slice(0, 8).forEach((s, i) => {
			svg.appendChild(el("rect", { x, y: H - 17, width: 11, height: 11, rx: 2, fill: CHART_COLOURS[i % CHART_COLOURS.length] }));
			const label = clip(s.name, 14);
			text(x + 16, H - 7, label, { size: 11 });
			x += 28 + label.length * 6.2;
		});
	}
	return svg;
}
