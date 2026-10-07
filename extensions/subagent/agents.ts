/**
 * Agent discovery and configuration
 *
 * Standalone extension version — adapted from Pi's example extension.
 * Discovers agent definitions from the user directory (~/.pi/agent/agents/)
 * and the nearest project directory (.pi/agents/), parses frontmatter, and
 * returns typed configs. The logic lives in ../lib/agent-config.ts; this file
 * only binds it to Pi's runtime.
 */

import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	type AgentConfig,
	type AgentScope,
	findNearestProjectAgentsDir,
	loadAgentsFromDir,
	mergeAgentsByScope,
} from "../lib/agent-config.ts";

export { type AgentConfig, type AgentScope, DEFAULT_AGENT_SCOPE } from "../lib/agent-config.ts";

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

export function getUserAgentsDir(): string {
	return path.join(getAgentDir(), "agents");
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const projectAgentsDir = findNearestProjectAgentsDir(cwd, CONFIG_DIR_NAME);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(getUserAgentsDir(), "user", parseFrontmatter);
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project", parseFrontmatter);

	return { agents: mergeAgentsByScope(userAgents, projectAgents, scope), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
