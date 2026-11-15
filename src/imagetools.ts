import { MarkdownView, Plugin, setIcon } from "obsidian";
import type { EditorView } from "@codemirror/view";

/**
 * Pictures in notes (Live Preview): click one for a small bar to wrap text around it (left or right),
 * centre it, or make it bigger or smaller; drag it to move it to another line.
 * The choice is kept in the link, like ![[photo.jpg|left|300]], so it shows the same in Reading view.
 */
type Spot = "left" | "right" | "center" | "";

interface Embed { from: number; to: number; path: string; spot: Spot; width: string }

const SPOTS = ["left", "right", "center"];

function parseEmbed(inner: string): { path: string; spot: Spot; width: string; rest: string[] } {
	const parts = inner.split("|");
	const path = parts.shift() ?? "";
	let spot: Spot = "", width = "";
	const rest: string[] = [];
	for (const p of parts) {
		const t = p.trim();
		if (SPOTS.includes(t.toLowerCase())) spot = t.toLowerCase() as Spot;
		else if (/^\d+(x\d+)?$/.test(t)) width = t;
		else rest.push(p);
	}
	return { path, spot, width, rest };
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
			best = { from, to, path: m[1], spot: p.spot, width: p.width };
		}
	}
	return best;
}

function rebuild(inner: string, change: { spot?: Spot; width?: string }): string {
	const p = parseEmbed(inner);
	const spot = change.spot ?? p.spot, width = change.width ?? p.width;
	return `![[${[p.path, ...p.rest, ...(spot ? [spot] : []), ...(width ? [width] : [])].join("|")}]]`;
}

export function setupImageTools(plugin: Plugin, enabled: () => boolean) {
	let bar: HTMLElement | null = null;
	const closeBar = () => { bar?.remove(); bar = null; };

	const showBar = (img: HTMLElement, cm: EditorView, embed: Embed) => {
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
		const apply = (change: { spot?: Spot; width?: string }) => {
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
		bar.createSpan({ cls: "bb-img-tip", text: "Drag the picture to move it" });
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
			if (box && marker) marker.setCssProps({ left: `${content.left}px`, width: `${content.width}px`, top: `${box.top - 2}px` });
		};
		const up = (ev: PointerEvent) => {
			activeDocument.removeEventListener("pointermove", move, true);
			activeDocument.removeEventListener("pointerup", up, true);
			img.removeClass("bb-img-dragging");
			marker?.remove();
			if (!dragging) { showBar(img, cm, embed); return; }
			ev.preventDefault(); ev.stopPropagation();
			const doc = cm.state.doc;
			const target = doc.lineAt(cm.posAtCoords({ x: ev.clientX, y: ev.clientY }, false));
			const src = doc.lineAt(embed.from);
			if (target.number === src.number) return;
			const text = cm.state.sliceDoc(embed.from, embed.to);
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

	plugin.registerDomEvent(activeDocument, "keydown", () => closeBar(), { capture: true });
	plugin.registerDomEvent(window, "resize", () => closeBar());
	plugin.registerDomEvent(activeDocument, "scroll", () => closeBar(), { capture: true });
	plugin.register(closeBar);
}
