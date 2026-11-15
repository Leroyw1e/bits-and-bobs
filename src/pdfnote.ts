import { App, FuzzySuggestModal, Notice, TFile, TFolder, loadPdfJs, normalizePath } from "obsidian";

/** The small part of pdf.js (bundled with Obsidian) that is used here. */
interface PdfTextItem { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number; fontName?: string }
interface PdfPage {
	getTextContent(): Promise<{ items: PdfTextItem[] }>;
	getOperatorList?(): Promise<unknown>;
	commonObjs?: { has?(id: string): boolean; get(id: string): unknown };
}
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage>; destroy?(): Promise<void> }
interface PdfJs { getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc> } }

export type PdfNoteStyle = "text" | "embed";

interface Run { text: string; x: number; end: number; size: number; bold: boolean; italic: boolean }
interface Line { y: number; x: number; size: number; runs: Run[]; page: number; first: boolean; last: boolean }

/**
 * The PDF's text as Markdown, keeping its look: big text becomes headings, bold and italic stay,
 * bullets and numbered lists become lists, and lines broken only to fit the page are joined into paragraphs.
 * Page breaks and page numbers are left out. Empty if the PDF is only pictures (a scan).
 */
export async function pdfMarkdown(data: ArrayBuffer): Promise<string> {
	const pdfjs = (await loadPdfJs()) as PdfJs;
	const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
	const lines: Line[] = [];
	try {
		for (let n = 1; n <= doc.numPages; n++) {
			const page = await doc.getPage(n);
			const { items } = await page.getTextContent();
			// the real font names (like "Helvetica-Bold") only appear once the page's fonts are loaded
			try { await page.getOperatorList?.(); } catch { /* fall back to plain text */ }
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
			lines.push(...pageLines);
		}
	} finally {
		await doc.destroy?.();
	}
	return toMarkdown(lines);
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
	const counts = new Map<number, number>();
	for (const l of lines) for (const r of l.runs) counts.set(r.size, (counts.get(r.size) ?? 0) + r.text.length);
	const body = [...counts.entries()].sort((p, q) => q[1] - p[1])[0][0];
	const left = Math.min(...lines.filter((l) => l.size <= body * 1.05).map((l) => l.x));
	const blocks: string[] = [];
	let para = "";
	let prev: Line | null = null;
	const flush = () => { if (para) blocks.push(para); para = ""; };

	for (const l of lines) {
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
		try { md = await pdfMarkdown(await app.vault.readBinary(pdf)); } catch (e) { console.error(e); }
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
