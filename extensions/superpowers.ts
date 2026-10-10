import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BOOTSTRAP_SECTION, buildBootstrapContent, isSubagentChild } from "./lib/bootstrap.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bootstrapSkillPath = resolve(packageRoot, "skills", "using-superpowers", "SKILL.md");
const piToolsReferencePath = resolve(packageRoot, "references", "pi-tools.md");

/**
 * Puts the using-superpowers bootstrap into the system prompt as its own
 * section. Skills are registered by the package manifest (`pi.skills`).
 *
 * Pi rebuilds the prompt options for every run, so the section is set on every
 * `before_agent_start`. Pi records the prompt in the session and replays it
 * after compaction, resume and branch navigation; an unchanged section is not
 * re-recorded and keeps the provider's prompt cache warm.
 */
export default function superpowersPiExtension(pi: ExtensionAPI): void {
	if (isSubagentChild(process.env)) return;

	pi.on("before_agent_start", (event) => {
		const bootstrap = buildBootstrapContent(bootstrapSkillPath, piToolsReferencePath);
		if (bootstrap) event.systemPromptOptions.sections[BOOTSTRAP_SECTION] = bootstrap;
		else delete event.systemPromptOptions.sections[BOOTSTRAP_SECTION];
	});
}
