/**
 * ask_user — let the model put a multiple-choice question to the user.
 *
 * Superpowers skills ask questions in plain chat; that stays the default. This
 * tool is for the moments a skill offers a short menu of options (brainstorming
 * when the user is stuck, finishing-a-development-branch's merge/PR/keep/discard
 * choice): the user picks with the arrow keys, or types their own answer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const OTHER = "Something else (type it)";

interface AskDetails {
	question: string;
	options: string[];
	answer: string | null;
	custom?: boolean;
}

const AskParams = Type.Object({
	question: Type.String({ description: "The question, one sentence" }),
	options: Type.Array(Type.String(), {
		description: "2-6 short, mutually exclusive answers. The user can always type their own instead.",
		minItems: 2,
		maxItems: 6,
	}),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user",
		label: "Ask user",
		description:
			"Ask the user one multiple-choice question and wait for the answer. The user picks an option or types their own. Use only for a short menu of options; ask open questions in your reply instead.",
		promptSnippet: "ask_user: put one multiple-choice question to the user and wait for the answer",
		parameters: AskParams,
		executionMode: "sequential",
		exposure: "model-only",
		annotations: { readOnlyHint: true, openWorldHint: false },

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details: AskDetails = { question: params.question, options: params.options, answer: null };
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "No interactive user is attached. Ask the question in your reply instead." }],
					details,
					isError: true,
				};
			}

			const picked = await ctx.ui.select(params.question, [...params.options, OTHER], { signal });
			if (picked === undefined) {
				return { content: [{ type: "text", text: "The user dismissed the question without answering." }], details };
			}
			if (picked !== OTHER) {
				return { content: [{ type: "text", text: `The user answered: ${picked}` }], details: { ...details, answer: picked } };
			}
			const typed = (await ctx.ui.input(params.question, "Your answer", { signal }))?.trim();
			if (!typed) return { content: [{ type: "text", text: "The user dismissed the question without answering." }], details };
			return {
				content: [{ type: "text", text: `The user answered in their own words: ${typed}` }],
				details: { ...details, answer: typed, custom: true },
			};
		},

		renderCall(args, theme, _context) {
			return new Text(theme.fg("toolTitle", theme.bold("ask_user ")) + theme.fg("dim", args.question ?? ""), 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const d = result.details as AskDetails | undefined;
			if (!d || d.answer === null) {
				const text = result.content[0];
				return new Text(theme.fg("muted", text?.type === "text" ? text.text : "(no answer)"), 0, 0);
			}
			return new Text(`${theme.fg("success", "→ ")}${theme.fg("accent", d.answer)}${d.custom ? theme.fg("dim", " (typed)") : ""}`, 0, 0);
		},
	});
}
