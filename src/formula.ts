// A small formula engine shared by spreadsheets (Excel-style formulas)
// and graphs on boards (plain maths like 2x^2 + sin(x)).

export class FErr extends Error {
	constructor(public code: string) { super(code); this.name = "FErr"; }
	toString() { return this.code; }
}
export type V = number | string | boolean | FErr;
type Arg = V | V[][];

type Node =
	| { t: "num"; v: number }
	| { t: "str"; v: string }
	| { t: "bool"; v: boolean }
	| { t: "ref"; sheet?: string; ref: string }
	| { t: "range"; sheet?: string; a: string; b: string }
	| { t: "var"; name: string }
	| { t: "fn"; name: string; args: Node[] }
	| { t: "bin"; op: string; l: Node; r: Node }
	| { t: "neg"; e: Node }
	| { t: "pct"; e: Node };

interface Tok { k: "num" | "str" | "ref" | "id" | "op" | "(" | ")" | "," | "fn"; v: string }

const REF = /^(?:('[^']+'|[A-Za-z_][\w.]*)!)?\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?/;

function tokenize(src: string, plain: boolean): Tok[] {
	const out: Tok[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i];
		if (/\s/.test(ch)) { i++; continue; }
		const rest = src.slice(i);
		let m: RegExpMatchArray | null;
		if ((m = rest.match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i))) {
			out.push({ k: "num", v: m[0] }); i += m[0].length; continue;
		}
		if (ch === '"') {
			let j = i + 1, s = "";
			while (j < src.length) {
				if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
				s += src[j++];
			}
			out.push({ k: "str", v: s }); i = j + 1; continue;
		}
		if (!plain && (m = rest.match(REF)) && !/^[\w(]/.test(rest.slice(m[0].length))) {
			out.push({ k: "ref", v: m[0] }); i += m[0].length; continue;
		}
		if ((m = rest.match(/^[A-Za-z_Ͱ-Ͽ][\w.]*/))) {
			const after = rest.slice(m[0].length).trimStart();
			out.push({ k: after.startsWith("(") ? "fn" : "id", v: m[0] }); i += m[0].length; continue;
		}
		if ((m = rest.match(/^(<=|>=|<>|!=|\*\*)/))) { out.push({ k: "op", v: m[0] === "**" ? "^" : m[0] === "!=" ? "<>" : m[0] }); i += 2; continue; }
		if ("+-*/^&=<>%".includes(ch)) { out.push({ k: "op", v: ch }); i++; continue; }
		if (ch === "×" || ch === "·") { out.push({ k: "op", v: "*" }); i++; continue; }
		if (ch === "÷") { out.push({ k: "op", v: "/" }); i++; continue; }
		if (ch === "(" || ch === ")") { out.push({ k: ch, v: ch }); i++; continue; }
		if (ch === "," || ch === ";") { out.push({ k: ",", v: "," }); i++; continue; }
		if (ch === "π") { out.push({ k: "id", v: "pi" }); i++; continue; }
		if (ch === "√") { out.push({ k: "fn", v: "sqrt" }); i++; if (src[i] !== "(") { /* √x */ const mm = src.slice(i).match(/^\s*([\w.]+)/); if (mm) { out.push({ k: "(", v: "(" }); out.push(/^\d/.test(mm[1]) ? { k: "num", v: mm[1] } : { k: "id", v: mm[1] }); out.push({ k: ")", v: ")" }); i += mm[0].length; } } continue; }
		throw new FErr("#PARSE!");
	}
	if (!plain) return out;
	// Implicit multiplication for plain maths: 2x, 3(x+1), (x+1)(x-1), x sin(x)
	const res: Tok[] = [];
	for (const t of out) {
		const p = res[res.length - 1];
		if (p && (p.k === "num" || p.k === "id" || p.k === ")") && (t.k === "num" || t.k === "id" || t.k === "fn" || t.k === "(")) {
			if (!(p.k === "num" && t.k === "num")) res.push({ k: "op", v: "*" });
		}
		// split identifiers like "xy" into x*y (single-letter variables), but keep known names
		if (t.k === "id" && t.v.length > 1 && !CONSTS[t.v.toLowerCase()] && /^[a-z]+$/i.test(t.v)) {
			t.v.split("").forEach((c, idx) => { if (idx) res.push({ k: "op", v: "*" }); res.push({ k: "id", v: c }); });
			continue;
		}
		res.push(t);
	}
	return res;
}

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

