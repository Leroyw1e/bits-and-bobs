import { App, Platform, PluginSettingTab, Setting } from "obsidian";
import type BitsAndBobs from "./main";
import { MATH_TOOLS, shortcutLabel } from "./math";
import type { Bg } from "./board";

export interface BitsSettings {
	// features (changing these reloads the plugin)
	boards: boolean;
	slides: boolean;
	sheets: boolean;
	embeds: boolean;
	ribbon: boolean;
	symbolSearch: boolean;
	// maths
	mathShortcuts: boolean;
	statusBar: boolean;
	mobileToolbar: boolean;
	mobileToolbarAdded: boolean;
	// drawing
	fingerDraws: boolean;
	pencilOnlyAfterPen: boolean;
	pressure: boolean;
	penSize: number;
	defaultBg: Bg;
	canvasDraw: boolean;
	tbHighlighter: boolean;
	tbShapes: boolean;
	tbMaths: boolean;
	tbGraph: boolean;
	tbImages: boolean;
	// slides
	speakerNotes: boolean;
	presentFullscreen: boolean;
	// spreadsheets
	sheetAutocorrect: boolean;
	sheetSuggest: boolean;
	// other
	homeButtons: boolean;
	newFileFolder: string;
}

export const DEFAULT_SETTINGS: BitsSettings = {
	boards: true, slides: true, sheets: true, embeds: true, ribbon: true, symbolSearch: true,
	mathShortcuts: true, statusBar: true, mobileToolbar: true, mobileToolbarAdded: false,
	fingerDraws: true, pencilOnlyAfterPen: true, pressure: true, penSize: 4, defaultBg: "grid", canvasDraw: true,
	tbHighlighter: true, tbShapes: true, tbMaths: true, tbGraph: true, tbImages: true,
	speakerNotes: true, presentFullscreen: true,
	sheetAutocorrect: false, sheetSuggest: true,
	homeButtons: true, newFileFolder: "",
};

type BoolKey = { [K in keyof BitsSettings]: BitsSettings[K] extends boolean ? K : never }[keyof BitsSettings];

