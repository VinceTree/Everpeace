import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  formatSkillsStatus,
  parseSkillMetadata,
  SkillCatalog,
} from "../../../src/skills/catalog.js";

test("skill metadata requires Codex-style frontmatter", () => {
  const skill = parseSkillMetadata(
    "---\nname: demo\ndescription: Use this skill for focused demos.\nmetadata:\n  short-description: Demo helper\n---\nInstructions",
    "/repo/.agents/skills/demo/SKILL.md",
    "repo",
  );
  assert.equal(skill.name, "demo");
  assert.equal(skill.description, "Use this skill for focused demos.");
  assert.equal(skill.shortDescription, "Demo helper");
  assert.throws(() => parseSkillMetadata("Instructions", "/tmp/demo/SKILL.md", "repo"), /frontmatter/u);
});

test("skills are discovered, explicitly activated, paged, and path-confined", async (t) => {
  const workspace = await fs.mkdtemp(join(tmpdir(), "everpeace-skills-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(join(workspace, ".git"));
  const skillDirectory = join(workspace, ".agents", "skills", "demo");
  await fs.mkdir(join(skillDirectory, "references"), { recursive: true });
  await fs.writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: demo\ndescription: Handle deterministic demo tasks.\n---\nFollow the demo instructions completely.\n",
  );
  await fs.writeFile(join(skillDirectory, "references", "details.md"), "reference text");

  const catalog = new SkillCatalog(workspace);
  const turn = await catalog.prepareTurn("请用$demo，现在开始。");
  assert.ok(turn.skills.some((skill) => skill.name === "demo" && skill.scope === "repo"));
  assert.deepEqual(turn.explicitNames, ["demo"]);
  assert.match(turn.explicitInstructions, /Follow the demo instructions completely/u);
  assert.match(formatSkillsStatus(turn), /demo · repo/u);

  const read = JSON.parse(await catalog.read(JSON.stringify({ name: "demo", resource: "references/details.md" }))) as {
    status: string;
    data: { contents: string; next_cursor: string | null };
  };
  assert.equal(read.status, "ok");
  assert.equal(read.data.contents, "reference text");
  assert.equal(read.data.next_cursor, null);

  const escaped = JSON.parse(await catalog.read(JSON.stringify({ name: "demo", resource: "../../outside.txt" }))) as { status: string };
  assert.equal(escaped.status, "error");
});

test("duplicate skill names are reported as conflicts and cannot be activated", async (t) => {
  const project = await fs.mkdtemp(join(tmpdir(), "everpeace-skill-conflict-"));
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  const workspace = join(project, "packages", "demo");
  await fs.mkdir(join(project, ".git"), { recursive: true });
  const locations = [
    join(project, ".agents", "skills", "same-name"),
    join(workspace, ".agents", "skills", "same-name"),
  ];
  await Promise.all(locations.map(async (directory, index) => {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      join(directory, "SKILL.md"),
      `---\nname: same-name\ndescription: Conflicting test skill ${index}.\n---\n\nDo not load this ambiguous skill.\n`,
    );
  }));

  const catalog = new SkillCatalog(workspace);
  const turn = await catalog.prepareTurn("Use $same-name for this task.");
  assert.deepEqual(turn.conflictedNames, ["same-name"]);
  assert.doesNotMatch(turn.instructions, /same-name/u);
  assert.match(turn.explicitInstructions, /ambiguous/u);
  assert.match(formatSkillsStatus(turn), /same-name · repo · conflict/u);

  const read = JSON.parse(await catalog.read(JSON.stringify({ name: "same-name" }))) as { status: string; error: string };
  assert.equal(read.status, "error");
  assert.match(read.error, /ambiguous/u);
});
