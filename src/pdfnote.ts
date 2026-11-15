import { App, FuzzySuggestModal, Notice, TFile, TFolder, loadPdfJs, normalizePath } from "obsidian";
import { diskPathOfUpload, heicToJpeg, isHeic } from "./board";

/** The small part of pdf.js (bundled with Obsidian) that is used here. */
interface PdfTextItem { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number; fontName?: string }
interface PdfObjs { get(id: string, cb?: (o: unknown) => void): unknown }
interface PdfPage {
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
	getOperatorList?(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
	commonObjs?: PdfObjs;
	objs?: PdfObjs;
}
interface PdfImage { width: number; height: number; kind?: number; data?: Uint8Array | Uint8ClampedArray; bitmap?: ImageBitmap }
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage>; destroy?(): Promise<void> }
interface PdfJs { getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc> }; OPS?: Record<string, number> }

/** Saves one picture from the PDF and returns its path in the vault. */
export type SaveImage = (data: ArrayBuffer, ext: "png" | "jpg") => Promise<string>;

export type PdfNoteStyle = "text" | "embed";

interface Run { text: string; x: number; end: number; size: number; bold: boolean; italic: boolean }
interface Line { y: number; x: number; size: number; runs: Run[]; page: number; first: boolean; last: boolean; image?: string }

/**
 * The PDF's text as Markdown, keeping its look: big text becomes headings, bold and italic stay,
 * bullets and numbered lists become lists, and lines broken only to fit the page are joined into paragraphs.
 * Page breaks and page numbers are left out. Empty if the PDF is only pictures (a scan).
 */
export async function pdfMarkdown(data: ArrayBuffer, saveImage?: SaveImage): Promise<string> {
	const pdfjs = (await loadPdfJs()) as PdfJs;
	const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
	const lines: Line[] = [];
	try {
		for (let n = 1; n <= doc.numPages; n++) {
			const page = await doc.getPage(n);
			const { items } = await page.getTextContent();
			// the real font names (like "Helvetica-Bold") only appear once the page's fonts are loaded
			let ops: { fnArray: number[]; argsArray: unknown[][] } | undefined;
			try { ops = await page.getOperatorList?.(); } catch { /* fall back to plain text */ }
			const fontName = (id: string) => {
				try { const f = page.commonObjs?.get(id) as { name?: string } | undefined; return f?.name ?? ""; } catch { return ""; }
			};
			const pageLines: Line[] = [];
			for (const it of items) {
				const str = it.str ?? "";
				if (!str.trim() || !it.transform) continue;
				const [a, b, , d, x, y] = it.transform;
				const size = Math.round(Math.hypot(a, b) || Math.abs(d) || it.height || 10);
				const name = fontName(it.fontName ?? "");
				const run: Run = { text: str, x, end: x + (it.width ?? str.length * size * 0.5), size, bold: /bold|black|heavy|semibold|demi/i.test(name), italic: /italic|oblique/i.test(name) };
				const line = pageLines.find((l) => Math.abs(l.y - y) < Math.max(2, size * 0.4));
				if (line) { line.runs.push(run); line.size = Math.max(line.size, size); }
				else pageLines.push({ y, x, size, runs: [run], page: n, first: false, last: false });
			}
			pageLines.sort((p, q) => q.y - p.y); // top of the page first
			for (const l of pageLines) { l.runs.sort((p, q) => p.x - q.x); l.x = l.runs[0].x; }
			if (pageLines.length) { pageLines[0].first = true; pageLines[pageLines.length - 1].last = true; }
			// pictures go in where they sit among the text
			if (saveImage && ops && pdfjs.OPS) {
				try { pageLines.push(...(await pageImages(page, ops, pdfjs.OPS, n, saveImage))); } catch (e) { console.error(e); }
				pageLines.sort((p, q) => q.y - p.y);
			}
			lines.push(...pageLines);
		}
	} finally {
		await doc.destroy?.();
	}
	return toMarkdown(lines);
}

