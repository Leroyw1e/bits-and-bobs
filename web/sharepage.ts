/**
 * The page people see when they open a shared spreadsheet link (bits-sync.leroyw1e.workers.dev/s/<id>).
 * Built with `npm run build:web` into the sync worker's src/share.client.js.
 * Shows the sheet with formulas worked out, colours, bold, alignment and number formats, and lets people
 * change cells when the link allows it. Checks for changes every few seconds.
 */
import { FErr, addr, colName } from "../src/formula";
import { displayValue } from "../src/sheetmeta";
import { ShareCalc, ShareCells, ShareMeta, cellKey } from "../src/sharecalc";
import { boardHtml, cleanOnly, panZoom, renderMarkdown, renderPdf } from "./viewers";

interface Doc { kind?: string; version: number; name: string; live: boolean; edit: boolean; signin: boolean; updated: number; meta?: ShareMeta; cells?: ShareCells }
interface AccountApi { ready: Promise<{ name?: string; email?: string } | null>; token(): string | null; signIn(): void }

const id = location.pathname.split("/").pop() ?? "";
const app = document.getElementById("app")!;
let doc: Doc | null = null;
let calc: ShareCalc | null = null;
let active = 0;
let sel = { r: 0, c: 0 };
let user: { name?: string; email?: string } | null = null;
let saving = 0;
const account = (): AccountApi | null => (window as unknown as { Account?: AccountApi }).Account ?? null;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text !== undefined) e.textContent = text;
	return e;
};

let msgEl: HTMLElement, barInput: HTMLInputElement, refEl: HTMLElement, wrap: HTMLElement, tabsEl: HTMLElement, headEl: HTMLElement;

function say(text: string, bad = false) { msgEl.textContent = text; msgEl.className = "msg" + (bad ? " err" : ""); }

const canEdit = () => !!doc?.edit && (!doc.signin || !!user);
const sheetName = () => doc!.meta!.sheets[active]?.name ?? "";

function shell() {
	app.textContent = "";
	headEl = el("header");
	app.append(headEl);
	const bar = el("div", "bar");
	refEl = el("span", "ref", "A1");
	barInput = el("input");
	barInput.setAttribute("aria-label", "Cell contents");
	barInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); void commit(barInput.value); move(1, 0); }
		if (e.key === "Escape") { e.stopPropagation(); barInput.value = rawAt(sel.r, sel.c); barInput.blur(); }
	});
	bar.append(refEl, barInput);
	msgEl = el("div", "msg");
	wrap = el("div", "wrap");
	tabsEl = el("div", "tabs");
	app.append(bar, msgEl, wrap, tabsEl);
	document.addEventListener("keydown", onKey);
}

function header() {
	headEl.textContent = "";
	const h = el("h1", "", doc!.name);
	headEl.append(h);
	headEl.append(el("span", "pill" + (doc!.live ? " live" : ""), doc!.live ? "Live" : "Copy"));
	headEl.append(el("span", "pill", !doc!.edit ? "View only" : doc!.signin && !user ? "Sign in with Keyring to edit" : "You can edit"));
	if (doc!.edit && doc!.signin && !user && account()) {
		const b = el("button", "cta", "Sign in with Keyring");
		b.onclick = () => account()!.signIn();
		headEl.append(b);
	}
}

const rawAt = (r: number, c: number) => doc?.cells?.[cellKey(sheetName(), addr(r, c))] ?? "";

