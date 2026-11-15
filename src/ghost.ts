import { Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap } from "@codemirror/view";

/** A faded suggestion shown after the cursor. Tab accepts it; typing or moving the cursor drops it. */
export const setGhost = StateEffect.define<{ pos: number; text: string } | null>();

class GhostWidget extends WidgetType {
	constructor(readonly text: string) { super(); }
	eq(o: GhostWidget) { return o.text === this.text; }
	toDOM() {
		const s = activeDocument.createElement("span");
		s.className = "bb-ghost";
		s.textContent = this.text;
		s.setAttribute("aria-hidden", "true");
		return s;
	}
	ignoreEvent() { return true; }
}

const field = StateField.define<{ pos: number; text: string } | null>({
	create: () => null,
	update(v, tr) {
		for (const e of tr.effects) if (e.is(setGhost)) return e.value;
		if (v && (tr.docChanged || tr.selection)) return null;
		return v;
	},
	provide: (f) => EditorView.decorations.from(f, (v) => (v ? Decoration.set([Decoration.widget({ widget: new GhostWidget(v.text), side: 1 }).range(v.pos)]) : Decoration.none)),
});

export function ghostExtension(): Extension {
	return [
		field,
		Prec.highest(keymap.of([
			{
				key: "Tab",
				run: (view) => {
					const g = view.state.field(field, false);
					if (!g || view.state.selection.main.head !== g.pos) return false;
					view.dispatch({ changes: { from: g.pos, insert: g.text }, selection: { anchor: g.pos + g.text.length }, effects: setGhost.of(null) });
					return true;
				},
			},
			{
				key: "Escape",
				run: (view) => {
					if (!view.state.field(field, false)) return false;
					view.dispatch({ effects: setGhost.of(null) });
					return true;
				},
			},
		])),
	];
}