/** Finds the pictures drawn on a page, saves each one, and returns where they go. */
async function pageImages(page: PdfPage, ops: { fnArray: number[]; argsArray: unknown[][] }, OPS: Record<string, number>, n: number, save: SaveImage): Promise<Line[]> {
	const out: Line[] = [];
	let ctm = [1, 0, 0, 1, 0, 0];
	const stack: number[][] = [];
	const times = (m: number[], c: number[]) => [m[0] * c[0] + m[1] * c[2], m[0] * c[1] + m[1] * c[3], m[2] * c[0] + m[3] * c[2], m[2] * c[1] + m[3] * c[3], m[4] * c[0] + m[5] * c[2] + c[4], m[4] * c[1] + m[5] * c[3] + c[5]];
	for (let i = 0; i < ops.fnArray.length; i++) {
		const fn = ops.fnArray[i], args = ops.argsArray[i];
		if (fn === OPS.save) stack.push(ctm.slice());
		else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
		else if (fn === OPS.transform) ctm = times(args as number[], ctm);
		else if (fn === OPS.paintImageXObject || fn === OPS.paintJpegXObject || fn === OPS.paintInlineImageXObject) {
			const w = Math.hypot(ctm[0], ctm[1]), h = Math.hypot(ctm[2], ctm[3]);
			if (w < 40 || h < 40) continue; // little icons and lines, not pictures
			let img: PdfImage | undefined;
			if (fn === OPS.paintInlineImageXObject) img = args[0] as PdfImage;
			else {
				const id = String(args[0]);
				const store = id.startsWith("g_") ? page.commonObjs : page.objs;
				img = await new Promise<PdfImage | undefined>((resolve) => {
					const timer = window.setTimeout(() => resolve(undefined), 4000);
					try { store?.get(id, (o) => { window.clearTimeout(timer); resolve(o as PdfImage); }); } catch { window.clearTimeout(timer); resolve(undefined); }
				});
			}
			if (!img?.width || !img.height) continue;
			const file = await imageFile(img);
			if (!file) continue;
			const path = await save(file.data, file.ext);
			const top = Math.max(ctm[5], ctm[5] + ctm[3]);
			out.push({ y: top, x: ctm[4], size: 0, runs: [], page: n, first: false, last: false, image: path });
		}
	}
	return out;
}

/** Turns a pdf.js picture into a JPEG (or a PNG if it has see-through parts). */
async function imageFile(img: PdfImage): Promise<{ data: ArrayBuffer; ext: "png" | "jpg" } | null> {
	const c = activeDocument.createElement("canvas");
	c.width = img.width; c.height = img.height;
	const g = c.getContext("2d");
	if (!g) return null;
	let alpha = false;
	if (img.bitmap) g.drawImage(img.bitmap, 0, 0);
	else if (img.data) {
		const px = g.createImageData(img.width, img.height), dst = px.data, src = img.data;
		const count = img.width * img.height;
		if (img.kind === 3) { dst.set(src.subarray(0, count * 4)); alpha = true; }
		else if (img.kind === 2) for (let p = 0, s = 0, d = 0; p < count; p++, s += 3, d += 4) { dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = 255; }
		else {
			// one bit per pixel, rows padded to whole bytes
			const row = Math.ceil(img.width / 8);
			for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
				const on = (src[y * row + (x >> 3)] >> (7 - (x & 7))) & 1, d = (y * img.width + x) * 4;
				dst[d] = dst[d + 1] = dst[d + 2] = on ? 255 : 0; dst[d + 3] = 255;
			}
		}
		g.putImageData(px, 0, 0);
	} else return null;
	const type = alpha ? "image/png" : "image/jpeg";
	const blob = await new Promise<Blob | null>((r) => c.toBlob(r, type, 0.9));
	return blob ? { data: await blob.arrayBuffer(), ext: alpha ? "png" : "jpg" } : null;
}