function render() {
	if (!doc?.meta || !calc) return;
	header();
	const sh = doc.meta.sheets[active] ?? doc.meta.sheets[0];
	const ext = calc.extent(sh.name);
	const rows = Math.max(ext.rows + (canEdit() ? 20 : 2), 20), cols = Math.max(ext.cols + (canEdit() ? 4 : 1), 6);
	const keepX = wrap.scrollLeft, keepY = wrap.scrollTop;
	wrap.textContent = "";
	const t = el("table");
	const cg = el("colgroup");
	cg.append(el("col", "rhc"));
	for (let c = 0; c < cols; c++) { const col = el("col"); col.style.width = `${sh.colW[c] ?? 96}px`; cg.append(col); }
	t.append(cg);
	const thead = el("thead"), hr = el("tr");
	hr.append(el("th", "rh"));
	for (let c = 0; c < cols; c++) hr.append(el("th", "", colName(c)));
	thead.append(hr); t.append(thead);
	const tb = el("tbody");
	for (let r = 0; r < rows; r++) {
		const tr = el("tr");
		const h = sh.rowH[r];
		if (h) tr.style.height = `${h}px`;
		tr.append(el("th", "rh", String(r + 1)));
		for (let c = 0; c < cols; c++) {
			const ref = addr(r, c);
			const v = calc.value(sh.name, ref);
			const f = sh.fmt[ref] ?? {};
			const td = el("td", "", displayValue(v, f.nf));
			if (typeof v === "number") td.classList.add("n");
			if (v instanceof FErr) td.classList.add("err");
			if (f.b) td.classList.add("b");
			if (f.i) td.classList.add("i");
			if (f.al) td.classList.add("al-" + f.al);
			if (f.bg) { td.classList.add("fill"); td.style.backgroundColor = f.bg; }
			if (f.c) td.style.color = f.c;
			if (r === sel.r && c === sel.c) td.classList.add("sel");
			td.dataset.r = String(r); td.dataset.c = String(c);
			tr.append(td);
		}
		tb.append(tr);
	}
	t.append(tb);
	t.addEventListener("click", (e) => {
		const td = (e.target as HTMLElement).closest("td");
		if (!td) return;
		select(Number(td.dataset.r), Number(td.dataset.c));
	});
	t.addEventListener("dblclick", () => { if (canEdit()) barInput.focus(); });
	wrap.append(t);
	wrap.scrollLeft = keepX; wrap.scrollTop = keepY;

	tabsEl.textContent = "";
	doc.meta.sheets.forEach((s, i) => {
		const b = el("button", i === active ? "on" : "", s.name);
		b.onclick = () => { active = i; sel = { r: 0, c: 0 }; render(); };
		tabsEl.append(b);
	});
	tabsEl.hidden = doc.meta.sheets.length < 2;
	showSel();
}

function showSel() {
	refEl.textContent = addr(sel.r, sel.c);
	if (document.activeElement !== barInput) barInput.value = rawAt(sel.r, sel.c);
	barInput.disabled = !canEdit();
	barInput.placeholder = canEdit() ? "Type here to change the cell, then press Enter" : "";
}

function select(r: number, c: number) {
	sel = { r: Math.max(0, r), c: Math.max(0, c) };
	wrap.querySelectorAll("td.sel").forEach((x) => x.classList.remove("sel"));
	const td = wrap.querySelector(`td[data-r="${sel.r}"][data-c="${sel.c}"]`);
	td?.classList.add("sel");
	td?.scrollIntoView({ block: "nearest", inline: "nearest" });
	barInput.blur();
	showSel();
}

function move(dr: number, dc: number) { select(sel.r + dr, sel.c + dc); }

function onKey(e: KeyboardEvent) {
	if (document.activeElement === barInput || e.metaKey || e.ctrlKey || e.altKey) return;
	const k = e.key;
	if (k === "ArrowDown") { e.preventDefault(); move(1, 0); }
	else if (k === "ArrowUp") { e.preventDefault(); move(-1, 0); }
	else if (k === "ArrowLeft") { e.preventDefault(); move(0, -1); }
	else if (k === "ArrowRight" || k === "Tab") { e.preventDefault(); move(0, 1); }
	else if (k === "Enter" && canEdit()) { e.preventDefault(); barInput.focus(); }
	else if ((k === "Backspace" || k === "Delete") && canEdit()) { e.preventDefault(); void commit(""); }
	else if (k.length === 1 && canEdit()) { barInput.value = ""; barInput.focus(); }
}

async function commit(raw: string) {
	if (!doc || !canEdit()) return;
	const key = cellKey(sheetName(), addr(sel.r, sel.c));
	if ((doc.cells![key] ?? "") === raw) return;
	doc.cells![key] = raw;
	calc!.reset();
	render();
	saving++;
	say("Saving…");
	try {
		const headers: Record<string, string> = { "content-type": "application/json" };
		const tok = account()?.token();
		if (tok) headers.authorization = `Bearer ${tok}`;
		const r = await fetch(`/api/s/${id}/cells`, { method: "POST", headers, body: JSON.stringify({ ops: [[key, raw]] }) });
		const d = (await r.json().catch(() => ({}))) as { error?: string; version?: number };
		if (!r.ok) throw new Error(d.error ?? "Couldn't save that change.");
		say("Saved");
	} catch (e) {
		say((e as Error).message, true);
		void load(true);
	} finally { saving--; }
}

