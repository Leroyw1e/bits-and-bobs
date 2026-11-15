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
