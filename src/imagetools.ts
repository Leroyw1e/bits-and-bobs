import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, TFile, setIcon } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { diskPathOfUpload, heicToJpeg, isHeic } from "./board";

/**
 * Pictures in notes (Live Preview): click one for a small bar to wrap text around it (left or right),
 * centre it, or make it bigger or smaller; drag it to move it to another line.
 * The choice is kept in the link, like ![[photo.jpg|left|300]], so it shows the same in Reading view.
 * Crop is kept in the link too, as crop-left-top-right-bottom in percent, like ![[photo.jpg|300|crop-10-0-25-5]].
 * The picture file itself is never changed, so a crop can be undone, and the original is still there.
 */
type Spot = "left" | "right" | "center" | "";

interface Embed { from: number; to: number; path: string; spot: Spot; width: string; crop: string }

const SPOTS = ["left", "right", "center"];

const CROP = /^crop-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})$/;

function parseEmbed(inner: string): { path: string; spot: Spot; width: string; crop: string; rest: string[] } {
	const parts = inner.split("|");
	const path = parts.shift() ?? "";
	let spot: Spot = "", width = "", crop = "";
	const rest: string[] = [];
	for (const p of parts) {
		const t = p.trim();
		if (SPOTS.includes(t.toLowerCase())) spot = t.toLowerCase() as Spot;
		else if (/^\d+(x\d+)?$/.test(t)) width = t;
		else if (CROP.test(t)) crop = t;
		else rest.push(p);
	}
	return { path, spot, width, crop, rest };
}

function viewFor(plugin: Plugin, el: HTMLElement): { cm: EditorView; md: MarkdownView } | null {
	for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
		const md = leaf.view as MarkdownView;
		if (!md.containerEl.contains(el)) continue;
		const cm = (md.editor as unknown as { cm?: EditorView }).cm;
		return cm ? { cm, md } : null;
	}
	return null;
}

/** The ![[...]] text behind a picture on screen. */
function findEmbed(cm: EditorView, el: HTMLElement): Embed | null {
	let pos: number;
	try { pos = cm.posAtDOM(el); } catch { return null; }
	const line = cm.state.doc.lineAt(pos);
	const re = /!\[\[([^\]]+)\]\]/g;
	let best: Embed | null = null, bestDist = Infinity;
	for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
		const from = line.from + m.index, to = from + m[0].length;
		const dist = pos < from ? from - pos : pos > to ? pos - to : 0;
		if (dist < bestDist) {
			const p = parseEmbed(m[1]);
			if (!/\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i.test(p.path.split("#")[0])) continue;
			bestDist = dist;
			best = { from, to, path: m[1], spot: p.spot, width: p.width, crop: p.crop };
		}
	}
	return best;
}

function rebuild(inner: string, change: { spot?: Spot; width?: string; crop?: string }): string {
	const p = parseEmbed(inner);
	const spot = change.spot ?? p.spot, width = change.width ?? p.width, crop = change.crop ?? p.crop;
	return `![[${[p.path, ...p.rest, ...(crop ? [crop] : []), ...(spot ? [spot] : []), ...(width ? [width] : [])].join("|")}]]`;
}

// ---------- showing a cropped picture ----------

/** Shrink a picture on screen to its cropped part, from the crop-… token in its link. Reading view and Live Preview. */
function showCrop(embed: HTMLElement) {
	const m = /(?:^|[\s|])crop-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{1,2})(?:$|[\s|])/.exec(embed.getAttribute("alt") ?? "");
	const img = embed.querySelector("img");
	if (!m || !img) {
		if (embed.hasClass("bb-cropped")) { embed.removeClass("bb-cropped"); embed.removeAttribute("style"); }
		return;
	}
	const [l, t, r, b] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
	const go = () => {
		const cw = 1 - (l + r) / 100, ch = 1 - (t + b) / 100;
		if (cw <= 0.02 || ch <= 0.02 || !img.naturalWidth) return;
		const asked = parseInt(embed.getAttribute("width") ?? "", 10);
		embed.addClass("bb-cropped");
		embed.setCssProps({
			"--bb-cl": String(l / 100), "--bb-ct": String(t / 100), "--bb-cw": String(cw), "--bb-ch": String(ch),
			"--bb-w": `${asked || Math.round(img.naturalWidth * cw)}px`,
			"aspect-ratio": `${img.naturalWidth * cw} / ${img.naturalHeight * ch}`,
		});
	};
	if (img.complete && img.naturalWidth) go();
	else img.addEventListener("load", go, { once: true });
}