async function load(full = false) {
	const r = await fetch(`/api/s/${id}${!full && doc ? `?since=${doc.version}` : ""}`, { cache: "no-store" });
	if (r.status === 404) { gone(); doc = null; return; }
	if (!r.ok) throw new Error("offline");
	const d = (await r.json()) as Doc;
	if (d.meta && d.cells) {
		// keep a change that's still being saved here
		doc = d;
		calc = new ShareCalc(d.meta, d.cells);
		if (document.activeElement === barInput) barInput.value = rawAt(sel.r, sel.c);
		if (active >= d.meta.sheets.length) active = 0;
		document.title = d.name;
		render();
	} else if (doc) {
		const changedRules = doc.edit !== d.edit || doc.signin !== d.signin || doc.live !== d.live || doc.name !== d.name;
		Object.assign(doc, { version: d.version, edit: d.edit, signin: d.signin, live: d.live, name: d.name });
		if (changedRules) render();
	}
}

// ---------- notes, boards, slides, PDFs and pictures (view only) ----------

const blobUrl = (name: string, v: number) => `/s/${id}/b/${encodeURIComponent(name)}?v=${v}`;

function gone() {
	app.textContent = "";
	const g = el("div", "gone");
	g.append(el("h1", "", "This link has been turned off"), el("p", "", "The person who shared it has stopped sharing."));
	app.append(g);
}

async function other(head: Doc) {
	let version = -1;
	const top = el("header");
	const body = el("div", "view view-" + head.kind);
	app.textContent = "";
	app.append(top, body);
	const draw = async (d: Doc) => {
		version = d.version;
		document.title = d.name;
		top.textContent = "";
		top.append(el("h1", "", d.name), el("span", "pill" + (d.live ? " live" : ""), d.live ? "Live" : "Copy"), el("span", "pill", "View only"));
		const blob = (n: string) => blobUrl(n, version);
		const fresh = el("div", "view view-" + d.kind);
		try {
			await drawKind(d.kind ?? "", fresh, blob);
		} catch (e) {
			console.error(e);
			fresh.textContent = "";
			fresh.append(el("div", "gone", d.version ? "This couldn't be shown. Try reloading the page." : "Still getting this ready. Try again in a moment."));
		}
		app.replaceChild(fresh, app.lastElementChild!);
	};
	await draw(head);
	if (!head.live) return;
	window.setInterval(() => {
		if (document.hidden) return;
		fetch(`/api/s/${id}?since=${version}`, { cache: "no-store" }).then(async (r) => {
			if (r.status === 404) { gone(); return; }
			const d = (await r.json()) as Doc;
			if (d.version !== version) await draw(d);
		}).catch(() => { /* offline: keep showing what we have */ });
	}, 10000);
	void body;
}

async function json<T>(url: string): Promise<T> {
	const r = await fetch(url, { cache: "no-store" });
	if (!r.ok) throw new Error(String(r.status));
	return (await r.json()) as T;
}

function zoomButtons(host: HTMLElement, pz: { fit(): void; zoom(f: number): void }) {
	const bar = el("div", "zoombar");
	const b = (label: string, text: string, fn: () => void) => { const x = el("button", "", text); x.setAttribute("aria-label", label); x.onclick = fn; bar.append(x); };
	b("Zoom out", "−", () => pz.zoom(1 / 1.25));
	b("Fit", "Fit", () => pz.fit());
	b("Zoom in", "+", () => pz.zoom(1.25));
	host.append(bar);
}

async function addCss(blob: (n: string) => string) {
	if (document.getElementById("bb-plugin-css")) return;
	const css = await fetch(blob("css")).then((r) => (r.ok ? r.text() : ""), () => "");
	const st = el("style");
	st.id = "bb-plugin-css";
	st.textContent = css;
	document.head.append(st);
}

