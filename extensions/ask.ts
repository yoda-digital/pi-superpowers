/**
 * ask_user — put one question to the user as an interactive card.
 *
 * Superpowers skills ask open questions in plain chat; that stays the default.
 * This tool is for the moments a skill offers a short menu (brainstorming when
 * the user is stuck, finishing-a-development-branch's merge/PR/keep/discard).
 *
 * In Pi's terminal UI the question renders as a card where the editor is:
 * number keys answer instantly, arrows or j/k move, a recommended option is
 * preselected, "Something else" and notes are typed inline, and in fullscreen
 * mode options are clickable. RPC clients get Pi's native picker; without a
 * user attached the model is told to ask in its reply.
 *
 * Layout, keys and result text live in lib/ask-view.ts (tested without Pi).
 */

import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getSelectListTheme,
	type Theme,
	type ThemeBg,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Editor,
	type Focusable,
	getNativeClipboard,
	Key,
	type KeybindingsManager,
	matchesKey,
	Text,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type AskAction,
	type AskOutcome,
	type AskSpec,
	type AskState,
	type AskTheme,
	askResult,
	initialAskState,
	MAX_OPTIONS,
	MIN_BOXED_WIDTH,
	normalizeAskParams,
	previewText,
	reduceAsk,
	renderAsk,
	type TextKit,
} from "./lib/ask-view.ts";

const AskParams = Type.Object({
	question: Type.String({ description: "The question, one sentence" }),
	context: Type.Optional(Type.String({ description: "What the user needs to know to decide, in a sentence or two" })),
	options: Type.Array(
		Type.Union([Type.String(), Type.Object({ label: Type.String(), description: Type.Optional(Type.String()) })]),
		{ description: `2-${MAX_OPTIONS} short, distinct answers (a label, or {label, description})`, minItems: 2, maxItems: MAX_OPTIONS },
	),
	recommended: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_OPTIONS, description: "Number of the option you recommend" })),
	multiple: Type.Optional(Type.Boolean({ description: "Let the user pick several options" })),
});

const AskOutput = Type.Object({
	status: StringEnum(["answered", "dismissed"] as const),
	choices: Type.Array(Type.String()),
	custom: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
});

interface AskDetails {
	spec: AskSpec;
	outcome: AskOutcome;
}

const kit: TextKit = {
	width: visibleWidth,
	truncate: (text, width) => truncateToWidth(text, width),
	wrap: wrapTextWithAnsi,
};

const askTheme = (theme: Theme): AskTheme => ({
	fg: (token, text) => theme.fg(token as ThemeColor, text),
	bg: (token, text) => theme.bg(token as ThemeBg, text),
	bold: (text) => theme.bold(text),
});

/** The interactive card. One instance per question. */
class AskCard implements Component, Focusable {
	private state: AskState;
	private readonly editor: Editor;
	private rowAt: Array<number | undefined> = [];
	private finished = false;
	private _focused = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
		private readonly spec: AskSpec,
		private readonly done: (outcome: AskOutcome) => void,
	) {
		this.state = initialAskState(spec);
		this.editor = new Editor(tui, {
			borderColor: (s) => theme.fg("borderMuted", s),
			selectList: getSelectListTheme(),
		});
		this.editor.onSubmit = (text) => this.apply({ type: "submitText", text });
	}

	// The editor shows the text cursor only while it has focus; IME windows follow it.
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.editor.focused = value && this.state.mode !== "choose";
	}

	finish(outcome: AskOutcome): void {
		if (this.finished) return;
		this.finished = true;
		this.done(outcome);
	}

	private apply(action: AskAction): void {
		if (this.finished) return;
		const before = this.state.mode;
		const { state, outcome } = reduceAsk(this.spec, this.state, action);
		this.state = state;
		if (outcome) {
			this.finish(outcome);
			return;
		}
		if (state.mode !== before) {
			this.editor.setText("");
			this.editor.focused = this._focused && state.mode !== "choose";
		}
		this.tui.requestRender();
	}

	/**
	 * Pi's clipboard-paste key (ctrl+v; alt+v on Windows and WSL). Terminals whose own
	 * paste shortcut is ctrl+shift+v pass ctrl+v through to us, so read the clipboard the
	 * way Pi's editor does and hand it to the field as a bracketed paste. Without a
	 * native clipboard helper this does nothing, and the terminal's paste still works.
	 */
	private async pasteFromClipboard(): Promise<void> {
		try {
			const text = await getNativeClipboard()?.getText();
			if (!text || this.finished || this.state.mode === "choose") return;
			this.editor.handleInput(`\x1b[200~${text}\x1b[201~`);
			this.tui.requestRender();
		} catch {
			// Clipboard unavailable or denied: nothing to paste.
		}
	}

	handleInput(data: string): void {
		const isPaste = data.startsWith("\x1b[200~");
		const isClipboardKey = this.keybindings.matches(data, "app.clipboard.pasteImage");
		if (this.state.mode === "choose" && (isPaste || isClipboardKey)) {
			// Pasting while the list has focus answers in the "Something else" field.
			this.apply({ type: "paste" });
		}
		if (this.state.mode !== "choose") {
			if (isClipboardKey) void this.pasteFromClipboard();
			else if (!isPaste && matchesKey(data, Key.escape)) this.apply({ type: "cancel" });
			else {
				// Bracketed pastes keep their newlines and big ones collapse to a marker that
				// expands on submit; Enter submits through editor.onSubmit.
				this.editor.handleInput(data);
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, Key.up) || data === "k") this.apply({ type: "up" });
		else if (matchesKey(data, Key.down) || data === "j") this.apply({ type: "down" });
		else if (matchesKey(data, Key.home)) this.apply({ type: "first" });
		else if (matchesKey(data, Key.end)) this.apply({ type: "last" });
		else if (matchesKey(data, Key.enter)) this.apply({ type: "enter" });
		else if (matchesKey(data, Key.space)) this.apply({ type: "toggle" });
		else if (matchesKey(data, Key.tab)) this.apply({ type: "note" });
		else if (matchesKey(data, Key.escape)) this.apply({ type: "cancel" });
		else if (/^[1-9]$/.test(data)) this.apply({ type: "digit", n: Number(data) });
	}

	/** Fullscreen mode only (in regular mode the terminal owns the mouse): click picks, wheel moves, hover follows. */
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.state.mode !== "choose") return undefined;
		const row = this.rowAt[event.y];
		if (event.type === "wheel") {
			this.apply({ type: (event.wheelDelta ?? 0) < 0 ? "up" : "down" });
			return { handled: true };
		}
		if (row === undefined) return undefined;
		if (event.type === "click" && event.button === "left") {
			this.apply({ type: "click", row });
			return { handled: true };
		}
		if (event.type === "move" && row !== this.state.cursor) {
			this.apply({ type: "hover", row });
			return { handled: true };
		}
		return undefined;
	}

	render(width: number): string[] {
		const inner = width >= MIN_BOXED_WIDTH ? width - 4 : width;
		const editorLines = this.state.mode === "choose" ? [] : this.editor.render(Math.max(10, inner - 4));
		const frame = renderAsk(this.spec, this.state, width, askTheme(this.theme), kit, editorLines);
		this.rowAt = frame.rowAt;
		return frame.lines;
	}

	invalidate(): void {
		this.editor.invalidate();
	}
}

