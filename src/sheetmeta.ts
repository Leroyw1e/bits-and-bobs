import * as XLSX from "xlsx";
import { FErr, V } from "./formula";

// ---------- cell formatting ----------
export interface CellFmt { b?: 1; i?: 1; c?: string; bg?: string; al?: "l" | "c" | "r"; nf?: string }

export const TEXT_COLOURS = ["", "#e03131", "#1971c2", "#2f9e44", "#f08c00", "#9c36b5", "#868e96"];
export const FILL_COLOURS = ["", "#ffec99", "#b2f2bb", "#a5d8ff", "#ffc9c9", "#eebefa", "#dee2e6"];

export const NUMBER_FORMATS: { label: string; nf: string }[] = [
	{ label: "General", nf: "" },
	{ label: "Whole number  1235", nf: "0" },
	{ label: "Two decimals  1234.50", nf: "0.00" },
	{ label: "With commas  1,234.50", nf: "#,##0.00" },
	{ label: "Currency  $1,234.50", nf: "$#,##0.00" },
	{ label: "Percent  12%", nf: "0%" },
	{ label: "Percent  12.5%", nf: "0.0%" },
	{ label: "Scientific  1.23E+03", nf: "0.00E+00" },
];

export function formatNumber(n: number, nf: string): string | null {
	try { return (XLSX as any).SSF.format(nf, n); } catch { return null; }
}

export function cleanFmt(f: CellFmt): CellFmt | null {
	const out: CellFmt = {};
	if (f.b) out.b = 1;
	if (f.i) out.i = 1;
	if (f.c) out.c = f.c;
	if (f.bg) out.bg = f.bg;
	if (f.al) out.al = f.al;
	if (f.nf) out.nf = f.nf;
	return Object.keys(out).length ? out : null;
}

// ---------- charts ----------
export type ChartType = "bar" | "line" | "pie" | "scatter";
export interface ChartDef { id: string; type: ChartType; title: string; range: string }

// ---------- saving formats and charts inside the .xlsx ----------
/** A hidden sheet holds the things Excel files can't store through this plugin (colours, charts). */
export const META_SHEET = "__bits_meta";
const CHUNK = 30000;

export interface MetaPayload { v: 1; sheets: Record<string, { fmt?: Record<string, CellFmt>; charts?: ChartDef[] }> }

export function writeMeta(wb: XLSX.WorkBook, payload: MetaPayload) {
	const empty = !Object.keys(payload.sheets).length;
	if (wb.Sheets[META_SHEET]) delete wb.Sheets[META_SHEET];
	wb.SheetNames = wb.SheetNames.filter((n) => n !== META_SHEET);
	if (!empty) {
		const json = JSON.stringify(payload);
		const ws: XLSX.WorkSheet = {};
		let rows = 0;
		for (let i = 0; i < json.length; i += CHUNK) { ws["A" + (rows + 1)] = { t: "s", v: json.slice(i, i + CHUNK) }; rows++; }
		ws["!ref"] = `A1:A${Math.max(1, rows)}`;
		wb.Sheets[META_SHEET] = ws;
		wb.SheetNames.push(META_SHEET);
	}
	wb.Workbook = { ...(wb.Workbook ?? {}), Sheets: wb.SheetNames.map((name) => ({ name, Hidden: name === META_SHEET ? 1 : 0 })) };
}

/** Reads the hidden sheet (if any) and removes it from the in-memory workbook. */
export function readMeta(wb: XLSX.WorkBook): MetaPayload | null {
	const ws = wb.Sheets[META_SHEET];
	if (!ws) return null;
	let json = "";
	for (let r = 1; ws["A" + r]; r++) json += String((ws["A" + r] as XLSX.CellObject).v ?? "");
	delete wb.Sheets[META_SHEET];
	wb.SheetNames = wb.SheetNames.filter((n) => n !== META_SHEET);
	try {
		const p = JSON.parse(json);
		return p && p.v === 1 && p.sheets ? (p as MetaPayload) : null;
	} catch { return null; }
}

