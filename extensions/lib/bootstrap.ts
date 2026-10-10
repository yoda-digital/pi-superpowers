/**
 * Pure bootstrap helpers for the superpowers extension.
 *
 * No runtime imports from Pi: this module must load under plain Node (type
 * stripping) so the test suite exercises the real code, not a copy of it.
 */

import { readFileSync } from "node:fs";

/** Name of the system prompt section that carries the bootstrap. Pi wraps it in `<superpowers>` tags. */
export const BOOTSTRAP_SECTION = "superpowers";

/**
 * Set by the subagent tool on every child process. A child is a worker with
 * one task: it must not receive the controller's bootstrap, even if it loads
 * this package (upstream's `<SUBAGENT-STOP>` note relies on model compliance,
 * which is not reliable).
 */
export const CHILD_ENV = "PI_SUPERPOWERS_CHILD";

export function isSubagentChild(env: Record<string, string | undefined>): boolean {
	return env[CHILD_ENV] === "1";
}

export function stripFrontmatter(content: string): string {
	const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
	return (match ? match[1] : content).trim();
}

function readOptional(path: string): string | null {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
}

/**
 * Assemble the bootstrap text. Re-reads from disk on every call (no cache) so
 * that SKILL.md edits take effect on the next prompt. Unchanged text produces
 * an identical section, which Pi does not re-record, so the prompt cache holds.
 * Returns null when the bootstrap skill itself cannot be read.
 */
export function buildBootstrapContent(skillPath: string, toolMappingPath: string): string | null {
	const skill = readOptional(skillPath);
	if (skill === null) return null;
	const toolMapping = readOptional(toolMappingPath);

	return [
		"<EXTREMELY_IMPORTANT>",
		"You have superpowers.",
		"",
		"The using-superpowers skill content is included below and is already loaded for this Pi session. Follow it now. Do not try to load using-superpowers again.",
		"",
		stripFrontmatter(skill),
		...(toolMapping ? ["", toolMapping] : []),
		"</EXTREMELY_IMPORTANT>",
	].join("\n");
}
