/**
 * The shape a shared spreadsheet is sent in, and formula working-out for it.
 * No Obsidian code here: the shared-link web page (web/sharepage.ts) uses this file too.
 */
import { FErr, V, addr, parse, parseAddr, run } from "./formula";
import type { CellFmt } from "./sheetmeta";

export interface ShareSheet { name: string; colW: Record<string, number>; rowH: Record<string, number>; fmt: Record<string, CellFmt> }
export interface ShareMeta { sheets: ShareSheet[] }
/** "Sheet1!A1" -> what was typed (a formula starts with =) */
export type ShareCells = Record<string, string>;

export const cellKey = (sheet: string, ref: string) => `${sheet}!${ref}`;

/** Works out cell values the same way the spreadsheet view does. */
export class ShareCalc {
	private cache = new Map<string, V>();
	private visiting = new Set<string>();
	constructor(public meta: ShareMeta, public cells: ShareCells) {}

	reset() { this.cache.clear(); }

	private sheetName(name?: string): string | null {
		if (!name) return null;
		const s = this.meta.sheets.find((x) => x.name.toLowerCase() === name.toLowerCase());
		return s ? s.name : null;
	}

	value(sheet: string, ref: string): V {
		const key = cellKey(sheet, ref);
		const hit = this.cache.get(key);
		if (hit !== undefined) return hit;
		const raw = this.cells[key];
		let v: V;
		if (raw === undefined || raw === "") v = "";
		else if (raw.startsWith("=") && raw.length > 1) {
			if (this.visiting.has(key)) return new FErr("#CIRCULAR!");
			this.visiting.add(key);
			try {
				v = run(parse(raw.slice(1)), {
					get: (sh, r) => { const s = sh ? this.sheetName(sh) : sheet; return s ? this.value(s, r) : new FErr("#REF!"); },
					range: (sh, a, b) => {
						const s = sh ? this.sheetName(sh) : sheet; const pa = parseAddr(a), pb = parseAddr(b);
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

	/** How many rows and columns a sheet uses. */
	extent(sheet: string): { rows: number; cols: number } {
		let rows = 0, cols = 0;
		const pre = sheet + "!";
		for (const k of Object.keys(this.cells)) {
			if (!k.startsWith(pre) || this.cells[k] === "") continue;
			const p = parseAddr(k.slice(pre.length));
			if (p) { rows = Math.max(rows, p.r + 1); cols = Math.max(cols, p.c + 1); }
		}
		return { rows, cols };
	}
}