// ---------- formulas: shift relative references (used by fill) ----------
export function shiftFormula(raw: string, dr: number, dc: number): string {
	if (!raw.startsWith("=")) return raw;
	const parts = raw.split('"'); // leave text inside "quotes" alone
	const colToNum = (s: string) => { let n = 0; for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
	const numToCol = (n: number) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
	for (let i = 0; i < parts.length; i += 2) {
		parts[i] = parts[i].replace(/([A-Za-z0-9_.']?)(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g, (m, pre: string, cd: string, col: string, rd: string, row: string) => {
			if (pre && /[A-Za-z0-9_.']/.test(pre)) return m; // part of a name like LOG10 or Sheet1
			let c = colToNum(col), r = parseInt(row, 10);
			if (!cd) c += dc;
			if (!rd) r += dr;
			if (c < 1 || r < 1) return pre + "#REF!";
			return pre + cd + numToCol(c) + rd + r;
		});
	}
	return parts.join('"');
}

// ---------- fill: continue a series by dragging ----------
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const WEEKDAYS_S = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTHS_S = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const LISTS = [WEEKDAYS, WEEKDAYS_S, MONTHS, MONTHS_S];

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;
const isNum = (s: string) => NUM.test(s.trim());
const tidy = (n: number) => String(+n.toPrecision(12));

function applyCase(sample: string, word: string) {
	if (sample === sample.toUpperCase() && sample.length > 1) return word.toUpperCase();
	if (sample[0] === sample[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
	return word;
}

export interface FillStep { raw?: string; from?: number; shift?: number }

/**
 * Work out what goes in the cells beyond a run of source cells.
 * `src` is in order along the fill direction; `p` positions are relative to the first source
 * (so 0..n-1 are the sources, n.. continue forward, -1.. continue backward).
 */
export function planFill(src: string[], count: number, backward: boolean): FillStep[] {
	const n = src.length;
	const positions: number[] = [];
	for (let k = 0; k < count; k++) positions.push(backward ? -1 - k : n + k);
	const cycle = (p: number): FillStep => { const j = ((p % n) + n) % n; return { from: j, shift: p - j }; };
	const trimmed = src.map((s) => s.trim());

	// numbers: a straight-line series through the selected numbers (two or more)
	if (n >= 2 && trimmed.every(isNum)) {
		const ys = trimmed.map(parseFloat);
		const xm = (n - 1) / 2, ym = ys.reduce((a, b) => a + b, 0) / n;
		let num = 0, den = 0;
		ys.forEach((y, i) => { num += (i - xm) * (y - ym); den += (i - xm) ** 2; });
		const slope = den ? num / den : 0, icpt = ym - slope * xm;
		return positions.map((p) => ({ raw: tidy(icpt + slope * p) }));
	}

	// weekdays and months
	if (trimmed.every((s) => s)) {
		for (const list of LISTS) {
			const idx = trimmed.map((s) => list.indexOf(s.toLowerCase()));
			if (idx.every((i) => i >= 0)) {
				const L = list.length;
				const step = n >= 2 ? ((idx[1] - idx[0]) % L + L) % L || 1 : 1;
				return positions.map((p) => ({ raw: applyCase(trimmed[0], list[(((idx[0] + step * p) % L) + L) % L]) }));
			}
		}
	}

	// text ending in a number: Item 1, Item 2 …
	const trail = trimmed.map((s) => s.match(/^(.*?)(\d+)$/));
	if (trail.every(Boolean) && trail[0]![1] !== "" && !src.some((s) => s.startsWith("=")) && trail.every((m) => m![1] === trail[0]![1])) {
		const nums = trail.map((m) => parseInt(m![2], 10));
		const step = n >= 2 ? (nums[n - 1] - nums[0]) / (n - 1) : 1;
		const width = trail[0]![2].length;
		return positions.map((p) => {
			const v = Math.round(nums[0] + step * p);
			const digits = String(Math.abs(v)).padStart(trail[0]![2].startsWith("0") ? width : 1, "0");
			return { raw: trail[0]![1] + (v < 0 ? "-" : "") + digits };
		});
	}

	// anything else (formulas, words, a single number): repeat the pattern
	return positions.map(cycle);
}

// ---------- display ----------
export function displayValue(v: V, nf?: string): string {
	if (v instanceof FErr) return v.code;
	if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
	if (typeof v === "number") {
		if (nf) { const f = formatNumber(v, nf); if (f !== null) return f; }
		if (Number.isInteger(v)) return String(v);
		return Math.abs(v) >= 1e12 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(6) : String(Math.round(v * 1e10) / 1e10);
	}
	return v;
}
