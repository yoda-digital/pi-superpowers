#!/usr/bin/env node
/**
 * Skill-activation evals against a real `pi` and model.
 *
 *   node scripts/eval-skills.mjs                 # all cases, the default model
 *   node scripts/eval-skills.mjs --model ollama/qwen3:32b --case react-todo
 *   node scripts/eval-skills.mjs --runs 3        # repeat each case; reports a pass rate
 *
 * Each case runs `pi --mode json -p` in a fresh temporary project (with this
 * package loaded the way it is installed) and grades two things:
 *   - every request to the model carried the bootstrap (a probe extension
 *     records it; independent of what the model then does);
 *   - the tool-call trace: a skill counts as used when its SKILL.md is read
 *     before the first file change.
 * Slow and model-dependent by nature, so it is not part of `npm test`; the
 * grading logic is (tests/eval-grading.test.mjs).
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Tools that change files. A bash call is not counted: it is usually a read (ls, cat, git status). */
const WRITE_TOOLS = new Set(["write", "edit"]);

/** Tool calls in order, from `pi --mode json` events. */
export function toolCalls(events) {
	const calls = [];
	for (const e of events) {
		if (e?.type !== "message_end" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
		for (const part of e.message.content) {
			if (part?.type === "toolCall") calls.push({ name: part.name, args: part.arguments ?? {} });
		}
	}
	return calls;
}

/** Name of the skill a call loads, if any (`read` of …/<skill>/SKILL.md, or a bash cat of it). */
export function skillLoaded(call) {
	const text =
		call.name === "read" ? String(call.args.path ?? call.args.file_path ?? "") : call.name === "bash" ? String(call.args.command ?? "") : "";
	const m = text.match(/([a-z0-9-]+)\/SKILL\.md\b/);
	return m ? m[1] : undefined;
}

/**
 * Loaded into each eval run with -e: records, for every request Pi sends to the
 * model, whether the Superpowers bootstrap section is in it. This is the
 * model-independent invariant; skill loading is the behavioral one, and a
 * capable model can load brainstorming from Pi's skill list alone.
 */
const PROBE_EXTENSION = `import { appendFileSync } from "node:fs";
export default function (pi) {
	pi.on("before_provider_request", (event) => {
		const body = JSON.stringify(event.payload ?? {});
		appendFileSync(process.env.SP_EVAL_PROBE, (body.includes("You have superpowers.") ? "1" : "0") + "\\n");
	});
}
`;

/** Every model request carried the bootstrap (probe lines, one per request). */
export function gradeBootstrapProbe(lines) {
	const requests = lines.filter((l) => l === "0" || l === "1");
	const missing = requests.filter((l) => l === "0").length;
	if (requests.length === 0) return ["no model request was recorded"];
	return missing > 0 ? [`bootstrap missing from ${missing} of ${requests.length} model requests`] : [];
}

/** Events after the last user message: earlier prompts of a case are setup, only the last is graded. */
export function lastPromptEvents(events) {
	let start = 0;
	events.forEach((e, i) => {
		if (e?.type === "message_end" && e.message?.role === "user") start = i + 1;
	});
	return events.slice(start);
}

/**
 * Grade one run.
 * expect.skill: this skill must be loaded before the first write/edit.
 * expect.noWrites: no write/edit at all (a question that needs no changes).
 */
export function gradeRun(events, expect) {
	const calls = toolCalls(events);
	const firstWrite = calls.findIndex((c) => WRITE_TOOLS.has(c.name));
	const loaded = calls.map(skillLoaded).filter(Boolean);
	const loadedBeforeWrite = (firstWrite === -1 ? calls : calls.slice(0, firstWrite)).map(skillLoaded).filter(Boolean);
	const reasons = [];
	if (expect.skill && !loadedBeforeWrite.includes(expect.skill)) {
		reasons.push(
			loaded.includes(expect.skill)
				? `${expect.skill} loaded only after the first file change`
				: `${expect.skill} never loaded (loaded: ${loaded.join(", ") || "none"})`,
		);
	}
	if (expect.noWrites && firstWrite !== -1) reasons.push(`changed files with ${calls[firstWrite].name}`);
	return { pass: reasons.length === 0, reasons, loaded, toolCalls: calls.length };
}

/** The evals. `setup` prepares the temporary project; `prompts` run in one pi process, in order. */
export const CASES = [
	{
		name: "react-todo",
		why: "upstream acceptance test: brainstorming before any code",
		prompts: ["Let's make a react todo list"],
		expect: { skill: "brainstorming" },
	},
	{
		name: "second-prompt",
		why: "the bootstrap must still be there after the first exchange",
		prompts: ["Hi! Just say hello back, nothing else.", "Let's build a small CLI tool that renames photos by their EXIF date."],
		expect: { skill: "brainstorming" },
	},
	{
		name: "failing-test",
		why: "a failing test triggers systematic-debugging before any edit",
		setup(dir) {
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "calc", type: "module", scripts: { test: "node --test" } }, null, 2));
			writeFileSync(join(dir, "sum.js"), "export const sum = (a, b) => a - b;\n");
			writeFileSync(
				join(dir, "sum.test.js"),
				'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.js";\ntest("adds", () => assert.equal(sum(2, 3), 5));\n',
			);
		},
		prompts: ["`npm test` fails in this project. Find out why and fix it."],
		expect: { skill: "systematic-debugging" },
	},
	{
		name: "near-miss",
		why: "a plain question gets an answer, not a workflow that changes files",
		prompts: ["In one sentence: what does `git stash` do?"],
		expect: { noWrites: true },
	},
];

