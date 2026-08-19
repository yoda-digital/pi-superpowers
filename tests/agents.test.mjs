/**
 * Tests for agent discovery logic (extensions/subagent/agents.ts).
 *
 * Since agents.ts imports from @earendil-works/pi-coding-agent, we cannot import
 * it directly. We re-implement the pure logic functions (parseToolList,
 * loadAgentsFromDir with a minimal parseFrontmatter) and test them against
 * temp directories with real .md files.
 */

import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readdirSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Re-implement pure functions from agents.ts
// ---------------------------------------------------------------------------

/**
 * Minimal YAML frontmatter parser matching what Pi's parseFrontmatter does
 * for simple key: value pairs.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const yamlBlock = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      let value = kv[2].trim();
      // Handle YAML arrays: [a, b, c]
      if (value.startsWith("[") && value.endsWith("]")) {
        value = value
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

function parseToolList(value) {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const tools = raw
    .filter((t) => typeof t === "string")
    .map((t) => t.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

function loadAgentsFromDir(dir, source) {
  const agents = [];
  if (!existsSync(dir)) return agents;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = join(dir, entry.name);
    let content;
    try {
      content = readFileSync(filePath, "utf-8");
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tempDir;

function createTempDir() {
  return mkdtempSync(join(tmpdir(), "pi-agents-test-"));
}

function writeAgent(dir, filename, frontmatter, body = "System prompt body.") {
  const lines = ["---"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      lines.push(`${k}: ${v.join(", ")}`);
    } else {
      lines.push(`${k}: ${v}`);
    }
  }
  lines.push("---");
  lines.push(body);
  writeFileSync(join(dir, filename), lines.join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseToolList", () => {
  it("parses a comma-separated string", () => {
    const result = parseToolList("Read, Bash, Grep");
    assert.deepEqual(result, ["Read", "Bash", "Grep"]);
  });

  it("parses an array of strings", () => {
    const result = parseToolList(["Read", "Bash", "Grep"]);
    assert.deepEqual(result, ["Read", "Bash", "Grep"]);
  });

  it("trims whitespace from each tool name", () => {
    const result = parseToolList("  Read , Bash ,  Grep ");
    assert.deepEqual(result, ["Read", "Bash", "Grep"]);
  });

  it("returns undefined for empty string", () => {
    assert.equal(parseToolList(""), undefined);
  });

  it("returns undefined for empty array", () => {
    assert.equal(parseToolList([]), undefined);
  });

  it("returns undefined for non-string/non-array input", () => {
    assert.equal(parseToolList(42), undefined);
    assert.equal(parseToolList(null), undefined);
    assert.equal(parseToolList(undefined), undefined);
    assert.equal(parseToolList({}), undefined);
  });

  it("filters out non-string elements in an array", () => {
    const result = parseToolList(["Read", 42, "Bash", null, "Grep"]);
    assert.deepEqual(result, ["Read", "Bash", "Grep"]);
  });

  it("filters out empty strings after splitting", () => {
    const result = parseToolList("Read,,Bash,,,Grep");
    assert.deepEqual(result, ["Read", "Bash", "Grep"]);
  });

  it("handles a single tool name", () => {
    const result = parseToolList("Read");
    assert.deepEqual(result, ["Read"]);
  });
});

describe("loadAgentsFromDir", () => {
  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads .md files with valid frontmatter", () => {
    writeAgent(tempDir, "scout.md", {
      name: "scout",
      description: "Fast codebase recon",
      tools: "Read, Bash, Grep",
      model: "claude-haiku-4-5",
    });

    const agents = loadAgentsFromDir(tempDir, "user");
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, "scout");
    assert.equal(agents[0].description, "Fast codebase recon");
    assert.deepEqual(agents[0].tools, ["Read", "Bash", "Grep"]);
    assert.equal(agents[0].model, "claude-haiku-4-5");
    assert.equal(agents[0].source, "user");
    assert.ok(agents[0].systemPrompt.includes("System prompt body"));
  });

  it("loads multiple agent files", () => {
    writeAgent(tempDir, "scout.md", {
      name: "scout",
      description: "Fast recon",
    });
    writeAgent(tempDir, "planner.md", {
      name: "planner",
      description: "Creates plans",
    });
    writeAgent(tempDir, "implementer.md", {
      name: "implementer",
      description: "Implements tasks",
    });

    const agents = loadAgentsFromDir(tempDir, "project");
    assert.equal(agents.length, 3);
    const names = agents.map((a) => a.name).sort();
    assert.deepEqual(names, ["implementer", "planner", "scout"]);
    agents.forEach((a) => assert.equal(a.source, "project"));
  });

  it("skips files without name in frontmatter", () => {
    writeAgent(tempDir, "invalid.md", {
      description: "Missing name field",
    });

    const agents = loadAgentsFromDir(tempDir, "user");
    assert.equal(agents.length, 0);
  });

  it("skips files without description in frontmatter", () => {
    writeAgent(tempDir, "invalid.md", {
      name: "orphan",
    });

    const agents = loadAgentsFromDir(tempDir, "user");
    assert.equal(agents.length, 0);
  });

  it("skips files without any frontmatter", () => {
    writeFileSync(
      join(tempDir, "nofm.md"),
      "This file has no frontmatter at all.",
      "utf-8"
    );

    const agents = loadAgentsFromDir(tempDir, "user");
    assert.equal(agents.length, 0);
  });

  it("skips non-.md files", () => {
    writeFileSync(
      join(tempDir, "readme.txt"),
      "---\nname: fake\ndescription: not an agent\n---\nBody",
      "utf-8"
    );

    const agents = loadAgentsFromDir(tempDir, "user");
    assert.equal(agents.length, 0);
  });

  it("returns empty array for non-existent directory", () => {
    const agents = loadAgentsFromDir("/tmp/does-not-exist-" + Date.now(), "user");
    assert.equal(agents.length, 0);
  });

  it("handles agent with no tools field", () => {
    writeAgent(tempDir, "notool.md", {
      name: "notool",
      description: "Agent with no tools specified",
    });

    const agents = loadAgentsFromDir(tempDir, "user");
    assert.equal(agents.length, 1);
    assert.equal(agents[0].tools, undefined);
  });

  it("handles agent with no model field", () => {
    writeAgent(tempDir, "nomodel.md", {
      name: "nomodel",
      description: "Agent with no model specified",
    });

    const agents = loadAgentsFromDir(tempDir, "user");
    assert.equal(agents.length, 1);
    assert.equal(agents[0].model, undefined);
  });

  it("preserves the body as systemPrompt", () => {
    const body =
      "You are a specialist.\n\n## Rules\n1. Do this\n2. Do that\n\n## Output\nReturn JSON.";
    writeAgent(
      tempDir,
      "specialist.md",
      { name: "specialist", description: "A specialist" },
      body
    );

    const agents = loadAgentsFromDir(tempDir, "user");
    assert.equal(agents.length, 1);
    assert.ok(agents[0].systemPrompt.includes("You are a specialist"));
    assert.ok(agents[0].systemPrompt.includes("## Rules"));
  });

  it("records the correct filePath", () => {
    writeAgent(tempDir, "pathtest.md", {
      name: "pathtest",
      description: "Path check",
    });

    const agents = loadAgentsFromDir(tempDir, "user");
    assert.equal(agents.length, 1);
    assert.equal(agents[0].filePath, join(tempDir, "pathtest.md"));
  });
});

describe("agent scope filtering (simulated discoverAgents logic)", () => {
  let userDir;
  let projectDir;

  beforeEach(() => {
    userDir = createTempDir();
    projectDir = createTempDir();

    writeAgent(userDir, "user-agent.md", {
      name: "user-agent",
      description: "From user dir",
    });
    writeAgent(projectDir, "project-agent.md", {
      name: "project-agent",
      description: "From project dir",
    });
    writeAgent(userDir, "shared.md", {
      name: "shared",
      description: "User version of shared",
    });
    writeAgent(projectDir, "shared.md", {
      name: "shared",
      description: "Project version of shared",
    });
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function discoverAgents(scope) {
    const userAgents =
      scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
    const projectAgents =
      scope === "user" ? [] : loadAgentsFromDir(projectDir, "project");

    const agentMap = new Map();

    if (scope === "both") {
      for (const a of userAgents) agentMap.set(a.name, a);
      for (const a of projectAgents) agentMap.set(a.name, a);
    } else if (scope === "user") {
      for (const a of userAgents) agentMap.set(a.name, a);
    } else {
      for (const a of projectAgents) agentMap.set(a.name, a);
    }

    return Array.from(agentMap.values());
  }

  it('scope "user" returns only user agents', () => {
    const agents = discoverAgents("user");
    assert.ok(agents.every((a) => a.source === "user"));
    const names = agents.map((a) => a.name).sort();
    assert.deepEqual(names, ["shared", "user-agent"]);
  });

  it('scope "project" returns only project agents', () => {
    const agents = discoverAgents("project");
    assert.ok(agents.every((a) => a.source === "project"));
    const names = agents.map((a) => a.name).sort();
    assert.deepEqual(names, ["project-agent", "shared"]);
  });

  it('scope "both" includes both, project overrides user for same name', () => {
    const agents = discoverAgents("both");
    const names = agents.map((a) => a.name).sort();
    assert.deepEqual(names, ["project-agent", "shared", "user-agent"]);

    const shared = agents.find((a) => a.name === "shared");
    assert.equal(shared.source, "project", "project should override user for same-named agent");
  });
});