class Parser {
	i = 0;
	constructor(private toks: Tok[], private plain: boolean) {}
	peek() { return this.toks[this.i]; }
	next() { return this.toks[this.i++]; }
	isOp(...ops: string[]) { const t = this.peek(); return t && t.k === "op" && ops.includes(t.v); }
	parse(): Node { const n = this.cmp(); if (this.i < this.toks.length) throw new FErr("#PARSE!"); return n; }
	cmp(): Node { let l = this.cat(); while (this.isOp("=", "<>", "<", ">", "<=", ">=")) { const op = this.next().v; l = { t: "bin", op, l, r: this.cat() }; } return l; }
	cat(): Node { let l = this.add(); while (this.isOp("&")) { this.next(); l = { t: "bin", op: "&", l, r: this.add() }; } return l; }
	add(): Node { let l = this.mul(); while (this.isOp("+", "-")) { const op = this.next().v; l = { t: "bin", op, l, r: this.mul() }; } return l; }
	mul(): Node { let l = this.pow(); while (this.isOp("*", "/")) { const op = this.next().v; l = { t: "bin", op, l, r: this.pow() }; } return l; }
	// Plain maths: -x^2 = -(x^2) and 2^3^2 = 2^9. Excel: -2^2 = 4 and 2^3^2 = 64.
	pow(): Node {
		if (this.plain) {
			if (this.isOp("-")) { this.next(); return { t: "neg", e: this.pow() }; }
			if (this.isOp("+")) { this.next(); return this.pow(); }
			const l = this.postfix();
			if (this.isOp("^")) { this.next(); return { t: "bin", op: "^", l, r: this.pow() }; }
			return l;
		}
		let l = this.unary();
		while (this.isOp("^")) { this.next(); l = { t: "bin", op: "^", l, r: this.unary() }; }
		return l;
	}
	unary(): Node {
		if (this.isOp("-")) { this.next(); return { t: "neg", e: this.unary() }; }
		if (this.isOp("+")) { this.next(); return this.unary(); }
		return this.postfix();
	}
	postfix(): Node { let e = this.atom(); while (this.isOp("%")) { this.next(); e = { t: "pct", e }; } return e; }
	atom(): Node {
		const t = this.next();
		if (!t) throw new FErr("#PARSE!");
		if (t.k === "num") return { t: "num", v: parseFloat(t.v) };
		if (t.k === "str") return { t: "str", v: t.v };
		if (t.k === "(") { const e = this.cmp(); if (this.next()?.k !== ")") throw new FErr("#PARSE!"); return e; }
		if (t.k === "ref") {
			let sheet: string | undefined, r = t.v;
			const bang = r.lastIndexOf("!");
			if (bang >= 0) { sheet = r.slice(0, bang).replace(/^'|'$/g, ""); r = r.slice(bang + 1); }
			r = r.replace(/\$/g, "").toUpperCase();
			if (r.includes(":")) { const [a, b] = r.split(":"); return { t: "range", sheet, a, b }; }
			return { t: "ref", sheet, ref: r };
		}
		if (t.k === "id") {
			const u = t.v.toUpperCase();
			if (u === "TRUE" || u === "FALSE") return { t: "bool", v: u === "TRUE" };
			return { t: "var", name: t.v };
		}
		if (t.k === "fn") {
			if (this.next()?.k !== "(") throw new FErr("#PARSE!");
			const args: Node[] = [];
			if (this.peek()?.k !== ")") {
				do { args.push(this.cmp()); } while (this.peek()?.k === "," && this.next());
			}
			if (this.next()?.k !== ")") throw new FErr("#PARSE!");
			return { t: "fn", name: t.v.toUpperCase(), args };
		}
		throw new FErr("#PARSE!");
	}
}

export function parse(src: string, plain = false): Node {
	return new Parser(tokenize(src, plain), plain).parse();
}

