import { FErr, parse, run } from "./formula";
import { superToCaret } from "./superscript";

const DATE_LIKE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/;

export function formatResult(v: number): string {
	if (Number.isInteger(v) && Math.abs(v) < 1e15) return String(v);
	const s = String(+v.toPrecision(10));
	return s.includes("e") ? v.toExponential(6).replace(/\.?0+e/, "e") : s;
}

/**
 * The line so far ends where you just typed "=". If the end of it is a sum like
 * `12*(3+4)` or `Total: 2^3 + 1`, return the answer ("84"); otherwise null.
 */
export function solveLine(before: string): string | null {
	let text = superToCaret(before).replace(/(\d)\s*[x×]\s*(\d)/g, "$1*$2");
	text = text.replace(/\s+$/, "");
	if (!text) return null;
	// try the longest ending first, starting after a space, "=", ":" or ";"
	for (let i = 0; i < text.length; i++) {
		if (i > 0 && !/[\s=:;]/.test(text[i - 1])) continue;
		const expr = text.slice(i).trim();
		if (!expr || expr.length > 200) continue;
		if (!/^[\d\s+\-*/^().%×÷·√πA-Za-z]+$/.test(expr)) continue;
		if (!/\d|π|pi/i.test(expr)) continue;
		if (!/[+\-*/^×÷·√%]/.test(expr) && !/[A-Za-z]+\s*\(/.test(expr)) continue; // a bare number isn't a sum
		if (DATE_LIKE.test(expr)) continue;
		try {
			const v = run(parse(expr, true), { vars: {} });
			if (typeof v === "number" && Number.isFinite(v)) return formatResult(v);
			if (v instanceof FErr) continue;
		} catch { /* not a sum — try a shorter ending */ }
	}
	return null;
}
