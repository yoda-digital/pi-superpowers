/**
 * Agent discovery and configuration
 *
 * Standalone extension version — adapted from Pi's example extension.
 * Discovers agent definitions from this package's agents/ directory, the user
 * directory (~/.pi/agent/agents/) and the nearest project directory
 * (.pi/agents/), parses frontmatter, and returns typed configs. The logic
 * lives in ../lib/agent-config.ts; this file only binds it to Pi's runtime.
 */

import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	agentOrigin,
	type AgentScope,
	findNearestProjectAgentsDir,
	loadAgentsFromDir,
	mergeAgents,
	PACKAGE_AGENTS_DIR,
} from "../lib/agent-config.ts";

export {
	type AgentConfig,
	agentOrigin,
	type AgentScope,
	type AgentSource,
	DEFAULT_AGENT_SCOPE,
} from "../lib/agent-config.ts";

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export function getUserAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const projectAgentsDir = findNearestProjectAgentsDir(cwd, CONFIG_DIR_NAME);

	const sources = {
		package: scope === "project" ? [] : loadAgentsFromDir(PACKAGE_AGENTS_DIR, "package", parseFrontmatter),
		user: scope === "project" ? [] : loadAgentsFromDir(getUserAgentsDir(), "user", parseFrontmatter),
		project: scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", parseFrontmatter),
	};
	return { agents: mergeAgents(sources, scope), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${agentOrigin(a)}): ${a.description}`).join("; "),
		remaining,
	};
}