export interface Ctx {
	get?(sheet: string | undefined, ref: string): V;
	range?(sheet: string | undefined, a: string, b: string): V[][];
	vars?: Record<string, number>;
}

const num = (v: V): number => {
	if (v instanceof FErr) throw v;
	if (typeof v === "number") return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (v === "") return 0;
	const n = Number(v);
	if (isNaN(n)) throw new FErr("#VALUE!");
	return n;
};
const str = (v: V): string => { if (v instanceof FErr) throw v; return typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v); };
const flat = (args: Arg[]): V[] => args.flatMap((a) => (Array.isArray(a) ? a.flat() : [a]));
const nums = (args: Arg[]): number[] => {
	const out: number[] = [];
	for (const a of args) {
		if (Array.isArray(a)) { for (const v of a.flat()) { if (v instanceof FErr) throw v; if (typeof v === "number") out.push(v); } }
		else out.push(num(a));
	}
	return out;
};
const one = (a: Arg): V => (Array.isArray(a) ? a[0]?.[0] ?? "" : a);
const n1 = (args: Arg[], i = 0) => num(one(args[i] ?? 0));
const fact = (n: number) => { if (n < 0) throw new FErr("#NUM!"); let r = 1; for (let i = 2; i <= Math.floor(n); i++) r *= i; return r; };
const roundTo = (x: number, d: number, f: (n: number) => number) => { const p = Math.pow(10, d); return f(x * p) / p; };

