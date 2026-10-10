/**
 * Running child `pi` processes and keeping their sessions for resume.
 *
 * No runtime imports from Pi, so the tests drive this exact code against a
 * fake `pi` executable.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isValidChildSessionId } from "./subagent-child.ts";

export interface ChildRunOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** The prompt, written to the child's stdin. */
	stdin: string;
	signal?: AbortSignal;
	/** 0 or undefined: no limit. */
	timeoutMs?: number;
	/** Grace period between SIGTERM and SIGKILL. */
	killGraceMs?: number;
	onEvent: (event: Record<string, unknown>) => void;
}

export interface ChildRunOutcome {
	exitCode: number | null;
	exitSignal: string | null;
	stderr: string;
	/** Set when the process could not be started. */
	spawnError?: string;
	timedOut: boolean;
	aborted: boolean;
}

const STDERR_CAP = 16 * 1024;

/**
 * Run one child to completion. Never rejects: every failure is reported in the
 * outcome. stdout is JSONL framed on LF only (Pi's JSON mode allows U+2028 and
 * U+2029 inside strings, so readline-style splitting is wrong).
 */
export function runChildProcess(opts: ChildRunOptions): Promise<ChildRunOutcome> {
	return new Promise((resolve) => {
		const outcome: ChildRunOutcome = { exitCode: null, exitSignal: null, stderr: "", timedOut: false, aborted: false };
		let settled = false;
		let timeoutTimer: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;

		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(opts.command, opts.args, {
				cwd: opts.cwd,
				env: opts.env,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
		} catch (err) {
			outcome.spawnError = err instanceof Error ? err.message : String(err);
			resolve(outcome);
			return;
		}

		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const processLine = (raw: string) => {
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			if (!line.trim()) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event && typeof event === "object") opts.onEvent(event as Record<string, unknown>);
		};
		const drain = () => {
			let nl = buffer.indexOf("\n");
			while (nl !== -1) {
				processLine(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf("\n");
			}
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			buffer += decoder.write(chunk);
			drain();
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			outcome.stderr += chunk.toString();
			if (outcome.stderr.length > STDERR_CAP) outcome.stderr = outcome.stderr.slice(-STDERR_CAP);
		});

		const stop = () => {
			if (proc.exitCode !== null || proc.signalCode !== null) return;
			proc.kill("SIGTERM");
			killTimer = setTimeout(() => {
				// `proc.killed` only says a signal was sent; check whether it actually exited.
				if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
			}, opts.killGraceMs ?? 5000);
		};
		const onAbort = () => {
			outcome.aborted = true;
			stop();
		};

		const finish = () => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (killTimer) clearTimeout(killTimer);
			opts.signal?.removeEventListener("abort", onAbort);
			buffer += decoder.end();
			drain();
			if (buffer) processLine(buffer);
			resolve(outcome);
		};

		proc.on("error", (err) => {
			outcome.spawnError = err.message;
			finish();
		});
		proc.on("close", (code, signal) => {
			outcome.exitCode = code;
			outcome.exitSignal = signal;
			finish();
		});

		if (opts.timeoutMs && opts.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				outcome.timedOut = true;
				stop();
			}, opts.timeoutMs);
		}
		if (opts.signal) {
			if (opts.signal.aborted) onAbort();
			else opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		// A child that exits before reading stdin makes the write fail with EPIPE; the close event reports it.
		proc.stdin?.on("error", () => {});
		proc.stdin?.end(opts.stdin);
	});
}

// ---------------------------------------------------------------------------
// Child session store
// ---------------------------------------------------------------------------

/**
 * What `resume` needs to reopen a child exactly as it was dispatched. Stored
 * next to the child's session file as `<id>.subagent.json`.
 */
export interface ChildSessionMeta {
	id: string;
	agent: string;
	model?: string;
	thinking?: string;
	cwd: string;
	createdAt: string;
	parentSessionId?: string;
}

const META_SUFFIX = ".subagent.json";

/** One directory per parent session, so children are found and pruned together. */
export function childSessionDir(root: string, parentSessionId: string | undefined): string {
	const safe = (parentSessionId ?? "").replace(/[^A-Za-z0-9._-]+/g, "_") || "no-parent-session";
	return path.join(root, safe);
}