type Box4 = [number, number, number, number];

/**
 * Crop on the page: the whole picture appears right where it is, with a frame to drag and resize over the part to keep.
 * Press Enter, tap Crop or click away to keep the crop; Escape cancels. The picture file isn't changed.
 */
function startCrop(embedEl: HTMLElement, src: string, start: Box4, done: (crop: string) => void) {
	const v: Box4 = [...start];
	const root = activeDocument.body.createDiv("bb-crop-live");
	root.createEl("img", { attr: { src, alt: "", draggable: "false" } });
	const box = root.createDiv("bb-crop-box");
	for (const h of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) box.createDiv({ cls: `bb-crop-h bb-crop-${h}`, attr: { "data-h": h } });
	let closed = false, raf = 0;
	const draw = () => box.setCssProps({ left: `${v[0]}%`, top: `${v[1]}%`, width: `${100 - v[0] - v[2]}%`, height: `${100 - v[1] - v[3]}%` });
	// keep the full picture exactly over the visible part (which may already be cropped), even if the page scrolls
	const cw = 1 - (start[0] + start[2]) / 100, ch = 1 - (start[1] + start[3]) / 100;
	const place = () => {
		if (closed) return;
		if (!embedEl.isConnected) { finish(false); return; }
		const r = embedEl.getBoundingClientRect();
		const W = r.width / cw, H = r.height / ch;
		root.setCssProps({ left: `${r.left - (start[0] / 100) * W}px`, top: `${r.top - (start[1] / 100) * H}px`, width: `${W}px`, height: `${H}px` });
		raf = window.requestAnimationFrame(place);
	};
	const finish = (keep: boolean) => {
		if (closed) return;
		closed = true;
		window.cancelAnimationFrame(raf);
		activeDocument.removeEventListener("pointerdown", outside, true);
		activeDocument.removeEventListener("keydown", keys, true);
		root.remove();
		if (!keep) return;
		const [l, t, r, b] = v.map((n) => Math.max(0, Math.min(95, Math.round(n))));
		done(l || t || r || b ? `crop-${l}-${t}-${r}-${b}` : "");
	};
	const outside = (e: PointerEvent) => { if (!root.contains(e.target as Node)) finish(true); };
	const keys = (e: KeyboardEvent) => {
		if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); finish(true); }
		else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
	};
	let drag: { h: string; x: number; y: number; start: Box4 } | null = null;
	box.addEventListener("pointerdown", (e) => {
		e.preventDefault(); e.stopPropagation();
		try { box.setPointerCapture(e.pointerId); } catch { /* the pointer already ended: not needed */ }
		drag = { h: (e.target as HTMLElement).dataset.h ?? "move", x: e.clientX, y: e.clientY, start: [...v] };
	});
	box.addEventListener("pointermove", (e) => {
		if (!drag) return;
		const r = root.getBoundingClientRect();
		const dx = ((e.clientX - drag.x) / r.width) * 100, dy = ((e.clientY - drag.y) / r.height) * 100;
		let [l, t, rr, b] = drag.start;
		const MIN = 6, h = drag.h;
		if (h === "move") {
			const w = 100 - l - rr, hh = 100 - t - b;
			l = Math.min(100 - w, Math.max(0, l + dx)); t = Math.min(100 - hh, Math.max(0, t + dy));
			rr = 100 - w - l; b = 100 - hh - t;
		} else {
			if (h.includes("w")) l = Math.min(100 - rr - MIN, Math.max(0, l + dx));
			if (h.includes("e")) rr = Math.min(100 - l - MIN, Math.max(0, rr - dx));
			if (h.includes("n")) t = Math.min(100 - b - MIN, Math.max(0, t + dy));
			if (h.includes("s")) b = Math.min(100 - t - MIN, Math.max(0, b - dy));
		}
		v[0] = l; v[1] = t; v[2] = rr; v[3] = b;
		draw();
	});
	const end = () => { drag = null; };
	box.addEventListener("pointerup", end);
	box.addEventListener("pointercancel", end);
	const tools = root.createDiv("bb-crop-tools");
	const tool = (text: string, cls: string, fn: () => void) => { const b = tools.createEl("button", { text, cls }); b.onpointerdown = (e) => e.stopPropagation(); b.onclick = (e) => { e.preventDefault(); fn(); }; };
	tool("Whole picture", "", () => { v[0] = v[1] = v[2] = v[3] = 0; draw(); });
	tool("Cancel", "", () => finish(false));
	tool("Crop", "mod-cta", () => finish(true));
	draw();
	place();
	activeDocument.addEventListener("pointerdown", outside, true);
	activeDocument.addEventListener("keydown", keys, true);
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|heif)$/i;

