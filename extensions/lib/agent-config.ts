/**
 * Pure agent-discovery helpers.
 *
 * No runtime imports from Pi: Pi's `parseFrontmatter`, agent dir and config dir
 * name are passed in by extensions/subagent/agents.ts, so this module loads
 * under plain Node and the tests exercise the real logic.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type AgentScope = "user" | "project" | "both";

/** Used by the subagent tool when the caller does not pass `agentScope`. */
export const DEFAULT_AGENT_SCOPE: AgentScope = "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
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
	source: "user" | "project",
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

/** Project agents override user agents with the same name when scope is "both". */
export function mergeAgentsByScope(
	userAgents: AgentConfig[],
	projectAgents: AgentConfig[],
	scope: AgentScope,
): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();
	if (scope !== "project") for (const agent of userAgents) agentMap.set(agent.name, agent);
	if (scope !== "user") for (const agent of projectAgents) agentMap.set(agent.name, agent);
	return Array.from(agentMap.values());
}
