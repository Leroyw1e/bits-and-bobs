// Typing ^ then a number gives a small raised number: x^2 becomes x², 10^-3 becomes 10⁻³.

export const SUPER: Record<string, string> = {
	"0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
	"+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾",
	a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ", m: "ᵐ",
	n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
};

export const FROM_SUPER: Record<string, string> = Object.fromEntries(Object.entries(SUPER).map(([k, v]) => [v, k]));
export const SUPER_RUN = new RegExp("[" + Object.values(SUPER).join("") + "]+", "g");

/** Replace runs of raised characters with ^(…) so they can be calculated. */
export function superToCaret(text: string): string {
	return text.replace(SUPER_RUN, (run) => "^(" + [...run].map((c) => FROM_SUPER[c]).join("") + ")");
}

export interface SuperResult {
	/** text to put in place of the typed character */
	insert: string;
	/** true: the typed character is replaced by `insert`; false: `insert` goes first and the character is typed as normal */
	swallow: boolean;
}

/**
 * Follows what you type after a ^ so that only the exponent is raised:
 *   x^2   x^10   x^-1   x^n   x^(n+1)
 * Anything else (a space, a letter after the number, …) ends it and is typed normally.
 */
export class SuperTyper {
	private phase: null | "start" | "signed" | "digits" | "paren" = null;
	get active() { return this.phase !== null; }
	/** a ^ has been typed but nothing has followed it yet */
	get pending() { return this.phase === "start"; }
	reset() { this.phase = null; }

	/** `canStart` says whether a ^ typed now may begin a raised number. Returns null to let the key through untouched. */
	handle(c: string, canStart: boolean): SuperResult | null {
		const digit = c >= "0" && c <= "9" && c.length === 1;
		switch (this.phase) {
			case null:
				if (c === "^" && canStart) { this.phase = "start"; return { insert: "", swallow: true }; }
				return null;
			case "start":
				if (digit) { this.phase = "digits"; return { insert: SUPER[c], swallow: true }; }
				if (c === "-" || c === "+") { this.phase = "signed"; return { insert: SUPER[c], swallow: true }; }
				if (c === "(") { this.phase = "paren"; return { insert: SUPER[c], swallow: true }; }
				if (c === "^") { this.phase = null; return { insert: "^", swallow: true }; }
				if (SUPER[c] && /[a-z]/.test(c)) { this.phase = null; return { insert: SUPER[c], swallow: true }; }
				this.phase = null;
				return { insert: "^", swallow: false };
			case "signed":
			case "digits":
				if (digit) { this.phase = "digits"; return { insert: SUPER[c], swallow: true }; }
				this.phase = null;
				return null;
			case "paren":
				if (c === ")") { this.phase = null; return { insert: SUPER[c], swallow: true }; }
				if (SUPER[c]) return { insert: SUPER[c], swallow: true };
				this.phase = null;
				return null;
		}
	}
}