export const FUNCTIONS: Record<string, { help: string; fn: (a: Arg[]) => V }> = {
	SUM: { help: "Add numbers: SUM(A1:A5)", fn: (a) => nums(a).reduce((s, x) => s + x, 0) },
	AVERAGE: { help: "Mean: AVERAGE(A1:A5)", fn: (a) => { const n = nums(a); if (!n.length) throw new FErr("#DIV/0!"); return n.reduce((s, x) => s + x, 0) / n.length; } },
	MIN: { help: "Smallest: MIN(A1:A5)", fn: (a) => { const n = nums(a); return n.length ? Math.min(...n) : 0; } },
	MAX: { help: "Largest: MAX(A1:A5)", fn: (a) => { const n = nums(a); return n.length ? Math.max(...n) : 0; } },
	COUNT: { help: "Count numbers", fn: (a) => flat(a).filter((v) => typeof v === "number").length },
	COUNTA: { help: "Count non-empty", fn: (a) => flat(a).filter((v) => v !== "").length },
	PRODUCT: { help: "Multiply: PRODUCT(A1:A5)", fn: (a) => nums(a).reduce((s, x) => s * x, 1) },
	MEDIAN: { help: "Middle value", fn: (a) => { const n = nums(a).sort((x, y) => x - y); if (!n.length) throw new FErr("#NUM!"); const m = n.length >> 1; return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2; } },
	STDEV: { help: "Sample standard deviation", fn: (a) => { const n = nums(a); if (n.length < 2) throw new FErr("#DIV/0!"); const m = n.reduce((s, x) => s + x, 0) / n.length; return Math.sqrt(n.reduce((s, x) => s + (x - m) ** 2, 0) / (n.length - 1)); } },
	VAR: { help: "Sample variance", fn: (a) => { const n = nums(a); if (n.length < 2) throw new FErr("#DIV/0!"); const m = n.reduce((s, x) => s + x, 0) / n.length; return n.reduce((s, x) => s + (x - m) ** 2, 0) / (n.length - 1); } },
	SUMSQ: { help: "Sum of squares", fn: (a) => nums(a).reduce((s, x) => s + x * x, 0) },
	POWER: { help: "x to the power of y: POWER(x, y)", fn: (a) => Math.pow(n1(a), n1(a, 1)) },
	SQRT: { help: "Square root", fn: (a) => { const x = n1(a); if (x < 0) throw new FErr("#NUM!"); return Math.sqrt(x); } },
	CBRT: { help: "Cube root", fn: (a) => Math.cbrt(n1(a)) },
	ROOT: { help: "nth root: ROOT(x, n)", fn: (a) => { const x = n1(a), n = n1(a, 1); return x < 0 && n % 2 === 1 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n); } },
	ABS: { help: "Absolute value", fn: (a) => Math.abs(n1(a)) },
	ROUND: { help: "ROUND(x, digits)", fn: (a) => roundTo(n1(a), a[1] ? n1(a, 1) : 0, Math.round) },
	ROUNDUP: { help: "ROUNDUP(x, digits)", fn: (a) => roundTo(n1(a), a[1] ? n1(a, 1) : 0, (x) => (x < 0 ? Math.floor(x) : Math.ceil(x))) },
	ROUNDDOWN: { help: "ROUNDDOWN(x, digits)", fn: (a) => roundTo(n1(a), a[1] ? n1(a, 1) : 0, Math.trunc) },
	INT: { help: "Round down to integer", fn: (a) => Math.floor(n1(a)) },
	MOD: { help: "Remainder: MOD(x, y)", fn: (a) => { const y = n1(a, 1); if (!y) throw new FErr("#DIV/0!"); const x = n1(a); return x - y * Math.floor(x / y); } },
	EXP: { help: "e to the power of x", fn: (a) => Math.exp(n1(a)) },
	LN: { help: "Natural log", fn: (a) => { const x = n1(a); if (x <= 0) throw new FErr("#NUM!"); return Math.log(x); } },
	LOG: { help: "LOG(x, base=10)", fn: (a) => { const x = n1(a); if (x <= 0) throw new FErr("#NUM!"); return Math.log(x) / Math.log(a[1] ? n1(a, 1) : 10); } },
	LOG10: { help: "Log base 10", fn: (a) => Math.log10(n1(a)) },
	SIN: { help: "Sine (radians)", fn: (a) => Math.sin(n1(a)) },
	COS: { help: "Cosine (radians)", fn: (a) => Math.cos(n1(a)) },
	TAN: { help: "Tangent (radians)", fn: (a) => Math.tan(n1(a)) },
	ASIN: { help: "Inverse sine", fn: (a) => Math.asin(n1(a)) },
	ACOS: { help: "Inverse cosine", fn: (a) => Math.acos(n1(a)) },
	ATAN: { help: "Inverse tangent", fn: (a) => Math.atan(n1(a)) },
	ATAN2: { help: "ATAN2(x, y)", fn: (a) => Math.atan2(n1(a, 1), n1(a)) },
	SINH: { help: "Hyperbolic sine", fn: (a) => Math.sinh(n1(a)) },
	COSH: { help: "Hyperbolic cosine", fn: (a) => Math.cosh(n1(a)) },
	TANH: { help: "Hyperbolic tangent", fn: (a) => Math.tanh(n1(a)) },
	PI: { help: "π", fn: () => Math.PI },
	RADIANS: { help: "Degrees to radians", fn: (a) => (n1(a) * Math.PI) / 180 },
	DEGREES: { help: "Radians to degrees", fn: (a) => (n1(a) * 180) / Math.PI },
	FACT: { help: "Factorial n!", fn: (a) => fact(n1(a)) },
	COMBIN: { help: "n choose k", fn: (a) => { const n = n1(a), k = n1(a, 1); return Math.round(fact(n) / (fact(k) * fact(n - k))); } },
	PERMUT: { help: "Permutations nPk", fn: (a) => { const n = n1(a), k = n1(a, 1); return Math.round(fact(n) / fact(n - k)); } },
	GCD: { help: "Greatest common divisor", fn: (a) => nums(a).map(Math.trunc).reduce((x, y) => { x = Math.abs(x); y = Math.abs(y); while (y) [x, y] = [y, x % y]; return x; }) },
	LCM: { help: "Least common multiple", fn: (a) => nums(a).map(Math.trunc).reduce((x, y) => { let g = x, h = y; while (h) [g, h] = [h, g % h]; return Math.abs((x * y) / g); }) },
	SIGN: { help: "Sign of x", fn: (a) => Math.sign(n1(a)) },
	IF: { help: "IF(test, yes, no)", fn: (a) => (num(one(a[0])) ? one(a[1] ?? true) : one(a[2] ?? false)) },
	AND: { help: "All true", fn: (a) => flat(a).every((v) => num(v) !== 0) },
	OR: { help: "Any true", fn: (a) => flat(a).some((v) => num(v) !== 0) },
	NOT: { help: "Opposite", fn: (a) => !num(one(a[0])) },
	CONCAT: { help: "Join text", fn: (a) => flat(a).map(str).join("") },
	LEN: { help: "Length of text", fn: (a) => str(one(a[0])).length },
	UPPER: { help: "UPPERCASE", fn: (a) => str(one(a[0])).toUpperCase() },
	LOWER: { help: "lowercase", fn: (a) => str(one(a[0])).toLowerCase() },
};

