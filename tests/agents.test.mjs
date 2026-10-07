/**
 * Tests for agent discovery (extensions/lib/agent-config.ts).
 *
 * agents.ts wires these helpers to Pi's runtime (getAgentDir, parseFrontmatter,
 * CONFIG_DIR_NAME). The helpers take those as parameters, so the tests run the
 * real discovery logic and inject only the frontmatter parser.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_AGENT_SCOPE,
  findNearestProjectAgentsDir,
  loadAgentsFromDir,
  mergeAgentsByScope,
  parseToolList,
} from "../extensions/lib/agent-config.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Minimal stand-in for Pi's parseFrontmatter: flat `key: value` and `[a, b]` lists. */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
    }
    frontmatter[kv[1]] = value;
  }
  return { frontmatter, body: match[2] };
}

function writeAgent(dir, file, fields, body = "System prompt body.") {
  const fm = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  writeFileSync(join(dir, file), `---\n${fm}\n---\n${body}\n`);
}

let tempDir;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "sp-agents-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("parseToolList", () => {
  it("accepts comma-separated strings and arrays", () => {
    assert.deepEqual(parseToolList("read, bash ,grep"), ["read", "bash", "grep"]);
    assert.deepEqual(parseToolList(["read", "bash"]), ["read", "bash"]);
  });

  it("drops empty and non-string entries", () => {
    assert.deepEqual(parseToolList(["read", 3, "", " ls "]), ["read", "ls"]);
    assert.deepEqual(parseToolList("read,,"), ["read"]);
  });

  it("returns undefined when nothing usable remains", () => {
    assert.equal(parseToolList(""), undefined);
    assert.equal(parseToolList([]), undefined);
    assert.equal(parseToolList(42), undefined);
    assert.equal(parseToolList({ a: 1 }), undefined);
  });
});

describe("loadAgentsFromDir", () => {
  it("loads name, description, tools, model, body and file path", () => {
    writeAgent(tempDir, "scout.md", { name: "scout", description: "Recon", tools: "read, bash", model: "x/y" }, "Body text");
    const [a, ...rest] = loadAgentsFromDir(tempDir, "user", parseFrontmatter);
    assert.equal(rest.length, 0);
    assert.equal(a.name, "scout");
    assert.equal(a.description, "Recon");
    assert.deepEqual(a.tools, ["read", "bash"]);
    assert.equal(a.model, "x/y");
    assert.equal(a.source, "user");
    assert.equal(a.filePath, join(tempDir, "scout.md"));
    assert.match(a.systemPrompt, /Body text/);
  });

  it("leaves tools and model undefined when absent", () => {
    writeAgent(tempDir, "a.md", { name: "a", description: "d" });
    const [a] = loadAgentsFromDir(tempDir, "project", parseFrontmatter);
    assert.equal(a.tools, undefined);
    assert.equal(a.model, undefined);
    assert.equal(a.source, "project");
  });

  it("skips files missing name or description, non-.md files and directories", () => {
    writeAgent(tempDir, "noname.md", { description: "d" });
    writeAgent(tempDir, "nodesc.md", { name: "n" });
    writeFileSync(join(tempDir, "plain.md"), "no frontmatter at all");
    writeAgent(tempDir, "notes.txt", { name: "t", description: "d" });
    mkdirSync(join(tempDir, "dir.md"));
    writeAgent(tempDir, "ok.md", { name: "ok", description: "d" });
    assert.deepEqual(loadAgentsFromDir(tempDir, "user", parseFrontmatter).map((a) => a.name), ["ok"]);
  });

  it("returns [] for a missing directory", () => {
    assert.deepEqual(loadAgentsFromDir(join(tempDir, "missing"), "user", parseFrontmatter), []);
  });
});

describe("mergeAgentsByScope", () => {
  const u = (name) => ({ name, source: "user" });
  const p = (name) => ({ name, source: "project" });

  it('"user" and "project" return only their own agents', () => {
    assert.deepEqual(mergeAgentsByScope([u("a")], [p("b")], "user").map((a) => a.name), ["a"]);
    assert.deepEqual(mergeAgentsByScope([u("a")], [p("b")], "project").map((a) => a.name), ["b"]);
  });

  it('"both" merges, and a project agent overrides a user agent of the same name', () => {
    const merged = mergeAgentsByScope([u("a"), u("shared")], [p("shared"), p("b")], "both");
    assert.deepEqual(merged.map((a) => `${a.name}:${a.source}`).sort(), ["a:user", "b:project", "shared:project"]);
  });
});

describe("findNearestProjectAgentsDir", () => {
  it("walks up from cwd to the nearest <configDir>/agents", () => {
    const agentsDir = join(tempDir, ".pi", "agents");
    const deep = join(tempDir, "src", "nested");
    mkdirSync(agentsDir, { recursive: true });
    mkdirSync(deep, { recursive: true });
    assert.equal(findNearestProjectAgentsDir(deep, ".pi"), agentsDir);
  });

  it("returns null when there is none", () => {
    assert.equal(findNearestProjectAgentsDir(tempDir, ".definitely-not-a-config-dir"), null);
  });
});

describe("default agent scope", () => {
  it('is "both"', () => {
    assert.equal(DEFAULT_AGENT_SCOPE, "both");
  });
});

describe("shipped agent definitions", () => {
  const agents = loadAgentsFromDir(join(projectRoot, "agents"), "user", parseFrontmatter);

  it("all load", () => {
    assert.deepEqual(
      agents.map((a) => a.name).sort(),
      ["debugger", "implementer", "planner", "researcher", "reviewer", "scout"],
    );
  });

  it("each carries a real system prompt body", () => {
    for (const a of agents) assert.ok(a.systemPrompt.trim().length > 200, `${a.name} body too short`);
  });

  it("none pins a model (agents inherit the parent session's model)", () => {
    for (const a of agents) assert.equal(a.model, undefined, `${a.name} pins a model`);
  });
});
