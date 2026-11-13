import { App, Modal } from "obsidian";
import type BitsAndBobs from "./main";
import { Board, El, TextEl, uid } from "./board";

// Slides are 1600 × 900
const T = (x: number, y: number, w: number, text: string, fs: number, extra: Partial<TextEl> = {}): El =>
	({ id: uid(), type: "text", x, y, w, text, color: "ink", fs, ...extra });
const title = (text = "## Slide title") => T(100, 60, 1400, text, 40);
const box = (x: number, y: number, w: number, h: number, color = "ink"): El =>
	({ id: uid(), type: "shape", kind: "rect", x, y, w, h, color, size: 3 });
const line = (x: number, y: number, w: number, color = "#1971c2"): El =>
	({ id: uid(), type: "shape", kind: "line", x, y, w, h: 0, color, size: 6 });

export interface Layout { id: string; name: string; make: () => El[] }

export const LAYOUTS: Layout[] = [
	{ id: "title", name: "Title slide", make: () => [
		T(150, 300, 1300, "# Presentation title", 56, { align: "center" }),
		line(600, 470, 400),
		T(150, 510, 1300, "Your name · date", 32, { align: "center" }),
	] },
	{ id: "content", name: "Title & bullets", make: () => [
		title(),
		T(120, 200, 1360, "- First point\n- Second point\n- Third point", 34),
	] },
	{ id: "two", name: "Two columns", make: () => [
		title(),
		T(100, 200, 660, "- Left point\n- Left point", 32),
		T(840, 200, 660, "- Right point\n- Right point", 32),
	] },
	{ id: "compare", name: "Compare", make: () => [
		title("## This vs that"),
		box(100, 190, 660, 620, "#1971c2"),
		box(840, 190, 660, 620, "#e03131"),
		T(130, 215, 600, "### Option A\n- Pro\n- Con", 32),
		T(870, 215, 600, "### Option B\n- Pro\n- Con", 32),
	] },
	{ id: "section", name: "Section header", make: () => [
		T(150, 340, 1300, "# Section name", 64),
		line(150, 470, 300, "#e03131"),
		T(150, 500, 1300, "What this part is about", 30),
	] },
	{ id: "equation", name: "Equation", make: () => [
		title("## The formula"),
		T(200, 300, 1200, "$$\nx = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\n$$", 52, { align: "center" }),
		T(200, 600, 1200, "What each letter means…", 30, { align: "center" }),
	] },
	{ id: "worked", name: "Worked example", make: () => [
		title("## Worked example"),
		T(100, 180, 1400, "**Question:** Solve $2x + 3 = 11$", 34),
		T(100, 300, 1400, "$$\n\\begin{aligned} 2x + 3 &= 11 \\\\ 2x &= 8 \\\\ x &= 4 \\end{aligned}\n$$", 40),
	] },
	{ id: "graph", name: "Graph", make: () => [
		title("## Graph"),
		{ id: uid(), type: "graph", x: 100, y: 180, w: 860, h: 640, fns: ["x^2 - 2"], xmin: -5, xmax: 5, ymin: -4, ymax: 6 },
		T(1020, 200, 480, "- Where it crosses the axes\n- Turning point\n- Shape", 30),
	] },
	{ id: "picture", name: "Picture & text", make: () => [
		title(),
		box(100, 190, 760, 620),
		T(140, 470, 680, "Add a picture with the image button, then delete this box", 26, { align: "center" }),
		T(920, 200, 580, "Describe the picture here.", 32),
	] },
	{ id: "quote", name: "Big statement", make: () => [
		T(200, 320, 1200, "## “A big idea or quote goes here.”", 48, { align: "center" }),
		T(200, 540, 1200, "— Who said it", 30, { align: "center" }),
	] },
	{ id: "blank", name: "Blank", make: () => [] },
];

export class LayoutPicker extends Modal {
	private boards: Board[] = [];
	constructor(app: App, private plugin: BitsAndBobs, private sourcePath: string, private pick: (l: Layout) => void) { super(app); }
	onOpen() {
		this.modalEl.addClass("ms-layout-modal");
		this.titleEl.setText("Choose a layout");
		const grid = this.contentEl.createDiv("ms-layout-grid");
		for (const l of LAYOUTS) {
			const card = grid.createEl("button", { cls: "ms-layout-card" });
			const prev = card.createDiv("ms-layout-preview");
			const b = new Board(this.plugin, prev, { elements: l.make(), bg: "plain" }, { sourcePath: this.sourcePath, frame: { w: 1600, h: 900 }, readOnly: true });
			b.load(); this.boards.push(b);
			card.createDiv({ cls: "ms-layout-name", text: l.name });
			card.onclick = () => { this.close(); this.pick(l); };
		}
	}
	onClose() { this.boards.forEach((b) => b.unload()); this.contentEl.empty(); }
}
