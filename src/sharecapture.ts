/**
 * Turns a note, board, slide deck, PDF or picture into the files a share link shows (view only).
 *   note    body.json { md } with Obsidian-only bits made plain, plus the pictures it shows
 *   board   body.json { html, box } — the board drawn read-only exactly as it looks, plus styles.css and pictures
 *   slides  body.json { w, h, slides: [{ html, transition }] }, plus styles.css and pictures
 *   pdf / image   the file itself
 * Text boxes on boards and slides are sent as their Markdown so the web page can show maths properly.
 */
import { Component, TFile, normalizePath } from "obsidian";
import type BitsAndBobs from "./main";
import { Board, BoardDoc, parseBoard } from "./board";
import { parseDeck } from "./views";
import { themeFor } from "./themes";

export type ShareKind = "sheet" | "note" | "board" | "slides" | "pdf" | "image";

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

export function shareKind(f: TFile): ShareKind | null {
	const e = f.extension.toLowerCase();
	if (e === "xlsx") return "sheet";
	if (e === "md") return "note";
	if (e === "mboard") return "board";
	if (e === "mslides") return "slides";
	if (e === "pdf") return "pdf";
	if (e in IMAGE_TYPES) return "image";
	return null;
}

export interface SharedFile { name: string; type: string; data: ArrayBuffer }

const enc = (s: string) => new TextEncoder().encode(s).buffer;
const json = (o: unknown): SharedFile => ({ name: "body", type: "application/json", data: enc(JSON.stringify(o)) });

/** Collects pictures used by a note or board, each once. */
class Pictures {
	files: SharedFile[] = [];
	private byPath = new Map<string, string>();
	constructor(private plugin: BitsAndBobs) {}
	async add(f: TFile): Promise<string | null> {
		const type = IMAGE_TYPES[f.extension.toLowerCase()];
		if (!type) return null;
		const have = this.byPath.get(f.path);
		if (have) return have;
		const name = `p${this.files.length}.${f.extension.toLowerCase()}`;
		this.files.push({ name, type, data: await this.plugin.app.vault.readBinary(f) });
		this.byPath.set(f.path, name);
		return name;
	}
}

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export async function capture(plugin: BitsAndBobs, file: TFile, kind: ShareKind): Promise<SharedFile[]> {
	const vault = plugin.app.vault;
	if (kind === "pdf") return [{ name: "file", type: "application/pdf", data: await vault.readBinary(file) }];
	if (kind === "image") return [{ name: "file", type: IMAGE_TYPES[file.extension.toLowerCase()], data: await vault.readBinary(file) }];
	if (kind === "note") return captureNote(plugin, file);
	if (kind === "board") return captureBoard(plugin, file);
	if (kind === "slides") return captureSlides(plugin, file);
	return [];
}

// ---------- notes ----------

async function captureNote(plugin: BitsAndBobs, file: TFile): Promise<SharedFile[]> {
	const pics = new Pictures(plugin);
	const md = await plainMarkdown(plugin, await plugin.app.vault.read(file), file.path, pics);
	return [json({ md }), ...pics.files];
}

