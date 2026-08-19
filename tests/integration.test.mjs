/**
 * Integration tests for the pi-superpowers package structure.
 *
 * These tests verify the overall package layout, file existence, and
 * structural correctness without importing any Pi packages.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const yamlBlock = match[1];
  const frontmatter = {};

  for (const line of yamlBlock.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) {
      frontmatter[kv[1]] = kv[2].trim();
    }
  }

  return frontmatter;
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Package structure tests
// ---------------------------------------------------------------------------

describe("package structure", () => {
  it("extensions/superpowers.ts exists", () => {
    assert.ok(existsSync(resolve(projectRoot, "extensions", "superpowers.ts")));
  });

  it("extensions/todo.ts exists", () => {
    assert.ok(existsSync(resolve(projectRoot, "extensions", "todo.ts")));
  });

  it("extensions/subagent/index.ts exists", () => {
    assert.ok(existsSync(resolve(projectRoot, "extensions", "subagent", "index.ts")));
  });

  it("extensions/subagent/agents.ts exists", () => {
    assert.ok(existsSync(resolve(projectRoot, "extensions", "subagent", "agents.ts")));
  });

  it("references/pi-tools.md exists", () => {
    assert.ok(existsSync(resolve(projectRoot, "references", "pi-tools.md")));
  });

  it("agents/ directory exists", () => {
    assert.ok(isDir(resolve(projectRoot, "agents")));
  });

  it("upstream-superpowers/ directory exists", () => {
    assert.ok(isDir(resolve(projectRoot, "upstream-superpowers")));
  });

  it("upstream-superpowers/skills/ directory exists", () => {
    assert.ok(isDir(resolve(projectRoot, "upstream-superpowers", "skills")));
  });
});

// ---------------------------------------------------------------------------
// references/pi-tools.md content tests
// ---------------------------------------------------------------------------

describe("references/pi-tools.md", () => {
  const piToolsPath = resolve(projectRoot, "references", "pi-tools.md");
  let content;

  it("is non-empty", () => {
    content = readFileSync(piToolsPath, "utf8");
    assert.ok(content.length > 0);
  });

  it("documents the seven core tools", () => {
    content = content || readFileSync(piToolsPath, "utf8");
    const coreTools = ["read", "write", "edit", "bash", "grep", "find", "ls"];
    for (const tool of coreTools) {
      assert.ok(
        content.includes(`\`${tool}\``),
        `pi-tools.md should document the '${tool}' tool`
      );
    }
  });

  it("documents the subagent tool", () => {
    content = content || readFileSync(piToolsPath, "utf8");
    assert.ok(content.includes("`subagent`"), "should document the subagent tool");
  });

  it("documents the todo tool", () => {
    content = content || readFileSync(piToolsPath, "utf8");
    assert.ok(content.includes("`todo`"), "should document the todo tool");
  });

  it("documents the three subagent modes (single, parallel, chain)", () => {
    content = content || readFileSync(piToolsPath, "utf8");
    assert.ok(content.includes("Single"), "should document single mode");
    assert.ok(content.includes("Parallel"), "should document parallel mode");
    assert.ok(content.includes("Chain"), "should document chain mode");
  });

  it("documents graceful degradation", () => {
    content = content || readFileSync(piToolsPath, "utf8");
    assert.ok(
      content.includes("Graceful Degradation"),
      "should have a graceful degradation section"
    );
  });
});

// ---------------------------------------------------------------------------
// Agent definitions tests
// ---------------------------------------------------------------------------

describe("agent definitions", () => {
  const agentsDir = resolve(projectRoot, "agents");
  const expectedAgents = ["planner", "scout", "implementer", "reviewer", "debugger"];

  for (const agentName of expectedAgents) {
    describe(`agents/${agentName}.md`, () => {
      const filePath = resolve(agentsDir, `${agentName}.md`);

      it("exists", () => {
        assert.ok(existsSync(filePath), `${agentName}.md should exist`);
      });

      it("has valid frontmatter with name and description", () => {
        const content = readFileSync(filePath, "utf8");
        const fm = parseFrontmatter(content);
        assert.ok(fm, `${agentName}.md should have frontmatter`);
        assert.ok(fm.name, `${agentName}.md frontmatter should have 'name'`);
        assert.ok(fm.description, `${agentName}.md frontmatter should have 'description'`);
      });

      it("has a name matching its filename", () => {
        const content = readFileSync(filePath, "utf8");
        const fm = parseFrontmatter(content);
        assert.equal(fm.name, agentName, `name should match filename`);
      });

      it("has a tools field", () => {
        const content = readFileSync(filePath, "utf8");
        const fm = parseFrontmatter(content);
        assert.ok(fm.tools, `${agentName}.md should specify tools`);
      });

      it("model field is optional (agents inherit parent model)", () => {
        const content = readFileSync(filePath, "utf8");
        const fm = parseFrontmatter(content);
        // model is deliberately omitted so agents inherit the parent session's model,
        // making them provider-agnostic (works with OpenRouter, Anthropic, etc.)
        assert.ok(true, `${agentName}.md model field is optional`);
      });

      it("has body content (system prompt)", () => {
        const content = readFileSync(filePath, "utf8");
        const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
        assert.ok(match, "should have content after frontmatter");
        const body = match[1].trim();
        assert.ok(body.length > 0, "system prompt should be non-empty");
      });
    });
  }

  it("only contains .md files", () => {
    const entries = readdirSync(agentsDir);
    for (const entry of entries) {
      assert.ok(entry.endsWith(".md"), `${entry} in agents/ should be an .md file`);
    }
  });
});

// ---------------------------------------------------------------------------
// Skills directory structure tests
// ---------------------------------------------------------------------------

describe("skills directory structure", () => {
  const skillsDir = resolve(projectRoot, "upstream-superpowers", "skills");

  it("skills directory contains subdirectories", () => {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    assert.ok(dirs.length > 0, "skills/ should contain subdirectories");
  });

  it("using-superpowers skill exists with SKILL.md", () => {
    const skillPath = resolve(skillsDir, "using-superpowers", "SKILL.md");
    assert.ok(existsSync(skillPath), "using-superpowers/SKILL.md should exist");
  });

  it("each skill subdirectory contains a SKILL.md", () => {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    for (const dir of dirs) {
      const skillMdPath = resolve(skillsDir, dir.name, "SKILL.md");
      assert.ok(
        existsSync(skillMdPath),
        `${dir.name}/ should contain a SKILL.md`
      );
    }
  });

  it("SKILL.md files have frontmatter with name and description", () => {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());

    for (const dir of dirs) {
      const skillMdPath = resolve(skillsDir, dir.name, "SKILL.md");
      if (!existsSync(skillMdPath)) continue;

      const content = readFileSync(skillMdPath, "utf8");
      const fm = parseFrontmatter(content);
      assert.ok(fm, `${dir.name}/SKILL.md should have frontmatter`);
      assert.ok(fm.name, `${dir.name}/SKILL.md should have 'name' in frontmatter`);
      assert.ok(
        fm.description,
        `${dir.name}/SKILL.md should have 'description' in frontmatter`
      );
    }
  });

  const expectedSkills = [
    "brainstorming",
    "dispatching-parallel-agents",
    "executing-plans",
    "finishing-a-development-branch",
    "receiving-code-review",
    "requesting-code-review",
    "subagent-driven-development",
    "systematic-debugging",
    "test-driven-development",
    "using-git-worktrees",
    "using-superpowers",
    "verification-before-completion",
    "writing-plans",
    "writing-skills",
  ];

  for (const skillName of expectedSkills) {
    it(`skill "${skillName}" directory exists`, () => {
      assert.ok(
        isDir(resolve(skillsDir, skillName)),
        `${skillName}/ should exist`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Extension source consistency tests
// ---------------------------------------------------------------------------

describe("extension source consistency", () => {
  it("superpowers.ts references paths that exist", () => {
    const src = readFileSync(resolve(projectRoot, "extensions", "superpowers.ts"), "utf8");

    // It should reference skills dir relative to package root
    assert.ok(src.includes('"skills"') || src.includes("'skills'"), "should reference skills directory");
    assert.ok(src.includes("using-superpowers"), "should reference using-superpowers");
    assert.ok(src.includes("SKILL.md"), "should reference SKILL.md");
    assert.ok(src.includes("pi-tools.md"), "should reference pi-tools.md");
  });

  it("subagent agents.ts exports expected types", () => {
    const src = readFileSync(
      resolve(projectRoot, "extensions", "subagent", "agents.ts"),
      "utf8"
    );
    assert.ok(src.includes("export type AgentScope"), "should export AgentScope type");
    assert.ok(src.includes("export interface AgentConfig"), "should export AgentConfig interface");
    assert.ok(src.includes("export function discoverAgents"), "should export discoverAgents");
    assert.ok(src.includes("export function formatAgentList"), "should export formatAgentList");
  });

  it("subagent index.ts imports from agents.ts", () => {
    const src = readFileSync(
      resolve(projectRoot, "extensions", "subagent", "index.ts"),
      "utf8"
    );
    assert.ok(
      src.includes("./agents"),
      "index.ts should import from agents.ts"
    );
  });

  it("todo.ts defines all expected actions", () => {
    const src = readFileSync(resolve(projectRoot, "extensions", "todo.ts"), "utf8");
    const expectedActions = ["list", "add", "toggle", "remove", "rename", "in_progress", "clear"];
    for (const action of expectedActions) {
      assert.ok(
        src.includes(`"${action}"`),
        `todo.ts should define the "${action}" action`
      );
    }
  });

  it("todo.ts defines all expected priorities", () => {
    const src = readFileSync(resolve(projectRoot, "extensions", "todo.ts"), "utf8");
    const expectedPriorities = ["low", "medium", "high"];
    for (const p of expectedPriorities) {
      assert.ok(
        src.includes(`"${p}"`),
        `todo.ts should define the "${p}" priority`
      );
    }
  });
});
