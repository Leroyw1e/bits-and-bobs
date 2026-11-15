import { formatResult } from "./autosolve";

/**
 * "5 km =" gives "3.107 miles"; "5 km to m =" gives "5000 m".
 * Each unit has a size relative to the base unit of its kind (metres, kilograms, litres, metres a second, seconds).
 */
interface Unit { kind: string; size: number; label: string; names: string[]; to: string }

const U: Unit[] = [
	// length
	{ kind: "length", size: 0.001, label: "mm", names: ["mm", "millimetre", "millimeter"], to: "in" },
	{ kind: "length", size: 0.01, label: "cm", names: ["cm", "centimetre", "centimeter"], to: "in" },
	{ kind: "length", size: 1, label: "m", names: ["m", "metre", "meter"], to: "ft" },
	{ kind: "length", size: 1000, label: "km", names: ["km", "kilometre", "kilometer"], to: "mi" },
	{ kind: "length", size: 0.0254, label: "inches", names: ["in", "inch", "inche", "\""], to: "cm" },
	{ kind: "length", size: 0.3048, label: "feet", names: ["ft", "foot", "feet"], to: "m" },
	{ kind: "length", size: 0.9144, label: "yards", names: ["yd", "yard"], to: "m" },
	{ kind: "length", size: 1609.344, label: "miles", names: ["mi", "mile"], to: "km" },
	// mass
	{ kind: "mass", size: 0.000001, label: "mg", names: ["mg", "milligram"], to: "g" },
	{ kind: "mass", size: 0.001, label: "g", names: ["g", "gram", "gramme"], to: "oz" },
	{ kind: "mass", size: 1, label: "kg", names: ["kg", "kilo", "kilogram", "kilogramme"], to: "lb" },
	{ kind: "mass", size: 1000, label: "tonnes", names: ["t", "tonne"], to: "kg" },
	{ kind: "mass", size: 0.45359237, label: "lb", names: ["lb", "lbs", "pound"], to: "kg" },
	{ kind: "mass", size: 0.028349523, label: "oz", names: ["oz", "ounce"], to: "g" },
	{ kind: "mass", size: 6.35029318, label: "stone", names: ["st", "stone"], to: "kg" },
	// volume
	{ kind: "volume", size: 0.001, label: "ml", names: ["ml", "millilitre", "milliliter"], to: "floz" },
	{ kind: "volume", size: 1, label: "L", names: ["l", "litre", "liter"], to: "gal" },
	{ kind: "volume", size: 3.785411784, label: "gallons", names: ["gal", "gallon"], to: "l" },
	{ kind: "volume", size: 0.946352946, label: "quarts", names: ["qt", "quart"], to: "l" },
	{ kind: "volume", size: 0.473176473, label: "pints", names: ["pt", "pint"], to: "ml" },
	{ kind: "volume", size: 0.0295735296, label: "fl oz", names: ["floz", "fl oz"], to: "ml" },
	{ kind: "volume", size: 0.2365882365, label: "cups", names: ["cup"], to: "ml" },
	{ kind: "volume", size: 0.01478676478, label: "tablespoons", names: ["tbsp", "tablespoon"], to: "ml" },
	{ kind: "volume", size: 0.00492892159, label: "teaspoons", names: ["tsp", "teaspoon"], to: "ml" },
	// speed
	{ kind: "speed", size: 1, label: "m/s", names: ["m/s", "mps"], to: "km/h" },
	{ kind: "speed", size: 1 / 3.6, label: "km/h", names: ["km/h", "kmh", "kph", "kmph"], to: "mph" },
	{ kind: "speed", size: 0.44704, label: "mph", names: ["mph"], to: "km/h" },
	{ kind: "speed", size: 0.514444, label: "knots", names: ["kn", "knot", "kt"], to: "km/h" },
	// time
	{ kind: "time", size: 1, label: "seconds", names: ["s", "sec", "second"], to: "min" },
	{ kind: "time", size: 60, label: "minutes", names: ["min", "minute"], to: "s" },
	{ kind: "time", size: 3600, label: "hours", names: ["h", "hr", "hour"], to: "min" },
	{ kind: "time", size: 86400, label: "days", names: ["day"], to: "h" },
	{ kind: "time", size: 604800, label: "weeks", names: ["wk", "week"], to: "day" },
	// temperature (handled separately)
	{ kind: "temp", size: 1, label: "°C", names: ["c", "°c", "celsius"], to: "f" },
	{ kind: "temp", size: 1, label: "°F", names: ["f", "°f", "fahrenheit"], to: "c" },
	{ kind: "temp", size: 1, label: "K", names: ["k", "kelvin"], to: "c" },
];

const find = (raw: string): Unit | null => {
	let n = raw.toLowerCase().replace(/\.$/, "");
	if (n === "°") return null;
	for (const cand of [n, n.endsWith("es") ? n.slice(0, -2) : "", n.endsWith("s") ? n.slice(0, -1) : ""]) {
		if (!cand) continue;
		const u = U.find((x) => x.names.includes(cand));
		if (u) return u;
	}
	return null;
};

const toBase = (u: Unit, v: number) => (u.kind !== "temp" ? v * u.size : u.label === "°C" ? v : u.label === "°F" ? ((v - 32) * 5) / 9 : v - 273.15); // temperature base is °C
const fromBase = (u: Unit, v: number) => (u.kind !== "temp" ? v / u.size : u.label === "°C" ? v : u.label === "°F" ? (v * 9) / 5 + 32 : v + 273.15);

const NAME = "[A-Za-z°][A-Za-z°/\"]*(?: oz)?";
const RE = new RegExp(`(?:^|[\\s(:;=])(-?\\d+(?:\\.\\d+)?)\\s*(${NAME})(?:\\s+(?:to|in|into|as)\\s+(${NAME}))?\\s*$`);

/** `before` ends where "=" was just typed. Returns e.g. "3.107 miles", or null if it isn't a conversion. */
export function convertUnits(before: string): string | null {
	const m = RE.exec(before.replace(/\s+$/, ""));
	if (!m) return null;
	const from = find(m[2]);
	if (!from) return null;
	const to = m[3] ? find(m[3]) : U.find((x) => x.names.includes(from.to)) ?? null;
	if (!to || to.kind !== from.kind || to === from) return null;
	const v = fromBase(to, toBase(from, parseFloat(m[1])));
	if (!Number.isFinite(v)) return null;
	return `${formatResult(+v.toPrecision(5))} ${to.label}`;
}
