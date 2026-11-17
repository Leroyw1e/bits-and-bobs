/** Reference list formatting for APA 7, MLA 9, Harvard (Cite Them Right) and Chicago (notes and bibliography). */

export type CiteStyle = "apa" | "mla" | "harvard" | "chicago";
export type SourceKind = "website" | "book" | "journal" | "video" | "news";

export interface Citation {
	id: string;
	kind: SourceKind;
	/** one per line, "First Middle Last" or "Last, First"; a group name if `group` is set */
	authors: string[];
	group?: boolean;
	title: string;
	/** website name, journal, newspaper, or YouTube channel */
	container: string;
	publisher: string;
	year: string;
	month: string; // "1".."12" or ""
	day: string;
	url: string;
	accessed: string; // YYYY-MM-DD
	edition: string;
	volume: string;
	issue: string;
	pages: string;
	doi: string;
	place: string;
}

export const STYLE_NAMES: Record<CiteStyle, string> = { apa: "APA 7", mla: "MLA 9", harvard: "Harvard", chicago: "Chicago" };
export const KIND_NAMES: Record<SourceKind, string> = { website: "Website", book: "Book", journal: "Journal article", video: "Video", news: "Newspaper or magazine" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MLA_MONTHS = ["Jan.", "Feb.", "Mar.", "Apr.", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];

interface Name { first: string[]; last: string; whole: string }

function splitName(raw: string, group: boolean): Name {
	const s = raw.trim().replace(/\s+/g, " ");
	if (group) return { first: [], last: s, whole: s };
	if (s.includes(",")) {
		const [last, first] = s.split(",", 2).map((x) => x.trim());
		return { first: first ? first.split(" ") : [], last, whole: s };
	}
	const parts = s.split(" ");
	const last = parts.pop() ?? "";
	return { first: parts, last, whole: s };
}

const initials = (n: Name, spaced = true) => n.first.map((f) => f.split("-").map((p) => p[0]?.toUpperCase() + ".").join("-")).join(spaced ? " " : "");
const firstNames = (n: Name) => n.first.join(" ");
/** "Last, F. M." */
const lastInit = (n: Name) => (n.first.length ? `${n.last}, ${initials(n)}` : n.last);
/** "Last, First" */
const lastFirst = (n: Name) => (n.first.length ? `${n.last}, ${firstNames(n)}` : n.last);
/** "First Last" */
const firstLast = (n: Name) => (n.first.length ? `${firstNames(n)} ${n.last}` : n.last);

const end = (s: string, mark = ".") => (!s ? "" : /[.?!]$/.test(s.replace(/\*+$/, "")) ? s : s + mark);
const join = (parts: string[], sep = " ") => parts.filter((p) => p && p.trim()).join(sep);
/** APA sentence case would change the user's words, so titles are kept as typed. */
const it = (s: string) => (s ? `*${s}*` : "");

function names(c: Citation): Name[] {
	return c.authors.map((a) => a.trim()).filter(Boolean).map((a) => splitName(a, !!c.group));
}
/** a video with no named person is credited to its channel (APA, Harvard and Chicago) */
function creditNames(c: Citation): Name[] {
	const ns = names(c);
	return !ns.length && c.kind === "video" && c.container.trim() ? [splitName(c.container, true)] : ns;
}

function dateParts(c: Citation) {
	const m = parseInt(c.month, 10), d = parseInt(c.day, 10);
	return { y: c.year.trim(), m: m >= 1 && m <= 12 ? m : 0, d: d >= 1 && d <= 31 ? d : 0 };
}

function accessedParts(c: Citation) {
	const [y, m, d] = (c.accessed || "").split("-").map((x) => parseInt(x, 10));
	return { y: y || 0, m: m || 0, d: d || 0 };
}

/** the reference, with *italics* in Markdown */
export function formatCitation(c: Citation, style: CiteStyle): string {
	switch (style) {
		case "apa": return apa(c);
		case "mla": return mla(c);
		case "harvard": return harvard(c);
		default: return chicago(c);
	}
}

// ---------- APA 7 ----------
function apaAuthors(ns: Name[]): string {
	const f = ns.map(lastInit);
	if (f.length <= 1) return f[0] ?? "";
	if (f.length === 2) return `${f[0]}, & ${f[1]}`;
	if (f.length <= 20) return `${f.slice(0, -1).join(", ")}, & ${f[f.length - 1]}`;
	return `${f.slice(0, 19).join(", ")}, . . . ${f[f.length - 1]}`;
}
function apa(c: Citation): string {
	const ns = names(c);
	const { y, m, d } = dateParts(c);
	const withDay = c.kind === "website" || c.kind === "video" || c.kind === "news";
	const date = `(${y || "n.d."}${withDay && y && m ? `, ${MONTHS[m - 1]}${d ? " " + d : ""}` : ""})`;
	const link = c.doi ? `https://doi.org/${c.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}` : c.url;
	let title: string, rest: string;
	switch (c.kind) {
		case "book":
			title = it(c.title) + (c.edition ? ` (${ordinal(c.edition)} ed.)` : "");
			rest = join([end(c.publisher), link]);
			break;
		case "journal":
			title = end(c.title);
			rest = join([`${it(c.container)}${c.volume ? `, ${it(c.volume)}` : ""}${c.issue ? `(${c.issue})` : ""}${c.pages ? `, ${c.pages}` : ""}.`, link]);
			break;
		case "news":
			title = end(c.title);
			rest = join([end(it(c.container)), link]);
			break;
		case "video":
			title = `${it(c.title)} [Video]`;
			rest = join([end(c.container ? "YouTube" : c.publisher || "YouTube"), link]);
			break;
		default:
			title = it(c.title);
			rest = join([c.container && !ns.some((n) => n.whole === c.container) ? end(c.container) : "", link]);
	}
	if (c.kind === "video" && c.container && !ns.length) return join([end(c.container), end(date), end(title), rest]);
	if (!ns.length) return join([end(title), end(date), rest]);
	return join([end(apaAuthors(ns)), end(date), end(title), rest]);
}

// ---------- MLA 9 ----------
function mlaAuthors(ns: Name[]): string {
	if (!ns.length) return "";
	if (ns.length === 1) return lastFirst(ns[0]);
	if (ns.length === 2) return `${lastFirst(ns[0])}, and ${firstLast(ns[1])}`;
	return `${lastFirst(ns[0])}, et al`;
}
function mlaDate(day: number, month: number, year: string | number) {
	return join([day ? String(day) : "", month ? MLA_MONTHS[month - 1] : "", year ? String(year) : ""]);
}
function mla(c: Citation): string {
	const ns = names(c);
	const { y, m, d } = dateParts(c);
	const a = accessedParts(c);
	const url = c.doi ? `https://doi.org/${c.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}` : c.url.replace(/^https?:\/\//, "");
	const accessed = c.kind === "website" && a.y ? `Accessed ${mlaDate(a.d, a.m, a.y)}.` : "";
	const author = end(mlaAuthors(ns));
	switch (c.kind) {
		case "book":
			return join([author, end(it(c.title)), c.edition ? end(`${ordinal(c.edition)} ed`) : "", end(join([c.publisher, y], ", "))]);
		case "journal":
			return join([author, `“${end(c.title)}”`, end(join([it(c.container), c.volume ? `vol. ${c.volume}` : "", c.issue ? `no. ${c.issue}` : "", y, c.pages ? `pp. ${c.pages}` : "", url], ", "))]);
		case "video":
			return join([author, end(it(c.title)), end(join(["YouTube", c.container && !ns.length ? `uploaded by ${c.container}` : "", mlaDate(d, m, y), url], ", "))]);
		case "news":
			return join([author, `“${end(c.title)}”`, end(join([it(c.container), mlaDate(d, m, y), url], ", "))]);
		default:
			return join([author, `“${end(c.title)}”`, end(join([it(c.container), c.publisher && c.publisher !== c.container ? c.publisher : "", mlaDate(d, m, y), url], ", ")), accessed]);
	}
}

// ---------- Harvard (Cite Them Right) ----------
function harvardAuthors(ns: Name[]): string {
	const f = ns.map((n) => (n.first.length ? `${n.last}, ${initials(n, false)}` : n.last));
	if (f.length <= 1) return f[0] ?? "";
	if (f.length <= 3) return `${f.slice(0, -1).join(", ")} and ${f[f.length - 1]}`;
	return `${f[0]} et al.`;
}
function harvard(c: Citation): string {
	const ns = creditNames(c);
	const { y, m, d } = dateParts(c);
	const a = accessedParts(c);
	const who = ns.length ? harvardAuthors(ns) : c.kind === "website" ? c.container : "";
	const yr = `(${y || "no date"})`;
	const accessed = c.url && a.y ? `(Accessed: ${a.d ? a.d + " " : ""}${a.m ? MONTHS[a.m - 1] + " " : ""}${a.y})` : "";
	const avail = c.url || c.doi ? join([`Available at: ${c.doi ? "https://doi.org/" + c.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "") : c.url}`, accessed]) + "." : "";
	const lead = who ? `${who} ${yr}` : `${it(c.title)} ${yr}`;
	switch (c.kind) {
		case "book":
			return join([lead, end(it(c.title)), c.edition ? end(`${ordinal(c.edition)} edn`) : "", end(join([c.place, c.publisher], ": ")), avail]);
		case "journal":
			return join([lead, `‘${c.title}’,`, end(join([it(c.container), `${c.volume}${c.issue ? `(${c.issue})` : ""}`, c.pages ? `pp. ${c.pages}` : ""], ", ")), avail]);
		case "news":
			return join([lead, `‘${c.title}’,`, end(join([it(c.container), join([d ? String(d) : "", m ? MONTHS[m - 1] : ""])], ", ")), avail]);
		case "video":
			return join([lead, end(`${it(c.title)} [Video]`), avail]);
		default:
			return join([lead, who ? end(it(c.title)) : "", avail]);
	}
}

// ---------- Chicago (bibliography) ----------
function chicagoAuthors(ns: Name[]): string {
	if (!ns.length) return "";
	if (ns.length === 1) return lastFirst(ns[0]);
	if (ns.length <= 10) return `${lastFirst(ns[0])}, ${ns.slice(1, -1).map(firstLast).map((x) => x + ", ").join("")}and ${firstLast(ns[ns.length - 1])}`;
	return `${ns.slice(0, 7).map((n, i) => (i ? firstLast(n) : lastFirst(n))).join(", ")}, et al`;
}
function chicago(c: Citation): string {
	const ns = creditNames(c);
	const { y, m, d } = dateParts(c);
	const author = end(chicagoAuthors(ns));
	const link = c.doi ? `https://doi.org/${c.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "")}` : c.url;
	const date = join([m ? MONTHS[m - 1] : "", d ? `${d},` : "", y]).replace(/,$/, "");
	switch (c.kind) {
		case "book":
			return join([author, end(it(c.title)), c.edition ? end(`${ordinal(c.edition)} ed`) : "", end(join([join([c.place, c.publisher], ": "), y], ", ")), link ? end(link) : ""]);
		case "journal":
			return join([author, `“${end(c.title)}”`, `${it(c.container)}${c.volume ? " " + c.volume : ""}${c.issue ? `, no. ${c.issue}` : ""} (${y})${c.pages ? `: ${c.pages}` : ""}.`, link ? end(link) : ""]);
		case "news":
			return join([author, `“${end(c.title)}”`, end(join([it(c.container), date], ", ")), link ? end(link) : ""]);
		case "video":
			return join([author, end(`${it(c.title)}`), end(join(["YouTube video", date], ", ")), link ? end(link) : ""]);
		default:
			return join([author, `“${end(c.title)}”`, c.container ? end(c.container) : "", date ? end(date) : "", link ? end(link) : ""]);
	}
}

/** (Smith, 2024) style, for the text of an essay */
export function inText(c: Citation, style: CiteStyle): string {
	const ns = style === "mla" ? names(c) : creditNames(c);
	const { y } = dateParts(c);
	const shortTitle = c.title.split(/[:.?!]/)[0].trim();
	if (style === "mla") {
		const who = !ns.length ? `“${shortTitle}”` : ns.length === 1 ? ns[0].last : ns.length === 2 ? `${ns[0].last} and ${ns[1].last}` : `${ns[0].last} et al.`;
		return `(${who})`;
	}
	if (style === "chicago") {
		const who = !ns.length ? `“${shortTitle}”` : ns.length === 1 ? ns[0].last : ns.length === 2 ? `${ns[0].last} and ${ns[1].last}` : ns.length === 3 ? `${ns[0].last}, ${ns[1].last}, and ${ns[2].last}` : `${ns[0].last} et al.`;
		return `(${who} ${y || "n.d."})`;
	}
	const and = style === "apa" ? "&" : "and";
	const who = !ns.length ? (style === "harvard" && c.kind === "website" && c.container ? c.container : `*${shortTitle}*`) : ns.length === 1 ? ns[0].last : ns.length === 2 ? `${ns[0].last} ${and} ${ns[1].last}` : style === "harvard" && ns.length === 3 ? `${ns[0].last}, ${ns[1].last} and ${ns[2].last}` : `${ns[0].last} et al.`;
	return `(${who}, ${y || (style === "apa" ? "n.d." : "no date")})`;
}

function ordinal(n: string): string {
	const v = parseInt(n, 10);
	if (!v) return n;
	const s = v % 100 >= 11 && v % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][v % 10] ?? "th";
	return `${v}${s}`;
}

/** Markdown *italics* to HTML, for pasting into Word, Google Docs or PowerPoint with the italics kept */
export function toHtml(md: string): string {
	const esc = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return esc.replace(/\*([^*]+)\*/g, "<i>$1</i>");
}
export const toPlain = (md: string) => md.replace(/\*([^*]+)\*/g, "$1");

export const sortKey = (s: string) => toPlain(s).replace(/^[“‘"']/, "").toLowerCase();
