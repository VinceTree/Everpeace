import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { API } from "typescript/unstable/async";
import {
  isCallExpression,
  isExportDeclaration,
  isExternalModuleReference,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportTypeNode,
  isLiteralTypeNode,
  isStringLiteralLikeNode,
  SyntaxKind,
  type Node,
  type SourceFile,
} from "typescript/unstable/ast";
import { createVirtualFileSystem } from "typescript/unstable/fs";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const coreDirectories = ["runtime", "agent", "workflow", "exec", "sdk"];
const uiPackages = ["react", "ink", "@inkjs/ui"];

function normalizedPath(file: string): string {
  return file.replaceAll("\\", "/");
}

function repositoryPath(file: string): string {
  return normalizedPath(path.relative(repositoryRoot, file));
}

function isCoreFile(file: string): boolean {
  const relative = repositoryPath(file);
  return coreDirectories.some((directory) => relative.startsWith(`src/${directory}/`));
}

function forbiddenDependency(file: string, specifier: string): boolean {
  if (uiPackages.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
    return true;
  }
  if (!specifier.startsWith(".") && !path.isAbsolute(specifier)) {
    return false;
  }
  const target = repositoryPath(path.resolve(path.dirname(file), normalizedPath(specifier)));
  return target === "src/tui" || target.startsWith("src/tui/");
}

function moduleSpecifier(node: Node): Node | undefined {
  if (isImportDeclaration(node) || isExportDeclaration(node)) {
    return node.moduleSpecifier;
  }
  if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
    return node.moduleReference.expression;
  }
  if (isImportTypeNode(node) && isLiteralTypeNode(node.argument)) {
    return node.argument.literal;
  }
  if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
    return node.arguments[0];
  }
  return undefined;
}

function dependencyViolations(source: SourceFile): string[] {
  if (!isCoreFile(source.fileName)) {
    return [];
  }
  const violations: string[] = [];
  function visit(node: Node): void {
    const specifier = moduleSpecifier(node);
    if (specifier && isStringLiteralLikeNode(specifier) && forbiddenDependency(source.fileName, specifier.text)) {
      const location = source.getLineAndCharacterOfPosition(specifier.getStart(source));
      violations.push(`${repositoryPath(source.fileName)}:${location.line + 1}:${location.character + 1} -> ${specifier.text}`);
    }
    node.forEachChild(visit);
  }
  visit(source);
  return violations;
}

test("core source modules do not depend on terminal UI adapters", async () => {
  const config = normalizedPath(path.join(repositoryRoot, "tsconfig.build.json"));
  const api = new API({ cwd: normalizedPath(repositoryRoot) });
  let snapshot: Awaited<ReturnType<API["updateSnapshot"]>> | undefined;
  try {
    snapshot = await api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    assert.ok(project, "build project must be available to the dependency guard");
    const files = project.rootFiles.filter(isCoreFile);
    for (const directory of coreDirectories) {
      assert.ok(files.some((file) => repositoryPath(file).startsWith(`src/${directory}/`)), `missing src/${directory} coverage`);
    }
    const violations: string[] = [];
    for (const file of files) {
      const source = await project.program.getSourceFile(file);
      assert.ok(source, `cannot parse ${repositoryPath(file)}`);
      assert.deepEqual(await project.program.getSyntacticDiagnostics(file), [], `invalid syntax in ${repositoryPath(file)}`);
      violations.push(...dependencyViolations(source));
    }
    assert.deepEqual(violations, [], `core modules must not import UI dependencies:\n${violations.join("\n")}`);
  } finally {
    try {
      await snapshot?.dispose();
    } finally {
      await api.close();
    }
  }
});