/** RPC clients: Pi's native picker, then a text input for "Something else". */
async function askWithDialogs(ctx: ExtensionContext, spec: AskSpec, signal?: AbortSignal): Promise<AskOutcome> {
	const OTHER = "Something else (type it)";
	const labels = spec.options.map((o, i) => `${i + 1}. ${o.label}${spec.recommended === i ? " (recommended)" : ""}`);
	const title = spec.multiple ? `${spec.question} (pick the most important one)` : spec.question;
	const picked = await ctx.ui.select(title, [...labels, OTHER], { signal });
	if (picked === undefined) return { kind: "dismissed" };
	const index = labels.indexOf(picked);
	if (index >= 0) return { kind: "chosen", indices: [index] };
	const typed = (await ctx.ui.input(spec.question, "Your answer", { signal }))?.trim();
	return typed ? { kind: "custom", text: typed } : { kind: "dismissed" };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user one question with a short menu of answers and wait for the reply. The user picks by number, arrows or click, can type their own answer, and can add a note. Mark the option you recommend. Use only for multiple-choice moments; ask open questions in your reply.",
		promptSnippet: "ask_user: put one multiple-choice question to the user and wait for the answer",
		parameters: AskParams,
		outputSchema: AskOutput,
		executionMode: "sequential",
		exposure: "model-only",
		annotations: { readOnlyHint: true, openWorldHint: false },

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const spec = normalizeAskParams(params);
			const reply = (outcome: AskOutcome, override?: string) => {
				const { text, structured } = askResult(spec, outcome);
				return {
					content: [{ type: "text" as const, text: override ?? text }],
					details: { spec, outcome } satisfies AskDetails,
					structuredContent: { ...structured },
					...(override ? { isError: true } : {}),
				};
			};

			if (spec.options.length < 2) return reply({ kind: "dismissed" }, "ask_user needs at least two non-empty options.");
			if (!ctx.hasUI) return reply({ kind: "dismissed" }, "No interactive user is attached. Ask the question in your reply instead.");
			if (ctx.mode !== "tui") return reply(await askWithDialogs(ctx, spec, signal));

			let card: AskCard | undefined;
			const onAbort = () => card?.finish({ kind: "dismissed" });
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				const outcome = await ctx.ui.custom<AskOutcome>((tui, theme, keybindings, done) => {
					card = new AskCard(tui, theme, keybindings, spec, done);
					return card;
				});
				return reply(outcome ?? { kind: "dismissed" });
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		},

		renderCall(args, theme, _context) {
			const question = typeof args.question === "string" ? args.question : "";
			return new Text(`${theme.fg("accent", theme.bold("? "))}${theme.fg("text", question)}`, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const d = result.details as AskDetails | undefined;
			if (!d?.outcome) {
				const t = result.content[0];
				return new Text(theme.fg("muted", t?.type === "text" ? t.text : ""), 0, 0);
			}
			const o = d.outcome;
			if (o.kind === "dismissed") return new Text(theme.fg("muted", "– dismissed"), 0, 0);
			// One line in the transcript, however long the answer; the model has the full text.
			const more = (n: number) => (n > 0 ? theme.fg("dim", ` (+${n} line${n === 1 ? "" : "s"})`) : "");
			if (o.kind === "custom") {
				const p = previewText(o.text);
				return new Text(`${theme.fg("success", "✓ ")}${theme.fg("accent", `"${p.line}"`)}${more(p.moreLines)}${theme.fg("dim", "  typed")}`, 0, 0);
			}
			const labels = o.indices.map((i) => d.spec.options[i]?.label ?? "?").join(theme.fg("dim", " · "));
			const n = o.note ? previewText(o.note) : undefined;
			const note = n ? `\n  ${theme.fg("muted", `note: ${n.line}`)}${more(n.moreLines)}` : "";
			return new Text(`${theme.fg("success", "✓ ")}${theme.fg("accent", theme.bold(labels))}${note}`, 0, 0);
		},
	});
}
