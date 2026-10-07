/**
 * How the subagent tool builds and reads child `pi` processes.
 *
 * No runtime imports from Pi, so the tests exercise this exact code.
 *
 * Two prompt modes:
 *
 * - "full" (default): the child gets the agent's whole markdown body as an
 *   appended system prompt, plus the parent's model (or the agent's own) and,
 *   when inherited, the parent's thinking level. This is what the agent
 *   definitions are written for.
 *
 * - "lean" (opt-in, PI_SUBAGENT_PROMPT_MODE=lean): the child gets only a
 *   one-line role prefix, no --model and no --thinking, so it resolves both
 *   from settings.json. Some local models (seen with Qwen via Ollama) emit
 *   tool calls as plain text when the system prompt grows; this mode trades
 *   the agent's instructions for more reliable tool calling on such models.
 */

import type { AgentConfig } from "./agent-config.ts";

export type PromptMode = "full" | "lean";

export const PROMPT_MODE_ENV = "PI_SUBAGENT_PROMPT_MODE";

/** Flags every child gets: JSON output, no session file, none of the parent's extensions/skills/context files. */
export const CHILD_ISOLATION_FLAGS = [
	"--mode",
	"json",
	"-p",
	"--no-session",
	"--no-extensions",
	"--no-skills",
	"--no-context-files",
	"--no-themes",
	"--approve",
] as const;

export interface DispatchDefaults {
	/** Parent session model as "provider/id". */
	model?: string;
	thinkingLevel?: string;
}

export type ChildAgent = Pick<AgentConfig, "name" | "description" | "tools" | "model" | "systemPrompt">;

export interface BuildChildArgsOptions {
	agent: ChildAgent;
	task: string;
	dispatchDefaults: DispatchDefaults;
	promptMode: PromptMode;
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

export function shouldAppendSystemPrompt(agent: ChildAgent, promptMode: PromptMode): boolean {
	return promptMode === "full" && agent.systemPrompt.trim().length > 0;
}

/**
 * Build the child's argv (without the `pi` executable).
 * `model` is what the UI should show: the model actually passed to the child,
 * or undefined when the child picks its own (then read it with childModelLabel).
 */
export function buildChildArgs(opts: BuildChildArgsOptions): { args: string[]; model?: string } {
	const { agent, task, dispatchDefaults, promptMode } = opts;
	const args: string[] = [...CHILD_ISOLATION_FLAGS];
	if (opts.webExtensionPath && childNeedsWebTools(agent)) args.push("-e", opts.webExtensionPath);
	let model: string | undefined;

	if (promptMode === "full") {
		model = agent.model ?? dispatchDefaults.model;
		if (model) args.push("--model", model);
		if (!agent.model && dispatchDefaults.thinkingLevel) args.push("--thinking", dispatchDefaults.thinkingLevel);
	}

	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	if (shouldAppendSystemPrompt(agent, promptMode)) {
		if (!opts.systemPromptFile) {
			throw new Error(`buildChildArgs: full mode needs systemPromptFile for agent "${agent.name}"`);
		}
		args.push("--append-system-prompt", opts.systemPromptFile);
	}

	const rolePrefix = promptMode === "lean" && agent.description ? `[Role: ${agent.name} — ${agent.description}] ` : "";
	args.push(`${rolePrefix}Task: ${task}`);

	return { args, model };
}

/** "provider/model" as reported by the child's own assistant message. */
export function childModelLabel(message: { provider?: unknown; model?: unknown }): string | undefined {
	if (typeof message.model !== "string" || !message.model) return undefined;
	return typeof message.provider === "string" && message.provider ? `${message.provider}/${message.model}` : message.model;
}

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

/**
 * The child's answer: its last non-empty assistant text. Some models (seen
 * with local Qwen via Ollama) stop after tool calls without a final summary;
 * then the tool results are returned instead of nothing.
 */
export function getFinalOutput(messages: ReadonlyArray<OutputMessage>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role !== "assistant") continue;
		const [first] = textParts(messages[i]);
		if (first !== undefined) return first;
	}
	return messages
		.filter((m) => m.role === "toolResult")
		.flatMap(textParts)
		.map((t) => t.trim())
		.join("\n\n");
}