/** Pictures dropped or pasted into a note: iPhone HEIC photos are turned into JPEGs so they show everywhere. Other pictures are left to Obsidian. */
async function handleDrop(plugin: Plugin, evt: DragEvent | ClipboardEvent, editor: Editor, info: MarkdownView | MarkdownFileInfo) {
	const dt = evt instanceof DragEvent ? evt.dataTransfer : evt.clipboardData;
	const files = Array.from(dt?.files ?? []);
	if (!files.length || !files.some((f) => isHeic(f.name.split(".").pop() ?? "", f.type))) return;
	if (!files.every((f) => f.type.startsWith("image/") || IMG_EXT.test(f.name))) return;
	evt.preventDefault();
	evt.stopPropagation();
	const app = plugin.app, from = info.file?.path ?? "";
	const out: string[] = [];
	let skipped = 0;
	for (const f of files) {
		let ext = (f.name.split(".").pop() || f.type.split("/")[1] || "png").toLowerCase();
		let data = await f.arrayBuffer();
		if (isHeic(ext, f.type)) {
			const jpg = await heicToJpeg(data, diskPathOfUpload(f));
			if (!jpg) { skipped++; continue; }
			data = jpg; ext = "jpg";
		}
		const base = f.name.replace(/\.[^.]+$/, "") || "Pasted image";
		const saved = await app.vault.createBinary(await app.fileManager.getAvailablePathForAttachment(`${base}.${ext}`, from), data);
		out.push(app.fileManager.generateMarkdownLink(saved, from).replace(/^(?!!)/, "!"));
	}
	if (skipped) new Notice(`${skipped} HEIC photo${skipped > 1 ? "s" : ""} couldn't be converted on this device. Save ${skipped > 1 ? "them" : "it"} as JPEG first.`);
	if (out.length) editor.replaceSelection(out.join("\n"));
}

