import { compilePlain } from "./formula";

export type GraphItem =
	| { kind: "curve"; f: (x: number) => number; label: string }
	| { kind: "shade"; f: (x: number) => number; above: boolean; strict: boolean; label: string }
	| { kind: "vline"; x: number; label: string }
	| { kind: "points"; pts: { x: number; y: number; name: string }[]; label: string };

const constant = (src: string): number | null => {
	const f = compilePlain(src);
	if (!f) return null;
	const v = f(0);
	return Number.isFinite(v) ? v : null;
};

/** Understands one line of the graph editor:
 *    x^2 - 3            curve
 *    y = 2sin(x)        curve
 *    y > x^2            shaded area above (also <, >=, <=, ≥, ≤)
 *    x = 3              vertical line
 *    (1, 2)  (3, 4) A   points, optionally named
 */
export function parseGraphLine(src: string): GraphItem | null {
	const s = src.trim();
	if (!s) return null;

	// points: one or more "(a, b)" optionally followed by a name
	if (s.startsWith("(")) {
		const pts: { x: number; y: number; name: string }[] = [];
		const re = /\(\s*([^(),]+?)\s*,\s*([^()]+?)\s*\)\s*([A-Za-z][\w']*)?\s*,?\s*/y;
		let i = 0;
		while (i < s.length) {
			re.lastIndex = i;
			const m = re.exec(s);
			if (!m) return null;
			const x = constant(m[1]), y = constant(m[2]);
			if (x === null || y === null) return null;
			pts.push({ x, y, name: m[3] ?? "" });
			i = re.lastIndex;
		}
		return pts.length ? { kind: "points", pts, label: s } : null;
	}

	// shaded inequality
	const ineq = s.match(/^(?:y|f\s*\(\s*x\s*\))\s*(<=|>=|≤|≥|<|>)\s*(.+)$/i);
	if (ineq) {
		const f = compilePlain(ineq[2]);
		if (!f) return null;
		const op = ineq[1];
		return { kind: "shade", f, above: op.startsWith(">") || op === "≥", strict: op === "<" || op === ">", label: `y ${op} ${ineq[2]}` };
	}

	// vertical line
	const vl = s.match(/^x\s*=\s*(.+)$/i);
	if (vl) {
		const x = constant(vl[1]);
		return x === null ? null : { kind: "vline", x, label: `x = ${vl[1]}` };
	}

	const f = compilePlain(s);
	if (!f) return null;
	return { kind: "curve", f, label: "y = " + s.replace(/^\s*(y|f\(x\))\s*=\s*/i, "") };
}
