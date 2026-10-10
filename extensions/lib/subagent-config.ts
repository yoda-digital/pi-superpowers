/**
 * Subagent settings and model selection.
 *
 * No runtime imports from Pi, so the tests exercise this exact code.
 *
 * Superpowers skills choose a model per dispatch by capability: a cheap/fast
 * model for mechanical work, a standard one for most tasks and reviews, the
 * most capable one for architecture and final reviews. Pi has no such tiers,
 * so this package maps three aliases to concrete models you already run:
 *
 *     ~/.pi/agent/superpowers/subagents.json
 *     {
 *       "tiers": { "cheap": "ollama/qwen3:8b", "mid": "ollama/qwen3:32b", "top": "ollama/qwen3:32b" },
 *       "concurrency": 2,
 *       "timeoutMinutes": 60
 *     }
 *
 * An unset tier falls back to the parent session's model, so a single-model
 * setup works without any configuration.
 */

import { readFileSync } from "node:fs";

export const TIERS = ["cheap", "mid", "top"] as const;
export type Tier = (typeof TIERS)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface SubagentSettings {
	tiers: Partial<Record<Tier, string>>;
	/** Children running at once in parallel mode. */
	concurrency: number;
	/** Tasks accepted by one parallel call. */
	maxParallelTasks: number;
	/** Wall-clock limit per child; 0 disables it. */
	timeoutMinutes: number;
	/** Child sessions (kept for `resume`) older than this are deleted at session start. 0 keeps them. */
	sessionRetentionDays: number;
}

export const DEFAULT_SETTINGS: SubagentSettings = {
	tiers: {},
	concurrency: 4,
	maxParallelTasks: 8,
	timeoutMinutes: 60,
	sessionRetentionDays: 14,
};

function positiveInt(value: unknown, fallback: number, { allowZero = false } = {}): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const n = Math.floor(value);
	return n > 0 || (allowZero && n === 0) ? n : fallback;
}

/** Validate a parsed settings object; unknown or malformed fields fall back to defaults. */
export function normalizeSettings(raw: unknown): SubagentSettings {
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const tiers: Partial<Record<Tier, string>> = {};
	const rawTiers = obj.tiers && typeof obj.tiers === "object" ? (obj.tiers as Record<string, unknown>) : {};
	for (const tier of TIERS) {
		const value = rawTiers[tier];
		if (typeof value === "string" && value.trim()) tiers[tier] = value.trim();
	}
	return {
		tiers,
		concurrency: positiveInt(obj.concurrency, DEFAULT_SETTINGS.concurrency),
		maxParallelTasks: positiveInt(obj.maxParallelTasks, DEFAULT_SETTINGS.maxParallelTasks),
		timeoutMinutes: positiveInt(obj.timeoutMinutes, DEFAULT_SETTINGS.timeoutMinutes, { allowZero: true }),
		sessionRetentionDays: positiveInt(obj.sessionRetentionDays, DEFAULT_SETTINGS.sessionRetentionDays, {
			allowZero: true,
		}),
	};
}

/**
 * Read the settings file. A missing file means defaults; a broken one is
 * reported through `error` instead of silently ignored.
 */
export function loadSettings(filePath: string): { settings: SubagentSettings; error?: string } {
	let text: string;
	try {
		text = readFileSync(filePath, "utf8");
	} catch {
		return { settings: { ...DEFAULT_SETTINGS, tiers: {} } };
	}
	try {
		return { settings: normalizeSettings(JSON.parse(text)) };
	} catch (err) {
		return {
			settings: { ...DEFAULT_SETTINGS, tiers: {} },
			error: `${filePath}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
}

export function isTier(value: string): value is Tier {
	return (TIERS as readonly string[]).includes(value);
}

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVELS as readonly string[]).includes(value);
}

export interface ModelChoice {
	/** "provider/id" to pass to the child, or undefined to let the child use its settings.json default. */
	model?: string;
	thinking?: string;
	/** Where the model came from, for the result footer. */
	source: "dispatch" | "agent" | "parent" | "child-default";
	/** Set when a tier was requested but is not configured. */
	note?: string;
}

export interface ModelRequest {
	/** `model` passed to this dispatch: a tier name or "provider/id". */
	requested?: string;
	/** `thinking` passed to this dispatch. */
	requestedThinking?: string;
	/** The agent definition's `model` frontmatter: a tier name or "provider/id". */
	agentModel?: string;
	/** The agent definition's `thinking` frontmatter. */
	agentThinking?: string;
	parentModel?: string;
	parentThinking?: string;
	tiers: Partial<Record<Tier, string>>;
	/** Lean prompt mode: without an explicit choice, the child resolves its own model. */
	lean?: boolean;
}

/**
 * Decide which model and thinking level a child runs with.
 *
 * Precedence: dispatch `model` > agent `model` > parent session model. Tier
 * aliases resolve through settings; an unset tier falls back to the parent
 * model and says so. Thinking: dispatch `thinking` > agent `thinking` > the
 * parent's level, which is inherited only when the child runs the parent's
 * model (a level chosen for one model can be wrong for another).
 */
export function resolveModelChoice(req: ModelRequest): ModelChoice {
	const notes: string[] = [];
	const resolveAlias = (value: string): string | undefined => {
		if (!isTier(value)) return value;
		const mapped = req.tiers[value];
		if (!mapped) notes.push(`tier "${value}" is not configured; using the parent session's model`);
		return mapped;
	};

	let model: string | undefined;
	let source: ModelChoice["source"];
	const requested = req.requested?.trim();
	const agentModel = req.agentModel?.trim();
	if (requested) {
		model = resolveAlias(requested);
		source = model ? "dispatch" : "parent";
	} else if (agentModel) {
		model = resolveAlias(agentModel);
		source = model ? "agent" : "parent";
	} else {
		source = "parent";
	}

	if (!model) {
		if (req.lean && source === "parent" && !requested && !agentModel) {
			return { source: "child-default", thinking: req.requestedThinking || req.agentThinking || undefined };
		}
		model = req.parentModel;
		if (!model) source = "child-default";
	}

	const usesParentModel = model !== undefined && model === req.parentModel;
	const thinking =
		req.requestedThinking?.trim() ||
		req.agentThinking?.trim() ||
		(usesParentModel && !req.lean ? req.parentThinking : undefined) ||
		undefined;

	return { model, thinking, source, ...(notes.length ? { note: notes.join("; ") } : {}) };
}