/** Obsidian-only Markdown made plain: embeds, wiki links, highlights and comments. Code is left alone. */
async function plainMarkdown(plugin: BitsAndBobs, src: string, from: string, pics: Pictures): Promise<string> {
	const mc = plugin.app.metadataCache;
	src = src.replace(/^---\n[\s\S]*?\n---\n?/, "");
	const parts = src.split(/(```[\s\S]*?```|`[^`\n]*`)/);
	for (let i = 0; i < parts.length; i += 2) {
		let t = parts[i].replace(/%%[\s\S]*?%%/g, "");
		const jobs: Promise<void>[] = [];
		const swaps: [string, string][] = [];
		// ![[picture.png|300]] and ![[Other note]]
		for (const m of t.matchAll(/!\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g)) {
			jobs.push((async () => {
				const f = mc.getFirstLinkpathDest(m[1].trim(), from);
				const name = f ? await pics.add(f) : null;
				const w = m[2] && /^\d+/.test(m[2]) ? ` width="${parseInt(m[2])}"` : "";
				swaps.push([m[0], name ? `<img data-bb="${name}" alt="${attr(f!.basename)}"${w}>` : `*${(f?.basename ?? m[1]).trim()}*`]);
			})());
		}
		// ![alt](picture.png) from the vault
		for (const m of t.matchAll(/!\[([^\]]*)\]\((?!https?:|data:)([^)\s]+)\)/g)) {
			jobs.push((async () => {
				const f = mc.getFirstLinkpathDest(decodeURIComponent(m[2]), from);
				const name = f ? await pics.add(f) : null;
				swaps.push([m[0], name ? `<img data-bb="${name}" alt="${attr(m[1])}">` : m[1]]);
			})());
		}
		await Promise.all(jobs);
		for (const [a, b] of swaps) t = t.split(a).join(b);
		t = t.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target: string, alias?: string) => `<span class="bb-link">${attr(alias ?? target.split("#")[0].split("/").pop() ?? target)}</span>`);
		t = t.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
		parts[i] = t;
	}
	return parts.join("");
}

// ---------- boards and slides ----------

/** Draw a board read-only off screen and copy what it looks like. */
async function snapshot(plugin: BitsAndBobs, doc: BoardDoc, sourcePath: string, pics: Pictures, frame?: { w: number; h: number }, theme?: ReturnType<typeof themeFor> | null) {
	const host = activeDocument.body.createDiv({ cls: "bb-share-capture" + (frame ? " is-frame" : "") });
	const comp = new Component();
	comp.load();
	try {
		const board = new Board(plugin, host, doc, { sourcePath, readOnly: true, frame, theme: theme ?? undefined });
		comp.addChild(board);
		await board.whenRendered();
		const root = host.querySelector<HTMLElement>(".ms-board");
		const world = host.querySelector<HTMLElement>(".ms-world");
		if (!root || !world) throw new Error("The board couldn't be drawn.");
		world.addClass("bb-capture-flat");
		const wr = world.getBoundingClientRect();
		let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
		for (const child of Array.from(world.children)) {
			if (child.hasClass("ms-sel-layer")) continue;
			const r = child.getBoundingClientRect();
			if (!r.width && !r.height) continue;
			x1 = Math.min(x1, r.left - wr.left); y1 = Math.min(y1, r.top - wr.top);
			x2 = Math.max(x2, r.right - wr.left); y2 = Math.max(y2, r.bottom - wr.top);
		}
		const box = frame ? { x: 0, y: 0, w: frame.w, h: frame.h } : isFinite(x1) ? { x: x1, y: y1, w: x2 - x1, h: y2 - y1 } : { x: 0, y: 0, w: 800, h: 600 };

		const copy = root.cloneNode(true) as HTMLElement;
		copy.querySelectorAll(".ms-sel-layer, .ms-toolbar, .ms-tb, .ms-guide").forEach((n) => n.remove());
		const cw = copy.querySelector<HTMLElement>(".ms-world");
		cw?.removeAttribute("style");
		cw?.removeClass("bb-capture-flat");
		for (const el of doc.elements) {
			const node = copy.querySelector<HTMLElement>(`[data-id="${CSS.escape(el.id)}"]`);
			if (!node) continue;
			if (el.type === "text") {
				node.empty();
				node.createDiv({ cls: "bb-md", attr: { "data-md": el.text } });
			} else if (el.type === "image") {
				const img = node.querySelector("img");
				if (!img) continue;
				if (/^https?:/i.test(el.src)) { img.setAttr("src", el.src); continue; }
				const f = plugin.app.vault.getAbstractFileByPath(el.src) ?? plugin.app.metadataCache.getFirstLinkpathDest(el.src, sourcePath);
				const name = f instanceof TFile ? await pics.add(f) : null;
				img.removeAttribute("src");
				if (name) img.setAttr("data-bb", name);
			}
		}
		return { html: copy.outerHTML, box };
	} finally {
		comp.unload();
		host.remove();
	}
}

async function styles(plugin: BitsAndBobs): Promise<SharedFile> {
	const dir = plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`;
	let css = "";
	try { css = await plugin.app.vault.adapter.read(normalizePath(`${dir}/styles.css`)); } catch { /* none */ }
	return { name: "css", type: "text/plain", data: enc(css) };
}

async function captureBoard(plugin: BitsAndBobs, file: TFile): Promise<SharedFile[]> {
	const pics = new Pictures(plugin);
	const doc = parseBoard(await plugin.app.vault.read(file));
	const snap = await snapshot(plugin, doc, file.path, pics);
	return [json({ ...snap, bg: doc.bg ?? "grid" }), await styles(plugin), ...pics.files];
}

async function captureSlides(plugin: BitsAndBobs, file: TFile): Promise<SharedFile[]> {
	const pics = new Pictures(plugin);
	const deck = parseDeck(await plugin.app.vault.read(file));
	const theme = plugin.settings.slideEffects ? themeFor(deck.theme, deck.font) : null;
	const slides: { html: string; transition?: string }[] = [];
	for (const s of deck.slides) {
		const snap = await snapshot(plugin, { elements: s.elements, bg: s.bg }, file.path, pics, { w: deck.w, h: deck.h }, theme);
		slides.push({ html: snap.html, transition: plugin.settings.slideEffects ? s.transition : undefined });
	}
	return [json({ w: deck.w, h: deck.h, slides }), await styles(plugin), ...pics.files];
}
