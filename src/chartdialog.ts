import { App, Modal } from "obsidian";
import { ChartData, ChartTheme, renderChart } from "./charts";

export type ChartKind = "bar" | "line" | "pie";

/** Everything needed to draw a chart you typed in by hand. */
export interface ChartSpec {
	kind: ChartKind;
	title: string;
	cats: string[];
	series: { name: string; values: (number | null)[] }[];
	/** lowest and highest number up the side; null means fit the numbers */
	ymin: number | null;
	ymax: number | null;
	xLabel: string;
	yLabel: string;
}

export const emptyChart = (): ChartSpec => ({
	kind: "bar", title: "", cats: ["A", "B", "C", "D"], series: [{ name: "Numbers", values: [null, null, null, null] }],
	ymin: null, ymax: null, xLabel: "", yLabel: "",
});

export function specToData(s: ChartSpec): ChartData {
	return { cats: s.cats, series: s.series.map((x) => ({ name: x.name, values: x.values.map((v) => (v === null ? NaN : v)) })), xs: null };
}

export function themeFromCss(el: HTMLElement): ChartTheme {
	const cs = getComputedStyle(el);
	const get = (v: string, fb: string) => cs.getPropertyValue(v).trim() || fb;
	return { fg: get("--text-normal", "#222"), muted: get("--text-muted", "#777"), grid: get("--background-modifier-border", "#ddd"), bg: get("--background-primary", "#fff") };
}

const WORD: Record<ChartKind, { one: string; many: string; count: string }> = {
	bar: { one: "bar", many: "bars", count: "Number of bars" },
	line: { one: "point", many: "points", count: "Number of points" },
	pie: { one: "slice", many: "slices", count: "Number of slices" },
};
const MAX_ITEMS = 40, MAX_SERIES = 4;
const label = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : String(i + 1));

/**
 * "Make a chart": you say how many bars there are, type a name and a number for each,
 * and choose the lowest and highest number up the side.
 */
class ChartModal extends Modal {
	private spec: ChartSpec;
	private done = false;
	private tableEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private errorEl!: HTMLElement;
	private insertBtn!: HTMLButtonElement;
	private sideRow!: HTMLElement;
	private countLabel!: HTMLElement;
	private countInput!: HTMLInputElement;

	constructor(app: App, initial: ChartSpec | null, private onDone: (spec: ChartSpec) => unknown, private editing: boolean) {
		super(app);
		this.spec = initial ? (JSON.parse(JSON.stringify(initial)) as ChartSpec) : emptyChart();
	}