export function writeChildMeta(dir: string, meta: ChildSessionMeta): void {
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(dir, `${meta.id}${META_SUFFIX}`), `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
}

/**
 * Locate a child by id: the current parent's directory first, then any other
 * parent's (a child dispatched before /new or a resume can still be continued).
 */
export function findChildSession(root: string, preferredDir: string, id: string): { dir: string; meta: ChildSessionMeta } | null {
	if (!isValidChildSessionId(id)) return null;
	const read = (dir: string) => {
		try {
			const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}${META_SUFFIX}`), "utf8")) as ChildSessionMeta;
			return meta && meta.id === id && typeof meta.agent === "string" ? { dir, meta } : null;
		} catch {
			return null;
		}
	};
	const preferred = read(preferredDir);
	if (preferred) return preferred;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		if (dir === preferredDir) continue;
		const found = read(dir);
		if (found) return found;
	}
	return null;
}

/** The child's session transcript, for diagnosing what it did. */
export function findChildSessionFile(dir: string, id: string): string | undefined {
	try {
		const match = fs.readdirSync(dir).find((f) => f.endsWith(".jsonl") && f.includes(id));
		return match ? path.join(dir, match) : undefined;
	} catch {
		return undefined;
	}
}

/** Mark a parent's child directory as used now, so pruning measures time since last use (a resume only appends to a file). */
export function touchDir(dir: string, now: Date = new Date()): void {
	try {
		fs.utimesSync(dir, now, now);
	} catch {
		/* directory vanished; the run reports its own errors */
	}
}

/** Whether `child` is `parent` or inside it (after resolving both). */
export function isPathInside(child: string, parent: string): boolean {
	const rel = path.relative(path.resolve(parent), path.resolve(child));
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Delete per-parent directories not touched for `days` days. Returns how many were removed. */
export function pruneChildSessions(root: string, days: number, now: number = Date.now()): number {
	if (days <= 0) return 0;
	let removed = 0;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	const cutoff = now - days * 24 * 60 * 60 * 1000;
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dir = path.join(root, entry.name);
		try {
			if (fs.statSync(dir).mtimeMs < cutoff) {
				fs.rmSync(dir, { recursive: true, force: true });
				removed++;
			}
		} catch {
			/* raced with another session; ignore */
		}
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Compaction recap
// ---------------------------------------------------------------------------

export interface ResumableChild {
	id: string;
	agent: string;
	/** First line of the task, capped. */
	task: string;
	failed: boolean;
}

/**
 * The subagents dispatched on this branch, newest first, read from `subagent`
 * tool results. After compaction the model no longer sees those results, so
 * this is how it keeps the ids it needs to resume children.
 */
export function collectResumableChildren(entries: Iterable<unknown>, limit = 8): ResumableChild[] {
	const byId = new Map<string, ResumableChild>();
	for (const entry of entries) {
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e?.type !== "message" || e.message?.role !== "toolResult" || e.message.toolName !== "subagent") continue;
		const results = (e.message.details as { results?: unknown } | undefined)?.results;
		if (!Array.isArray(results)) continue;
		for (const r of results as Array<Record<string, unknown>>) {
			if (typeof r?.id !== "string" || typeof r.agent !== "string") continue;
			const task = typeof r.task === "string" ? (r.task.split("\n").find((l) => l.trim()) ?? "").trim() : "";
			byId.delete(r.id); // re-insert so a resumed child counts as recent
			byId.set(r.id, {
				id: r.id,
				agent: r.agent,
				task: task.length > 100 ? `${task.slice(0, 100)}…` : task,
				failed: r.exitCode !== 0 || r.stopReason === "error" || Boolean(r.spawnError) || Boolean(r.timedOut),
			});
		}
	}
	return [...byId.values()].reverse().slice(0, limit);
}

export function buildSubagentRecap(children: ResumableChild[]): string | null {
	if (children.length === 0) return null;
	return [
		"Subagents dispatched earlier in this session (newest first). Resume one with subagent { resume: <id>, task } to continue it with its context:",
		...children.map((c) => `- ${c.id} (${c.agent}${c.failed ? ", failed" : ""}): ${c.task}`),
	].join("\n");
}
