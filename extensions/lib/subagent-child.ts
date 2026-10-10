/**
 * How the subagent tool builds and reads child `pi` processes.
 *
 * No runtime imports from Pi, so the tests exercise this exact code.
 *
 * Every child is a `pi --mode json -p` process with its own persisted session
 * (so a later dispatch can resume it), none of the parent's extensions, skills
 * or themes, and the task on stdin (no argv size limit).
 *
 * Two prompt modes:
 *
 * - "full" (default): the child gets the agent's whole markdown body as an
 *   appended system prompt.
 *
 * - "lean" (opt-in, PI_SUBAGENT_PROMPT_MODE=lean): the child gets only a
 *   one-line role prefix, and unless the dispatch or agent names a model it
 *   resolves model and thinking from settings.json. Some local models (seen
 *   with Qwen via Ollama) emit tool calls as plain text when the system prompt
 *   grows; this mode trades the agent's instructions for more reliable tool
 *   calling on such models.
 */

import { randomBytes } from "node:crypto";
import type { AgentConfig } from "./agent-config.ts";
import type { ModelChoice } from "./subagent-config.ts";

export type PromptMode = "full" | "lean";

export const PROMPT_MODE_ENV = "PI_SUBAGENT_PROMPT_MODE";

/** Flags every child gets: JSON output, none of the parent's extensions, skills or themes. */
export const CHILD_ISOLATION_FLAGS = ["--mode", "json", "-p", "--no-extensions", "--no-skills", "--no-themes"] as const;

export type ChildAgent = Pick<AgentConfig, "name" | "description" | "tools" | "systemPrompt" | "contextFiles">;

export interface BuildChildArgsOptions {
	agent: ChildAgent;
	choice: Pick<ModelChoice, "model" | "thinking">;
	promptMode: PromptMode;
	/** Child session storage; `id` is created on first use and reopened on resume. */
	session: { dir: string; id: string };
	/** Whether the parent trusts the project. The child gets the same decision instead of a blanket --approve. */
	projectTrusted: boolean;
	/** File holding agent.systemPrompt. Required in full mode when the body is non-empty. */
	systemPromptFile?: string;
	/** Path of extensions/web.ts; loaded with -e for agents that use web tools. */
	webExtensionPath?: string;
}

export function resolvePromptMode(env: Record<string, string | undefined>): PromptMode {
	return env[PROMPT_MODE_ENV]?.trim().toLowerCase() === "lean" ? "lean" : "full";
}

/**
 * Children run with --no-extensions, so the web tools must be loaded explicitly
 * for agents that list a web_* tool, or that allow all tools (no `tools` field).
 */
export function childNeedsWebTools(agent: Pick<ChildAgent, "tools">): boolean {
	return !agent.tools || agent.tools.some((t) => t.startsWith("web_"));
}

export function shouldAppendSystemPrompt(agent: Pick<ChildAgent, "systemPrompt">, promptMode: PromptMode): boolean {
	return promptMode === "full" && agent.systemPrompt.trim().length > 0;
}

/** Session ids must start and end with a letter or digit and use only [A-Za-z0-9._-]. */
export function newChildSessionId(agentName: string, random: string = randomBytes(4).toString("hex")): string {
	const slug = agentName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32);
	return `${slug || "agent"}-${random}`;
}

export function isValidChildSessionId(id: string): boolean {
	return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id);
}

/** Build the child's argv (without the `pi` executable). The task goes to stdin. */
export function buildChildArgs(opts: BuildChildArgsOptions): string[] {
	const { agent, choice, promptMode, session } = opts;
	const args: string[] = [...CHILD_ISOLATION_FLAGS];
	args.push("--session-dir", session.dir, "--session-id", session.id);
	args.push(opts.projectTrusted ? "--approve" : "--no-approve");
	if (agent.contextFiles === false) args.push("--no-context-files");
	if (opts.webExtensionPath && childNeedsWebTools(agent)) args.push("-e", opts.webExtensionPath);
	if (choice.model) args.push("--model", choice.model);
	if (choice.thinking) args.push("--thinking", choice.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	if (shouldAppendSystemPrompt(agent, promptMode)) {
		if (!opts.systemPromptFile) {
			throw new Error(`buildChildArgs: full mode needs systemPromptFile for agent "${agent.name}"`);
		}
		args.push("--append-system-prompt", opts.systemPromptFile);
	}
	return args;
}

/** The first prompt of a new child. A resumed child gets the follow-up text as is. */
export function buildChildTask(agent: Pick<ChildAgent, "name" | "description">, task: string, promptMode: PromptMode): string {
	const rolePrefix = promptMode === "lean" && agent.description ? `[Role: ${agent.name} — ${agent.description}] ` : "";
	return `${rolePrefix}Task: ${task}`;
}

/** "provider/model" as reported by the child's own assistant message. */
export function childModelLabel(message: { provider?: unknown; model?: unknown }): string | undefined {
	if (typeof message.model !== "string" || !message.model) return undefined;
	return typeof message.provider === "string" && message.provider ? `${message.provider}/${message.model}` : message.model;
}

// ---------------------------------------------------------------------------
// Reading the child's JSON event stream
// ---------------------------------------------------------------------------

interface OutputMessage {
	role: string;
	content?: unknown;
}

/** Non-empty text parts of a message, in order. */
function textParts(msg: OutputMessage): string[] {
	if (!Array.isArray(msg.content)) return [];
	const texts: string[] = [];
	for (const part of msg.content as Array<{ type?: unknown; text?: unknown }>) {
		if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) texts.push(part.text);
	}
	return texts;
}