	onOpen() {
		this.titleEl.setText(this.editing ? "Edit chart" : "Make a chart");
		this.modalEl.addClass("bb-chart-modal");
		const c = this.contentEl;
		const s = this.spec;

		// title and kind
		const title = c.createEl("input", { type: "text", cls: "bb-chart-title", attr: { placeholder: "Chart title (optional)" } });
		title.value = s.title;
		title.oninput = () => { s.title = title.value; this.redraw(); };
		const kinds = c.createDiv("bb-chart-kinds");
		(["bar", "line", "pie"] as ChartKind[]).forEach((k) => {
			const b = kinds.createEl("button", { cls: "bb-chart-kind" + (s.kind === k ? " is-active" : ""), text: k === "bar" ? "Bar chart" : k === "line" ? "Line chart" : "Pie chart" });
			b.onclick = () => { s.kind = k; kinds.querySelectorAll("button").forEach((x) => x.removeClass("is-active")); b.addClass("is-active"); this.syncKind(); this.buildTable(); this.redraw(); };
		});

		// how many bars
		const count = c.createDiv("bb-chart-count");
		this.countLabel = count.createSpan({ cls: "bb-chart-count-label" });
		const minus = count.createEl("button", { cls: "bb-chart-step", text: "−", attr: { "aria-label": "One fewer" } });
		this.countInput = count.createEl("input", { type: "number", cls: "bb-chart-count-input", attr: { min: "1", max: String(MAX_ITEMS), inputmode: "numeric" } });
		const plus = count.createEl("button", { cls: "bb-chart-step", text: "+", attr: { "aria-label": "One more" } });
		minus.onclick = () => this.setCount(s.cats.length - 1);
		plus.onclick = () => this.setCount(s.cats.length + 1);
		this.countInput.onchange = () => this.setCount(parseInt(this.countInput.value, 10) || s.cats.length);

		// the numbers
		this.tableEl = c.createDiv("bb-chart-table");

		// the highest and lowest number up the side
		this.sideRow = c.createDiv("bb-chart-side");
		this.sideRow.createSpan({ cls: "bb-chart-side-title", text: "Numbers up the side" });
		const numBox = (name: string, value: number | null, set: (v: number | null) => void) => {
			const w = this.sideRow.createDiv("bb-chart-side-item");
			w.createSpan({ text: name });
			const i = w.createEl("input", { type: "number", attr: { placeholder: "auto", step: "any", inputmode: "decimal" } });
			i.value = value === null ? "" : String(value);
			i.oninput = () => { const v = parseFloat(i.value); set(i.value.trim() === "" || isNaN(v) ? null : v); this.redraw(); };
		};
		numBox("Lowest", s.ymin, (v) => (s.ymin = v));
		numBox("Highest", s.ymax, (v) => (s.ymax = v));
		this.sideRow.createDiv({ cls: "setting-item-description bb-chart-side-tip", text: "Leave empty to fit your numbers." });

		const labels = c.createDiv("bb-chart-labels");
		const lab = (name: string, value: string, set: (v: string) => void, ph: string) => {
			const w = labels.createDiv("bb-chart-label-item");
			w.createSpan({ text: name });
			const i = w.createEl("input", { type: "text", attr: { placeholder: ph } });
			i.value = value;
			i.oninput = () => { set(i.value); this.redraw(); };
		};
		lab("Side label", s.yLabel, (v) => (s.yLabel = v), "e.g. Number of people");
		lab("Bottom label", s.xLabel, (v) => (s.xLabel = v), "e.g. Month");
		this.labelsEl = labels;

		this.previewEl = c.createDiv("bb-chart-preview");
		this.errorEl = c.createDiv("bb-chart-error");
		const actions = c.createDiv("bb-chart-actions");
		const cancel = actions.createEl("button", { text: "Cancel" });
		cancel.onclick = () => this.close();
		this.insertBtn = actions.createEl("button", { cls: "mod-cta", text: this.editing ? "Save" : "Insert" });
		this.insertBtn.onclick = () => this.finish();

		this.syncKind();
		this.buildTable();
		this.redraw();
		window.setTimeout(() => this.tableEl.querySelector<HTMLInputElement>("input.bb-chart-value")?.focus(), 40);
	}

	private labelsEl!: HTMLElement;

	private syncKind() {
		const w = WORD[this.spec.kind];
		this.countLabel.setText(w.count);
		this.countInput.value = String(this.spec.cats.length);
		this.sideRow.toggleClass("is-hidden", this.spec.kind === "pie");
		this.labelsEl.toggleClass("is-hidden", this.spec.kind === "pie");
		if (this.spec.kind === "pie" && this.spec.series.length > 1) this.spec.series.length = 1;
	}

	private setCount(n: number) {
		const s = this.spec;
		n = Math.max(1, Math.min(MAX_ITEMS, Math.round(n)));
		while (s.cats.length < n) { s.cats.push(label(s.cats.length)); s.series.forEach((x) => x.values.push(null)); }
		while (s.cats.length > n) { s.cats.pop(); s.series.forEach((x) => x.values.pop()); }
		this.countInput.value = String(n);
		this.buildTable();
		this.redraw();
	}

