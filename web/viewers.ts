/**
 * View-only pages for shared notes, boards, slide decks, PDFs and pictures.
 * Libraries load from jsDelivr at pinned versions: marked (Markdown), DOMPurify (cleans anything shown),
 * MathJax (maths). Everything from the shared file goes through DOMPurify before it's shown.
 */

const LIBS = {
	marked: "https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js",
	purify: "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js",
	mathjax: "https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js",
	pdf: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js",
	pdfWorker: "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js",
};

interface PdfPage { getViewport(o: { scale: number }): { width: number; height: number }; render(o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }): { promise: Promise<void> } }
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage> }
interface PdfLib { GlobalWorkerOptions: { workerSrc: string }; getDocument(o: { url: string } | { data: ArrayBuffer }): { promise: Promise<PdfDoc> } }

/** Draw every page of a PDF, fitted to the width, a few pages at a time as you scroll. */
export async function renderPdf(host: HTMLElement, url: string) {
	await load(LIBS.pdf);
	const lib = (window as unknown as { pdfjsLib: PdfLib }).pdfjsLib;
	lib.GlobalWorkerOptions.workerSrc = LIBS.pdfWorker;
	const data = await fetch(url).then((r) => { if (!r.ok) throw new Error("The PDF couldn't be loaded."); return r.arrayBuffer(); });
	const pdf = await lib.getDocument({ data }).promise;
	const width = Math.min(host.clientWidth || 800, 1000);
	const dpr = Math.min(window.devicePixelRatio || 1, 2);
	const pages: { n: number; canvas: HTMLCanvasElement; done: boolean }[] = [];
	for (let n = 1; n <= pdf.numPages; n++) {
		const first = await pdf.getPage(n);
		const vp = first.getViewport({ scale: 1 });
		const c = document.createElement("canvas");
		c.className = "pdfpage";
		c.style.aspectRatio = `${vp.width} / ${vp.height}`;
		host.append(c);
		pages.push({ n, canvas: c, done: false });
		if (n >= 300) break;
	}
	const draw = async (p: { n: number; canvas: HTMLCanvasElement; done: boolean }) => {
		if (p.done) return;
		p.done = true;
		const page = await pdf.getPage(p.n);
		const base = page.getViewport({ scale: 1 });
		const vp = page.getViewport({ scale: (width / base.width) * dpr });
		p.canvas.width = vp.width; p.canvas.height = vp.height;
		await page.render({ canvasContext: p.canvas.getContext("2d")!, viewport: vp }).promise;
	};
	const io = new IntersectionObserver((entries) => {
		for (const e of entries) if (e.isIntersecting) { const p = pages.find((x) => x.canvas === e.target); if (p) void draw(p); }
	}, { rootMargin: "800px" });
	for (const p of pages) io.observe(p.canvas);
}

interface Marked { parse(md: string, o?: object): string }
interface Purify { sanitize(html: string, o?: object): string }
interface MathJaxApi { typesetPromise(els: Element[]): Promise<void>; startup?: { promise: Promise<void> } }
type W = Window & { marked?: Marked; DOMPurify?: Purify; MathJax?: MathJaxApi | object };

const win = window as W;
const loaded = new Map<string, Promise<void>>();
function load(src: string): Promise<void> {
	let p = loaded.get(src);
	if (!p) {
		p = new Promise((res, rej) => { const s = document.createElement("script"); s.src = src; s.onload = () => res(); s.onerror = () => rej(new Error("Couldn't load " + src)); document.head.append(s); });
		loaded.set(src, p);
	}
	return p;
}

async function libs(withMarked: boolean) {
	await load(LIBS.purify);
	if (withMarked) await load(LIBS.marked);
}

let mathReady: Promise<MathJaxApi> | null = null;
function mathjax(): Promise<MathJaxApi> {
	if (!mathReady) {
		win.MathJax = { tex: { inlineMath: [["\\(", "\\)"]], displayMath: [["\\[", "\\]"]] }, svg: { fontCache: "global" }, startup: { typeset: false } };
		mathReady = load(LIBS.mathjax).then(async () => { const m = win.MathJax as MathJaxApi; await m.startup?.promise; return m; });
	}
	return mathReady;
}

interface PurifyFrag { sanitize(html: string, o: { RETURN_DOM_FRAGMENT: true } & Record<string, unknown>): DocumentFragment }
/** Clean HTML into page elements (scripts, event handlers and the like are removed). */
const clean = (html: string): DocumentFragment => (win.DOMPurify as unknown as PurifyFrag).sanitize(html, { RETURN_DOM_FRAGMENT: true, FORBID_TAGS: ["style", "form", "input", "button", "textarea", "iframe"] });

/** Pull maths out before Markdown sees it ($…$, $$…$$), leaving code alone. */
function protectMath(md: string): { md: string; math: { tex: string; display: boolean }[] } {
	const math: { tex: string; display: boolean }[] = [];
	const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/);
	for (let i = 0; i < parts.length; i += 2) {
		parts[i] = parts[i]
			.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex: string) => { math.push({ tex: tex.trim(), display: true }); return `\n\nBBMATH${math.length - 1}X\n\n`; })
			.replace(/(^|[^\\$])\$(?!\s)([^$\n]+?)\$(?!\d)/g, (all: string, pre: string, tex: string) => {
				if (/\s$/.test(tex)) return all; // "$5 and $6" isn't maths
				math.push({ tex, display: false });
				return `${pre}BBMATH${math.length - 1}X`;
			});
	}
	return { md: parts.join(""), math };
}

