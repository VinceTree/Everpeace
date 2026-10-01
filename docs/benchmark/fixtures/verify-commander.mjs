import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [task, workspace] = process.argv.slice(2);
if (!task || !workspace) throw new Error("usage: verify-commander.mjs <task> <workspace>");
const module = await import(pathToFileURL(path.join(workspace, "index.js")).href + `?grade=${Date.now()}`);
if (task === "negated-default") {
  const program = new module.Command().option("--no-color").parse([], { from: "user" });
  assert.equal(program.opts().color, true);
} else if (task === "async-action") {
  let completed = false;
  const program = new module.Command().action(async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    completed = true;
  });
  await program.parseAsync([], { from: "user" });
  assert.equal(completed, true);
} else if (task === "styled-width") {
  const helper = new module.Help();
  assert.equal(helper.displayWidth("\u001B[31mabc\u001B[39m"), 3);
} else {
  throw new Error(`unknown Commander task: ${task}`);
}
