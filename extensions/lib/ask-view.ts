/**
 * The ask_user card: state machine, rendering and result text.
 *
 * No runtime imports from Pi: terminal-width helpers and theme colors are
 * passed in (Pi's visibleWidth / truncateToWidth / wrapTextWithAnsi and the
 * active theme in extensions/ask.ts; plain stand-ins in the tests), so the
 * tests exercise this exact code.
 */

export interface AskOption {
	label: string;
	description?: string;
}

export interface AskSpec {
	question: string;
	/** What the user needs to know to decide, shown under the question. */
	context?: string;
	options: AskOption[];
	/** 0-based index of the option the model recommends; the cursor starts there. */
	recommended?: number;
	/** Pick any number of options instead of one. */
	multiple: boolean;
}

/** "choose": moving through rows; "other": typing a free answer; "note": typing a note for the pick. */
export type AskMode = "choose" | "other" | "note";

export interface AskState {
	/** Row under the cursor; options.length is the "Something else" row. */
	cursor: number;
	/** Checked option indices (multiple mode), ascending. */
	checked: number[];
	mode: AskMode;
}

export type AskAction =
	| { type: "up" }
	| { type: "down" }
	| { type: "first" }
	| { type: "last" }
	| { type: "digit"; n: number }
	| { type: "toggle" }
	| { type: "enter" }
	| { type: "note" }
	| { type: "cancel" }
	| { type: "hover"; row: number }
	| { type: "click"; row: number }
	/** Pasted text arrived while the list had focus: answer with it in the "Something else" field. */
	| { type: "paste" }
	| { type: "submitText"; text: string };

export type AskOutcome =
	| { kind: "chosen"; indices: number[]; note?: string }
	| { kind: "custom"; text: string }
	| { kind: "dismissed" };

export const MAX_OPTIONS = 9;

export function initialAskState(spec: AskSpec): AskState {
	const rec = spec.recommended;
	return { cursor: rec !== undefined && rec >= 0 && rec < spec.options.length ? rec : 0, checked: [], mode: "choose" };
}

const toggled = (checked: number[], i: number) =>
	checked.includes(i) ? checked.filter((c) => c !== i) : [...checked, i].sort((a, b) => a - b);

