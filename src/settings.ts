import { App, Platform, PluginSettingTab, Setting, Notice } from "obsidian";
import type BitsAndBobs from "./main";
import { MATH_TOOLS, shortcutLabel } from "./math";
import type { Bg } from "./board";
import type { PdfNoteStyle } from "./pdfnote";
import { TagAllModal } from "./foldertags";
import { SPELL_LANGS } from "./spell";
import { ConfirmBox } from "./historyview";
import { STYLE_NAMES } from "./citeformat";
import type { Citation, CiteStyle } from "./citeformat";
import { DEFAULT_SYNC, type SyncSettings } from "./sync";
import { DEFAULT_SOURCE, type SourceState } from "./sourcelists";
import type { ShareLink } from "./share";
import { renderSyncSettings } from "./syncsettings";

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
	tbLasso: boolean;
	tbTrace: boolean;
	tbChart: boolean;
	tbGuides: boolean;
	tbLayers: boolean;
	shapeSnap: boolean;
	snapHoldMs: number;
	// slides
	speakerNotes: boolean;
	presentFullscreen: boolean;
	presentDraw: boolean;
	slideEffects: boolean;
	// spreadsheets
	sheetAutocorrect: boolean;
	sheetSuggest: boolean;
	sheetFormat: boolean;
	sheetFill: boolean;
	sheetCharts: boolean;
	superscriptTyping: boolean;
	autoSolve: boolean;
	autoSolveGhost: boolean;
	typeShortcuts: boolean;
	realOperators: boolean;
	typePi: boolean;
	symbolsSidebar: boolean;
	// other
	homeButtons: boolean;
	pdfNotes: boolean;
	photoNotes: boolean;
	folderTags: boolean;
	citeTool: boolean;
	citeStyle: CiteStyle;
	citations: Citation[];
	imageTools: boolean;
	editorTab: boolean;
	/** keep every save of notes, boards, decks and spreadsheets on this device */
	fileHistory: boolean;
	history: { notes: boolean; boards: boolean; sheets: boolean; other: boolean };
	/** master switch for typing helpers (shortcuts, auto solve, ^, pi, fractions, symbol search, maths buttons) */
	mathTyping: boolean;
	/** master switch for Keyring and OneDrive sync, share links and Source lists */
	cloud: boolean;
	spellOn: boolean;
	spellLang: string;
	spellSkipNames: boolean;
	myWords: string[];
	wordGoal: number;
	pdfNoteStyle: PdfNoteStyle;
	newFileFolder: string;
	sync: SyncSettings;
	source: SourceState;
	shares: ShareLink[];
}

export const DEFAULT_SETTINGS: BitsSettings = {
	boards: true, slides: true, sheets: true, embeds: true, ribbon: true, symbolSearch: true,
	mathShortcuts: true, statusBar: true, mobileToolbar: true, mobileToolbarAdded: false,
	fingerDraws: true, pencilOnlyAfterPen: true, pressure: true, penSize: 4, defaultBg: "grid", canvasDraw: true,
	tbHighlighter: true, tbShapes: true, tbMaths: true, tbGraph: true, tbImages: true, tbLasso: true, tbTrace: true, tbChart: true, tbGuides: true, tbLayers: true, shapeSnap: true, snapHoldMs: 600,
	speakerNotes: true, presentFullscreen: true, presentDraw: true, slideEffects: true,
	sheetAutocorrect: false, sheetSuggest: true, sheetFormat: true, sheetFill: true, sheetCharts: true, superscriptTyping: true, autoSolve: true, autoSolveGhost: false, typeShortcuts: true, realOperators: true, typePi: true, symbolsSidebar: true,
	homeButtons: true, pdfNotes: true, photoNotes: true, folderTags: true, citeTool: true, citeStyle: "apa", citations: [], imageTools: true, editorTab: true, fileHistory: true, history: { notes: true, boards: true, sheets: true, other: false }, mathTyping: true, cloud: true, spellOn: true, spellLang: "en-AU", spellSkipNames: true, myWords: [], wordGoal: 0, pdfNoteStyle: "text", newFileFolder: "", sync: DEFAULT_SYNC, source: DEFAULT_SOURCE, shares: [],
};

type BoolKey = { [K in keyof BitsSettings]: BitsSettings[K] extends boolean ? K : never }[keyof BitsSettings];

