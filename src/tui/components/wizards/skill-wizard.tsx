import path from "node:path";
import type { SkillLifecyclePreview } from "../../../skills/manager.js";
import { ConfirmInput, Select, Spinner, TextInput } from "@inkjs/ui";
import { Box, Text, useInput, usePaste, useWindowSize } from "ink";
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { RegisteredModel } from "../../../storage/model-registry.js";
import {
  normalizeGeneratedSkillMarkdown,
  validateManagedSkillMarkdown,
  type ManagedSkill,
  type PreparedSkillInstall,
  type SkillInstallCandidate,
  type SkillManagerLike,
  type SkillTargetScope,
} from "../../../skills/manager.js";
import {
  createComposerState,
  deleteComposerBackward,
  deleteComposerForward,
  insertComposerText,
  moveComposerLeft,
  moveComposerLineEnd,
  moveComposerLineStart,
  moveComposerRight,
  moveComposerVertically,
  type ComposerState,
} from "../../composer/editor.js";
import { CommandSurface, commandScreenWidth } from "../screens/command-surface.js";
import { RichOutput } from "../../rendering/rich-text.js";
import { textWidth, truncateEnd } from "../../rendering/text-width.js";

type State =
  | { kind: "menu" }
  | { kind: "create-scope" }
  | { kind: "create-description"; scope: SkillTargetScope; error?: string }
  | { kind: "loading"; title: string; label: string; returnState: State }
  | { kind: "review"; scope: SkillTargetScope; draft: string; error?: string }
  | { kind: "edit"; scope: SkillTargetScope; draft: string; error?: string }
  | { kind: "install-url"; error?: string }
  | { kind: "install-select"; prepared: PreparedSkillInstall }
  | { kind: "install-preview"; prepared: PreparedSkillInstall; candidate: SkillInstallCandidate }
  | { kind: "install-scope"; prepared: PreparedSkillInstall; candidate: SkillInstallCandidate }
  | { kind: "install-confirm"; prepared: PreparedSkillInstall; candidate: SkillInstallCandidate; scope: SkillTargetScope }
  | { kind: "skills-list"; skills: readonly ManagedSkill[] }
  | { kind: "skill-detail"; skill: ManagedSkill }
  | { kind: "lifecycle-confirm"; preview: SkillLifecyclePreview }
  | { kind: "success"; title: string; text: string };

export interface SkillWizardProps {
  manager?: SkillManagerLike;
  activeModel?: RegisteredModel;
  generateDraft?(model: RegisteredModel, description: string, signal?: AbortSignal): Promise<string>;
  reviseDraft?(model: RegisteredModel, skillMarkdown: string, signal?: AbortSignal): Promise<string>;
  onUse(name: string): void;
  onBack(): void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopeOptions() {
  return [
    { label: "Current project · .agents/skills", value: "project" },
    { label: "User · $CODEX_HOME/skills", value: "user" },
  ];
}

function skillScopeLabel(scope: ManagedSkill["scope"]): string {
  if (scope === "repo") return "repo";
  if (scope === "admin") return "admin";
  if (scope === "system") return "system";
  return scope;
}

function skillStatus(skill: ManagedSkill): string {
  if (skill.conflict) return "conflict · resolve duplicate before use";
  if (!skill.usable) return "unavailable · inspect the source or path";
  return "ready to use";
}

function wrapSkillDescription(value: string, width: number, maximumLines = 2): string[] {
  const words = (value.trim() || "No description provided.").split(/\s+/u);
  const lines: string[] = [];
  let current = "";
  let consumed = 0;

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate) <= width) {
      current = candidate;
      consumed += 1;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length >= maximumLines) break;
    current = textWidth(word) <= width ? word : truncateEnd(word, width);
    consumed += 1;
  }
  if (lines.length < maximumLines && current) lines.push(current);

  const hasMore = consumed < words.length;
  if (hasMore && lines.length > 0) {
    lines[lines.length - 1] = truncateEnd(lines[lines.length - 1]!, Math.max(1, width - 1)) + "…";
  }
  while (lines.length < maximumLines) lines.push("");
  return lines;
}