function runPi(args, prompt, cwd, timeoutMs, env) {
	return new Promise((resolve) => {
		const proc = spawn("pi", args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
		const events = [];
		let buf = "";
		let stderr = "";
		proc.stdout.on("data", (d) => {
			buf += d.toString();
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				try {
					events.push(JSON.parse(line));
				} catch {
					/* not JSON */
				}
				nl = buf.indexOf("\n");
			}
		});
		proc.stderr.on("data", (d) => (stderr += d.toString()));
		const timer = setTimeout(() => proc.kill("SIGKILL"), timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(timer);
			resolve({ events, code, stderr });
		});
		proc.stdin.end(prompt);
	});
}

async function runCase(c, { model, timeoutMs }) {
	const dir = mkdtempSync(join(tmpdir(), `sp-eval-${c.name}-`));
	try {
		mkdirSync(join(dir, "project"));
		const project = join(dir, "project");
		c.setup?.(project);
		const probe = join(dir, "probe.mjs");
		const probeLog = join(dir, "probe.log");
		writeFileSync(probe, PROBE_EXTENSION);
		const args = ["--mode", "json", "-p", "-e", probe, "--session-dir", join(dir, "sessions"), "--no-approve"];
		if (model) args.push("--model", model);
		// One process for all prompts, each a positional message run in order, so later prompts
		// test the same running session. (Piped stdin would be merged into the first prompt.)
		const r = await runPi([...args, ...c.prompts], "", project, timeoutMs, { SP_EVAL_PROBE: probeLog });
		if (r.code !== 0) return { pass: false, reasons: [`pi exited ${r.code}: ${r.stderr.trim().split("\n").pop()}`], loaded: [] };
		const graded = gradeRun(lastPromptEvents(r.events), c.expect);
		const probeReasons = gradeBootstrapProbe(existsSync(probeLog) ? readFileSync(probeLog, "utf8").split("\n") : []);
		return { ...graded, pass: graded.pass && probeReasons.length === 0, reasons: [...probeReasons, ...graded.reasons] };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

async function main() {
	const argv = process.argv.slice(2);
	const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
	const model = opt("--model");
	const only = opt("--case");
	const runs = Number(opt("--runs") ?? 1);
	const timeoutMs = Number(opt("--timeout-min") ?? 15) * 60_000;
	const cases = CASES.filter((c) => !only || c.name === only);
	if (cases.length === 0) {
		console.error(`No case named "${only}". Cases: ${CASES.map((c) => c.name).join(", ")}`);
		process.exit(2);
	}

	let failed = 0;
	for (const c of cases) {
		let passes = 0;
		const notes = [];
		for (let i = 0; i < runs; i++) {
			const r = await runCase(c, { model, timeoutMs });
			if (r.pass) passes++;
			else notes.push(r.reasons.join("; "));
		}
		if (passes < runs) failed++;
		const mark = passes === runs ? "PASS" : passes === 0 ? "FAIL" : "FLAKY";
		console.log(`${mark}  ${c.name}  ${passes}/${runs}  — ${c.why}`);
		for (const n of new Set(notes)) console.log(`      ${n}`);
	}
	process.exit(failed > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