export function setupImageTools(plugin: Plugin, enabled: () => boolean) {
	let bar: HTMLElement | null = null;
	const closeBar = () => { bar?.remove(); bar = null; };

	const showBar = (img: HTMLElement, cm: EditorView, embed: Embed, from: string) => {
		closeBar();
		const r = img.getBoundingClientRect();
		bar = activeDocument.body.createDiv("bb-img-bar");
		bar.setCssProps({ left: `${Math.max(8, r.left)}px`, top: `${Math.max(8, r.top - 44)}px` });
		const btn = (icon: string, label: string, active: boolean, fn: () => void) => {
			const b = bar!.createEl("button", { cls: "clickable-icon" + (active ? " is-active" : ""), attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onpointerdown = (e) => { e.preventDefault(); e.stopPropagation(); };
			b.onclick = (e) => { e.preventDefault(); fn(); closeBar(); };
		};
		const apply = (change: { spot?: Spot; width?: string; crop?: string }) => {
			const now = findEmbed(cm, img) ?? embed;
			const inner = cm.state.sliceDoc(now.from + 3, now.to - 2);
			cm.dispatch({ changes: { from: now.from, to: now.to, insert: rebuild(inner, change) } });
		};
		btn("align-left", "Wrap text on the right (picture on the left)", embed.spot === "left", () => apply({ spot: "left" }));
		btn("align-center", "Centre, no wrapping", embed.spot === "center", () => apply({ spot: "center" }));
		btn("align-right", "Wrap text on the left (picture on the right)", embed.spot === "right", () => apply({ spot: "right" }));
		btn("square", "Back to normal", embed.spot === "", () => apply({ spot: "" }));
		const width = () => parseInt(embed.width, 10) || Math.round(img.getBoundingClientRect().width) || 400;
		btn("minus", "Smaller", false, () => apply({ width: String(Math.max(60, Math.round(width() / 1.25))) }));
		btn("plus", "Bigger", false, () => apply({ width: String(Math.min(2000, Math.round(width() * 1.25))) }));
		btn("crop", "Crop on the page", !!embed.crop, () => {
			const now = findEmbed(cm, img) ?? embed;
			const p = parseEmbed(cm.state.sliceDoc(now.from + 3, now.to - 2));
			const file = plugin.app.metadataCache.getFirstLinkpathDest(p.path.split("#")[0], from);
			if (!(file instanceof TFile)) { new Notice("Couldn't find that picture."); return; }
			const m = CROP.exec(p.crop);
			const start: Box4 = m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : [0, 0, 0, 0];
			startCrop(img, plugin.app.vault.getResourcePath(file), start, (crop) => {
				const cur = findEmbed(cm, img) ?? now;
				const inner = cm.state.sliceDoc(cur.from + 3, cur.to - 2);
				cm.dispatch({ changes: { from: cur.from, to: cur.to, insert: rebuild(inner, { crop }) } });
			});
		});
		bar.createSpan({ cls: "bb-img-tip", text: "Drag it to move it: drop on the left, middle or right" });
	};

	plugin.registerDomEvent(activeDocument, "pointerdown", (e: PointerEvent) => {
		const t = e.target as HTMLElement | null;
		if (bar && t && bar.contains(t)) return;
		closeBar();
		if (!enabled() || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
		const img = t?.closest<HTMLElement>(".markdown-source-view.is-live-preview .internal-embed.image-embed");
		if (!img) return;
		const found = viewFor(plugin, img);
		if (!found) return;
		const embed = findEmbed(found.cm, img);
		if (!embed) return;
		e.preventDefault(); e.stopPropagation();
		const cm = found.cm;
		const sx = e.clientX, sy = e.clientY;
		let dragging = false;
		let marker: HTMLElement | null = null;
		const move = (ev: PointerEvent) => {
			if (!dragging && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
			if (!dragging) { dragging = true; img.addClass("bb-img-dragging"); marker = activeDocument.body.createDiv("bb-img-drop"); }
			const pos = cm.posAtCoords({ x: ev.clientX, y: ev.clientY }, false);
			const line = cm.state.doc.lineAt(pos);
			const box = cm.coordsAtPos(line.from);
			const content = cm.contentDOM.getBoundingClientRect();
			const third = content.width / 3, zone = Math.min(2, Math.max(0, Math.floor((ev.clientX - content.left) / third)));
			if (box && marker) marker.setCssProps({ left: `${content.left + zone * third}px`, width: `${third}px`, top: `${box.top - 2}px` });
		};
		const up = (ev: PointerEvent) => {
			activeDocument.removeEventListener("pointermove", move, true);
			activeDocument.removeEventListener("pointerup", up, true);
			img.removeClass("bb-img-dragging");
			marker?.remove();
			if (!dragging) { showBar(img, cm, embed, found.md.file?.path ?? ""); return; }
			ev.preventDefault(); ev.stopPropagation();
			const doc = cm.state.doc;
			const target = doc.lineAt(cm.posAtCoords({ x: ev.clientX, y: ev.clientY }, false));
			const src = doc.lineAt(embed.from);
			// the left third of the page wraps text on the right, the right third on the left, the middle centres it
			const box = cm.contentDOM.getBoundingClientRect();
			const zone = Math.min(2, Math.max(0, Math.floor(((ev.clientX - box.left) / box.width) * 3)));
			const spot: Spot = zone === 0 ? "left" : zone === 2 ? "right" : "center";
			const text = rebuild(cm.state.sliceDoc(embed.from + 3, embed.to - 2), { spot });
			if (target.number === src.number) {
				if (spot !== embed.spot) cm.dispatch({ changes: { from: embed.from, to: embed.to, insert: text } });
				return;
			}
			// take the picture out (and its line, if nothing else was on it), then put it on its own line
			const rest = src.text.slice(0, embed.from - src.from) + src.text.slice(embed.to - src.from);
			let removal = { from: embed.from, to: embed.to, insert: "" };
			if (!rest.trim()) {
				removal = src.number < doc.lines ? { from: src.from, to: src.to + 1, insert: "" } : { from: Math.max(0, src.from - 1), to: src.to, insert: "" };
				// don't leave two blank lines where the picture was
				const before = src.number > 1 ? doc.line(src.number - 1) : null, after = src.number < doc.lines ? doc.line(src.number + 1) : null;
				if (before && after && !before.text.trim() && !after.text.trim() && after.number < doc.lines && after.number !== target.number) removal = { from: src.from, to: after.to + 1, insert: "" };
			}
			cm.dispatch({ changes: [removal, { from: target.from, insert: text + "\n" }] });
		};
		activeDocument.addEventListener("pointermove", move, true);
		activeDocument.addEventListener("pointerup", up, true);
	}, { capture: true });

	// cropped pictures, in Live Preview and Reading view
	const pending = new Set<HTMLElement>();
	let queued = false;
	const flush = () => { queued = false; for (const el of pending) showCrop(el); pending.clear(); };
	const queue = (el: HTMLElement) => { pending.add(el); if (!queued) { queued = true; window.requestAnimationFrame(flush); } };
	const embedsIn = (n: Node) => {
		if (!n.instanceOf(HTMLElement)) return;
		if (n.matches(".internal-embed.image-embed")) queue(n);
		n.querySelectorAll<HTMLElement>(".internal-embed.image-embed").forEach(queue);
	};
	const watcher = new MutationObserver((records) => {
		for (const r of records) {
			if (r.type === "attributes") embedsIn(r.target);
			else r.addedNodes.forEach(embedsIn);
		}
	});
	watcher.observe(activeDocument.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["alt"] });
	plugin.register(() => watcher.disconnect());
	embedsIn(activeDocument.body);

	// HEIC photos dropped or pasted into a note
	plugin.registerEvent(plugin.app.workspace.on("editor-drop", (evt, editor, info) => { if (enabled()) void handleDrop(plugin, evt, editor, info); }));
	plugin.registerEvent(plugin.app.workspace.on("editor-paste", (evt, editor, info) => { if (enabled()) void handleDrop(plugin, evt, editor, info); }));

	plugin.registerDomEvent(activeDocument, "keydown", () => closeBar(), { capture: true });
	plugin.registerDomEvent(window, "resize", () => closeBar());
	plugin.registerDomEvent(activeDocument, "scroll", () => closeBar(), { capture: true });
	plugin.register(closeBar);
}
