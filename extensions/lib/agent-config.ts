/**
 * Pure agent-discovery helpers.
 *
 * No runtime imports from Pi: Pi's `parseFrontmatter`, agent dir and config dir
 * name are passed in by extensions/subagent/agents.ts, so this module loads
 * under plain Node and the tests exercise the real logic.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type AgentScope = "user" | "project" | "both";

/** Where an agent definition came from, from least to most specific. */
export type AgentSource = "package" | "user" | "project";

/** Agent definitions shipped with this package; they update with the package. */
export const PACKAGE_AGENTS_DIR = fileURLToPath(new URL("../../agents/", import.meta.url)).replace(/[\\/]$/, "");

/** Used by the subagent tool when the caller does not pass `agentScope`. */
export const DEFAULT_AGENT_SCOPE: AgentScope = "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	/** A tier name (cheap, mid, top) or "provider/id". */
	model?: string;
	/** Thinking level for this agent's children. */
	thinking?: string;
	/** `contextFiles: false` keeps AGENTS.md / CLAUDE.md out of the child. Default: loaded. */
	contextFiles?: boolean;
	systemPrompt: string;
	source: AgentSource;
	/** Set when this definition replaces one with the same name from a less specific source. */
	overrides?: AgentSource;
	filePath: string;
}

export type FrontmatterParser = (content: string) => { frontmatter: Record<string, unknown>; body: string };

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
export function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

export function loadAgentsFromDir(
	dir: string,
	source: AgentSource,
	parseFrontmatter: FrontmatterParser,
): AgentConfig[] {
	const agents: AgentConfig[] = [];

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
			contextFiles: frontmatter.contextFiles === false ? false : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

export function findNearestProjectAgentsDir(cwd: string, configDirName: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, configDirName, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/**
 * Combine agent sources for a scope. "user" = package + user agents,
 * "project" = project agents only, "both" = all three. A more specific source
 * replaces a less specific one with the same name and records what it overrode.
 */
export function mergeAgents(
	sources: { package: AgentConfig[]; user: AgentConfig[]; project: AgentConfig[] },
	scope: AgentScope,
): AgentConfig[] {
	const layers = scope === "project" ? [sources.project] : scope === "user" ? [sources.package, sources.user] : [sources.package, sources.user, sources.project];
	const byName = new Map<string, AgentConfig>();
	for (const layer of layers) {
		for (const agent of layer) {
			const prev = byName.get(agent.name);
			byName.set(agent.name, prev ? { ...agent, overrides: prev.source } : agent);
		}
	}
	return Array.from(byName.values());
}

/** "user", or "user, overrides package" — where an agent came from and what it shadows. */
export function agentOrigin(agent: Pick<AgentConfig, "source" | "overrides">): string {
	return agent.overrides ? `${agent.source}, overrides ${agent.overrides}` : agent.source;
}