const BULLET = /^\s*([•●▪◦‣∙·○■□➢►–-]|\*)\s+/;
const NUMBERED = /^\s*(\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/i;

function lineText(l: Line): string {
	let out = "", open: { bold: boolean; italic: boolean } = { bold: false, italic: false }, prev: Run | null = null;
	const close = () => { if (open.italic) out += "*"; if (open.bold) out += "**"; open = { bold: false, italic: false }; };
	for (const r of l.runs) {
		const gap = prev ? r.x - prev.end : 0;
		const space = prev && gap > r.size * 0.12 && !/\s$/.test(prev.text) && !/^\s/.test(r.text) ? " " : "";
		if (r.bold !== open.bold || r.italic !== open.italic) {
			close();
			out = out.replace(/\s+$/, "");
			out += space || (prev && /\s$/.test(prev.text) ? " " : "");
			if (r.bold) out += "**";
			if (r.italic) out += "*";
			open = { bold: r.bold, italic: r.italic };
			out += r.text.replace(/^\s+/, "");
		} else out += space + r.text;
		prev = r;
	}
	close();
	return out.replace(/\*\*\s*\*\*/g, "").replace(/\s+/g, " ").trim();
}

function toMarkdown(lines: Line[]): string {
	if (!lines.length) return "";
	// the usual text size, counted by how much text uses it
	if (!lines.some((l) => !l.image)) return lines.map((l) => `![[${l.image}]]`).join("\n\n");
	const counts = new Map<number, number>();
	for (const l of lines) for (const r of l.runs) counts.set(r.size, (counts.get(r.size) ?? 0) + r.text.length);
	const body = [...counts.entries()].sort((p, q) => q[1] - p[1])[0][0];
	const left = Math.min(...lines.filter((l) => !l.image && l.size <= body * 1.05).map((l) => l.x));
	const blocks: string[] = [];
	let para = "";
	let prev: Line | null = null;
	const flush = () => { if (para) blocks.push(para); para = ""; };

	for (const l of lines) {
		if (l.image) { flush(); blocks.push(`![[${l.image}]]`); prev = null; continue; }
		let text = lineText(l);
		if (!text) continue;
		const plain = text.replace(/\*/g, "");
		// page numbers and "Page 3 of 9" at the top or bottom of a page
		if ((l.first || l.last) && /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(plain)) continue;
		const ratio = l.size / body;
		const gap = prev && prev.page === l.page ? prev.y - l.y : 0;
		const newBlock = !prev || prev.page !== l.page ? false : gap > Math.max(prev.size, l.size) * 1.6;

		if (ratio >= 1.15 && plain.length < 120) {
			flush();
			const level = ratio >= 1.7 ? 1 : ratio >= 1.35 ? 2 : 3;
			const heading = plain.replace(/\s+/g, " ").trim();
			const lastBlock = blocks[blocks.length - 1];
			// a heading that wraps onto a second line
			if (prev && lastBlock?.startsWith("#".repeat(level) + " ") && Math.abs(prev.size - l.size) < 1 && !newBlock) blocks[blocks.length - 1] = `${lastBlock} ${heading}`;
			else blocks.push(`${"#".repeat(level)} ${heading}`);
			prev = l;
			continue;
		}
		const indent = Math.max(0, Math.round((l.x - left) / (body * 1.8)));
		const bullet = BULLET.exec(plain);
		const numbered = !bullet ? NUMBERED.exec(plain) : null;
		if (bullet || numbered) {
			flush();
			const marker = bullet ? "- " : (numbered![1].replace(/[()]/g, "").replace(/\)$/, ".").replace(/([^.])$/, "$1."));
			text = text.replace(bullet ? /^(\**)\s*([•●▪◦‣∙·○■□➢►–-]|\*(?=\s))\s+/ : /^(\**)\s*\(?(\d{1,3}|[a-z])[.)]\s+/i, "$1");
			para = "  ".repeat(Math.min(indent, 4)) + (bullet ? marker : marker + " ") + text;
		} else if (para && !newBlock) {
			// carry on the paragraph (or the list item that wrapped)
			para = /[A-Za-z]-$/.test(para) ? para.slice(0, -1) + text : para + " " + text;
		} else {
			flush();
			para = text;
		}
		prev = l;
	}
	flush();
	// list items sit together; everything else gets a blank line between
	const isItem = (b: string) => /^\s*(- |\d{1,3}\. |[a-z]\. )/i.test(b);
	let out = "";
	blocks.forEach((b, i) => { out += i === 0 ? b : (isItem(b) && isItem(blocks[i - 1]) && /^\s*- /.test(b) === /^\s*- /.test(blocks[i - 1]) ? "\n" : "\n\n") + b; });
	return out.replace(/\*\*\*\*/g, "").trim();
}

/** Makes a note next to (or about) a PDF that is already in the vault. Returns the new note. */
export async function noteFromPdf(app: App, pdf: TFile, folder: string, style: PdfNoteStyle): Promise<TFile> {
	const notePath = availablePath(app, folder, pdf.basename, "md");
	let body: string;
	if (style === "embed") body = `![[${pdf.path}]]\n`;
	else {
		let md = "";
		let count = 0;
		const seen = new Map<string, string>(); // the same picture (a logo on every page) is saved once
		const saveImage: SaveImage = async (data, ext) => {
			const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", data))).map((b) => b.toString(16).padStart(2, "0")).join("");
			const known = seen.get(hash);
			if (known) return known;
			const p = await app.fileManager.getAvailablePathForAttachment(`${pdf.basename} picture ${++count}.${ext}`, notePath);
			const path = (await app.vault.createBinary(p, data)).path;
			seen.set(hash, path);
			return path;
		};
		try { md = await pdfMarkdown(await app.vault.readBinary(pdf), saveImage); } catch (e) { console.error(e); }
		const link = `\n\n---\nFrom [[${pdf.path}|${pdf.name}]]\n`;
		body = md ? md + link : `_This PDF has no text that can be copied. It might be a scanned picture._\n\n![[${pdf.path}]]\n`;
	}
	return app.vault.create(notePath, body);
}

