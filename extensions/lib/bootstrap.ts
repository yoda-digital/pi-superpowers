/**
 * Pure bootstrap helpers for the superpowers extension.
 *
 * No runtime imports from Pi: this module must load under plain Node (type
 * stripping) so the test suite exercises the real code, not a copy of it.
 */

import { readFileSync } from "node:fs";

/**
 * The tag the bootstrap wraps its content in. Also used as the dedup signal:
 * if any message in the conversation already contains this tag, the bootstrap
 * has already been injected and should not be duplicated.
 */
export const EXTREMELY_IMPORTANT_TAG = "<EXTREMELY_IMPORTANT>";

/** Used only when references/pi-tools.md cannot be read. Keep it consistent with that file. */
export const INLINE_TOOL_MAPPING = `## Pi tool mapping

Pi has native skills but does not expose Claude Code's \`Skill\` tool. When a Superpowers instruction says to invoke a skill, load the relevant \`SKILL.md\` with \`read\`, or let a human invoke \`/skill:name\`.

Pi's built-in coding tools are lowercase: \`read\`, \`write\`, \`edit\`, \`bash\`, \`grep\`, \`find\`, and \`ls\`. Use them to read a file, create or edit files, run shell commands, search file contents, find files by name, and list directories.

Pi has no dedicated worktree tools. When a Superpowers instruction calls for an isolated worktree, run \`git worktree add\` / \`git worktree remove\` through \`bash\`.

Pi does not ship web search or web fetch tools. If an extension or MCP server provides web access, use it; otherwise say the capability is missing rather than fabricating calls.

Use this package's \`subagent\` tool for Superpowers subagent workflows. If it is not available, do the work in this session instead of inventing \`Task\` calls.

Use this package's \`todo\` tool for task tracking. If it is not available, track work in plan files or a repo-local \`TODO.md\`. Treat older \`TodoWrite\` references as this task-tracking action.`;

export function stripFrontmatter(content: string): string {
	const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
	return (match ? match[1] : content).trim();
}

function loadToolMapping(toolMappingPath: string): string {
	try {
		return readFileSync(toolMappingPath, "utf8").trim();
	} catch {
		return INLINE_TOOL_MAPPING;
	}
}

/**
 * Assemble the bootstrap text. Re-reads from disk on every call (no cache) so
 * that SKILL.md edits during a session take effect immediately.
 * Returns null when the bootstrap skill itself cannot be read.
 */
export function buildBootstrapContent(skillPath: string, toolMappingPath: string): string | null {
	let skillBody: string;
	try {
		skillBody = stripFrontmatter(readFileSync(skillPath, "utf8"));
	} catch {
		return null;
	}

	return `${EXTREMELY_IMPORTANT_TAG}

You have superpowers.

The using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.

${skillBody}

${loadToolMapping(toolMappingPath)}
</EXTREMELY_IMPORTANT>`;
}

/** Dedup check: does this message already carry the bootstrap tag? */
export function messageContainsBootstrap(message: unknown): boolean {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content.includes(EXTREMELY_IMPORTANT_TAG);
	if (!Array.isArray(content)) return false;
	return content.some((part: unknown) => {
		if (!part || typeof part !== "object") return false;
		const typed = part as { type?: unknown; text?: unknown };
		return typed.type === "text" && typeof typed.text === "string" && typed.text.includes(EXTREMELY_IMPORTANT_TAG);
	});
}

export function firstNonCompactionSummaryIndex(messages: unknown[]): number {
	let index = 0;
	while (
		index < messages.length &&
		(messages[index] as { role?: unknown } | undefined)?.role === "compactionSummary"
	) {
		index += 1;
	}
	return index;
}