/** One keyboard or mouse step. Returns the next state and, when the interaction is over, its outcome. */
export function reduceAsk(spec: AskSpec, state: AskState, action: AskAction): { state: AskState; outcome?: AskOutcome } {
	const rows = spec.options.length + 1;
	const otherRow = spec.options.length;
	const s = { ...state };
	const choose = (): AskOutcome => ({
		kind: "chosen",
		indices: spec.multiple && s.checked.length > 0 ? [...s.checked] : [s.cursor],
	});

	if (s.mode !== "choose") {
		if (action.type === "cancel") return { state: { ...s, mode: "choose" } };
		if (action.type === "submitText") {
			const text = action.text.trim();
			if (s.mode === "other") return text ? { state: s, outcome: { kind: "custom", text } } : { state: { ...s, mode: "choose" } };
			const outcome = choose() as Extract<AskOutcome, { kind: "chosen" }>;
			return { state: s, outcome: text ? { ...outcome, note: text } : outcome };
		}
		return { state: s }; // keys belong to the editor while it is open
	}

	switch (action.type) {
		case "up":
			return { state: { ...s, cursor: (s.cursor - 1 + rows) % rows } };
		case "down":
			return { state: { ...s, cursor: (s.cursor + 1) % rows } };
		case "first":
			return { state: { ...s, cursor: 0 } };
		case "last":
			return { state: { ...s, cursor: otherRow } };
		case "hover":
			return action.row >= 0 && action.row < rows ? { state: { ...s, cursor: action.row } } : { state: s };
		case "digit": {
			const i = action.n - 1;
			if (i < 0 || i >= spec.options.length) return { state: s };
			if (spec.multiple) return { state: { ...s, cursor: i, checked: toggled(s.checked, i) } };
			return { state: { ...s, cursor: i }, outcome: { kind: "chosen", indices: [i] } };
		}
		case "toggle":
			if (s.cursor === otherRow) return { state: { ...s, mode: "other" } };
			if (spec.multiple) return { state: { ...s, checked: toggled(s.checked, s.cursor) } };
			return { state: s, outcome: choose() };
		case "click":
			if (action.row < 0 || action.row >= rows) return { state: s };
			return reduceAsk(spec, { ...s, cursor: action.row }, { type: spec.multiple ? "toggle" : "enter" });
		case "enter":
			if (s.cursor === otherRow) return { state: { ...s, mode: "other" } };
			return { state: s, outcome: choose() };
		case "note":
			if (s.cursor === otherRow && !(spec.multiple && s.checked.length > 0)) return { state: { ...s, mode: "other" } };
			return { state: { ...s, mode: "note" } };
		case "cancel":
			return { state: s, outcome: { kind: "dismissed" } };
		case "paste":
			return { state: { ...s, cursor: otherRow, mode: "other" } };
		case "submitText":
			return { state: s };
	}
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export interface AskStructured {
	status: "answered" | "dismissed";
	/** Labels of the chosen options. */
	choices: string[];
	/** The user's own answer, when they typed one instead of choosing. */
	custom?: string;
	/** A note the user attached to their choice. */
	note?: string;
}

export function askResult(spec: AskSpec, outcome: AskOutcome): { text: string; structured: AskStructured } {
	switch (outcome.kind) {
		case "dismissed":
			return {
				text: "The user dismissed the question without answering. If you still need the answer, ask in your reply.",
				structured: { status: "dismissed", choices: [] },
			};
		case "custom":
			return {
				text: `The user answered in their own words: ${outcome.text}`,
				structured: { status: "answered", choices: [], custom: outcome.text },
			};
		case "chosen": {
			const choices = outcome.indices.map((i) => spec.options[i]?.label).filter((l): l is string => Boolean(l));
			const list = choices.map((c) => `"${c}"`).join(", ");
			const note = outcome.note ? ` Their note: ${outcome.note}` : "";
			return {
				text: `The user chose ${list}.${note}`,
				structured: { status: "answered", choices, ...(outcome.note ? { note: outcome.note } : {}) },
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Theme colors by Pi token name (accent, muted, dim, text, borderAccent, success, selectedBg, …). */
export interface AskTheme {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
	bold(text: string): string;
}

/** ANSI-aware width helpers (Pi's visibleWidth, truncateToWidth, wrapTextWithAnsi). */
export interface TextKit {
	width(text: string): number;
	truncate(text: string, width: number): string;
	wrap(text: string, width: number): string[];
}

export interface AskFrame {
	lines: string[];
	/** Option row shown on each line (for mouse hit-testing); undefined for chrome. */
	rowAt: Array<number | undefined>;
}

/** Narrower than this, the card drops its border and renders as plain lines. */
export const MIN_BOXED_WIDTH = 32;

export function keyHints(spec: AskSpec, state: AskState): string {
	if (state.mode === "other") return "⏎ send · ctrl+j new line · esc back";
	if (state.mode === "note") return "⏎ send with note · ctrl+j new line · esc back";
	const n = spec.options.length;
	const digits = n === 1 ? "1" : `1-${n}`;
	return spec.multiple
		? `↑↓ move · space/${digits} toggle · ⏎ submit · tab note · esc skip`
		: `↑↓ move · ${digits} pick · ⏎ choose · tab note · esc skip`;
}

/**
 * Draw the card for `width` columns. `editorLines` are the rendered text field
 * (Pi's Editor) while the user types an answer or a note.
 */
export function renderAsk(
	spec: AskSpec,
	state: AskState,
	width: number,
	theme: AskTheme,
	kit: TextKit,
	editorLines: string[] = [],
): AskFrame {
	const boxed = width >= MIN_BOXED_WIDTH;
	const inner = Math.max(1, boxed ? width - 4 : width);
	const lines: string[] = [];
	const rowAt: Array<number | undefined> = [];
	const border = (s: string) => theme.fg("borderAccent", s);
	const pad = (s: string) => {
		const fitted = kit.width(s) > inner ? kit.truncate(s, inner) : s;
		return fitted + " ".repeat(Math.max(0, inner - kit.width(fitted)));
	};
	const push = (content: string, row?: number, highlight = false) => {
		const body = pad(content);
		if (!boxed) lines.push(highlight ? theme.bg("selectedBg", body) : body);
		else if (highlight) lines.push(`${border("│")}${theme.bg("selectedBg", ` ${body} `)}${border("│")}`);
		else lines.push(`${border("│")} ${body} ${border("│")}`);
		rowAt.push(row);
	};
	const pushWrapped = (text: string, style: (s: string) => string, indent = 0, row?: number, highlight = false) => {
		for (const part of kit.wrap(text, Math.max(1, inner - indent))) push(" ".repeat(indent) + style(part), row, highlight);
	};

	// Header
	const title = spec.multiple ? "Pick any that apply" : "Question";
	if (boxed) {
		const label = ` ${theme.fg("accent", theme.bold("?"))} ${theme.bold(title)} `;
		const fill = Math.max(0, width - 3 - kit.width(label));
		lines.push(`${border("╭─")}${label}${border(`${"─".repeat(fill)}╮`)}`);
	} else {
		lines.push(theme.fg("accent", theme.bold(`? ${title}`)));
	}
	rowAt.push(undefined);

	pushWrapped(spec.question, (s) => theme.bold(s));
	if (spec.context) pushWrapped(spec.context, (s) => theme.fg("muted", s));
	push("");

	// Options
	const showEditorAfter = (row: number) =>
		state.mode !== "choose" && editorLines.length > 0 && row === (state.mode === "other" ? spec.options.length : state.cursor);
	const optionCount = spec.options.length;
	for (let row = 0; row <= optionCount; row++) {
		const isOther = row === optionCount;
		const selected = row === state.cursor && state.mode === "choose";
		const active = row === state.cursor;
		const bar = selected ? theme.fg("accent", "▌") : " ";
		const key = isOther ? "✎" : String(row + 1);
		const keyStyled = active ? theme.fg("accent", theme.bold(key)) : theme.fg("dim", key);
		const box = spec.multiple && !isOther ? (state.checked.includes(row) ? `${theme.fg("success", "●")} ` : `${theme.fg("dim", "○")} `) : "";
		const labelText = isOther ? "Something else…" : spec.options[row].label;
		const label = active ? theme.bold(labelText) : isOther ? theme.fg("muted", labelText) : labelText;
		let line = `${bar}${keyStyled}  ${box}${label}`;

		if (!isOther && spec.recommended === row) {
			const badge = theme.fg("success", "★ recommended");
			const short = theme.fg("success", "★");
			const room = inner - kit.width(line);
			if (room >= kit.width(badge) + 2) line += " ".repeat(room - kit.width(badge)) + badge;
			else if (room >= 2) line += ` ${short}`;
		}
		push(line, row, selected);

		const description = isOther ? undefined : spec.options[row].description;
		if (description) {
			const indent = 4 + (spec.multiple ? 2 : 0);
			pushWrapped(description, (s) => theme.fg(active ? "text" : "muted", s), indent, row, selected);
		}
		if (showEditorAfter(row)) {
			const prompt = state.mode === "other" ? "Your answer" : "Note for your pick";
			push(`    ${theme.fg("accent", prompt)}`);
			for (const e of editorLines) push(`    ${e}`);
		}
	}

	push("");
	pushWrapped(keyHints(spec, state), (s) => theme.fg("dim", s));

	if (boxed) {
		lines.push(border(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
		rowAt.push(undefined);
	}
	return { lines, rowAt };
}

/**
 * One line for the transcript chip: the first non-empty line, capped, and how
 * many lines were left out. The model always gets the full text.
 */
export function previewText(text: string, maxChars = 80): { line: string; moreLines: number } {
	const lines = text.split("\n");
	const first = lines.find((l) => l.trim()) ?? "";
	const line = first.length > maxChars ? `${first.slice(0, maxChars - 1)}…` : first;
	return { line, moreLines: Math.max(0, lines.filter((l) => l.trim()).length - 1) };
}

/** Normalize the tool's arguments: string or {label, description} options, 1-based recommended. */
export function normalizeAskParams(params: {
	question: string;
	context?: string;
	options: Array<string | { label: string; description?: string }>;
	recommended?: number;
	multiple?: boolean;
}): AskSpec {
	const options = params.options
		.slice(0, MAX_OPTIONS)
		.map((o) => (typeof o === "string" ? { label: o } : { label: o.label, ...(o.description ? { description: o.description } : {}) }))
		.filter((o) => o.label.trim().length > 0);
	const rec = params.recommended !== undefined ? params.recommended - 1 : undefined;
	return {
		question: params.question,
		...(params.context?.trim() ? { context: params.context.trim() } : {}),
		options,
		...(rec !== undefined && rec >= 0 && rec < options.length ? { recommended: rec } : {}),
		multiple: params.multiple === true,
	};
}
