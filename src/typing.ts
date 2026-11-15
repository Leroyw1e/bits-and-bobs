/**
 * Typed shortcuts that only use numbers and symbols (never letters):
 *   2/4 then space      -> a fraction, 2 over 4
 *   sqrt(16)            -> a square root
 *   <=  >=  !=  +-  ->  ~=   -> ≤ ≥ ≠ ± → ≈
 * Anything made of letters (Greek, integrals, and so on) uses the symbols menu or the bottom row.
 */
export interface Rewrite {
	/** characters before the cursor to replace */
	remove: number;
	insert: string;
	/** true when the typed character is already included in `insert` */
	swallow: boolean;
}

const PAIRS: Record<string, { sym: string; tex: string }> = {
	"<=": { sym: "≤", tex: "\\le " },
	">=": { sym: "≥", tex: "\\ge " },
	"!=": { sym: "≠", tex: "\\ne " },
	"~=": { sym: "≈", tex: "\\approx " },
	"+-": { sym: "±", tex: "\\pm " },
	"->": { sym: "→", tex: "\\to " },
};

export function rewriteTyping(line: string, c: string, inMath: boolean): Rewrite | null {
	const wrap = (s: string) => (inMath ? s : `$${s}$`);

	// 2/4 then a space
	if (c === " ") {
		const m = /(?<![\w./\\])(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(line);
		if (m) return { remove: m[0].length, insert: wrap(`\\frac{${m[1]}}{${m[2]}}`) + " ", swallow: true };
		return null;
	}

	// sqrt(16)
	if (c === ")") {
		const m = /(?<![A-Za-z\\])sqrt\(([^()]+)$/.exec(line);
		if (m) return { remove: m[0].length, insert: wrap(`\\sqrt{${m[1]}}`), swallow: true };
		return null;
	}

	// two-character symbols
	const prev = line.slice(-1);
	const pair = PAIRS[prev + c];
	if (pair) {
		const before = line.slice(0, -1);
		if (prev === ">" && /^[\s>]*$/.test(before)) return null; // a block quote, not an arrow
		if (prev === "-" && /[-<]$/.test(before)) return null; // --> or <->
		if (prev === "=" || prev === "<" || prev === "!") { /* fine */ }
		return { remove: 1, insert: inMath ? pair.tex : pair.sym, swallow: true };
	}
	return null;
}

/**
 * Typing * or / straight after a number, a bracket or a single letter gives × or ÷.
 * Returns the symbol, plus how many characters before the cursor to rewrite first (for dates), or null.
 */
export function operatorFor(line: string, c: string): { insert: string; remove: number } | null {
	if (c !== "*" && c !== "/") return null;
	// inside a [[link]], a [link](url), or a web address: leave it alone
	const lastOpen = line.lastIndexOf("[["), lastClose = line.lastIndexOf("]]");
	if (lastOpen > lastClose) return null;
	if (/\]\([^)]*$/.test(line) || /\b[a-z][a-z0-9+.-]*:\/?\/?\S*$/i.test(line)) return null;
	// a date like 1/2/2025: the first slash became ÷, so put it back
	if (c === "/") {
		const d = /(?<![\d.])(\d{1,4})÷(\d{1,2})$/.exec(line);
		if (d) return { insert: `${d[1]}/${d[2]}/`, remove: d[0].length };
	}
	const before = line.replace(/\s+$/, "");
	if (!before) return null;
	const last = before.slice(-1);
	const spaced = before.length !== line.length;
	const ok =
		/[\d)\]²³¹⁰⁴⁵⁶⁷⁸⁹⁾π]/.test(last) ||
		(!spaced && /[A-Za-z]/.test(last) && !/[A-Za-z_*]/.test(before.slice(-2, -1))); // a single letter like x
	if (!ok) return null;
	return { insert: c === "*" ? "×" : "÷", remove: 0 };
}