export class BitsSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: BitsAndBobs) { super(app, plugin); }

	display() {
		const { containerEl } = this;
		const s = this.plugin.settings;
		const st = s;
		containerEl.empty();

		const toggle = (key: BoolKey, name: string, desc: string, after?: (v: boolean) => void) =>
			new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) => t.setValue(s[key]).onChange((v) => {
				s[key] = v;
				void this.plugin.saveSettings();
				after?.(v);
			}));
		const feature = (key: BoolKey, name: string, desc: string) => toggle(key, name, desc, () => { void this.plugin.reload(); });

		const note = (text: string) => containerEl.createDiv({ cls: "setting-item-description ms-note", text });
		/** a feature's own heading; its options are only shown while the feature is on */
		const section = (title: string, on: boolean, body: () => void, blurb?: string) => {
			new Setting(containerEl).setName(title).setHeading();
			if (!on) { note("Turned off. Switch it on in Features at the top."); return; }
			if (blurb) note(blurb);
			body();
		};
		/** a switch that also shows or hides the feature's options below */
		const switchOn = (key: BoolKey, name: string, desc: string, after?: (v: boolean) => void) =>
			toggle(key, name, desc, (v) => { after?.(v); this.display(); });

		// ---------- 1. every major feature, on or off ----------
		new Setting(containerEl).setName("Features").setHeading();
		note("Turn each part of Bits and Bobs on or off. A feature you turn off disappears completely, and its options below are hidden.");
		feature("boards", "Drawing boards", "Freeform boards for drawing, maths, images and graphs (.mboard files).");
		feature("slides", "Slides", "Presentations with layouts and full-screen presenting (.mslides files).");
		feature("sheets", "Spreadsheets", "Open and edit Excel .xlsx files with formulas. Turn off if another plugin should open .xlsx files.");
		feature("mathTyping", "Maths typing and symbols", "Keyboard shortcuts, symbol search, auto solve, type ^ for powers, pi, fractions, real × and ÷ signs, and the maths buttons.");
		feature("citeTool", "Citations", "A citation maker in its own tab: websites, books, articles and videos in APA, MLA, Harvard or Chicago.");
		feature("editorTab", "Editor tab", "Live word counts, reading time, how easy the note is to read, and spelling mistakes with their corrections, in the right sidebar.");
		feature("fileHistory", "File history", "Keeps every save of your notes, boards, slides and spreadsheets on this device, so you can see what you added each year, month, day, hour, minute or second, and go back to any version.");
		switchOn("imageTools", "Picture tools", "Crop, move and wrap pictures in notes, and turn dropped or pasted iPhone HEIC photos into JPEGs.");
		switchOn("folderTags", "Folder tags", "New notes, and notes you move, get tags for the folders they're in.");
		switchOn("pdfNotes", "PDF to note", "Drop a PDF on the file list to make a note from it.");
		switchOn("photoNotes", "Photos to note", "Drop photos on the file list to make one note showing them all.");
		feature("cloud", "Cloud sync, OneDrive and share links", "Sign in with Keyring to sync your vault, sync with OneDrive, share files as web links and keep your Source citation lists. Nothing is sent unless you sign in.");
		feature("embeds", "Show boards, slides and spreadsheets inside notes and Canvas", "Embedding one shows it in place instead of a link.");
		feature("ribbon", "Ribbon buttons", "Buttons in the left sidebar for new boards, slides and spreadsheets, the symbols menu, citations and the Editor tab.");
		switchOn("homeButtons", "Home + AI buttons", "If the Home + AI plugin is installed, add new board, slides and spreadsheet buttons to its home screen.", () => this.plugin.setupHomeButtons());

		// ---------- 2. the options of each feature ----------
		new Setting(containerEl).setName("Inside each feature").setHeading();
		note("Each feature has its own heading below, with everything you can change for it.");

		section("Drawing boards", st.boards, () => {
			toggle("fingerDraws", "Draw with your finger", "When off, fingers only move and zoom the board.");
			toggle("pencilOnlyAfterPen", "Palm rejection", "Once a stylus such as Apple Pencil touches the board, fingers and palms pan instead of drawing.");
			toggle("pressure", "Pressure sensitivity", "Press harder for thicker lines with a stylus.");
			new Setting(containerEl).setName("Default pen size")
				.addDropdown((d) => d.addOptions({ "2": "Fine", "4": "Medium", "8": "Bold", "14": "Marker" }).setValue(String(s.penSize)).onChange(async (v) => { s.penSize = parseInt(v); await this.plugin.saveSettings(); }));
			new Setting(containerEl).setName("Background for new boards")
				.addDropdown((d) => d.addOptions({ grid: "Grid", dots: "Dots", lines: "Lined", plain: "Plain" }).setValue(s.defaultBg).onChange(async (v) => { s.defaultBg = v as Bg; await this.plugin.saveSettings(); }));
			toggle("shapeSnap", "Snap shapes when you hold the pen", "Draw a line, circle, rectangle or triangle, then hold the pen still at the end and it turns into a clean shape. Lines can then be aimed before you lift.");
			new Setting(containerEl).setName("Hold time before snapping").setDesc("How long to hold the pen still.")
				.addDropdown((d) => d.addOptions({ "400": "Short (0.4 s)", "600": "Normal (0.6 s)", "900": "Long (0.9 s)" }).setValue(String(s.snapHoldMs)).onChange(async (v) => { s.snapHoldMs = parseInt(v); await this.plugin.saveSettings(); }));
			toggle("canvasDraw", "Draw straight onto Canvas cards", "When off, select the card first; drag cards by their title either way.", () => this.plugin.applyBodyClasses());
			toggle("tbHighlighter", "Highlighter tool", "Show the highlighter in the board toolbar.");
			toggle("tbShapes", "Shape tools", "Show rectangle, circle, line and arrow.");
			toggle("tbMaths", "Maths tools", "Show the maths box and symbol buttons.");
			toggle("tbGraph", "Graph tool", "Show the graph button.");
			toggle("tbTrace", "Graph trace tool", "Show the button for reading values off a graph.");
			toggle("tbChart", "Chart tool", "Show the button for making bar, line and pie charts from numbers you type.");
			toggle("tbGuides", "Ruler and protractor", "Show the ruler and protractor buttons. Draw close to the ruler's edge and the line stays straight.");
			toggle("tbLayers", "Layers", "Show the layers button for stacking, hiding and locking parts of a board.");
			toggle("tbLasso", "Lasso tool", "Show the lasso button for circling things to select them.");
			toggle("tbImages", "Image tool", "Show the add image button.");
			containerEl.createDiv({ cls: "setting-item-description ms-note", text: "Toolbar changes apply to boards you open next." });
		});

		section("Slides", st.slides, () => {
			toggle("speakerNotes", "Speaker notes", "Show the notes box under each slide.");
			toggle("slideEffects", "Slide effects", "Themes, transitions between slides, and showing bullets or objects one click at a time.");
			toggle("presentDraw", "Draw while presenting", "Pen, highlighter and laser pointer on top of the slide. Drawings are cleared when you finish.");
			toggle("presentFullscreen", "Present in full screen", "On desktop, presenting fills the whole screen.");
		});

		section("Spreadsheets", st.sheets, () => {
			toggle("sheetAutocorrect", "Autocorrect and predictions", "Let the keyboard fix spelling and suggest words in cells. Usually best off for numbers and formulas.");
			toggle("sheetFormat", "Formatting buttons", "Bold, italic, colours, alignment and number formats. Colours and bold are kept by this plugin; number formats are also saved in the Excel file.");
			toggle("sheetFill", "Drag to fill", "A small square on the selection that you drag to continue numbers, dates like Mon and Tue, and formulas.");
			toggle("sheetCharts", "Charts", "Make bar, line, pie and scatter charts from cells, shown next to the spreadsheet.");
			toggle("sheetSuggest", "Suggest functions", "Typing =SU shows SUM and SUMSQ. Press Tab or Enter to pick one.");
		});

		section("Maths typing and symbols", st.mathTyping, () => {
			toggle("mathShortcuts", "Keyboard shortcuts", "Use the shortcuts listed at the bottom in notes, boards and spreadsheets.", (v) => this.plugin.applyShortcuts(v));
			feature("symbolSearch", "Symbol search while typing", "Type \\ then a name, such as \\alpha or \\frac, to pick a symbol.");
			toggle("superscriptTyping", "Type ^ for small raised numbers", "In a note, x^2 becomes x² as you type, and 10^-3 becomes 10⁻³. It isn't used inside maths, code or spreadsheets.");
			toggle("autoSolve", "Auto solve", "In a note, type a sum and then =, for example 12*(3+4)=, and the answer appears after it. Also converts units: 5 km = gives miles.");
			toggle("autoSolveGhost", "Show the answer first, press Tab to use it", "Instead of writing the answer straight away, auto solve shows it faded after the = and you press Tab to keep it. Keep typing to ignore it.");
			toggle("realOperators", "Type * and / for × and ÷", "In a note, 3*4 becomes 3×4 and 8/2 becomes 8÷2 as you type. Press Backspace straight after to get the plain * or / back. Links, web addresses and dates are left alone.");
			toggle("typePi", "Type pi for π", "In a note, pi on its own becomes π (inside maths it becomes \\pi). Words like pie and spin are left alone. If you delete a π and type pi again in the same place, it stays as pi.");
			toggle("typeShortcuts", "Type 2/4 for a fraction", "In a note, 2/4 followed by a space becomes a fraction, sqrt(16) becomes a square root, and <= >= != +- -> become ≤ ≥ ≠ ± →. Letters such as alpha still use the symbols menu.");
			toggle("symbolsSidebar", "Show the symbols menu in the left sidebar", "When off, the symbols menu opens as a pop-up instead.");
			toggle("statusBar", "Maths buttons in the status bar", "The row of buttons at the bottom of the window on desktop.", () => this.plugin.setupStatusBar());
			toggle("mobileToolbar", "Maths buttons in the mobile toolbar", "The row of buttons above the keyboard on iPad and iPhone.", (v) => (v ? this.plugin.addToMobileToolbar() : this.plugin.removeFromMobileToolbar()));
		});

		section("Citations", st.citeTool, () => {
			new Setting(containerEl).setName("Referencing style").setDesc("The style new citation lists start with. You can change it in the Citations tab too.")
				.addDropdown((d) => d.addOptions(STYLE_NAMES).setValue(s.citeStyle).onChange(async (v) => { s.citeStyle = v as CiteStyle; await this.plugin.saveSettings(); }));
		});

		section("Editor tab", st.editorTab, () => {
			new Setting(containerEl).setName("Check spelling").setDesc("Show spelling mistakes in the Editor tab.")
				.addToggle((t) => t.setValue(s.spellOn).onChange(async (v) => { s.spellOn = v; await this.plugin.saveSettings(); this.plugin.speller.onChange?.(); }));
			new Setting(containerEl).setName("Spelling language").setDesc("The dictionary is downloaded the first time you use it and kept on this device.")
				.addDropdown((d) => d.addOptions(SPELL_LANGS).setValue(s.spellLang).onChange(async (v) => { s.spellLang = v; await this.plugin.saveSettings(); this.plugin.speller.reset(); void this.plugin.speller.load(v); }));
			toggle("spellSkipNames", "Don't flag names", "Skip capitalised words in the middle of a sentence, like Leroy or Perth, so names aren't marked as mistakes.", () => this.plugin.speller.onChange?.());
			new Setting(containerEl).setName("My words").setDesc("Words the spell checker should accept, one per line. Add one from the Editor tab with the book button.")
				.addTextArea((t) => { t.setValue(s.myWords.join("\n")).onChange((v) => { s.myWords = [...new Set(v.split("\n").map((x) => x.trim()).filter(Boolean))].sort((x, y) => x.localeCompare(y)); this.plugin.speller.setWords(s.myWords); }); t.inputEl.rows = 4; });
			new Setting(containerEl).setName("Word goal").setDesc("A number of words to aim for in a note. Leave empty for no goal. You can also set it in the Editor tab.")
				.addText((t) => t.setPlaceholder("For example 500").setValue(s.wordGoal ? String(s.wordGoal) : "").onChange(async (v) => { s.wordGoal = Math.max(0, Math.floor(Number(v) || 0)); await this.plugin.saveSettings(); this.plugin.speller.onChange?.(); }));
		});

		section("File history", st.fileHistory, () => {
			const track = (key: "notes" | "boards" | "sheets" | "other", name: string, desc: string) =>
				new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) => t.setValue(s.history[key]).onChange(async (v) => { s.history[key] = v; await this.plugin.saveSettings(); if (v) void this.plugin.history.scan(); }));
			track("notes", "Notes", "Every change to your notes (.md files).");
			track("boards", "Boards and slides", "Every save of drawing boards and slide decks.");
			track("sheets", "Spreadsheets", "A copy of each spreadsheet, at most one every 10 seconds while you work.");
			track("other", "Other text files", "Canvas, text, CSV and JSON files.");
			const use = new Setting(containerEl).setName("Space used").setDesc("Working it out…")
				.addButton((b) => b.setButtonText("Clear all history").setClass("mod-warning").onClick(() => new ConfirmBox(this.app, "Clear all history?", "Every recorded version of every file will be deleted from this device. Your notes and files stay as they are.", "", "Clear it", async () => { await this.plugin.history.clearAll(); new Notice("History cleared."); this.display(); }).open()));
			void this.plugin.history.size().then((n) => use.setDesc(`${n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`} on this device, for ${this.plugin.history.files().length} files. It's kept in this plugin's folder and never uploaded by this plugin or synced to OneDrive.`));
		}, "History starts from the moment it's switched on and keeps every change after that. Open it with the command Show the history of this file, or right-click a file and choose File history.");

		section("Picture tools", st.imageTools, () => { /* no options: click a picture in Live Preview for crop, wrap and size buttons */ }, "In Live Preview, click a picture for buttons to crop it, wrap text on either side, centre it, or change its size. Drag a picture to move it: drop it on the left, middle or right of the page.");

		section("Folder tags", st.folderTags, () => {
			new Setting(containerEl).setName("Tag all your notes now").setDesc("Adds folder tags to every note already in the vault. You'll be asked first.")
				.addButton((b) => b.setButtonText("Tag all notes").onClick(() => new TagAllModal(this.app).open()));
		}, "New notes, and notes you move, get tags such as #school-work and #maths. When a note moves, the old folder tags come off. Other tags are left alone.");

		section("PDFs and photos", st.pdfNotes || st.photoNotes, () => {
			new Setting(containerEl).setName("What goes in a note made from a PDF")
				.addDropdown((d) => d.addOptions({ text: "The PDF's text, keeping its headings, bold, italics and lists", embed: "The PDF itself, shown in the note" }).setValue(s.pdfNoteStyle).onChange(async (v) => { s.pdfNoteStyle = v as PdfNoteStyle; await this.plugin.saveSettings(); }));
		}, "Dragging a PDF or photos from outside Obsidian onto the file list saves them and makes a note. iPhone HEIC photos are turned into JPEGs so they show everywhere.");

		section("Cloud sync, OneDrive and share links", st.cloud, () => renderSyncSettings(containerEl, this.plugin, () => this.display(), false));

		new Setting(containerEl).setName("New files").setHeading();
		new Setting(containerEl).setName("Folder for new files").setDesc("Leave empty to use the same folder as new notes.")
			.addText((t) => t.setPlaceholder("Example: Maths").setValue(s.newFileFolder).onChange(async (v) => { s.newFileFolder = v.trim().replace(/\/$/, ""); await this.plugin.saveSettings(); }));

		new Setting(containerEl).setName("Keyboard shortcuts").setHeading();
		const table = containerEl.createDiv("ms-keys").createEl("table");
		const row = (a: string, b: string) => { const r = table.insertRow(); r.insertCell().setText(a); r.insertCell().createEl("kbd", { text: b }); };
		for (const t of MATH_TOOLS) row(t.name, shortcutLabel(t));
		row("Search symbols while typing", "\\ then a name");
		row("Board: pen, highlighter, eraser", "P  H  E");
		row("Board: select, lasso, text, maths box, graph, trace", "V  S  T  M  G  C");
		row("Board: shapes", "R  O  L  A");
		row("Presenting: pen, highlighter, laser, clear", "P  H  L  C");
		row("Board: colours, sizes", "1–6  [ ]");
		row("Board: pan, fit to screen", "Space  0");
		containerEl.createDiv({ cls: "setting-item-description ms-note", text: Platform.isMobile ? "Shortcuts work with a hardware keyboard." : "You can also give any Bits and Bobs command your own hotkey in Settings → Hotkeys." });
	}
}
