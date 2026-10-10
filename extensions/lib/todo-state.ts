/**
 * Pure todo state machine.
 *
 * Every action returns a new state; inputs are never mutated. This matters
 * because each tool result stores a snapshot in `details`, and the extension
 * rebuilds state on branch switches by replaying those snapshots — a shared,
 * mutated object would silently rewrite history.
 *
 * No runtime imports from Pi, so the tests exercise this exact code.
 */

export const ACTIONS = ["list", "add", "toggle", "remove", "rename", "in_progress", "clear"] as const;
export const PRIORITIES = ["low", "medium", "high"] as const;

export type Action = (typeof ACTIONS)[number];
export type Priority = (typeof PRIORITIES)[number];

export interface Todo {
	id: number;
	text: string;
	done: boolean;
	inProgress: boolean;
	priority: Priority;
	createdAt: number;
}

export interface TodoState {
	todos: Todo[];
	nextId: number;
}

export interface TodoDetails extends TodoState {
	action: Action;
	error?: string;
}

export interface TodoActionParams {
	action: string;
	text?: string;
	id?: number;
	priority?: Priority;
}

export interface TodoActionResult {
	state: TodoState;
	/** Text returned to the model as the tool result content. */
	text: string;
	/** Snapshot stored on the tool result; used to rebuild state on branch switches. */
	details: TodoDetails;
}

export const EMPTY_TODO_STATE: TodoState = Object.freeze({ todos: [], nextId: 1 }) as TodoState;

export function priorityLabel(p: Priority): string {
	switch (p) {
		case "high":
			return "[!!!]";
		case "medium":
			return "[!!]";
		case "low":
			return "[!]";
	}
}

export function statusPlaintext(todo: Todo): string {
	if (todo.done) return "x";
	if (todo.inProgress) return "~";
	return " ";
}

export function formatTodoList(todos: Todo[]): string {
	if (todos.length === 0) return "No todos";
	return todos.map((t) => `[${statusPlaintext(t)}] #${t.id} ${priorityLabel(t.priority)}: ${t.text}`).join("\n");
}

export function summarizeTodos(todos: Todo[]): { done: number; inProgress: number; pending: number; total: number } {
	const done = todos.filter((t) => t.done).length;
	const inProgress = todos.filter((t) => t.inProgress && !t.done).length;
	return { done, inProgress, pending: todos.length - done - inProgress, total: todos.length };
}

function ok(action: Action, state: TodoState, text: string): TodoActionResult {
	return { state, text, details: { action, todos: state.todos, nextId: state.nextId } };
}

function fail(action: Action, state: TodoState, text: string, error: string): TodoActionResult {
	return { state, text, details: { action, todos: state.todos, nextId: state.nextId, error } };
}

function updateTodo(state: TodoState, id: number, patch: Partial<Todo>): TodoState {
	return { ...state, todos: state.todos.map((t) => (t.id === id ? { ...t, ...patch } : t)) };
}

export function applyTodoAction(state: TodoState, params: TodoActionParams, now: number = Date.now()): TodoActionResult {
	const action = params.action as Action;

	// Actions that take an id share the same validation.
	const needsId = action === "toggle" || action === "remove" || action === "rename" || action === "in_progress";
	let target: Todo | undefined;
	if (needsId) {
		if (params.id === undefined) return fail(action, state, `Error: id required for ${action}`, "id required");
		if (action === "rename" && !params.text)
			return fail(action, state, "Error: text required for rename", "text required");
		target = state.todos.find((t) => t.id === params.id);
		if (!target) return fail(action, state, `Todo #${params.id} not found`, `#${params.id} not found`);
	}

	switch (action) {
		case "list":
			return ok("list", state, formatTodoList(state.todos));

		case "add": {
			if (!params.text) return fail("add", state, "Error: text required for add", "text required");
			const priority: Priority = params.priority ?? "medium";
			const todo: Todo = {
				id: state.nextId,
				text: params.text,
				done: false,
				inProgress: false,
				priority,
				createdAt: now,
			};
			return ok(
				"add",
				{ todos: [...state.todos, todo], nextId: state.nextId + 1 },
				`Added todo #${todo.id} ${priorityLabel(priority)}: ${todo.text}`,
			);
		}

		case "toggle": {
			const done = !target!.done;
			const next = updateTodo(state, target!.id, done ? { done, inProgress: false } : { done });
			return ok("toggle", next, `Todo #${target!.id} ${done ? "completed" : "uncompleted"}`);
		}

		case "remove":
			return ok(
				"remove",
				{ ...state, todos: state.todos.filter((t) => t.id !== target!.id) },
				`Removed todo #${target!.id}: ${target!.text}`,
			);

		case "rename":
			return ok(
				"rename",
				updateTodo(state, target!.id, { text: params.text! }),
				`Renamed todo #${target!.id}: "${target!.text}" -> "${params.text}"`,
			);

		case "in_progress": {
			if (target!.done)
				return fail(
					"in_progress",
					state,
					`Todo #${target!.id} is already completed`,
					`#${target!.id} already completed`,
				);
			const inProgress = !target!.inProgress;
			return ok(
				"in_progress",
				updateTodo(state, target!.id, { inProgress }),
				`Todo #${target!.id} ${inProgress ? "started" : "paused"}`,
			);
		}

		case "clear":
			return ok("clear", { todos: [], nextId: 1 }, `Cleared ${state.todos.length} todos`);

		default:
			return fail("list", state, `Unknown action: ${params.action}`, `unknown action: ${params.action}`);
	}
}

/**
 * Rebuild state from session branch entries. Each `todo` tool result carries a
 * full snapshot, so the last one wins.
 */
export function reconstructTodoState(entries: Iterable<unknown>): TodoState {
	let state: TodoState = EMPTY_TODO_STATE;
	for (const entry of entries) {
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: TodoDetails } };
		if (e?.type !== "message") continue;
		const msg = e.message;
		if (msg?.role !== "toolResult" || msg.toolName !== "todo" || !msg.details) continue;
		state = { todos: msg.details.todos, nextId: msg.details.nextId };
	}
	return state;
}

/**
 * What the model must not lose when context is compacted: the open items.
 * Returns null when nothing is open (no message is worth sending then).
 */
export function buildTodoRecap(todos: Todo[]): string | null {
	const open = todos.filter((t) => !t.done);
	if (open.length === 0) return null;
	const { done, total } = summarizeTodos(todos);
	return [
		`Todo list after context compaction (${done}/${total} done). Open items:`,
		formatTodoList(open),
		"Continue from the item in progress; update items with the todo tool.",
	].join("\n");
}
