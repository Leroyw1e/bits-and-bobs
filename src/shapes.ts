// Turns a rough hand-drawn stroke into a clean line, ellipse, rectangle or polygon.

export type Pt2 = [number, number];
export type Recognized =
	| { kind: "line"; x1: number; y1: number; x2: number; y2: number }
	| { kind: "ellipse"; x: number; y: number; w: number; h: number }
	| { kind: "rect"; x: number; y: number; w: number; h: number }
	| { kind: "poly"; pts: Pt2[] };

const dist = (a: Pt2, b: Pt2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function segDist(p: Pt2, a: Pt2, b: Pt2) {
	const dx = b[0] - a[0], dy = b[1] - a[1];
	const l2 = dx * dx + dy * dy;
	let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

function pathLength(p: Pt2[]) { let l = 0; for (let i = 1; i < p.length; i++) l += dist(p[i - 1], p[i]); return l; }

function resample(p: Pt2[], n: number): Pt2[] {
	const total = pathLength(p);
	if (total === 0) return p.slice();
	const step = total / (n - 1);
	const out: Pt2[] = [p[0]];
	let acc = 0;
	for (let i = 1; i < p.length; i++) {
		let a = p[i - 1];
		const b = p[i];
		let d = dist(a, b);
		while (acc + d >= step && d > 0) {
			const t = (step - acc) / d;
			const q: Pt2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
			out.push(q);
			a = q; d = dist(a, b); acc = 0;
		}
		acc += d;
	}
	if (out.length < n) out.push(p[p.length - 1]);
	return out;
}

/** Ramer–Douglas–Peucker simplification of an open polyline. */
function rdp(p: Pt2[], eps: number): Pt2[] {
	if (p.length < 3) return p.slice();
	let max = 0, idx = 0;
	for (let i = 1; i < p.length - 1; i++) { const d = segDist(p[i], p[0], p[p.length - 1]); if (d > max) { max = d; idx = i; } }
	if (max <= eps) return [p[0], p[p.length - 1]];
	return [...rdp(p.slice(0, idx + 1), eps).slice(0, -1), ...rdp(p.slice(idx), eps)];
}

/** Drop vertices where the path barely turns (so an edge isn't split in two). */
function dropStraight(poly: Pt2[], minTurnDeg: number): Pt2[] {
	let v = poly.slice();
	let changed = true;
	while (changed && v.length > 3) {
		changed = false;
		for (let i = 0; i < v.length; i++) {
			const a = v[(i + v.length - 1) % v.length], b = v[i], c = v[(i + 1) % v.length];
			const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
			let turn = Math.abs(a2 - a1);
			if (turn > Math.PI) turn = 2 * Math.PI - turn;
			if (turn * 180 / Math.PI < minTurnDeg) { v.splice(i, 1); changed = true; break; }
		}
	}
	return v;
}

export function recognizeShape(raw: Pt2[]): Recognized | null {
	if (raw.length < 4) return null;
	const L = pathLength(raw);
	let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
	for (const [x, y] of raw) { if (x < x1) x1 = x; if (y < y1) y1 = y; if (x > x2) x2 = x; if (y > y2) y2 = y; }
	const w = x2 - x1, h = y2 - y1, D = Math.hypot(w, h);
	if (L < 24 || D < 16) return null;
	const first = raw[0], last = raw[raw.length - 1];
	const gap = dist(first, last);

	// ---- straight line ----
	if (gap > 0.5 * L || gap > 0.4 * D) {
		let worst = 0;
		for (const p of raw) worst = Math.max(worst, segDist(p, first, last));
		if (worst / gap < 0.08 && gap / L > 0.85) {
			// snap near-horizontal / near-vertical lines to exactly horizontal / vertical
			let ex = last[0], ey = last[1];
			const ang = Math.atan2(last[1] - first[1], last[0] - first[0]) * 180 / Math.PI;
			const a = ((ang % 180) + 180) % 180;
			if (a < 4 || a > 176) ey = first[1];
			else if (Math.abs(a - 90) < 4) ex = first[0];
			return { kind: "line", x1: first[0], y1: first[1], x2: ex, y2: ey };
		}
		return null;
	}

	// ---- closed shapes ----
	if (gap > 0.28 * D) return null;
	const pts = resample(raw, 72);
	const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = w / 2, ry = h / 2;
	if (rx < 4 || ry < 4) return null;

	let dev = 0;
	for (const [x, y] of pts) dev += Math.abs(Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2) - 1);
	dev /= pts.length;

	for (const k of [0.07, 0.1, 0.14]) {
		const closed = [...pts, pts[0]];
		const simple = rdp(closed, k * D);
		simple.pop();
		const poly = dropStraight(simple, 32);
		if (poly.length !== 3 && poly.length !== 4) continue;
		// how closely does the stroke hug the polygon?
		let err = 0;
		for (const p of pts) { let m = Infinity; for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist(p, poly[i], poly[(i + 1) % poly.length])); err += m; }
		err /= pts.length;
		if (err / D > 0.06) continue;
		if (dev < 0.07 && poly.length === 4) break; // a very round shape is a circle, not a square
		if (poly.length === 4) {
			let axis = true;
			for (let i = 0; i < 4; i++) {
				const a = poly[i], b = poly[(i + 1) % 4];
				const ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI) % 90;
				if (Math.min(ang, 90 - ang) > 14) axis = false;
			}
			if (axis) {
				const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
				return { kind: "rect", x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
			}
		}
		return { kind: "poly", pts: poly.map(([x, y]) => [x, y] as Pt2) };
	}
	if (dev < 0.13) {
		// near-perfect circle when the box is almost square
		if (Math.abs(w - h) / Math.max(w, h) < 0.12) { const d = (w + h) / 2; return { kind: "ellipse", x: cx - d / 2, y: cy - d / 2, w: d, h: d }; }
		return { kind: "ellipse", x: x1, y: y1, w, h };
	}
	return null;
}