/** A PDF dropped from outside Obsidian: saves it, then makes the note in the folder it was dropped on. */
export async function noteFromDroppedPdf(app: App, file: File, folder: string, style: PdfNoteStyle): Promise<TFile> {
	const base = file.name.replace(/\.pdf$/i, "") || "PDF";
	const data = await file.arrayBuffer();
	const noteGuess = normalizePath(`${folder ? folder + "/" : ""}${base}.md`);
	const pdfPath = await app.fileManager.getAvailablePathForAttachment(`${base}.pdf`, noteGuess);
	const pdf = await app.vault.createBinary(pdfPath, data);
	return noteFromPdf(app, pdf, folder, style);
}

export const isPhoto = (f: File) => f.type.startsWith("image/") || isHeic(f.name.split(".").pop() ?? "", f.type);

/**
 * Photos dropped from outside Obsidian: saves them (iPhone HEIC photos become JPEGs so they show everywhere)
 * and makes one note with all of them in it, in the folder they were dropped on.
 */
export async function noteFromDroppedPhotos(app: App, files: File[], folder: string): Promise<TFile> {
	const first = files[0].name.replace(/\.[^.]+$/, "") || "Photo";
	const d = new Date(), pad = (n: number) => String(n).padStart(2, "0");
	const name = files.length === 1 ? first : `Photos ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	const notePath = availablePath(app, folder, name, "md");
	const embeds: string[] = [];
	let skipped = 0;
	for (const f of files) {
		let ext = (f.name.split(".").pop() || f.type.split("/")[1] || "png").toLowerCase();
		let data = await f.arrayBuffer();
		if (isHeic(ext, f.type)) {
			const jpg = await heicToJpeg(data, diskPathOfUpload(f));
			if (!jpg) { skipped++; continue; }
			data = jpg; ext = "jpg";
		}
		const base = f.name.replace(/\.[^.]+$/, "") || "Photo";
		const path = await app.fileManager.getAvailablePathForAttachment(`${base}.${ext}`, notePath);
		const saved = await app.vault.createBinary(path, data);
		embeds.push(`![[${saved.path}]]`);
	}
	if (skipped) new Notice(`${skipped} HEIC photo${skipped > 1 ? "s" : ""} couldn't be converted on this device. Save ${skipped > 1 ? "them" : "it"} as JPEG first.`);
	if (!embeds.length) throw new Error("no photos could be saved");
	return app.vault.create(notePath, embeds.join("\n\n") + "\n");
}

function availablePath(app: App, folder: string, base: string, ext: string): string {
	const clean = base.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "PDF";
	const dir = folder ? folder + "/" : "";
	let p = normalizePath(`${dir}${clean}.${ext}`);
	for (let i = 1; app.vault.getAbstractFileByPath(p); i++) p = normalizePath(`${dir}${clean} ${i}.${ext}`);
	return p;
}

/** The folder a drop landed on in the file list (a folder, or the folder of a file), or the vault's top level. */
export function dropFolder(app: App, target: HTMLElement): string {
	const el = target.closest<HTMLElement>("[data-path]");
	const path = el?.dataset.path ?? "";
	const f = path ? app.vault.getAbstractFileByPath(path) : null;
	if (f instanceof TFolder) return f.path === "/" ? "" : f.path;
	if (f instanceof TFile) return f.parent && f.parent.path !== "/" ? f.parent.path : "";
	return "";
}

export class PdfPicker extends FuzzySuggestModal<TFile> {
	constructor(app: App, private pick: (f: TFile) => void) { super(app); this.setPlaceholder("Pick a PDF to turn into a note"); }
	getItems() { return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === "pdf"); }
	getItemText(f: TFile) { return f.path; }
	onChooseItem(f: TFile) { this.pick(f); }
}

export function noPdfs(app: App): boolean {
	if (app.vault.getFiles().some((f) => f.extension.toLowerCase() === "pdf")) return false;
	new Notice("There are no PDFs in this vault yet. Drag one into the file list to make a note from it.");
	return true;
}
