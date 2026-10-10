/**
 * Subagent Tool
 *
 * Grew out of Pi's example subagent extension. Spawns a separate `pi` process
 * per dispatch, giving each child an isolated context window, and keeps the
 * child's session so a later dispatch can resume it with its context intact.
 *
 * Modes:
 *   - Single:   { agent, task }
 *   - Resume:   { resume: "<id>", task: "follow-up" }
 *   - Parallel: { tasks: [{ agent, task }, ...] }
 *   - Chain:    { chain: [{ agent, task: "... {previous} ..." }, ...] }
 *
 * `model` (a tier — cheap, mid, top — or "provider/id") and `thinking` can be
 * set per dispatch, per parallel task and per chain step. Tiers are mapped to
 * concrete models in ~/.pi/agent/superpowers/subagents.json (/subagent-models).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	getMarkdownTheme,
	type ThemeColor,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CHILD_ENV } from "../lib/bootstrap.ts";
import {
	buildChildArgs,
	buildChildTask,
	ChildEventCollector,
	type ChildUsage,
	type DisplayItem,
	emptyUsage,
	newChildSessionId,
	type PromptMode,
	resolvePromptMode,
	shouldAppendSystemPrompt,
} from "../lib/subagent-child.ts";
import {
	loadSettings,
	type ModelChoice,
	resolveModelChoice,
	type SubagentSettings,
	THINKING_LEVELS,
	TIERS,
} from "../lib/subagent-config.ts";
import {
	buildSubagentRecap,
	childSessionDir,
	collectResumableChildren,
	findChildSession,
	findChildSessionFile,
	isDirectory,
	isPathInside,
	pruneChildSessions,
	touchDir,
	runChildProcess,
	writeChildMeta,
} from "../lib/subagent-run.ts";
import {
	type AgentConfig,
	type AgentScope,
	type AgentSource,
	agentOrigin,
	DEFAULT_AGENT_SCOPE,
	discoverAgents,
	getUserAgentsDir,
} from "./agents.ts";

/** Loaded into children that use web tools; they run with --no-extensions. */
const WEB_EXTENSION_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web.ts");

const settingsPath = () => path.join(getAgentDir(), "superpowers", "subagents.json");
const sessionsRoot = () => path.join(getAgentDir(), "superpowers", "subagent-sessions");