function InstalledSkillList({
  skills,
  onSelect,
}: {
  skills: readonly ManagedSkill[];
  onSelect(skill: ManagedSkill): void;
}) {
  const { columns, rows } = useWindowSize();
  const [selected, setSelected] = useState(0);
  const [offset, setOffset] = useState(0);
  const width = Math.max(24, commandScreenWidth(columns) - 4);
  const itemHeight = 4;
  const visibleCount = Math.max(1, Math.min(skills.length, Math.floor(Math.max(6, rows - 14) / itemHeight)));

  useEffect(() => {
    setSelected((current) => Math.min(current, Math.max(0, skills.length - 1)));
  }, [skills.length]);

  useEffect(() => {
    setOffset((current) => Math.min(current, Math.max(0, skills.length - visibleCount)));
  }, [skills.length, visibleCount]);

  useInput((_input, key) => {
    if (!skills.length) return;
    if (key.upArrow) setSelected((current) => Math.max(0, current - 1));
    if (key.downArrow) setSelected((current) => Math.min(skills.length - 1, current + 1));
    if (key.pageUp) setSelected((current) => Math.max(0, current - visibleCount));
    if (key.pageDown) setSelected((current) => Math.min(skills.length - 1, current + visibleCount));
    if (key.home) setSelected(0);
    if (key.end) setSelected(skills.length - 1);
    if (key.return) {
      const skill = skills[selected];
      if (skill) onSelect(skill);
    }
  });

  useEffect(() => {
    if (selected < offset) setOffset(selected);
    else if (selected >= offset + visibleCount) setOffset(selected - visibleCount + 1);
  }, [selected, offset, visibleCount]);

  if (!skills.length) {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="#D4AF37" bold>No installed Skills</Text>
        <Text dimColor>Create one or install a public Skill to see it here.</Text>
      </Box>
    );
  }

  const nameWidth = Math.max(12, width - 20);
  const descriptionWidth = Math.max(10, width - 5);
  const visibleSkills = skills.slice(offset, offset + visibleCount);
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="#D4AF37">Installed Skills</Text>
        <Text dimColor>{`${selected + 1}/${skills.length}`}</Text>
      </Box>
      <Text dimColor>Browse a Skill to inspect its instructions and invoke it.</Text>
      <Box flexDirection="column" marginTop={1}>
        {visibleSkills.map((skill, index) => {
          const absoluteIndex = offset + index;
          const isSelected = absoluteIndex === selected;
          const statusColor = skill.conflict || !skill.usable ? "yellow" : "green";
          return (
            <Box key={`${skill.name}-${skill.path}`} flexDirection="column" marginBottom={1}>
              <Text>
                <Text color={isSelected ? "#4EC9B0" : "#6A9955"}>{isSelected ? "› " : "  "}</Text>
                <Text bold {...(isSelected ? { color: "#4EC9B0" } : {})}>{truncateEnd(skill.name, nameWidth)}</Text>
                <Text dimColor>{` · ${skillScopeLabel(skill.scope)}`}</Text>
                {skill.conflict ? <Text color="yellow">{" · conflict"}</Text> : null}
              </Text>
              {wrapSkillDescription(skill.description, descriptionWidth).map((line, lineIndex) => (
                <Text key={`${skill.name}-description-${lineIndex}`} dimColor>{`  ${line}`}</Text>
              ))}
              <Text color={statusColor}>{`  ${skillStatus(skill)}`}</Text>
            </Box>
          );
        })}
      </Box>
      <Text dimColor>{`↑↓ browse · Enter inspect · PgUp/PgDn jump · ${offset + 1}-${Math.min(skills.length, offset + visibleCount)} shown`}</Text>
    </Box>
  );
}

