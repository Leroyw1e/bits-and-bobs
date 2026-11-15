import { App, FuzzySuggestModal, Notice, TFile, TFolder, loadPdfJs, normalizePath } from "obsidian";

/** The small part of pdf.js (bundled with Obsidian) that is used here. */
interface PdfTextItem { str?: string; hasEOL?: boolean }
interface PdfPage { getTextContent(): Promise<{ items: PdfTextItem[] }> }
interface PdfDoc { numPages: number; getPage(n: number): Promise<PdfPage>; destroy?(): Promise<void> }
interface PdfJs { getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDoc> } }

export type PdfNoteStyle = "text" | "embed";

/** All the text in a PDF, one block per page. Empty if the PDF is only pictures (a scan). */
export async function pdfText(data: ArrayBuffer): Promise<string[]> {
	const pdfjs = (await loadPdfJs()) as PdfJs;
	const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise;
	const pages: string[] = [];
	try {
		for (let n = 1; n <= doc.numPages; n++) {
			const page = await doc.getPage(n);
			const { items } = await page.getTextContent();
			let text = "";
			for (const it of items) {
				text += it.str ?? "";
				if (it.hasEOL) text += "\n";
			}
			pages.push(tidy(text));
		}
	} finally {
		await doc.destroy?.();
	}
	return pages;
}

/** joins lines that were only broken to fit the page, and keeps real paragraphs */
function tidy(t: string): string {
	return t
		.replace(/[ \t]+\n/g, "\n")
		.replace(/(\w)-\n(\w)/g, "$1$2") // hyphen at the end of a line
		.replace(/([^\n.!?:;])\n(?=[a-z(])/g, "$1 ") // a sentence carrying on
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** Makes a note next to (or about) a PDF that is already in the vault. Returns the new note. */
export async function noteFromPdf(app: App, pdf: TFile, folder: string, style: PdfNoteStyle): Promise<TFile> {
	const notePath = availablePath(app, folder, pdf.basename, "md");
	let body: string;
	if (style === "embed") body = `![[${pdf.path}]]\n`;
	else {
		let pages: string[] = [];
		try { pages = await pdfText(await app.vault.readBinary(pdf)); } catch (e) { console.error(e); }
		const text = pages.filter(Boolean);
		const link = `Original PDF: [[${pdf.path}|${pdf.name}]]\n\n`;
		if (!text.length) body = link + "_This PDF has no text that can be copied. It might be a scanned picture._\n\n" + `![[${pdf.path}]]\n`;
		else body = link + (pages.length > 1 ? pages.map((p, i) => `## Page ${i + 1}\n\n${p || "_No text on this page._"}`).join("\n\n") : text[0]) + "\n";
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