const COLLAPSED_ITEM_COUNT = 10;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const DETAILS_TASK_CAP = 4 * 1024;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(usage: Partial<ChildUsage>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: ThemeColor, text: string) => string,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};
	const str = (v: unknown, fallback: string) => (typeof v === "string" && v ? v : fallback);

	switch (toolName) {
		case "bash": {
			const command = str(args.command, "...");
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const filePath = shortenPath(str(args.file_path ?? args.path, "..."));
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write":
			return themeFg("muted", "write ") + themeFg("accent", shortenPath(str(args.file_path ?? args.path, "...")));
		case "edit":
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(str(args.file_path ?? args.path, "...")));
		case "ls":
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(str(args.path, ".")));
		case "find":
			return (
				themeFg("muted", "find ") +
				themeFg("accent", str(args.pattern, "*")) +
				themeFg("dim", ` in ${shortenPath(str(args.path, "."))}`)
			);
		case "grep":
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${str(args.pattern, "")}/`) +
				themeFg("dim", ` in ${shortenPath(str(args.path, "."))}`)
			);
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

function capText(text: string, cap: number): string {
	if (Buffer.byteLength(text, "utf8") <= cap) return text;
	let truncated = text.slice(0, cap);
	while (Buffer.byteLength(truncated, "utf8") > cap) truncated = truncated.slice(0, -1);
	return truncated;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** One child's result as stored in the parent session: a summary, never the full transcript. */
interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	/** Child session id; pass it as `resume` to continue this child. */
	id?: string;
	resumed?: boolean;
	sessionFile?: string;
	/** -1 while running. */
	exitCode: number;
	stderr: string;
	usage: ChildUsage;
	model?: string;
	thinking?: string;
	modelNote?: string;
	stopReason?: string;
	errorMessage?: string;
	spawnError?: string;
	timedOut?: boolean;
	step?: number;
	items: DisplayItem[];
	output: string;
}

interface SubagentDetails {
	mode: "single" | "resume" | "parallel" | "chain";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function placeholderResult(agent: string, task: string, step?: number): SingleResult {
	return {
		agent,
		agentSource: "unknown",
		task: capText(task, DETAILS_TASK_CAP),
		exitCode: -1,
		stderr: "",
		usage: emptyUsage(),
		step,
		items: [],
		output: "",
	};
}

function isFailedResult(result: SingleResult): boolean {
	return (
		result.exitCode !== 0 ||
		Boolean(result.spawnError) ||
		Boolean(result.timedOut) ||
		result.stopReason === "error" ||
		result.stopReason === "aborted"
	);
}

function failureText(result: SingleResult): string {
	if (result.spawnError) return `could not start the child process: ${result.spawnError}`;
	if (result.timedOut) return `timed out${result.output ? `; partial output:\n\n${result.output}` : ""}`;
	return result.errorMessage || result.stderr.trim() || result.output || "(no output)";
}

/** Footer the parent model reads: how to continue this child, and what ran. */
function resultFooter(r: SingleResult): string {
	const facts = [r.agent, r.model, formatUsageStats({ turns: r.usage.turns, input: r.usage.input, output: r.usage.output })]
		.filter(Boolean)
		.join(" · ");
	const lines = [`[subagent ${facts}]`];
	if (r.modelNote) lines.push(`[note: ${r.modelNote}]`);
	if (r.id) lines.push(`[continue this subagent with its context: subagent { "resume": "${r.id}", "task": "..." }]`);
	return lines.join("\n");
}

function totalUsage(results: SingleResult[]) {
	const t = emptyUsage();
	for (const r of results) {
		t.input += r.usage.input;
		t.output += r.usage.output;
		t.cacheRead += r.usage.cacheRead;
		t.cacheWrite += r.usage.cacheWrite;
		t.cost += r.usage.cost;
		t.turns += r.usage.turns;
	}
	return t;
}

/** Children's usage in Pi's shape, so it counts toward the session totals. */
function toPiUsage(results: SingleResult[]) {
	const t = totalUsage(results);
	return {
		input: t.input,
		output: t.output,
		cacheRead: t.cacheRead,
		cacheWrite: t.cacheWrite,
		totalTokens: t.input + t.output + t.cacheRead + t.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: t.cost },
	};
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
	signal?: AbortSignal,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length) as TOut[];
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (!signal?.aborted) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

// ---------------------------------------------------------------------------
// Running one child
// ---------------------------------------------------------------------------

interface DispatchContext {
	cwd: string;
	parentModel?: string;
	parentThinking?: string;
	parentSessionId?: string;
	projectTrusted: boolean;
	promptMode: PromptMode;
	settings: SubagentSettings;
	signal?: AbortSignal;
}

interface ChildRequest {
	agent: AgentConfig;
	/** A new child's task, or the follow-up for a resumed one. */
	task: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	step?: number;
	/** Reopen this child session instead of starting a new one. */
	resume?: { id: string; dir: string; model?: string; thinking?: string };
}

type OnResult = (partial: SingleResult) => void;

/** Children running in this Pi process, by session id: two processes must never write one session file. */
const runningChildren = new Set<string>();

async function runChild(dc: DispatchContext, req: ChildRequest, onUpdate?: OnResult): Promise<SingleResult> {
	const { agent } = req;
	// A resumed child keeps the model it was dispatched with unless this dispatch names another.
	const choice: ModelChoice = resolveModelChoice({
		requested: req.model,
		requestedThinking: req.thinking,
		agentModel: req.resume ? req.resume.model : agent.model,
		agentThinking: req.resume ? req.resume.thinking : agent.thinking,
		parentModel: dc.parentModel,
		parentThinking: dc.parentThinking,
		tiers: dc.settings.tiers,
		lean: dc.promptMode === "lean",
	});

	if (dc.signal?.aborted) throw new Error("Subagent was aborted");
	const sessionDir = req.resume?.dir ?? childSessionDir(sessionsRoot(), dc.parentSessionId);
	const sessionId = req.resume?.id ?? newChildSessionId(agent.name);
	const cwd = path.resolve(dc.cwd, req.cwd ?? ".");

	const result: SingleResult = {
		...placeholderResult(agent.name, req.task, req.step),
		agentSource: agent.source,
		id: sessionId,
		resumed: Boolean(req.resume),
		model: choice.model,
		thinking: choice.thinking,
		modelNote: choice.note,
	};
	const collector = new ChildEventCollector();
	const sync = () => {
		result.usage = { ...collector.usage };
		result.items = [...collector.items];
		result.output = capText(collector.output, PER_TASK_OUTPUT_CAP);
		result.model = collector.model ?? result.model;
		result.stopReason = collector.stopReason;
		result.errorMessage = collector.errorMessage;
	};

	const refuse = (message: string): SingleResult => ({ ...result, exitCode: 1, errorMessage: message });
	if (!isDirectory(cwd)) {
		return refuse(
			req.resume
				? `the subagent's working directory ${cwd} no longer exists, so it cannot be resumed. Dispatch a fresh subagent.`
				: `working directory ${cwd} does not exist`,
		);
	}
	if (runningChildren.has(sessionId)) {
		return refuse(`subagent ${sessionId} is already running; wait for its result before resuming it again`);
	}
	runningChildren.add(sessionId);

	let tmp: { dir: string; filePath: string } | null = null;
	try {
		if (shouldAppendSystemPrompt(agent, dc.promptMode)) tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
		const args = buildChildArgs({
			agent,
			choice,
			promptMode: dc.promptMode,
			session: { dir: sessionDir, id: sessionId },
			// The parent's trust covers its own project, not a directory elsewhere that the model named.
			projectTrusted: dc.projectTrusted && isPathInside(cwd, dc.cwd),
			systemPromptFile: tmp?.filePath,
			webExtensionPath: WEB_EXTENSION_PATH,
		});

		if (!req.resume) {
			writeChildMeta(sessionDir, {
				id: sessionId,
				agent: agent.name,
				model: choice.model,
				thinking: choice.thinking,
				cwd,
				createdAt: new Date().toISOString(),
				parentSessionId: dc.parentSessionId,
			});
		}
		touchDir(sessionDir);

		const invocation = getPiInvocation(args);
		const outcome = await runChildProcess({
			command: invocation.command,
			args: invocation.args,
			cwd,
			env: { ...process.env, [CHILD_ENV]: "1" },
			stdin: req.resume ? req.task : buildChildTask(agent, req.task, dc.promptMode),
			signal: dc.signal,
			timeoutMs: dc.settings.timeoutMinutes * 60_000,
			onEvent: (event) => {
				if (collector.handle(event)) {
					sync();
					onUpdate?.({ ...result });
				}
			},
		});

		sync();
		result.exitCode = outcome.exitCode ?? 1;
		result.stderr = outcome.stderr.slice(-4000);
		result.spawnError = outcome.spawnError;
		result.timedOut = outcome.timedOut;
		result.sessionFile = findChildSessionFile(sessionDir, sessionId);
		if (outcome.aborted) throw new Error("Subagent was aborted");
		return result;
	} finally {
		runningChildren.delete(sessionId);
		if (tmp) fs.rmSync(tmp.dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// Tool schema
// ---------------------------------------------------------------------------

// Item fields carry no descriptions: the top-level fields describe them once,
// which keeps this schema (sent with every request) small.
const modelField = (description?: string) =>
	Type.Optional(Type.String(description ? { description } : {}));
const thinkingField = (description?: string) =>
	Type.Optional(StringEnum(THINKING_LEVELS, description ? { description } : {}));

const ChildSpec = Type.Object({
	agent: Type.String(),
	task: Type.String(),
	cwd: Type.Optional(Type.String()),
	model: modelField(),
	thinking: thinkingField(),
});

const SubagentParams = Type.Object({
	agent: Type.Optional(Type.String({ description: "Agent name (single mode)" })),
	task: Type.Optional(Type.String({ description: "The task (single mode), or the follow-up message (resume mode)" })),
	resume: Type.Optional(Type.String({ description: "Id of an earlier subagent to continue with its context (with task)" })),
	tasks: Type.Optional(Type.Array(ChildSpec, { description: "Parallel mode: independent {agent, task} items" })),
	chain: Type.Optional(
		Type.Array(ChildSpec, { description: "Chain mode: sequential {agent, task} items; {previous} in a task is the prior step's output" }),
	),
	model: modelField(`A tier (${TIERS.join(", ")}) or "provider/id". Default: the agent's model, else the session's`),
	thinking: thinkingField("Thinking level"),
	cwd: Type.Optional(Type.String({ description: "Working directory (default: the session's)" })),
	agentScope: Type.Optional(
		StringEnum(["user", "project", "both"] as const, {
			description: `Agent sources to search. Default "${DEFAULT_AGENT_SCOPE}": package, user and project`,
		}),
	),
});

/** What codemode scripts receive instead of the text. */
const SubagentOutput = Type.Object({
	ok: Type.Boolean(),
	results: Type.Array(
		Type.Object({
			agent: Type.String(),
			ok: Type.Boolean(),
			id: Type.Optional(Type.String()),
			step: Type.Optional(Type.Number()),
			model: Type.Optional(Type.String()),
			output: Type.String(),
			error: Type.Optional(Type.String()),
		}),
	),
	error: Type.Optional(Type.String()),
});

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const { settings } = loadSettings(settingsPath());
		pruneChildSessions(sessionsRoot(), settings.sessionRetentionDays);
	});

	// After compaction the model no longer sees earlier subagent results, and with
	// them the ids it needs for resume (the SDD fix loop resumes its implementer).
	// Re-attach the recent ones as a message appended after the compaction point.
	pi.on("session_compact", (_event, ctx) => {
		const recap = buildSubagentRecap(collectResumableChildren(ctx.sessionManager.getBranch()));
		if (recap) pi.sendMessage({ customType: "superpowers-subagent-recap", content: recap, display: true });
	});

	pi.registerCommand("subagent-models", {
		description: "Map the subagent model tiers (cheap, mid, top) to models",
		handler: async (_args, ctx) => {
			const file = settingsPath();
			const { settings, error } = loadSettings(file);
			if (error) {
				ctx.ui.notify(`Cannot read ${file}: ${error}. Fix or delete it first.`, "error");
				return;
			}
			if (!ctx.hasUI) return;
			const models = ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
			const PARENT = "(session model)";
			for (const tier of TIERS) {
				const current = settings.tiers[tier] ?? PARENT;
				const picked = await ctx.ui.select(`Model for tier "${tier}" (now: ${current})`, [PARENT, ...models]);
				if (picked === undefined) return;
				if (picked === PARENT) delete settings.tiers[tier];
				else settings.tiers[tier] = picked;
			}
			await withFileMutationQueue(file, async () => {
				let raw: Record<string, unknown> = {};
				try {
					raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
				} catch {
					/* new file */
				}
				fs.mkdirSync(path.dirname(file), { recursive: true });
				fs.writeFileSync(file, `${JSON.stringify({ ...raw, tiers: settings.tiers }, null, 2)}\n`);
			});
			const summary = TIERS.map((t) => `${t}: ${settings.tiers[t] ?? PARENT}`).join(", ");
			ctx.ui.notify(`Subagent tiers saved — ${summary}`, "info");
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate tasks to subagents with isolated context.",
			"Modes: single (agent + task), resume (resume id + task: continue an earlier subagent with its context),",
			"parallel (tasks array), chain (sequential, {previous} carries the prior step's output).",
			`model sets the model per dispatch: a tier (${TIERS.join(", ")}) or "provider/id"; thinking sets the thinking level.`,
			"Every result ends with the subagent's id.",
			`Agents come from this package, the user directory (${getUserAgentsDir()}) and the nearest project's ${CONFIG_DIR_NAME}/agents; a more specific one overrides a less specific one with the same name.`,
		].join(" "),
		promptSnippet: "subagent: delegate a task to an isolated child agent (single, parallel, chain), or resume one by id",
		parameters: SubagentParams,
		outputSchema: SubagentOutput,
		// Children run with the tools their agent allows, up to every tool, and may reach the web.
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? DEFAULT_AGENT_SCOPE;
			const { settings, error: settingsError } = loadSettings(settingsPath());
			const dc: DispatchContext = {
				cwd: ctx.cwd,
				parentModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				parentThinking: ctx.thinkingLevel,
				parentSessionId: ctx.sessionManager.getSessionId(),
				projectTrusted: ctx.isProjectTrusted(),
				promptMode: resolvePromptMode(process.env),
				settings,
				signal,
			};
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const warning = settingsError ? `[warning: subagent settings ignored — ${settingsError}]\n\n` : "";

			const hasChain = (params.chain?.length ?? 0) > 0;
			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasResume = Boolean(params.resume);
			const hasSingle = Boolean(params.agent && params.task) && !hasResume;
			const modeCount = Number(hasChain) + Number(hasTasks) + Number(hasSingle) + Number(hasResume);
			const mode: SubagentDetails["mode"] = hasChain ? "chain" : hasTasks ? "parallel" : hasResume ? "resume" : "single";

			const makeDetails = (results: SingleResult[]): SubagentDetails => ({
				mode,
				agentScope,
				projectAgentsDir: discovery.projectAgentsDir,
				results,
			});
			const done = (text: string, results: SingleResult[], isError = false) => ({
				content: [{ type: "text" as const, text: warning + text }],
				details: makeDetails(results),
				structuredContent: {
					ok: !isError,
					results: results.map((r) => ({
						agent: r.agent,
						ok: !isFailedResult(r),
						...(r.id ? { id: r.id } : {}),
						...(r.step !== undefined ? { step: r.step } : {}),
						...(r.model ? { model: r.model } : {}),
						output: r.output,
						...(isFailedResult(r) ? { error: failureText(r) } : {}),
					})),
					...(isError && results.length === 0 ? { error: text } : {}),
				},
				...(results.length ? { usage: toPiUsage(results) } : {}),
				...(isError ? { isError: true } : {}),
			});
			const availableList = () => agents.map((a) => `${a.name} (${agentOrigin(a)})`).join(", ") || "none";
			const findAgent = (name: string) => agents.find((a) => a.name === name);
			const unknownAgent = (name: string) =>
				done(`Unknown agent: "${name}". Available agents: ${availableList()}.`, [], true);

			if (modeCount !== 1 || (hasResume && !params.task)) {
				return done(
					`Invalid parameters. Provide exactly one mode: agent+task, resume+task, tasks, or chain.\nAvailable agents: ${availableList()}`,
					[],
					true,
				);
			}

			const requestedNames = new Set<string>();
			for (const step of params.chain ?? []) requestedNames.add(step.agent);
			for (const t of params.tasks ?? []) requestedNames.add(t.agent);
			if (hasSingle && params.agent) requestedNames.add(params.agent);
			for (const name of requestedNames) if (!findAgent(name)) return unknownAgent(name);

			// A resumed child keeps its agent, wherever that agent is defined now.
			let resumeTarget: { found: NonNullable<ReturnType<typeof findChildSession>>; agent: AgentConfig } | undefined;
			if (hasResume && params.resume) {
				const found = findChildSession(sessionsRoot(), childSessionDir(sessionsRoot(), dc.parentSessionId), params.resume);
				if (!found) return done(`No subagent with id "${params.resume}" to resume. Dispatch a fresh one instead.`, [], true);
				const agent = discoverAgents(ctx.cwd, "both").agents.find((a) => a.name === found.meta.agent);
				if (!agent) {
					return done(
						`Cannot resume ${found.meta.id}: its agent "${found.meta.agent}" no longer exists. Dispatch a fresh subagent instead (available agents: ${availableList()}).`,
						[],
						true,
					);
				}
				resumeTarget = { found, agent };
			}

			// Only the user can approve repo-controlled agents; the model has no parameter to skip this.
			if (ctx.hasUI && !ctx.isProjectTrusted()) {
				const projectAgents = [
					...(agentScope !== "user" ? [...requestedNames].map(findAgent) : []),
					resumeTarget?.agent,
				].filter((a): a is AgentConfig => a?.source === "project");
				if (projectAgents.length > 0) {
					const ok = await ctx.ui.confirm(
						"Run project-local agents?",
						`Agents: ${projectAgents.map((a) => a.name).join(", ")}\nSource: ${path.dirname(projectAgents[0].filePath)}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok) return done("Canceled: project-local agents not approved.", [], true);
				}
			}

			// ── Resume ──────────────────────────────────────────────────────────
			if (resumeTarget && params.task) {
				const { found, agent } = resumeTarget;
				const result = await runChild(
					dc,
					{
						agent,
						task: params.task,
						cwd: found.meta.cwd,
						model: params.model,
						thinking: params.thinking,
						resume: { id: found.meta.id, dir: found.dir, model: found.meta.model, thinking: found.meta.thinking },
					},
					(partial) => onUpdate?.({ content: [{ type: "text", text: partial.output || "(running...)" }], details: makeDetails([partial]) }),
				);
				if (isFailedResult(result)) return done(`Subagent failed: ${failureText(result)}\n\n${resultFooter(result)}`, [result], true);
				return done(`${result.output || "(no output)"}\n\n${resultFooter(result)}`, [result]);
			}

			// ── Chain ───────────────────────────────────────────────────────────
			if (params.chain && params.chain.length > 0) {
				const results: SingleResult[] = [];
				let previousOutput = "";
				for (let i = 0; i < params.chain.length; i++) {
					const step = params.chain[i];
					// A function replacement inserts the text literally ($&, $' and $$ stay as written).
					const task = step.task.replace(/\{previous\}/g, () => previousOutput);
					const result = await runChild(
						dc,
						{ agent: findAgent(step.agent) as AgentConfig, task, cwd: step.cwd, model: step.model, thinking: step.thinking, step: i + 1 },
						(partial) =>
							onUpdate?.({
								content: [{ type: "text", text: partial.output || "(running...)" }],
								details: makeDetails([...results, partial]),
							}),
					);
					results.push(result);
					if (isFailedResult(result)) {
						return done(`Chain stopped at step ${i + 1} (${step.agent}): ${failureText(result)}\n\n${resultFooter(result)}`, results, true);
					}
					previousOutput = result.output;
				}
				const last = results[results.length - 1];
				const ids = results.map((r) => `${r.step}. ${r.agent}: ${r.id}`).join("\n");
				return done(`${last.output || "(no output)"}\n\n${resultFooter(last)}\n[chain step ids:\n${ids}]`, results);
			}

			// ── Parallel ────────────────────────────────────────────────────────
			if (params.tasks && params.tasks.length > 0) {
				const tasks = params.tasks;
				if (tasks.length > settings.maxParallelTasks) {
					return done(`Too many parallel tasks (${tasks.length}). Max is ${settings.maxParallelTasks}.`, [], true);
				}
				const allResults = tasks.map((t) => placeholderResult(t.agent, t.task));
				const emitParallelUpdate = () => {
					if (!onUpdate) return;
					const running = allResults.filter((r) => r.exitCode === -1).length;
					onUpdate({
						content: [{ type: "text", text: `Parallel: ${allResults.length - running}/${allResults.length} done, ${running} running...` }],
						details: makeDetails([...allResults]),
					});
				};
				const results = await mapWithConcurrencyLimit(tasks, settings.concurrency, async (t, index) => {
					const result = await runChild(
						dc,
						{ agent: findAgent(t.agent) as AgentConfig, task: t.task, cwd: t.cwd, model: t.model ?? params.model, thinking: t.thinking ?? params.thinking },
						(partial) => {
							allResults[index] = partial;
							emitParallelUpdate();
						},
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				}, signal);
				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const failed = isFailedResult(r);
					const body = failed ? failureText(r) : r.output || "(no output)";
					const status = failed ? `failed${r.stopReason && r.stopReason !== "stop" ? ` (${r.stopReason})` : ""}` : "completed";
					return `### [${r.agent}] ${status}\n\n${body}\n\n${resultFooter(r)}`;
				});
				return done(`Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`, results);
			}

			// ── Single ──────────────────────────────────────────────────────────
			const result = await runChild(
				dc,
				{ agent: findAgent(params.agent as string) as AgentConfig, task: params.task as string, cwd: params.cwd, model: params.model, thinking: params.thinking },
				(partial) => onUpdate?.({ content: [{ type: "text", text: partial.output || "(running...)" }], details: makeDetails([partial]) }),
			);
			if (isFailedResult(result)) {
				return done(`Agent ${result.stopReason || "failed"}: ${failureText(result)}\n\n${resultFooter(result)}`, [result], true);
			}
			return done(`${result.output || "(no output)"}\n\n${resultFooter(result)}`, [result]);
		},

		renderCall(args, theme, _context) {
			const scope: AgentScope = args.agentScope ?? DEFAULT_AGENT_SCOPE;
			const title = theme.fg("toolTitle", theme.bold("subagent "));
			const modelTag = args.model ? theme.fg("muted", ` ${args.model}`) : "";
			if (args.chain && args.chain.length > 0) {
				let text = title + theme.fg("accent", `chain (${args.chain.length} steps)`) + theme.fg("muted", ` [${scope}]`);
				for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
					const step = args.chain[i];
					const cleanTask = step.task.replace(/\{previous\}/g, "").trim();
					const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
					text += `\n  ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.chain.length > 3) text += `\n  ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			if (args.tasks && args.tasks.length > 0) {
				let text = title + theme.fg("accent", `parallel (${args.tasks.length} tasks)`) + theme.fg("muted", ` [${scope}]`);
				for (const t of args.tasks.slice(0, 3)) {
					const preview = t.task.length > 40 ? `${t.task.slice(0, 40)}...` : t.task;
					text += `\n  ${theme.fg("accent", t.agent)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const preview = args.task ? (args.task.length > 60 ? `${args.task.slice(0, 60)}...` : args.task) : "...";
			const who = args.resume ? `resume ${args.resume}` : args.agent || "...";
			return new Text(`${title}${theme.fg("accent", who)}${modelTag}${theme.fg("muted", ` [${scope}]`)}\n  ${theme.fg("dim", preview)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as SubagentDetails | undefined;
			if (!details || details.results.length === 0) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const fg = theme.fg.bind(theme);
			const statusIcon = (r: SingleResult) =>
				r.exitCode === -1 ? fg("warning", "⏳") : isFailedResult(r) ? fg("error", "✗") : fg("success", "✓");
			const idTag = (r: SingleResult) => (r.id ? fg("dim", ` ${r.resumed ? "resumed " : ""}${r.id}`) : "");

			const renderItems = (items: DisplayItem[], limit?: number) => {
				const toShow = limit ? items.slice(-limit) : items;
				const skipped = limit && items.length > limit ? items.length - limit : 0;
				let text = "";
				if (skipped > 0) text += fg("muted", `... ${skipped} earlier items\n`);
				for (const item of toShow) {
					if (item.type === "text") {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${fg("toolOutput", preview)}\n`;
					} else {
						text += `${fg("muted", "→ ") + formatToolCall(item.name, item.args, fg)}\n`;
					}
				}
				return text.trimEnd();
			};

			const addExpanded = (container: Container, r: SingleResult, header: string) => {
				container.addChild(new Text(header, 0, 0));
				if (isFailedResult(r) && r.exitCode !== -1) container.addChild(new Text(fg("error", `Error: ${failureText(r).split("\n")[0]}`), 0, 0));
				container.addChild(new Text(fg("muted", "Task: ") + fg("dim", r.task), 0, 0));
				for (const item of r.items) {
					if (item.type === "toolCall") container.addChild(new Text(fg("muted", "→ ") + formatToolCall(item.name, item.args, fg), 0, 0));
				}
				if (r.output) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(r.output.trim(), 0, 0, mdTheme));
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) container.addChild(new Text(fg("dim", usageStr), 0, 0));
			};

			if ((details.mode === "single" || details.mode === "resume") && details.results.length === 1) {
				const r = details.results[0];
				const header = `${statusIcon(r)} ${fg("toolTitle", theme.bold(r.agent))}${fg("muted", ` (${r.agentSource})`)}${idTag(r)}`;
				if (expanded) {
					const container = new Container();
					addExpanded(container, r, header);
					return container;
				}
				let text = header;
				if (isFailedResult(r) && r.exitCode !== -1) text += `\n${fg("error", `Error: ${failureText(r).split("\n")[0]}`)}`;
				else if (r.items.length === 0) text += `\n${fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
				else {
					text += `\n${renderItems(r.items, COLLAPSED_ITEM_COUNT)}`;
					if (r.items.length > COLLAPSED_ITEM_COUNT) text += `\n${fg("muted", "(Ctrl+O to expand)")}`;
				}
				const usageStr = formatUsageStats(r.usage, r.model);
				if (usageStr) text += `\n${fg("dim", usageStr)}`;
				return new Text(text, 0, 0);
			}

			const running = details.results.filter((r) => r.exitCode === -1).length;
			const okCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedResult(r)).length;
			const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedResult(r)).length;
			const label = details.mode === "chain" ? "chain " : "parallel ";
			const icon = running > 0 ? fg("warning", "⏳") : failCount > 0 ? fg("error", "✗") : fg("success", "✓");
			const status =
				running > 0
					? `${okCount + failCount}/${details.results.length} done, ${running} running`
					: `${okCount}/${details.results.length} ${details.mode === "chain" ? "steps" : "tasks"}`;
			const titleLine = `${icon} ${fg("toolTitle", theme.bold(label))}${fg("accent", status)}`;
			const rowHeader = (r: SingleResult) =>
				`${fg("muted", details.mode === "chain" ? `─── Step ${r.step}: ` : "─── ")}${fg("accent", r.agent)} ${statusIcon(r)}${idTag(r)}`;

			if (expanded && running === 0) {
				const container = new Container();
				container.addChild(new Text(titleLine, 0, 0));
				for (const r of details.results) {
					container.addChild(new Spacer(1));
					addExpanded(container, r, rowHeader(r));
				}
				const usageStr = formatUsageStats(totalUsage(details.results));
				if (usageStr) {
					container.addChild(new Spacer(1));
					container.addChild(new Text(fg("dim", `Total: ${usageStr}`), 0, 0));
				}
				return container;
			}

			let text = titleLine;
			for (const r of details.results) {
				text += `\n\n${rowHeader(r)}`;
				if (r.items.length === 0) text += `\n${fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
				else text += `\n${renderItems(r.items, 5)}`;
			}
			if (running === 0) {
				const usageStr = formatUsageStats(totalUsage(details.results));
				if (usageStr) text += `\n\n${fg("dim", `Total: ${usageStr}`)}`;
			}
			if (!expanded) text += `\n${fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}

