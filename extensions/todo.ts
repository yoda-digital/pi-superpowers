/**
 * Todo Extension — task management via session-entry state reconstruction
 *
 * Actions: list, add, toggle, remove, rename, in_progress, clear
 *
 * State lives in tool-result details (not external files). When the session
 * branches, the todo state is automatically correct for that point in history
 * because it is reconstructed by replaying every `todo` tool result in order.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	ACTIONS,
	applyTodoAction,
	buildTodoRecap,
	EMPTY_TODO_STATE,
	PRIORITIES,
	type Priority,
	reconstructTodoState,
	summarizeTodos,
	type Todo,
	type TodoDetails,
	type TodoState,
} from "./lib/todo-state.ts";

// ---------------------------------------------------------------------------
// Tool parameter schema (erasable — no `enum`, uses StringEnum)
// ---------------------------------------------------------------------------

const TodoParams = Type.Object({
	action: StringEnum(ACTIONS),
	text: Type.Optional(Type.String({ description: "Todo text (for add / rename)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle / remove / rename / in_progress)" })),
	priority: Type.Optional(StringEnum(PRIORITIES, { description: "Priority level (for add; defaults to medium)" })),
});

/** What codemode scripts receive instead of the text: the list after the action. */
const TodoOutput = Type.Object({
	todos: Type.Array(
		Type.Object({
			id: Type.Number(),
			text: Type.String(),
			done: Type.Boolean(),
			inProgress: Type.Boolean(),
			priority: StringEnum(PRIORITIES),
		}),
	),
	error: Type.Optional(Type.String()),
});

// ---------------------------------------------------------------------------
// Priority display helpers
// ---------------------------------------------------------------------------

function priorityIndicator(p: Priority, theme: Theme): string {
	switch (p) {
		case "high":
			return theme.fg("error", "!!!");
		case "medium":
			return theme.fg("warning", "!!");
		case "low":
			return theme.fg("dim", "!");
	}
}

// ---------------------------------------------------------------------------
// Status display helpers
// ---------------------------------------------------------------------------

function statusIndicator(todo: Todo, theme: Theme): string {
	if (todo.done) return theme.fg("success", "✓");
	if (todo.inProgress) return theme.fg("warning", "◐");
	return theme.fg("dim", "○");
}

// ---------------------------------------------------------------------------
// TUI component for /todos
// ---------------------------------------------------------------------------

class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) +
			title +
			th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const { done, inProgress, total } = summarizeTodos(this.todos);

			let summary = `${done}/${total} completed`;
			if (inProgress > 0) summary += `, ${inProgress} in progress`;
			lines.push(truncateToWidth(`  ${th.fg("muted", summary)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const check = statusIndicator(todo, th);
				const id = th.fg("accent", `#${todo.id}`);
				const pri = priorityIndicator(todo.priority, th);
				const text = todo.done ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${pri} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let state: TodoState = EMPTY_TODO_STATE;

	/** Rebuild state from the `todo` tool-result snapshots on the current branch. */
	const reconstructState = (ctx: ExtensionContext) => {
		state = reconstructTodoState(ctx.sessionManager.getBranch());
	};

	// ── pi-statusbar integration ─────────────────────────────────────
	// Register a native statusbar segment so pi-statusbar can display
	// todo progress without needing its adapter fallback.

	const registerStatusbarSegments = () => {
		pi.events.emit("pi-statusbar:register", {
			pluginId: "pi-superpowers",
			segments: [
				{
					id: "superpowers:todo",
					position: "left" as const,
					priority: 45,
					render: (theme: { fg(color: string, text: string): string }) => {
						if (state.todos.length === 0) return null;

						const { done, inProgress, pending, total } = summarizeTodos(state.todos);
						const parts: string[] = [theme.fg("accent", "TODO")];

						if (done > 0) parts.push(theme.fg("success", `${done}✓`));
						if (inProgress > 0) parts.push(theme.fg("warning", `${inProgress}◐`));
						if (pending > 0) parts.push(theme.fg("dim", `${pending}○`));
						parts.push(theme.fg("muted", `${done}/${total}`));

						return parts.join(" ");
					},
				},
			],
		});
	};

	// When pi-statusbar announces it's ready, register our segments.
	let statusbarPresent = false;
	pi.events.on("pi-statusbar:ready", () => {
		statusbarPresent = true;
		registerStatusbarSegments();
	});

	/**
	 * Show progress: through pi-statusbar when it is installed, otherwise in
	 * Pi's own footer status line.
	 */
	const showProgress = (ctx: ExtensionContext) => {
		pi.events.emit("pi-statusbar:update", { pluginId: "pi-superpowers" });
		if (statusbarPresent || !ctx.hasUI) return;
		if (state.todos.length === 0) {
			ctx.ui.setStatus("superpowers-todo", undefined);
			return;
		}
		const { done, inProgress, total } = summarizeTodos(state.todos);
		const current = state.todos.find((t) => t.inProgress && !t.done);
		const label = `todo ${done}/${total}${inProgress > 0 ? ` ◐${inProgress}` : ""}${current ? ` · ${current.text}` : ""}`;
		ctx.ui.setStatus("superpowers-todo", ctx.ui.theme.fg("muted", label));
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		// Re-register in case statusbar was already ready before us.
		registerStatusbarSegments();
		showProgress(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		showProgress(ctx);
	});

	// Compaction summarizes the todo tool results away. The list is the plan the
	// model is executing, so put the open items back in context. A custom message
	// is appended (queued to the end of the turn when a run is active): the
	// compacted prefix stays untouched, so the prompt cache rebuilds once.
	pi.on("session_compact", async (_event, ctx) => {
		reconstructState(ctx);
		const recap = buildTodoRecap(state.todos);
		if (recap) pi.sendMessage({ customType: "superpowers-todo-recap", content: recap, display: true });
	});

	// -------------------------------------------------------------------
	// Tool registration
	// -------------------------------------------------------------------

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list. Actions: list, add (text, priority?), toggle (id), " +
			"remove (id), rename (id, text), in_progress (id), clear",
		promptSnippet: "todo: track the steps of multi-step work (add, in_progress, toggle when done, list)",
		parameters: TodoParams,
		outputSchema: TodoOutput,
		// Calls share the in-memory list: run them in order.
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = applyTodoAction(state, params);
			state = result.state;
			if (params.action !== "list") showProgress(ctx);
			return {
				content: [{ type: "text", text: result.text }],
				details: result.details,
				structuredContent: {
					todos: result.state.todos.map(({ id, text, done, inProgress, priority }) => ({ id, text, done, inProgress, priority })),
					...(result.details.error ? { error: result.details.error } : {}),
				},
			};
		},

		// -----------------------------------------------------------------
		// Render: tool-call header in the conversation timeline
		// -----------------------------------------------------------------

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.priority) text += ` ${theme.fg("warning", args.priority)}`;
			return new Text(text, 0, 0);
		},

		// -----------------------------------------------------------------
		// Render: tool-result body in the conversation timeline
		// -----------------------------------------------------------------

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const todoList = details.todos;

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const check = statusIndicator(t, theme);
						const pri = priorityIndicator(t.priority, theme);
						const itemText = t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${check} ${theme.fg("accent", `#${t.id}`)} ${pri} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							priorityIndicator(added.priority, theme) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}

				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "remove": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "rename": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "in_progress": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("warning", "◐ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});

	// -------------------------------------------------------------------
	// /todos command
	// -------------------------------------------------------------------

	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(state.todos, theme, () => done());
			});
		},
	});
}
