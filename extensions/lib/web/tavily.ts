/**
 * Tavily REST client and API-key storage for the web tools.
 * https://docs.tavily.com/documentation/api-reference
 *
 * No runtime imports from Pi, so the tests exercise this exact code.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const API = "https://api.tavily.com";
const TIMEOUT_MS = 90_000;

export const TAVILY_KEY_ENV = "TAVILY_API_KEY";

export class TavilyError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(status ? `Tavily API error ${status}: ${message}` : message);
		this.status = status;
	}
}

/** Missing or invalid configuration; the message tells the user how to fix it. */
export class WebConfigError extends Error {}

/** Where /web-key stores the key: <agentDir>/superpowers/tavily.env */
export function tavilyKeyFile(agentDir: string): string {
	return join(agentDir, "superpowers", "tavily.env");
}

/** TAVILY_API_KEY from the environment, else from the key file. */
export function resolveTavilyKey(env: Record<string, string | undefined>, keyFile: string): string {
	const fromEnv = env[TAVILY_KEY_ENV]?.trim();
	if (fromEnv) return fromEnv;
	try {
		for (const line of readFileSync(keyFile, "utf8").split("\n")) {
			const m = line.match(/^\s*TAVILY_API_KEY\s*=\s*(.*?)\s*$/);
			if (m?.[1]) return m[1].replace(/^(['"])(.*)\1$/, "$2");
		}
	} catch {
		/* fall through */
	}
	throw new WebConfigError(
		`No Tavily API key configured. Run /web-key in Pi, set ${TAVILY_KEY_ENV}, or put "${TAVILY_KEY_ENV}=tvly-..." in ${keyFile}. Get a key at https://app.tavily.com.`,
	);
}

export function saveTavilyKey(keyFile: string, key: string): void {
	const trimmed = key.trim();
	if (!/^tvly-[A-Za-z0-9_-]+$/.test(trimmed)) throw new WebConfigError('A Tavily API key starts with "tvly-".');
	const dir = dirname(keyFile);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	writeFileSync(keyFile, `# Tavily API key for pi-superpowers web tools\n${TAVILY_KEY_ENV}=${trimmed}\n`, { mode: 0o600 });
	chmodSync(keyFile, 0o600);
}

// ---------------------------------------------------------------------------

export interface TavilyResult {
	title?: string;
	url: string;
	content?: string;
	score?: number;
	published_date?: string;
	raw_content?: string;
}

export interface TavilySearchResponse {
	query?: string;
	answer?: string | null;
	results?: TavilyResult[];
}

export interface TavilyExtractResponse {
	results?: Array<{ url: string; raw_content?: string }>;
	failed_results?: Array<{ url: string; error: string }>;
}

export interface TavilyClient {
	search(body: Record<string, unknown>, signal?: AbortSignal): Promise<TavilySearchResponse>;
	extract(body: Record<string, unknown>, signal?: AbortSignal): Promise<TavilyExtractResponse>;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
	text(): Promise<string>;
}>;

function errorMessage(body: unknown, fallback: string): string {
	const b = body as { detail?: unknown; error?: unknown } | undefined;
	const d = b?.detail as { error?: unknown } | string | undefined;
	if (typeof d === "object" && typeof d?.error === "string") return d.error;
	if (typeof d === "string") return d;
	if (typeof b?.error === "string") return b.error;
	return fallback;
}

export function createTavilyClient(opts: { fetch: FetchLike; apiKey: string }): TavilyClient {
	async function call(endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const timeout = AbortSignal.timeout(TIMEOUT_MS);
		let res;
		try {
			res = await opts.fetch(`${API}/${endpoint}`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
				body: JSON.stringify(body),
				signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
			});
		} catch (err) {
			throw new TavilyError(0, `Tavily ${endpoint} request failed: ${(err as Error).message}`);
		}
		if (!res.ok) {
			let text = "";
			let payload: unknown;
			try {
				text = await res.text();
				payload = JSON.parse(text);
			} catch {
				/* keep raw text */
			}
			throw new TavilyError(res.status, errorMessage(payload, text || "no details"));
		}
		return res.json();
	}

	return {
		search: (body, signal) => call("search", body, signal) as Promise<TavilySearchResponse>,
		extract: (body, signal) => call("extract", body, signal) as Promise<TavilyExtractResponse>,
	};
}
