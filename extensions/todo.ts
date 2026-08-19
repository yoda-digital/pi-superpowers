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

// ---------------------------------------------------------------------------
// State model
// ---------------------------------------------------------------------------

const ACTIONS = ["list", "add", "toggle", "remove", "rename", "in_progress", "clear"] as const;
const PRIORITIES = ["low", "medium", "high"] as const;

type Action = (typeof ACTIONS)[number];
type Priority = (typeof PRIORITIES)[number];

interface Todo {
	id: number;
	text: string;
	done: boolean;
	inProgress: boolean;
	priority: Priority;
	createdAt: number;
}

interface TodoDetails {
	action: Action;
	todos: Todo[];
	nextId: number;
	error?: string;
}

// ---------------------------------------------------------------------------
// Tool parameter schema (erasable — no `enum`, uses StringEnum)
// ---------------------------------------------------------------------------

const TodoParams = Type.Object({
	action: StringEnum(ACTIONS),
	text: Type.Optional(Type.String({ description: "Todo text (for add / rename)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle / remove / rename / in_progress)" })),
	priority: Type.Optional(StringEnum(PRIORITIES, { description: "Priority level (for add; defaults to medium)" })),
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

function priorityLabel(p: Priority): string {
	switch (p) {
		case "high":
			return "[!!!]";
		case "medium":
			return "[!!]";
		case "low":
			return "[!]";
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

function statusPlaintext(todo: Todo): string {
	if (todo.done) return "x";
	if (todo.inProgress) return "~";
	return " ";
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
			const done = this.todos.filter((t) => t.done).length;
			const inProg = this.todos.filter((t) => t.inProgress && !t.done).length;
			const total = this.todos.length;

			let summary = `${done}/${total} completed`;
			if (inProg > 0) summary += `, ${inProg} in progress`;
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
	let todos: Todo[] = [];
	let nextId = 1;

	/**
	 * Reconstruct state by replaying every `todo` tool result in the current
	 * branch. Each result carries a full snapshot, so the last one wins.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	// -------------------------------------------------------------------
	// Tool registration
	// -------------------------------------------------------------------

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list. Actions: list, add (text, priority?), toggle (id), " +
			"remove (id), rename (id, text), in_progress (id), clear",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			switch (params.action) {
				// ---- list -------------------------------------------------------
				case "list":
					return {
						content: [
							{
								type: "text",
								text: todos.length
									? todos
											.map(
												(t) =>
													`[${statusPlaintext(t)}] #${t.id} ${priorityLabel(t.priority)}: ${t.text}`,
											)
											.join("\n")
									: "No todos",
							},
						],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				// ---- add --------------------------------------------------------
				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: {
								action: "add",
								todos: [...todos],
								nextId,
								error: "text required",
							} as TodoDetails,
						};
					}
					const priority: Priority = params.priority ?? "medium";
					const newTodo: Todo = {
						id: nextId++,
						text: params.text,
						done: false,
						inProgress: false,
						priority,
						createdAt: Date.now(),
					};
					todos.push(newTodo);
					return {
						content: [
							{
								type: "text",
								text: `Added todo #${newTodo.id} ${priorityLabel(priority)}: ${newTodo.text}`,
							},
						],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				// ---- toggle -----------------------------------------------------
				case "toggle": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for toggle" }],
							details: {
								action: "toggle",
								todos: [...todos],
								nextId,
								error: "id required",
							} as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "toggle",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					todo.done = !todo.done;
					if (todo.done) todo.inProgress = false;
					return {
						content: [
							{
								type: "text",
								text: `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}`,
							},
						],
						details: { action: "toggle", todos: [...todos], nextId } as TodoDetails,
					};
				}

				// ---- remove -----------------------------------------------------
				case "remove": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for remove" }],
							details: {
								action: "remove",
								todos: [...todos],
								nextId,
								error: "id required",
							} as TodoDetails,
						};
					}
					const idx = todos.findIndex((t) => t.id === params.id);
					if (idx === -1) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "remove",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					const removed = todos.splice(idx, 1)[0];
					return {
						content: [
							{
								type: "text",
								text: `Removed todo #${removed.id}: ${removed.text}`,
							},
						],
						details: { action: "remove", todos: [...todos], nextId } as TodoDetails,
					};
				}

				// ---- rename -----------------------------------------------------
				case "rename": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for rename" }],
							details: {
								action: "rename",
								todos: [...todos],
								nextId,
								error: "id required",
							} as TodoDetails,
						};
					}
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for rename" }],
							details: {
								action: "rename",
								todos: [...todos],
								nextId,
								error: "text required",
							} as TodoDetails,
						};
					}
					const target = todos.find((t) => t.id === params.id);
					if (!target) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "rename",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					const oldText = target.text;
					target.text = params.text;
					return {
						content: [
							{
								type: "text",
								text: `Renamed todo #${target.id}: "${oldText}" -> "${target.text}"`,
							},
						],
						details: { action: "rename", todos: [...todos], nextId } as TodoDetails,
					};
				}

				// ---- in_progress ------------------------------------------------
				case "in_progress": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for in_progress" }],
							details: {
								action: "in_progress",
								todos: [...todos],
								nextId,
								error: "id required",
							} as TodoDetails,
						};
					}
					const wip = todos.find((t) => t.id === params.id);
					if (!wip) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "in_progress",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					if (wip.done) {
						return {
							content: [
								{
									type: "text",
									text: `Todo #${wip.id} is already completed`,
								},
							],
							details: {
								action: "in_progress",
								todos: [...todos],
								nextId,
								error: `#${wip.id} already completed`,
							} as TodoDetails,
						};
					}
					wip.inProgress = !wip.inProgress;
					return {
						content: [
							{
								type: "text",
								text: `Todo #${wip.id} ${wip.inProgress ? "started" : "paused"}`,
							},
						],
						details: { action: "in_progress", todos: [...todos], nextId } as TodoDetails,
					};
				}

				// ---- clear ------------------------------------------------------
				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				// ---- fallback ---------------------------------------------------
				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
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
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