/** The child's answer: every text part of its last assistant message that has text. "" when there is none. */
export function getFinalAnswer(messages: ReadonlyArray<OutputMessage>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "assistant") continue;
		const parts = textParts(messages[i]);
		if (parts.length > 0) return parts.join("\n\n");
	}
	return "";
}

const NO_ANSWER_TAIL = 4000;

/**
 * What the parent sees. Some models (seen with local Qwen via Ollama) stop
 * after tool calls without a final summary; then the tail of the last tool
 * output is returned, labelled as such so it is not mistaken for an answer.
 */
export function getFinalOutput(messages: ReadonlyArray<OutputMessage>): string {
	const answer = getFinalAnswer(messages);
	if (answer) return answer;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "toolResult") continue;
		const text = textParts(messages[i]).join("\n").trim();
		if (!text) continue;
		const tail = text.length > NO_ANSWER_TAIL ? `…${text.slice(-NO_ANSWER_TAIL)}` : text;
		return `(The subagent ended without a final answer. Its last tool output was:)\n\n${tail}`;
	}
	return "";
}

export interface ChildUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export const emptyUsage = (): ChildUsage => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
});

/** What the TUI shows of a child's work. Only a capped, trimmed list is kept, never the full transcript. */
export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

const MAX_DISPLAY_ITEMS = 40;
const MAX_DISPLAY_TEXT = 1500;
const MAX_ARG_STRING = 300;

function trimArgs(args: unknown): Record<string, unknown> {
	if (!args || typeof args !== "object") return {};
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
		if (typeof v === "string") out[k] = v.length > MAX_ARG_STRING ? `${v.slice(0, MAX_ARG_STRING)}…` : v;
		else if (typeof v === "number" || typeof v === "boolean" || v === null) out[k] = v;
		else out[k] = "…";
	}
	return out;
}

/**
 * Accumulates one child's JSON events. Messages are held in memory only for
 * computing the answer; what is stored in the parent session is `snapshot()`.
 */
export class ChildEventCollector {
	readonly messages: OutputMessage[] = [];
	readonly usage: ChildUsage = emptyUsage();
	items: DisplayItem[] = [];
	sessionId?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;

	/** Returns true when the event changed what the UI should show. */
	handle(event: Record<string, unknown>): boolean {
		if (event.type === "session" && typeof event.id === "string") {
			this.sessionId = event.id;
			return false;
		}
		if (event.type !== "message_end" || !event.message || typeof event.message !== "object") return false;
		const msg = event.message as OutputMessage & Record<string, unknown>;
		this.messages.push(msg);
		if (msg.role !== "assistant") return false;

		this.usage.turns++;
		const u = msg.usage as Record<string, unknown> | undefined;
		if (u) {
			const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
			this.usage.input += num(u.input);
			this.usage.output += num(u.output);
			this.usage.cacheRead += num(u.cacheRead);
			this.usage.cacheWrite += num(u.cacheWrite);
			this.usage.cost += num((u.cost as Record<string, unknown> | undefined)?.total);
			this.usage.contextTokens = num(u.totalTokens);
		}
		this.model ??= childModelLabel({ provider: msg.provider, model: msg.model });
		if (typeof msg.stopReason === "string") this.stopReason = msg.stopReason;
		if (typeof msg.errorMessage === "string") this.errorMessage = msg.errorMessage;

		if (Array.isArray(msg.content)) {
			for (const part of msg.content as Array<Record<string, unknown>>) {
				if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
					const t = part.text;
					this.items.push({ type: "text", text: t.length > MAX_DISPLAY_TEXT ? `${t.slice(0, MAX_DISPLAY_TEXT)}…` : t });
				} else if (part?.type === "toolCall" && typeof part.name === "string") {
					this.items.push({ type: "toolCall", name: part.name, args: trimArgs(part.arguments) });
				}
			}
			if (this.items.length > MAX_DISPLAY_ITEMS) this.items = this.items.slice(-MAX_DISPLAY_ITEMS);
		}
		return true;
	}

	get output(): string {
		return getFinalOutput(this.messages);
	}
}