function SkillIdentity({ skill }: { skill: ManagedSkill }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text bold color="#4EC9B0">{skill.name}</Text>
        <Text dimColor>{skillScopeLabel(skill.scope)}</Text>
      </Box>
      <Text>{skill.description || "No description provided."}</Text>
      <Text dimColor>{skillStatus(skill)}</Text>
      {skill.managed ? <Text dimColor wrap="truncate-end">{`Managed source: ${skill.sourceUrl ?? "local creation"}`}</Text> : null}
    </Box>
  );
}

function PagedSkill({ markdown, footer }: { markdown: string; footer?: React.ReactNode }) {
  const { rows } = useWindowSize();
  const lines = useMemo(() => markdown.replace(/\r/gu, "").split("\n"), [markdown]);
  const page = Math.max(3, rows - 18);
  const [offset, setOffset] = useState(0);
  useEffect(() => setOffset((current) => Math.min(current, Math.max(0, lines.length - page))), [lines.length, page]);
  useInput((_input, key) => {
    if (key.pageUp) setOffset((current) => Math.max(0, current - page));
    if (key.pageDown) setOffset((current) => Math.min(Math.max(0, lines.length - page), current + page));
    if (key.home) setOffset(0);
    if (key.end) setOffset(Math.max(0, lines.length - page));
  });
  return (
    <Box flexDirection="column">
      <Text dimColor>{`${offset + 1}-${Math.min(lines.length, offset + page)} / ${lines.length} · PgUp/PgDn scroll`}</Text>
      <RichOutput text={markdown} range={{ start: offset, count: page }} />
      {footer}
    </Box>
  );
}

function lineAndColumn(state: ComposerState): { line: number; column: number } {
  const before = Array.from(state.value).slice(0, state.cursor).join("");
  const parts = before.split("\n");
  return { line: parts.length - 1, column: Array.from(parts.at(-1) ?? "").length };
}

function SkillEditor({ initialValue, error, onSave, onCancel }: {
  initialValue: string;
  error?: string;
  onSave(value: string): void;
  onCancel(): void;
}) {
  const [editor, setEditor] = useState(() => createComposerState(initialValue));
  const { rows } = useWindowSize();
  const visibleCount = Math.max(4, rows - 12);
  const update = (operation: (state: ComposerState) => ComposerState) => setEditor((current) => operation(current));
  usePaste((text) => update((current) => insertComposerText(current, text)));
  useInput((input, key) => {
    if (key.ctrl && input.toLowerCase() === "s") { onSave(editor.value); return; }
    if (key.escape) { onCancel(); return; }
    if (key.return || input === "\n") { update((current) => insertComposerText(current, "\n")); return; }
    if (key.home) { update(moveComposerLineStart); return; }
    if (key.end) { update(moveComposerLineEnd); return; }
    if (key.leftArrow) { update(moveComposerLeft); return; }
    if (key.rightArrow) { update(moveComposerRight); return; }
    if (key.upArrow) { update((current) => moveComposerVertically(current, -1)); return; }
    if (key.downArrow) { update((current) => moveComposerVertically(current, 1)); return; }
    if (key.backspace) { update(deleteComposerBackward); return; }
    if (key.delete) { update(deleteComposerForward); return; }
    if (!key.ctrl && !key.meta && !key.tab && input) update((current) => insertComposerText(current, input));
  });
  const lines = editor.value.replace(/\r/gu, "").split("\n");
  const cursor = lineAndColumn(editor);
  const offset = Math.max(0, Math.min(cursor.line - visibleCount + 1, Math.max(0, lines.length - visibleCount)));
  return (
    <CommandSurface title="/skills · Edit SKILL.md">
      {error ? <Text color="red">{error}</Text> : null}
      <Text dimColor>{`${cursor.line + 1}:${cursor.column + 1} · Ctrl+S save draft · Esc discard edits`}</Text>
      {lines.slice(offset, offset + visibleCount).map((line, index) => {
        const lineNumber = offset + index;
        if (lineNumber !== cursor.line) return <Text key={lineNumber}>{line || " "}</Text>;
        const characters = Array.from(line);
        return <Text key={lineNumber}>{characters.slice(0, cursor.column).join("")}<Text inverse>{characters[cursor.column] ?? " "}</Text>{characters.slice(cursor.column + 1).join("")}</Text>;
      })}
    </CommandSurface>
  );
}