async function drawKind(kind: string, host: HTMLElement, blob: (n: string) => string) {
	if (kind === "note") {
		const b = await json<{ md: string }>(blob("body"));
		const page = el("article", "note markdown-rendered");
		host.append(page);
		await renderMarkdown(page, b.md, blob);
		return;
	}
	if (kind === "image") {
		await cleanOnly();
		const img = el("img", "pic");
		img.src = blob("file");
		img.alt = "";
		await new Promise((res) => { img.onload = res; img.onerror = res; });
		const view = el("div", "stage pan"), inner = el("div", "inner");
		inner.append(img); view.append(inner); host.append(view);
		zoomButtons(host, panZoom(view, inner, img.naturalWidth || 800, img.naturalHeight || 600));
		return;
	}
	if (kind === "pdf") {
		const a = el("a", "btn", "Download the PDF");
		a.href = blob("file"); a.setAttribute("download", (document.title || "file") + ".pdf");
		const bar = el("div", "pdfbar"); bar.append(a);
		const pages = el("div", "pdfpages");
		host.append(bar, pages);
		await renderPdf(pages, blob("file"));
		return;
	}
	if (kind === "board") {
		const [b] = await Promise.all([json<{ html: string; box: { x: number; y: number; w: number; h: number } }>(blob("body")), addCss(blob)]);
		const root = await boardHtml(b.html, blob);
		const view = el("div", "stage pan board"), inner = el("div", "inner");
		root.style.width = `${b.box.w}px`; root.style.height = `${b.box.h}px`;
		const world = root.querySelector<HTMLElement>(".ms-world");
		if (world) world.style.transform = `translate(${-b.box.x}px, ${-b.box.y}px)`;
		inner.append(root); view.append(inner); host.append(view);
		zoomButtons(host, panZoom(view, inner, b.box.w, b.box.h));
		return;
	}
	if (kind === "slides") {
		const [b] = await Promise.all([json<{ w: number; h: number; slides: { html: string; transition?: string }[] }>(blob("body")), addCss(blob)]);
		const roots = await Promise.all(b.slides.map((s) => boardHtml(s.html, blob)));
		const stage = el("div", "stage deck"), frame = el("div", "deckframe");
		stage.append(frame); host.append(stage);
		const nav = el("div", "decknav"), prev = el("button", "", "‹ Back"), count = el("span", "count"), next = el("button", "cta", "Next ›");
		nav.append(prev, count, next); host.append(nav);
		let i = 0;
		const fit = () => {
			const r = stage.getBoundingClientRect();
			const z = Math.min(r.width / b.w, r.height / b.h);
			frame.style.width = `${b.w}px`; frame.style.height = `${b.h}px`;
			frame.style.transform = `translate(${(r.width - b.w * z) / 2}px, ${(r.height - b.h * z) / 2}px) scale(${z})`;
		};
		const show = (n: number, back = false) => {
			if (!roots.length) { count.textContent = "No slides"; return; }
			i = Math.max(0, Math.min(roots.length - 1, n));
			const root = roots[i];
			root.style.width = `${b.w}px`; root.style.height = `${b.h}px`;
			const t = b.slides[i].transition;
			root.className = root.className.replace(/\bfx-\S+/g, "").trim();
			frame.textContent = "";
			frame.append(root);
			if (t && t !== "none") { root.classList.add("fx-" + t + (back ? "-back" : "")); }
			count.textContent = `${i + 1} / ${roots.length}`;
			prev.disabled = i === 0; next.disabled = i === roots.length - 1;
		};
		prev.onclick = () => show(i - 1, true);
		next.onclick = () => show(i + 1);
		document.onkeydown = (e) => {
			if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") { e.preventDefault(); show(i + 1); }
			if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); show(i - 1, true); }
		};
		let sx = 0;
		stage.addEventListener("pointerdown", (e) => { sx = e.clientX; });
		stage.addEventListener("pointerup", (e) => { const dx = e.clientX - sx; if (Math.abs(dx) > 40) show(dx < 0 ? i + 1 : i - 1, dx > 0); else if (e.clientX > stage.getBoundingClientRect().left + stage.clientWidth / 2) show(i + 1); else show(i - 1, true); });
		new ResizeObserver(fit).observe(stage);
		show(0);
		return;
	}
	host.append(el("div", "gone", "This kind of file can't be shown here."));
}

async function main() {
	let head: Doc;
	try {
		const r = await fetch(`/api/s/${id}`, { cache: "no-store" });
		if (r.status === 404) { gone(); return; }
		head = (await r.json()) as Doc;
	} catch {
		app.textContent = "Couldn't load this. Check your internet connection.";
		return;
	}
	if (head.kind && head.kind !== "sheet") { await other(head); return; }
	shell();
	const acc = account();
	if (acc) user = await acc.ready.catch(() => null);
	try { await load(true); say(""); } catch { say("Couldn't load this spreadsheet. Check your internet connection.", true); }
	window.setInterval(() => {
		// don't pull while someone is part-way through typing a change
		const typing = document.activeElement === barInput && barInput.value !== rawAt(sel.r, sel.c);
		if (!doc || saving || document.hidden || typing) return;
		load().then(() => { if (msgEl.classList.contains("err") && msgEl.textContent?.startsWith("Offline")) say(""); }, () => say("Offline. Changes from others will show when you're back online.", true));
	}, 4000);
}

void main();