test("dependency guard checks TypeScript syntax and permits adapter imports", async (t) => {
  const cases = [
    { name: "ordinary import", code: 'import React from "react";', denied: "react" },
    { name: "type import", code: 'import type { BoxProps } from "ink";', denied: "ink" },
    { name: "inline type import", code: 'import { type BoxProps } from "ink";', denied: "ink" },
    { name: "side effect import", code: 'import "@inkjs/ui";', denied: "@inkjs/ui" },
    { name: "package subpath", code: 'import { jsx } from "react/jsx-runtime";', denied: "react/jsx-runtime" },
    { name: "named re-export", code: 'export { Box } from "ink";', denied: "ink" },
    { name: "wildcard re-export", code: 'export * from "@inkjs/ui";', denied: "@inkjs/ui" },
    { name: "type re-export", code: 'export type { BoxProps } from "ink";', denied: "ink" },
    { name: "import type expression", code: 'type BoxProps = import("ink").BoxProps;', denied: "ink" },
    { name: "literal dynamic import", code: 'const ui = import("ink");', denied: "ink" },
    { name: "template literal dynamic import", code: 'const ui = import(`react`);', denied: "react" },
    { name: "import equals", code: 'import ui = require("ink");', denied: "ink" },
    { name: "escaped module name", code: 'import "re\\u0061ct";', denied: "react" },
    { name: "multiline import", code: 'import type {\n BoxProps,\n} from\n "ink";', denied: "ink" },
    { name: "TUI module", code: 'import { App } from "../tui/app/app.js";', denied: "../tui/app/app.js" },
    { name: "TUI re-export", code: 'export * from "../tui/index.js";', denied: "../tui/index.js" },
    { name: "TUI dynamic import", code: 'const ui = import("../tui/index.js");', denied: "../tui/index.js" },
    { name: "TUI directory", code: 'import "../tui";', denied: "../tui" },
    { name: "normalized TUI path", code: 'import "../agent/../tui/index.js";', denied: "../agent/../tui/index.js" },
    { name: "absolute TUI path", code: `import ${JSON.stringify(normalizedPath(path.join(repositoryRoot, "src/tui/index.js")))};`, denied: normalizedPath(path.join(repositoryRoot, "src/tui/index.js")) },
    { name: "source TSX", file: "src/runtime/fixture.tsx", code: 'import React from "react"; const element = <div />;', denied: "react" },
    { name: "Node and core imports", code: 'import path from "node:path"; import { Agent } from "../agent/index.js";' },
    { name: "similar package names", code: 'import "reactive"; import "inkwell"; import "@inkjs/ui-tools";' },
    { name: "similar directory", code: 'import "../tui-other/index.js";' },
    { name: "strings and comments", code: 'const example = \'import "react";\'; // import "ink";\n/* export * from "@inkjs/ui"; */' },
    { name: "nonliteral dynamic import", code: 'const name = "node:path"; const module = import(name);' },
    { name: "TUI adapter", file: "src/tui/fixture.tsx", code: 'import React from "react"; import { Box } from "ink"; import "@inkjs/ui";' },
    { name: "CLI adapter", file: "src/cli/fixture.ts", code: 'export * from "../tui/index.js"; const ui = import("ink");' },
    ...coreDirectories.map((directory) => ({ name: `${directory} boundary`, file: `src/${directory}/fixture.ts`, code: 'import "react";', denied: "react" })),
  ];
  // The virtual project uses real repository paths so the same path policy is exercised.
  const config = normalizedPath(path.join(repositoryRoot, "architecture-fixtures.json"));
  const fixtureFiles = cases.map((fixture, index) => {
    const file = fixture.file ?? "src/runtime/fixture.ts";
    return normalizedPath(path.join(repositoryRoot, file.replace(/fixture(?=\.tsx?$)/, `fixture-${index}`)));
  });
  const virtualFiles: Record<string, string> = {
    [config]: JSON.stringify({ compilerOptions: { noLib: true, noResolve: true, jsx: "react-jsx" }, files: fixtureFiles }),
  };
  for (const [index, fixture] of cases.entries()) {
    const file = fixtureFiles[index];
    assert.ok(file);
    virtualFiles[file] = fixture.code;
  }
  const api = new API({ cwd: normalizedPath(repositoryRoot), fs: createVirtualFileSystem(virtualFiles) });
  let snapshot: Awaited<ReturnType<API["updateSnapshot"]>> | undefined;
  try {
    snapshot = await api.updateSnapshot({ openProjects: [config] });
    const project = snapshot.getProject(config);
    assert.ok(project);
    for (const [index, fixture] of cases.entries()) {
      await t.test(fixture.name, async () => {
        const file = fixtureFiles[index];
        assert.ok(file);
        const source = await project.program.getSourceFile(file);
        assert.ok(source);
        assert.deepEqual(await project.program.getSyntacticDiagnostics(file), []);
        const dependencies = dependencyViolations(source).map((violation) => violation.split(" -> ")[1]);
        assert.deepEqual(dependencies, fixture.denied ? [fixture.denied] : []);
      });
    }
  } finally {
    try {
      await snapshot?.dispose();
    } finally {
      await api.close();
    }
  }
});