export function SkillWizard({ manager, activeModel, generateDraft, reviseDraft, onUse, onBack }: SkillWizardProps) {
  const [state, setState] = useState<State>({ kind: "menu" });
  const controller = useRef<AbortController | undefined>(undefined);
  const preparedId = useRef<string | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (preparedId.current) void manager?.discardPrepared(preparedId.current);
    };
  }, [manager]);

  const discardPrepared = async () => {
    const id = preparedId.current;
    preparedId.current = undefined;
    if (id) await manager?.discardPrepared(id);
  };

  const returnToMenu = () => {
    controller.current?.abort();
    void discardPrepared();
    setState({ kind: "menu" });
  };

  const run = <T,>(loading: State, operation: (signal: AbortSignal) => Promise<T>, complete: (result: T) => void, fail: (error: string) => State) => {
    const nextController = new AbortController();
    controller.current?.abort();
    controller.current = nextController;
    setState(loading);
    void operation(nextController.signal).then((result) => {
      if (!mounted.current || nextController.signal.aborted) return;
      complete(result);
    }).catch((error: unknown) => {
      if (!mounted.current || nextController.signal.aborted) return;
      setState(fail(message(error)));
    });
  };

  const loadSkills = () => {
    if (!manager) { setState({ kind: "success", title: "/skills · Unavailable", text: "Skill management is unavailable in this integration." }); return; }
    const previous: State = { kind: "menu" };
    run(
      { kind: "loading", title: "/skills · Installed skills", label: "Discovering skills", returnState: previous },
      () => manager.list(),
      (skills) => setState({ kind: "skills-list", skills }),
      (error) => ({ kind: "success", title: "/skills · Could not load", text: error }),
    );
  };

  const back = () => {
    if (state.kind === "menu") { onBack(); return; }
    if (state.kind === "loading") { controller.current?.abort(); setState(state.returnState); return; }
    if (state.kind === "skill-detail") { loadSkills(); return; }
    if (state.kind === "review" || state.kind === "edit") { setState({ kind: "create-description", scope: state.scope }); return; }
    if (state.kind === "install-preview" || state.kind === "install-scope" || state.kind === "install-confirm") {
      setState({ kind: "install-select", prepared: state.prepared });
      return;
    }
    returnToMenu();
  };

  if (state.kind === "edit") {
    return <SkillEditor initialValue={state.draft} {...(state.error ? { error: state.error } : {})} onCancel={() => setState({ kind: "review", scope: state.scope, draft: state.draft })} onSave={(value) => {
      try {
        const draft = normalizeGeneratedSkillMarkdown(value);
        validateManagedSkillMarkdown(draft);
        setState({ kind: "review", scope: state.scope, draft });
      } catch (error) {
        setState({ ...state, error: message(error) });
      }
    }} />;
  }

  return (
    <CommandSurface title={state.kind === "menu" ? "/skills · Skill manager" : "/skills"} onBack={back}>
      {state.kind === "menu" ? <Select options={[
        { label: "Create a skill", value: "create" },
        { label: "Install from URL", value: "install" },
        { label: "View installed skills", value: "view" },
      ]} onChange={(value) => {
        if (value === "create") setState({ kind: "create-scope" });
        else if (value === "install") setState({ kind: "install-url" });
        else loadSkills();
      }} /> : null}

      {state.kind === "create-scope" ? <>
        <Text dimColor>Choose where this Skill will be available.</Text>
        <Select options={scopeOptions()} onChange={(value) => setState({ kind: "create-description", scope: value as SkillTargetScope })} />
      </> : null}

      {state.kind === "create-description" ? <>
        {state.error ? <Text color="red">{state.error}</Text> : null}
        <Text>Describe the task, workflow, and important constraints.</Text>
        <Box><Text color="#4EC9B0">Description ❯ </Text><TextInput placeholder="What should this Skill teach the agent?" onSubmit={(description) => {
          if (!activeModel || !generateDraft) { setState({ ...state, error: "An active model is required. Use /login first." }); return; }
          if (!description.trim()) { setState({ ...state, error: "Description cannot be empty." }); return; }
          const previous = state;
          run(
            { kind: "loading", title: "/skills · Create", label: "Generating SKILL.md", returnState: previous },
            (signal) => generateDraft(activeModel, description.trim(), signal),
            (draft) => setState({ kind: "review", scope: state.scope, draft }),
            (error) => ({ ...state, error }),
          );
        }} /></Box>
      </> : null}

      {state.kind === "review" ? <>
        {state.error ? <Text color="red">{state.error}</Text> : null}
        <PagedSkill markdown={state.draft} footer={<Select options={[
          { label: "Validate and improve with AI", value: "validate" },
          { label: "Edit manually", value: "edit" },
          { label: "Confirm and save", value: "save" },
        ]} onChange={(value) => {
          if (value === "edit") { setState({ kind: "edit", scope: state.scope, draft: state.draft }); return; }
          if (value === "validate") {
            if (!activeModel || !reviseDraft) { setState({ ...state, error: "An active model is required for AI validation." }); return; }
            const previous = state;
            run(
              { kind: "loading", title: "/skills · Validate", label: "Validating and improving SKILL.md", returnState: previous },
              (signal) => reviseDraft(activeModel, state.draft, signal),
              (draft) => setState({ kind: "review", scope: state.scope, draft }),
              (error) => ({ ...state, error }),
            );
            return;
          }
          if (!manager) { setState({ ...state, error: "Skill management is unavailable." }); return; }
          const previous = state;
          run(
            { kind: "loading", title: "/skills · Save", label: "Saving Skill", returnState: previous },
            () => manager.saveCreated(state.draft, state.scope),
            (result) => setState({ kind: "success", title: "/skills · Created", text: `${result.name} is available now. Use $${result.name} or let the agent match it automatically.\n${result.directory}` }),
            (error) => ({ ...state, error }),
          );
        }} />} />
      </> : null}

      {state.kind === "install-url" ? <>
        {state.error ? <Text color="red">{state.error}</Text> : null}
        <Text>Public GitHub folder, Git repository, SKILL.md, or ZIP URL.</Text>
        <Box><Text color="#4EC9B0">URL ❯ </Text><TextInput placeholder="https://github.com/owner/repo/tree/main/path" onSubmit={(url) => {
          if (!manager) { setState({ ...state, error: "Skill management is unavailable." }); return; }
          const previous = state;
          run(
            { kind: "loading", title: "/skills · Install", label: "Downloading and validating Skill", returnState: previous },
            (signal) => manager.prepareInstall(url, signal),
            (prepared) => {
              preparedId.current = prepared.id;
              if (prepared.candidates.length === 1) setState({ kind: "install-preview", prepared, candidate: prepared.candidates[0]! });
              else setState({ kind: "install-select", prepared });
            },
            (error) => ({ ...state, error }),
          );
        }} /></Box>
      </> : null}

      {state.kind === "install-select" ? <>
        <Text dimColor>Select one Skill from this source.</Text>
        <Select visibleOptionCount={Math.min(8, state.prepared.candidates.length)} options={state.prepared.candidates.map((candidate) => ({ label: `${candidate.name} · ${candidate.description}`, value: candidate.id }))} onChange={(id) => {
          const candidate = state.prepared.candidates.find((item) => item.id === id);
          if (candidate) setState({ kind: "install-preview", prepared: state.prepared, candidate });
        }} />
      </> : null}

      {state.kind === "install-preview" ? <PagedSkill markdown={state.candidate.skillMarkdown} footer={<>
        <Text dimColor>{`${state.candidate.files.length} files · ${state.prepared.sourceUrl}`}</Text>
        <Select options={[{ label: "Install this Skill", value: "install" }, { label: "Choose another", value: "back" }]} onChange={(value) => value === "install" ? setState({ kind: "install-scope", prepared: state.prepared, candidate: state.candidate }) : setState({ kind: "install-select", prepared: state.prepared })} />
      </>} /> : null}

      {state.kind === "install-scope" ? <>
        <Text dimColor>Choose where this Skill will be available.</Text>
        <Select options={scopeOptions()} onChange={(value) => setState({ kind: "install-confirm", prepared: state.prepared, candidate: state.candidate, scope: value as SkillTargetScope })} />
      </> : null}

      {state.kind === "install-confirm" ? <>
        <Text>{`Install ${state.candidate.name} into ${state.scope === "project" ? "the current project" : "the user Skill directory"}?`}</Text>
        <ConfirmInput defaultChoice="cancel" onCancel={() => setState({ kind: "install-scope", prepared: state.prepared, candidate: state.candidate })} onConfirm={() => {
          if (!manager) return;
          const previous = state;
          run(
            { kind: "loading", title: "/skills · Install", label: "Installing Skill", returnState: previous },
            () => manager.installPrepared(state.prepared.id, state.candidate.id, state.scope),
            (result) => { preparedId.current = undefined; setState({ kind: "success", title: "/skills · Installed", text: `${result.name} is available now. Use $${result.name} or let the agent match it automatically.\n${result.directory}` }); },
            (error) => ({ kind: "success", title: "/skills · Installation failed", text: error }),
          );
        }} />
      </> : null}

      {state.kind === "lifecycle-confirm" ? <PagedSkill markdown={state.preview.diff} footer={<>
        <Text>{state.preview.sourceUrl ?? state.preview.directory}</Text>
        <Text>{`Confirm ${state.preview.action} of ${state.preview.name}?`}</Text>
        <ConfirmInput defaultChoice="cancel" onCancel={loadSkills} onConfirm={() => run({ kind: "loading", title: "/skills · Apply", label: "Applying confirmed change", returnState: state }, async () => { if (!manager?.commitLifecycle) throw new Error("Skill management is unavailable"); await manager.commitLifecycle(state.preview.id); }, () => { preparedId.current = undefined; setState({ kind: "success", title: "/skills · Updated", text: `${state.preview.action} complete` }); }, (error) => ({ kind: "success", title: "/skills · Could not apply", text: error }))} />
      </>} /> : null}
      {state.kind === "skills-list" ? <InstalledSkillList skills={state.skills} onSelect={(skill) => setState({ kind: "skill-detail", skill })} /> : null}

      {state.kind === "skill-detail" ? <>
        <SkillIdentity skill={state.skill} />
        <PagedSkill markdown={state.skill.skillMarkdown} footer={<>
          {state.skill.conflict ? <Text color="yellow">This name is ambiguous. Resolve duplicate installations before using it.</Text> : <Select options={[{ label: "Use in next prompt", value: "use" }, ...(state.skill.managed ? [{ label: "Preview update from source", value: "update" }, { label: "Preview uninstall", value: "uninstall" }] : []), { label: "Back to list", value: "back" }]} onChange={(value) => {
            if (value === "use") { onUse(state.skill.name); return; }
            if (value === "back") { loadSkills(); return; }
            const directory = path.dirname(state.skill.path);
            run({ kind: "loading", title: "/skills · Preview", label: "Checking managed installation", returnState: state }, async (signal) => {
              const preview = value === "update" ? await manager?.previewUpdate?.(directory, signal) : await manager?.previewUninstall?.(directory);
              if (!preview) throw new Error("Skill lifecycle management is unavailable");
              return preview;
            }, (preview) => { preparedId.current = preview.id; setState({ kind: "lifecycle-confirm", preview }); }, (error) => ({ kind: "success", title: "/skills · Preview failed", text: error }));
          }} />}
        </>} />
      </> : null}

      {state.kind === "loading" ? <Spinner label={state.label} /> : null}
      {state.kind === "success" ? <><Text bold>{state.title}</Text><Text>{state.text}</Text><Select options={[{ label: "Back to Skill manager", value: "back" }]} onChange={returnToMenu} /></> : null}
    </CommandSurface>
  );
}