export function evaluate(node: Node, ctx: Ctx): Arg {
	switch (node.t) {
		case "num": case "str": case "bool": return node.v;
		case "ref": return ctx.get ? ctx.get(node.sheet, node.ref) : new FErr("#REF!");
		case "range": return ctx.range ? ctx.range(node.sheet, node.a, node.b) : new FErr("#REF!");
		case "var": {
			const k = node.name;
			if (ctx.vars && k in ctx.vars) return ctx.vars[k];
			const c = CONSTS[k.toLowerCase()];
			if (c !== undefined) return c;
			throw new FErr("#NAME?");
		}
		case "neg": return -num(one(evaluate(node.e, ctx)));
		case "pct": return num(one(evaluate(node.e, ctx))) / 100;
		case "fn": {
			const name = node.name === "LOG" && node.args.length === 1 && ctx.vars ? "LOG10" : node.name;
			const f = FUNCTIONS[name];
			if (!f) throw new FErr("#NAME?");
			if (name === "IF") {
				const test = num(one(evaluate(node.args[0], ctx)));
				const pick = test ? node.args[1] : node.args[2];
				return pick ? one(evaluate(pick, ctx)) : !!test;
			}
			return f.fn(node.args.map((n) => evaluate(n, ctx)));
		}
		case "bin": {
			const l = one(evaluate(node.l, ctx)), r = one(evaluate(node.r, ctx));
			if (l instanceof FErr) throw l;
			if (r instanceof FErr) throw r;
			switch (node.op) {
				case "+": return num(l) + num(r);
				case "-": return num(l) - num(r);
				case "*": return num(l) * num(r);
				case "/": { const d = num(r); if (d === 0) throw new FErr("#DIV/0!"); return num(l) / d; }
				case "^": return Math.pow(num(l), num(r));
				case "&": return str(l) + str(r);
				default: {
					const cmp = typeof l === "number" && typeof r === "number" ? l - r : str(l).localeCompare(str(r), undefined, { sensitivity: "base" });
					return node.op === "=" ? cmp === 0 : node.op === "<>" ? cmp !== 0 : node.op === "<" ? cmp < 0 : node.op === ">" ? cmp > 0 : node.op === "<=" ? cmp <= 0 : cmp >= 0;
				}
			}
		}
	}
}

/** Evaluate and always return a single value (errors become FErr values). */
export function run(node: Node, ctx: Ctx): V {
	try {
		const v = one(evaluate(node, ctx));
		if (typeof v === "number" && !isFinite(v)) return new FErr("#NUM!");
		return v;
	} catch (e) {
		return e instanceof FErr ? e : new FErr("#ERROR!");
	}
}

/** Compile plain maths like "2x^2 + sin(x)" or "y = x^2" into a function of x. */
export function compilePlain(src: string): ((x: number) => number) | null {
	let s = src.trim().replace(/^(y|f\s*\(\s*x\s*\))\s*=/i, "");
	if (!s) return null;
	try {
		const node = parse(s, true);
		return (x: number) => {
			const v = run(node, { vars: { x } });
			return typeof v === "number" ? v : NaN;
		};
	} catch {
		return null;
	}
}

// --- cell address helpers ---
export function colName(c: number): string { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }
export function colIndex(s: string): number { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }
export function addr(r: number, c: number) { return colName(c) + (r + 1); }
export function parseAddr(a: string): { r: number; c: number } | null { const m = a.match(/^([A-Z]+)(\d+)$/i); return m ? { r: parseInt(m[2]) - 1, c: colIndex(m[1]) } : null; }
