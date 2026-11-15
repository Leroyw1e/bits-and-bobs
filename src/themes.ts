/** Ready-made looks for a whole slide deck: colours and fonts. Only fonts already on the device are used. */
export interface Theme { id: string; name: string; bg: string; ink: string; accent: string; accent2: string; font: string; head: string }

const SANS = `-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
const SERIF = `Georgia, "Times New Roman", serif`;
const ROUND = `"Avenir Next", "Trebuchet MS", "Segoe UI", sans-serif`;
const HAND = `"Bradley Hand", "Marker Felt", "Segoe Print", "Comic Sans MS", cursive`;
const MONO = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

export const FONTS: { id: string; name: string; css: string }[] = [
	{ id: "sans", name: "Clean", css: SANS },
	{ id: "serif", name: "Serif", css: SERIF },
	{ id: "round", name: "Rounded", css: ROUND },
	{ id: "hand", name: "Handwriting", css: HAND },
	{ id: "mono", name: "Typewriter", css: MONO },
];

export const THEMES: Theme[] = [
	{ id: "classic", name: "Classic", bg: "#ffffff", ink: "#1e1e1e", accent: "#1971c2", accent2: "#e03131", font: SANS, head: SANS },
	{ id: "dark", name: "Dark", bg: "#1b1d23", ink: "#f1f3f5", accent: "#74c0fc", accent2: "#ff8787", font: SANS, head: SANS },
	{ id: "chalk", name: "Chalkboard", bg: "#26433a", ink: "#f1f5ee", accent: "#ffd43b", accent2: "#ff8787", font: HAND, head: HAND },
	{ id: "ocean", name: "Ocean", bg: "#e7f5ff", ink: "#0b3558", accent: "#1c7ed6", accent2: "#0ca678", font: ROUND, head: ROUND },
	{ id: "sunset", name: "Sunset", bg: "#fff4e6", ink: "#3b2412", accent: "#e8590c", accent2: "#c2255c", font: SANS, head: SERIF },
	{ id: "paper", name: "Paper", bg: "#fbf6ea", ink: "#2b2b2b", accent: "#7048e8", accent2: "#d9480f", font: SERIF, head: SERIF },
	{ id: "midnight", name: "Midnight", bg: "#0b1d3a", ink: "#e7f0ff", accent: "#4dabf7", accent2: "#f783ac", font: ROUND, head: ROUND },
];

/** The theme a deck uses, or null to follow the Obsidian theme. A font choice replaces the theme's fonts. */
export function themeFor(themeId?: string, fontId?: string): Theme | null {
	const base = THEMES.find((t) => t.id === themeId) ?? null;
	const f = FONTS.find((x) => x.id === fontId);
	if (!f) return base;
	return { ...(base ?? { id: "obsidian", name: "Match Obsidian", bg: "", ink: "", accent: "", accent2: "", font: SANS, head: SANS }), font: f.css, head: f.css };
}