export class BitsSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: BitsAndBobs) { super(app, plugin); }

	display() {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		const toggle = (key: BoolKey, name: string, desc: string, after?: (v: boolean) => void) =>
			new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) => t.setValue(s[key]).onChange(async (v) => {
				s[key] = v;
				await this.plugin.saveSettings();
				after?.(v);
			}));
		const feature = (key: BoolKey, name: string, desc: string) => toggle(key, name, desc, () => this.plugin.reload());

		// General (no heading, per Obsidian's guidelines)
		feature("boards", "Drawing boards", "Freeform boards for drawing, maths, images and graphs (.mboard files).");
		feature("slides", "Slides", "Presentations with layouts and full-screen presenting (.mslides files).");
		feature("sheets", "Spreadsheets", "Open and edit Excel .xlsx files with formulas. Turn off if another plugin should open .xlsx files.");
		feature("embeds", "Show inside notes and Canvas", "Embedding a board, deck or spreadsheet shows it in place instead of a link.");
		feature("ribbon", "Ribbon buttons", "Buttons in the left sidebar for new boards, slides and spreadsheets.");
		new Setting(containerEl).setName("Folder for new files").setDesc("Leave empty to use the same folder as new notes.")
			.addText((t) => t.setPlaceholder("Example: Maths").setValue(s.newFileFolder).onChange(async (v) => { s.newFileFolder = v.trim().replace(/\/$/, ""); await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName("Maths").setHeading();
		toggle("mathShortcuts", "Keyboard shortcuts", "Use the shortcuts listed below in notes, boards and spreadsheets.", (v) => this.plugin.applyShortcuts(v));
		feature("symbolSearch", "Symbol search while typing", "Type \\ then a name, such as \\alpha or \\frac, to pick a symbol.");
		toggle("statusBar", "Maths buttons in the status bar", "The row of buttons at the bottom of the window on desktop.", () => this.plugin.setupStatusBar());
		toggle("mobileToolbar", "Maths buttons in the mobile toolbar", "The row of buttons above the keyboard on iPad and iPhone.", (v) => (v ? this.plugin.addToMobileToolbar() : this.plugin.removeFromMobileToolbar()));

		new Setting(containerEl).setName("Drawing").setHeading();
		toggle("fingerDraws", "Draw with your finger", "When off, fingers only move and zoom the board.");
		toggle("pencilOnlyAfterPen", "Palm rejection", "Once a stylus such as Apple Pencil touches the board, fingers and palms pan instead of drawing.");
		toggle("pressure", "Pressure sensitivity", "Press harder for thicker lines with a stylus.");
		new Setting(containerEl).setName("Default pen size")
			.addDropdown((d) => d.addOptions({ "2": "Fine", "4": "Medium", "8": "Bold", "14": "Marker" }).setValue(String(s.penSize)).onChange(async (v) => { s.penSize = parseInt(v); await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName("Background for new boards")
			.addDropdown((d) => d.addOptions({ grid: "Grid", dots: "Dots", lines: "Lined", plain: "Plain" }).setValue(s.defaultBg).onChange(async (v) => { s.defaultBg = v as Bg; await this.plugin.saveSettings(); }));
		toggle("canvasDraw", "Draw straight onto Canvas cards", "When off, select the card first; drag cards by their title either way.", () => this.plugin.applyBodyClasses());
		toggle("tbHighlighter", "Highlighter tool", "Show the highlighter in the board toolbar.");
		toggle("tbShapes", "Shape tools", "Show rectangle, circle, line and arrow.");
		toggle("tbMaths", "Maths tools", "Show the maths box and symbol buttons.");
		toggle("tbGraph", "Graph tool", "Show the graph button.");
		toggle("tbImages", "Image tool", "Show the add image button.");
		containerEl.createDiv({ cls: "setting-item-description ms-note", text: "Toolbar changes apply to boards you open next." });

		new Setting(containerEl).setName("Slides").setHeading();
		toggle("speakerNotes", "Speaker notes", "Show the notes box under each slide.");
		toggle("presentFullscreen", "Present in full screen", "On desktop, presenting fills the whole screen.");

		new Setting(containerEl).setName("Spreadsheets").setHeading();
		toggle("sheetAutocorrect", "Autocorrect and predictions", "Let the keyboard fix spelling and suggest words in cells. Usually best off for numbers and formulas.");
		toggle("sheetSuggest", "Suggest functions", "Typing =SU shows SUM and SUMSQ. Press Tab or Enter to pick one.");

		new Setting(containerEl).setName("Other plugins").setHeading();
		toggle("homeButtons", "Buttons on the Home + AI home screen", "If the Home + AI plugin is installed, add new board, slides and spreadsheet buttons to its home screen.", () => this.plugin.setupHomeButtons());

		new Setting(containerEl).setName("Keyboard shortcuts").setHeading();
		const table = containerEl.createDiv("ms-keys").createEl("table");
		const row = (a: string, b: string) => { const r = table.insertRow(); r.insertCell().setText(a); r.insertCell().createEl("kbd", { text: b }); };
		for (const t of MATH_TOOLS) row(t.name, shortcutLabel(t));
		row("Search symbols while typing", "\\ then a name");
		row("Board: pen, highlighter, eraser", "P  H  E");
		row("Board: select, text, maths box, graph", "V  T  M  G");
		row("Board: shapes", "R  O  L  A");
		row("Board: colours, sizes", "1–6  [ ]");
		row("Board: pan, fit to screen", "Space  0");
		containerEl.createDiv({ cls: "setting-item-description ms-note", text: Platform.isMobile ? "Shortcuts work with a hardware keyboard." : "You can also give any Bits and Bobs command your own hotkey in Settings → Hotkeys." });
	}
}