	/** One row per bar: a name and a number (and more columns if there's more than one set of numbers). */
	private buildTable() {
		const s = this.spec, t = this.tableEl;
		t.empty();
		const head = t.createDiv("bb-chart-row is-head");
		head.createSpan({ cls: "bb-chart-num" });
		head.createSpan({ text: WORD[s.kind].one[0].toUpperCase() + WORD[s.kind].one.slice(1) + " name", cls: "bb-chart-cell" });
		s.series.forEach((ser, si) => {
			const h = head.createDiv("bb-chart-cell bb-chart-serhead");
			if (s.kind === "pie") h.createSpan({ text: "Number" });
			else {
				const n = h.createEl("input", { type: "text", cls: "bb-chart-sername", attr: { "aria-label": "Name of this set of numbers" } });
				n.value = ser.name;
				n.oninput = () => { ser.name = n.value; this.redraw(); };
				if (s.series.length > 1) {
					const rm = h.createEl("button", { cls: "bb-chart-x", text: "×", attr: { "aria-label": "Remove this set" } });
					rm.onclick = () => { s.series.splice(si, 1); this.buildTable(); this.redraw(); };
				}
			}
		});
		for (let i = 0; i < s.cats.length; i++) {
			const row = t.createDiv("bb-chart-row");
			row.createSpan({ cls: "bb-chart-num", text: String(i + 1) });
			const name = row.createEl("input", { type: "text", cls: "bb-chart-cell bb-chart-name", attr: { "aria-label": `Name of ${WORD[s.kind].one} ${i + 1}` } });
			name.value = s.cats[i];
			name.oninput = () => { s.cats[i] = name.value; this.redraw(); };
			s.series.forEach((ser, si) => {
				const v = row.createEl("input", { type: "number", cls: "bb-chart-cell bb-chart-value", attr: { step: "any", placeholder: "number", inputmode: "decimal", "aria-label": `Number for ${WORD[s.kind].one} ${i + 1}` } });
				v.value = ser.values[i] === null || ser.values[i] === undefined ? "" : String(ser.values[i]);
				v.oninput = () => { const x = parseFloat(v.value); ser.values[i] = v.value.trim() === "" || isNaN(x) ? null : x; this.redraw(); };
				v.onkeydown = (e) => {
					if (e.key === "Enter" || e.key === "ArrowDown") {
						e.preventDefault();
						const next = this.tableEl.querySelectorAll<HTMLInputElement>(`.bb-chart-row:nth-child(${i + 3}) .bb-chart-value`)[si];
						if (next) next.focus(); else if (e.key === "Enter") this.finish();
					} else if (e.key === "ArrowUp") {
						e.preventDefault();
						this.tableEl.querySelectorAll<HTMLInputElement>(`.bb-chart-row:nth-child(${i + 1}) .bb-chart-value`)[si]?.focus();
					}
				};
			});
		}
		if (s.kind !== "pie" && s.series.length < MAX_SERIES) {
			const add = t.createEl("button", { cls: "bb-chart-addset", text: "+ Add another set of numbers" });
			add.onclick = () => { s.series.push({ name: `Numbers ${s.series.length + 1}`, values: s.cats.map(() => null) }); this.buildTable(); this.redraw(); };
		}
	}

	private problem(): string {
		const s = this.spec;
		if (!s.series.some((x) => x.values.some((v) => v !== null))) return "Type at least one number.";
		if (s.kind !== "pie" && s.ymin !== null && s.ymax !== null && s.ymax <= s.ymin) return "The highest number must be bigger than the lowest.";
		if (s.kind === "pie" && s.series[0].values.some((v) => v !== null && v < 0)) return "A pie chart can't use negative numbers.";
		return "";
	}

	private redraw() {
		const s = this.spec;
		this.previewEl.empty();
		const W = 460, H = 300;
		const svg = renderChart({ type: s.kind, title: s.title }, specToData(s), themeFromCss(activeDocument.body), W, H, { ymin: s.ymin, ymax: s.ymax, xLabel: s.xLabel, yLabel: s.yLabel });
		this.previewEl.appendChild(svg);
		const p = this.problem();
		this.errorEl.setText(p);
		this.insertBtn.disabled = !!p;
	}

	private finish() {
		if (this.done || this.problem()) return;
		this.done = true;
		this.close();
		this.onDone(JSON.parse(JSON.stringify(this.spec)) as ChartSpec);
	}

	onClose() { this.contentEl.empty(); }
}

export function openChartDialog(app: App, initial: ChartSpec | null, done: (spec: ChartSpec) => unknown) {
	new ChartModal(app, initial, done, initial !== null).open();
}