/** Markdown (Obsidian flavour, already made plain by the plugin) into the element, with maths and callouts. */
export async function renderMarkdown(el: HTMLElement, src: string, blob: (name: string) => string) {
	await libs(true);
	const { md, math } = protectMath(src);
	el.replaceChildren(clean(win.marked!.parse(md, { gfm: true, breaks: false })));
	// pictures from the share
	el.querySelectorAll("img").forEach((img) => {
		const name = img.getAttribute("data-bb");
		if (name) img.src = blob(name);
		img.loading = "lazy";
	});
	el.querySelectorAll("a[href]").forEach((a) => { a.setAttribute("target", "_blank"); a.setAttribute("rel", "noopener nofollow"); });
	// > [!note] Title  ->  a callout box
	el.querySelectorAll("blockquote").forEach((q) => {
		const first = q.firstElementChild;
		const m = first?.textContent?.match(/^\[!(\w+)\][-+]?\s*(.*)/);
		if (!first || !m) return;
		q.classList.add("callout", "callout-" + m[1].toLowerCase());
		const title = document.createElement("div");
		title.className = "callout-title";
		title.textContent = m[2] || m[1][0].toUpperCase() + m[1].slice(1);
		first.textContent = (first.textContent ?? "").split("\n").slice(1).join("\n");
		if (!first.textContent.trim()) first.remove();
		q.prepend(title);
	});
	if (!math.length) return;
	// put maths back as plain text, then let MathJax draw it
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const hits: Text[] = [];
	while (walker.nextNode()) if (/BBMATH\d+X/.test(walker.currentNode.nodeValue ?? "")) hits.push(walker.currentNode as Text);
	for (const t of hits) {
		t.nodeValue = (t.nodeValue ?? "").replace(/BBMATH(\d+)X/g, (_, i: string) => { const m = math[Number(i)]; return m.display ? `\\[${m.tex}\\]` : `\\(${m.tex}\\)`; });
	}
	// MathJax measures text, so the element must be on the page while it draws
	const mj = await mathjax();
	let parked: HTMLElement | null = null;
	if (!el.isConnected) {
		let top: HTMLElement = el;
		while (top.parentElement) top = top.parentElement;
		parked = document.createElement("div");
		parked.className = "bb-parked";
		parked.append(top);
		document.body.append(parked);
	}
	try { await mj.typesetPromise([el]); }
	finally {
		if (parked) { const top = parked.firstElementChild; if (top) top.remove(); parked.remove(); }
	}
}

// ---------- pan and zoom (boards, pictures) ----------

export function panZoom(view: HTMLElement, content: HTMLElement, w: number, h: number) {
	let z = 1, x = 0, y = 0;
	const apply = () => { content.style.transform = `translate(${x}px, ${y}px) scale(${z})`; };
	const fit = () => {
		const r = view.getBoundingClientRect();
		z = Math.min(r.width / Math.max(w, 1), r.height / Math.max(h, 1), 2) * 0.94;
		x = (r.width - w * z) / 2; y = (r.height - h * z) / 2;
		apply();
	};
	const zoomAt = (f: number, cx: number, cy: number) => {
		const nz = Math.min(8, Math.max(0.05, z * f));
		x = cx - (cx - x) * (nz / z); y = cy - (cy - y) * (nz / z); z = nz; apply();
	};
	const pts = new Map<number, { x: number; y: number }>();
	let last: { d: number; cx: number; cy: number } | null = null;
	view.addEventListener("pointerdown", (e) => { view.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); });
	view.addEventListener("pointermove", (e) => {
		const p = pts.get(e.pointerId);
		if (!p) return;
		const r = view.getBoundingClientRect();
		if (pts.size === 1) { x += e.clientX - p.x; y += e.clientY - p.y; apply(); }
		pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
		if (pts.size === 2) {
			const [a, b] = [...pts.values()];
			const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
			if (last) { zoomAt(d / last.d, cx, cy); x += cx - last.cx; y += cy - last.cy; apply(); }
			last = { d, cx, cy };
		}
	});
	const up = (e: PointerEvent) => { pts.delete(e.pointerId); if (pts.size < 2) last = null; };
	view.addEventListener("pointerup", up);
	view.addEventListener("pointercancel", up);
	view.addEventListener("wheel", (e) => {
		e.preventDefault();
		const r = view.getBoundingClientRect();
		// pinch on a trackpad (or ctrl/cmd + wheel) zooms; scrolling pans
		if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY / 200), e.clientX - r.left, e.clientY - r.top);
		else { x -= e.deltaX; y -= e.deltaY; apply(); }
	}, { passive: false });
	new ResizeObserver(fit).observe(view);
	return { fit, zoom: (f: number) => { const r = view.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); } };
}

/** A board or slide copied from Obsidian: clean it, point pictures at the share, draw text as Markdown. */
export async function boardHtml(html: string, blob: (name: string) => string): Promise<HTMLElement> {
	await libs(true);
	const holder = document.createElement("div");
	holder.className = "bb-parked";
	holder.append(clean(html));
	document.body.append(holder); // on the page (out of sight) so maths can be measured
	const root = holder.firstElementChild as HTMLElement;
	root.querySelectorAll("img[data-bb]").forEach((img) => { (img as HTMLImageElement).src = blob(img.getAttribute("data-bb")!); });
	const jobs: Promise<void>[] = [];
	root.querySelectorAll<HTMLElement>(".bb-md").forEach((d) => {
		d.classList.add("markdown-rendered");
		jobs.push(renderMarkdown(d, d.getAttribute("data-md") ?? "", blob));
	});
	try { await Promise.all(jobs); }
	finally { holder.remove(); }
	return root;
}

export async function cleanOnly() { await libs(false); }
