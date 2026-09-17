import { Spinner } from "@inkjs/ui";
import { Box, Text, useApp, useInput, usePaste, useStdout, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentIO } from "../agent/react-agent.js";
import { defaultPermissions } from "../permissions/policy.js";
import { PermissionsPicker } from "./components/permissions-picker.js";
import { renderTerminalOutput } from "../tools/terminal.js";
import { TextBrowser } from "./components/text-browser.js";
import { TerminalSetup } from "./components/terminal-setup.js";
import { retainOutput, type CommandRecord } from "../tools/command-record.js";
import { randomUUID } from "node:crypto";
import { createComposerState } from "./composer/editor.js";
import type {
  RegisteredModel,
  RegisteredModelStatus,
  ResolvedModels,
} from "../storage/model-registry.js";
import type {
  LoadedSession,
  SessionModelRef,
  SessionSummary,
} from "../storage/session-store.js";
import {
  applyUsageSample,
  createEmptySessionUsage,
  resetContextUsage,
  resolveModelStatusMetadata,
  type StatusSnapshot,
} from "../status/model-status.js";
import type { BashResult } from "../tools/bash.js";
import { parseTuiInput, TUI_HELP } from "./commands.js";
import { BashConfirmation } from "./components/bash-confirmation.js";
import {
  CommandInfoSurface,
  CommandLoadingSurface,
  CommandScreen,
  StatusSurface,
  type CommandSurfaceTone,
} from "./components/command-surface.js";
import { History } from "./components/history.js";
import { LoginWizard } from "./components/login-wizard.js";
import { LogoutWizard } from "./components/logout-wizard.js";
import { ModelPicker } from "./components/model-picker.js";
import { Prompt } from "./components/prompt.js";
import { SessionPicker } from "./components/session-picker.js";
import { StatusBar } from "./components/status-bar.js";
import { truncateEnd } from "./text-width.js";
import type {
  HistoryKind,
  TimelineEntry,
  TuiDependencies,
} from "./types.js";

type View =
  | { kind: "outputs" }
  | { kind: "input-history" }
  | { kind: "terminal-setup" }
  | { kind: "permissions" }
  | { kind: "chat" }
  | { kind: "login" }
  | {
      kind: "model-picker";
      title: string;
      models: RegisteredModel[];
      resumeSession?: LoadedSession;
    }
  | { kind: "session-picker"; sessions: SessionSummary[]; notice?: string }
  | { kind: "logout"; models: RegisteredModelStatus[] }
  | {
      kind: "loading";
      title: string;
      label: string;
      cancellable: boolean;
    }
  | {
      kind: "info";
      title: string;
      text: string;
      tone: CommandSurfaceTone;
    }
  | { kind: "status"; snapshot: StatusSnapshot };

type CommandView = Exclude<View, { kind: "chat" }>;

interface PendingConfirmation {
  command: string;
  resolve(accepted: boolean): void;
}

// Codex uses a short trailing reflow: the live composer follows the viewport
// immediately, while source-backed transcript replay waits for resize churn to
// settle. This prevents a second, visibly delayed layout change during zoom.
export const RESIZE_REDRAW_DEBOUNCE_MS = 75;

export interface EverpeaceAppProps {
  dependencies: TuiDependencies;
  initialModels: ResolvedModels;
  onReplayOutput(update: () => void): void;
}

function initialActiveModel(models: RegisteredModel[]): RegisteredModel | undefined {
  return models.length === 1 ? models[0] : undefined;
}

function initialView(models: RegisteredModel[]): View {
  return models.length > 1
    ? { kind: "model-picker", title: "选择本次会话模型", models }
    : { kind: "chat" };
}

function infoView(
  title: string,
  text: string,
  tone: CommandSurfaceTone = "default",
): CommandView {
  return { kind: "info", title, text, tone };
}

function toSessionModel(model: RegisteredModel): SessionModelRef {
  return {
    id: model.id,
    model_name: model.model_name,
    base_url: model.base_url,
  };
}

function fallbackSessionTitle(firstQuestion: string): string {
  const normalized = firstQuestion.replace(/\s+/g, " ").trim();
  return truncateEnd(normalized || "Untitled Session", 60);
}

function bashStatus(result: BashResult): { kind: HistoryKind; text: string } {
  if (result.cancelled) return { kind: "system", text: "Command cancelled" };
  if (result.error) return { kind: "error", text: `Bash error: ${result.error}` };
  if (result.signal) return { kind: "error", text: `Bash stopped by ${result.signal}` };
  if (result.exitCode !== 0) {
    return { kind: "error", text: `Bash exited with code ${result.exitCode}` };
  }
  return { kind: "system", text: "Bash completed successfully" };
}

function terminalStatus(result: BashResult): { kind: HistoryKind; text: string } {
  if (result.cancelled) return { kind: "system", text: "Command cancelled" };
  if (result.error) return { kind: "error", text: `Terminal error: ${result.error}` };
  if (result.signal) return { kind: "error", text: `Command stopped by ${result.signal}` };
  if (result.exitCode !== 0) {
    return { kind: "error", text: `Command exited with code ${result.exitCode}` };
  }
  return { kind: "system", text: "Command completed successfully" };
}

function commandOutput(result: BashResult): string {
  return [result.stdout.trimEnd(), result.stderr.trimEnd()]
    .filter((text) => text.length > 0)
    .join("\n");
}

function TerminalActivity({ output }: { output: string | undefined }) {
  const { rows } = useWindowSize();
  const allLines = output ? output.split("\n") : [];
  const maximumOutputLines = Math.max(1, Math.min(5, rows - 4));
  const hiddenLineCount = Math.max(0, allLines.length - maximumOutputLines);
  const visibleLines = allLines.slice(hiddenLineCount);

  return (
    <Box flexDirection="column">
      {hiddenLineCount > 0 ? (
        <Box marginLeft={3} height={1}>
          <Text dimColor>… {hiddenLineCount} earlier lines</Text>
        </Box>
      ) : null}
      {visibleLines.map((line, index) => (
        <Box key={`${hiddenLineCount + index}:${line}`} marginLeft={3} height={1} overflow="hidden">
          <Text wrap="truncate-end">{line || " "}</Text>
        </Box>
      ))}
      <Box paddingLeft={1}>
        <Text dimColor>• 正在执行终端命令</Text>
      </Box>
    </Box>
  );
}

export function EverpeaceApp({
  dependencies,
  initialModels,
  onReplayOutput,
}: EverpeaceAppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const firstActiveModel = initialActiveModel(initialModels.available);
  const initialTimeline = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [
      {
        id: 0,
        kind: "banner",
        ...(firstActiveModel === undefined
          ? {}
          : { modelName: firstActiveModel.model_name }),
      },
    ];
    initialModels.missing.forEach((model, index) => {
      entries.push({
        id: index + 1,
        kind: "error",
        text: `凭据缺失：${model.model_name}，请使用 /login 修复或 /logout 删除。`,
      });
    });
    return entries;
  }, [firstActiveModel, initialModels.missing]);

  const nextId = useRef(initialTimeline.length);
  const abortController = useRef<AbortController | undefined>(undefined);
  const titleControllers = useRef(new Set<AbortController>());
  const confirmationRef = useRef<PendingConfirmation | undefined>(undefined);
  const permissions = useRef(defaultPermissions());
  const terminalCommandRunning = useRef(false);
  const commandOperation = useRef(0);
  const activeSessionId = useRef<string | undefined>(undefined);
  const sessionTitlePending = useRef(false);
  const [timeline, setTimeline] = useState(initialTimeline);
  const [timelineEpoch, setTimelineEpoch] = useState(0);
  const [inputKey, setInputKey] = useState(0);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [sessionContext, setSessionContext] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [sessionUsage, setSessionUsage] = useState(() =>
    createEmptySessionUsage(),
  );
  const [activeModel, setActiveModel] = useState(firstActiveModel);
  const [workspacePath, setWorkspacePath] = useState(dependencies.workspacePath);
  const [view, setView] = useState<View>(() => initialView(initialModels.available));
  const [busyLabel, setBusyLabel] = useState<string>();
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState<string>();
  const [activeCommand, setActiveCommand] = useState<{ command: string; shell: string; cancelling?: boolean }>();
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [resumedInputHistory, setResumedInputHistory] = useState<string[]>();
  const editorRef = useRef(createComposerState());
  const historyNavigationRef = useRef<{ index: number | undefined; draft: string }>({ index: undefined, draft: "" });
  const directController = useRef<AbortController | undefined>(undefined);
  const commandInput = useRef<((input: string) => void) | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void dependencies.inputHistory?.load().then((entries) => { if (active) setInputHistory((current) => [...entries, ...current].slice(-1000)); }).catch(() => undefined);
    return () => { active = false; directController.current?.abort(); };
  }, [dependencies.inputHistory]);
  const [confirmation, setConfirmation] = useState<PendingConfirmation>();

  const appendText = useCallback((
    kind: HistoryKind,
    text: string,
    persist: boolean,
  ): number => {
    const id = nextId.current++;
    setTimeline((current) => [
      ...current,
      { id, kind, text },
    ]);
    if (!persist) return id;

    const sessionId = activeSessionId.current;
    if (sessionId !== undefined) {
      void dependencies.sessionStore
        .appendTimeline(sessionId, { kind, text })
        .catch((error: unknown) => {
          const errorId = nextId.current++;
          const message = error instanceof Error ? error.message : String(error);
          setTimeline((current) => [
            ...current,
            { id: errorId, kind: "error", text: `Session save failed: ${message}` },
          ]);
        });
    }
    return id;
  }, [dependencies.sessionStore]);

  const append = useCallback(
    (kind: HistoryKind, text: string): number => appendText(kind, text, true),
    [appendText],
  );

  const appendTransient = useCallback(
    (kind: HistoryKind, text: string): number => appendText(kind, text, false),
    [appendText],
  );

  const appendCommand = useCallback((text: string, command: CommandRecord) => {
    const entry = { kind: "output" as const, text, command };
    const id = nextId.current++;
    setTimeline((current) => [...current, { ...entry, id }]);
    const sessionId = activeSessionId.current;
    if (sessionId) void dependencies.sessionStore.appendTimeline(sessionId, entry).catch((e: unknown) => appendTransient("error", `Session save failed: ${String(e)}`));
  }, [dependencies.sessionStore, appendTransient]);

  const enterCommandView = useCallback((nextView: CommandView) => {
    commandOperation.current += 1;
    onReplayOutput(() => {
      setView(nextView);
    });
  }, [onReplayOutput]);

  const replaceCommandView = useCallback((nextView: CommandView) => {
    setView(nextView);
  }, []);

  const startCommandLoad = useCallback((
    title: string,
    label: string,
    enterFromChat = true,
    cancellable = true,
  ): number => {
    const operation = ++commandOperation.current;
    const nextView: CommandView = {
      kind: "loading",
      title,
      label,
      cancellable,
    };
    if (enterFromChat) {
      onReplayOutput(() => setView(nextView));
    } else {
      setView(nextView);
    }
    return operation;
  }, [onReplayOutput]);

  const isCurrentCommandOperation = useCallback(
    (operation: number): boolean => commandOperation.current === operation,
    [],
  );

  const returnToChat = useCallback((update?: () => void) => {
    commandOperation.current += 1;
    onReplayOutput(() => {
      update?.();
      setView({ kind: "chat" });
      setTimelineEpoch((current) => current + 1);
      setInputKey((current) => current + 1);
    });
  }, [onReplayOutput]);

  const openInfo = useCallback((
    title: string,
    text: string,
    tone: CommandSurfaceTone = "default",
  ) => {
    enterCommandView(infoView(title, text, tone));
  }, [enterCommandView]);

  const finishConfirmation = useCallback(
    (accepted: boolean) => {
      const pending = confirmationRef.current;
      confirmationRef.current = undefined;
      setConfirmation(undefined);
      if (!accepted) append("system", "Bash command rejected");
      pending?.resolve(accepted);
    },
    [append],
  );

  const requestBashConfirmation = useCallback(
    (command: string): Promise<boolean> => {
      append("tool", `! ${command}`);
      return new Promise((resolve) => {
        const pending = { command, resolve };
        confirmationRef.current = pending;
        setConfirmation(pending);
      });
    },
    [append],
  );

  const executeBash = useCallback(
    async (command: string, signal?: AbortSignal): Promise<BashResult> => {
      const started = Date.now();
      setActiveCommand({ command, shell: "Bash" });
      let generation = 0;
      let finished = false;
      setTerminalBusy(true);
      setTerminalOutput(undefined);
      const preview = (output: string) => {
        const id = ++generation;
        void renderTerminalOutput(output).then((clean) => { if (!finished && id === generation) setTerminalOutput(clean); });
      };
      let result: BashResult;
      try { result = await dependencies.runBash(command, signal, preview); }
      finally { finished = true; setTerminalBusy(false); setTerminalOutput(undefined); setActiveCommand(undefined); }
      if (result === undefined) throw new Error("Bash did not return a result");
      const output = await renderTerminalOutput(commandOutput(result));
      const retained = retainOutput(output);
      appendCommand(retained.text, { id: randomUUID(), command, shell: "Bash", workspace: workspacePath, source: "model", status: result.cancelled ? "cancelled" : result.error || result.exitCode !== 0 ? "failed" : "completed", durationMs: Date.now() - started, truncated: retained.truncated || result.truncated === true });
      const status = bashStatus(result);
      append(status.kind, status.text);
      return result;
    },
    [append, appendCommand, dependencies, workspacePath],
  );

  const executeTerminalCommand = useCallback(
    async (
      command: string,
      onOutput?: (output: string) => void,
    ): Promise<BashResult> => {
      const started = Date.now();
      const shell = process.platform === "win32" ? "PowerShell" : "Bash";
      setActiveCommand({ command, shell });
      terminalCommandRunning.current = true;
      let result: BashResult;
      try {
        result = await dependencies.runTerminalCommand(command, onOutput, directController.current?.signal, (write) => { commandInput.current = write; });
      } finally {
        terminalCommandRunning.current = false;
        commandInput.current = undefined;
        setActiveCommand(undefined);
      }
      const output = commandOutput(result);
      const retained = retainOutput(output);
      appendCommand(retained.text, { id: randomUUID(), command, shell, workspace: workspacePath, source: "user", status: result.cancelled ? "cancelled" : result.error || result.exitCode !== 0 ? "failed" : "completed", durationMs: Date.now() - started, truncated: retained.truncated || result.truncated === true });
      const status = terminalStatus(result);
      append(status.kind, status.text);
      return result;
    },
    [append, appendCommand, dependencies, workspacePath],
  );

  const agentIo = useMemo<AgentIO>(
    () => ({
      getPermissions: () => ({ ...permissions.current }),
      confirmBash: requestBashConfirmation,
      runBash: executeBash,
      writeAssistant(text) {
        append("assistant", text);
      },
      writeTool(text) {
        append("tool", text);
      },
    }),
    [append, executeBash, requestBashConfirmation],
  );

  const agent = useMemo(
    () =>
      activeModel === undefined
        ? undefined
        : dependencies.createAgent(activeModel, agentIo, {
            initialContext: sessionContext,
            async onContextAppend(items) {
              const sessionId = activeSessionId.current;
              if (sessionId !== undefined) {
                await dependencies.sessionStore.appendContext(sessionId, items);
              }
            },
            async onUsage(usage) {
              setSessionUsage((current) => applyUsageSample(current, usage));
              const sessionId = activeSessionId.current;
              if (sessionId !== undefined) {
                await dependencies.sessionStore.appendUsage(sessionId, usage);
              }
            },
          }),
    [activeModel, agentIo, dependencies, sessionContext, sessionEpoch],
  );

  const activateModel = useCallback(
    (model: RegisteredModel, message = `已启用模型 ${model.model_name}`) => {
      abortController.current?.abort();
      const sessionId = activeSessionId.current;
      if (sessionId !== undefined) {
        void dependencies.sessionStore
          .selectModel(sessionId, toSessionModel(model), false)
          .catch((error: unknown) => {
            appendTransient("error", `Session save failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
      returnToChat(() => {
        setActiveModel(model);
        setSessionContext([]);
        setSessionUsage((current) => resetContextUsage(current, false));
        setSessionEpoch((current) => current + 1);
        appendTransient("system", `${message}；对话上下文已重置。`);
      });
    },
    [appendTransient, dependencies.sessionStore, returnToChat],
  );

  const showModels = useCallback(async () => {
    const operation = startCommandLoad(
      "/models · 模型状态",
      "正在读取模型注册表",
    );
    try {
      const models = await dependencies.registry.listStatuses();
      if (!isCurrentCommandOperation(operation)) return;
      if (models.length === 0) {
        replaceCommandView(infoView(
          "/models · 模型状态",
          "尚未注册模型，请使用 /login。",
        ));
        return;
      }
      replaceCommandView(infoView(
        "/models · 模型状态",
        models
          .map(
            (model) =>
              `${activeModel?.id === model.id ? "●" : "○"} ${model.model_name} [${model.credential_status}]`,
          )
          .join("\n"),
      ));
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        "/models · 读取失败",
        error instanceof Error ? error.message : String(error),
        "error",
      ));
    }
  }, [
    activeModel?.id,
    dependencies.registry,
    isCurrentCommandOperation,
    replaceCommandView,
    startCommandLoad,
  ]);

  const openModelPicker = useCallback(async () => {
    const operation = startCommandLoad(
      "/model · 切换模型",
      "正在读取可用模型",
    );
    try {
      const resolved = await dependencies.registry.resolveAll();
      if (!isCurrentCommandOperation(operation)) return;
      if (resolved.available.length === 0) {
        replaceCommandView(infoView(
          "/model · 切换模型",
          "没有可用模型，请先使用 /login。",
        ));
        return;
      }
      replaceCommandView({
        kind: "model-picker",
        title: "切换当前模型",
        models: resolved.available,
      });
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        "/model · 读取失败",
        error instanceof Error ? error.message : String(error),
        "error",
      ));
    }
  }, [
    dependencies.registry,
    isCurrentCommandOperation,
    replaceCommandView,
    startCommandLoad,
  ]);

  const openLogout = useCallback(async () => {
    const operation = startCommandLoad(
      "/logout · 注销模型",
      "正在读取模型注册表",
    );
    try {
      const models = await dependencies.registry.listStatuses();
      if (!isCurrentCommandOperation(operation)) return;
      if (models.length === 0) {
        replaceCommandView(infoView(
          "/logout · 注销模型",
          "尚未注册模型。",
        ));
        return;
      }
      replaceCommandView({ kind: "logout", models });
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        "/logout · 读取失败",
        error instanceof Error ? error.message : String(error),
        "error",
      ));
    }
  }, [
    dependencies.registry,
    isCurrentCommandOperation,
    replaceCommandView,
    startCommandLoad,
  ]);

  const completeResume = useCallback(
    async (
      loaded: LoadedSession,
      model: RegisteredModel,
      replacementModel: boolean,
    ) => {
      const previousWorkspace = workspacePath;
      let changedWorkspace = false;
      try {
        const restoredWorkspace = await dependencies.changeWorkspace(
          loaded.summary.workspace_path,
        );
        changedWorkspace = restoredWorkspace !== previousWorkspace;
        if (replacementModel) {
          await dependencies.sessionStore.selectModel(
            loaded.summary.id,
            toSessionModel(model),
            true,
          );
        }

        const restoredTimeline: TimelineEntry[] = [
          { id: 0, kind: "banner", modelName: model.model_name },
          ...loaded.timeline.map((entry, index): TimelineEntry =>
            entry.kind === "status"
              ? {
                  id: index + 1,
                  kind: "status",
                  snapshot: { ...entry.snapshot },
                }
              : {
                  id: index + 1,
                  kind: entry.kind,
                  text: entry.text,
                  ...(entry.command ? { command: entry.command } : {}),
                },
          ),
        ];

        abortController.current?.abort();
        activeSessionId.current = loaded.summary.id;
        sessionTitlePending.current = loaded.summary.title_pending;
        nextId.current = restoredTimeline.length;
        onReplayOutput(() => {
          setTimeline(restoredTimeline);
          setResumedInputHistory(loaded.timeline.flatMap((entry) => {
            if (entry.kind === "user") return [entry.text];
            if (entry.kind === "output" && entry.command?.source === "user") return [`!${entry.command.command}`];
            return [];
          }));
          editorRef.current = createComposerState();
          historyNavigationRef.current = { index: undefined, draft: "" };
          setTimelineEpoch((current) => current + 1);
          setSessionContext(loaded.context.map((item) => ({ ...item })));
          setSessionUsage(
            replacementModel
              ? resetContextUsage(loaded.usage, true)
              : { ...loaded.usage },
          );
          setActiveModel(model);
          setWorkspacePath(restoredWorkspace);
          setSessionEpoch((current) => current + 1);
          setInputKey((current) => current + 1);
          setView({ kind: "chat" });
        });
      } catch (error) {
        if (changedWorkspace) {
          await dependencies.changeWorkspace(previousWorkspace).catch(() => undefined);
        }
        throw error;
      }
    },
    [dependencies, onReplayOutput, workspacePath],
  );

  const chooseSession = useCallback(
    async (summary: SessionSummary) => {
      let operation = startCommandLoad(
        "/resume · 恢复 Session",
        "正在读取 Session",
        false,
      );
      try {
        const [loaded, resolved] = await Promise.all([
          dependencies.sessionStore.load(summary.id),
          dependencies.registry.resolveAll(),
        ]);
        if (!isCurrentCommandOperation(operation)) return;
        const originalModel = resolved.available.find(
          (candidate) =>
            candidate.id === loaded.summary.model.id ||
            (candidate.model_name === loaded.summary.model.model_name &&
              candidate.base_url === loaded.summary.model.base_url),
        );

        if (originalModel) {
          operation = startCommandLoad(
            "/resume · 恢复 Session",
            "正在恢复 Session",
            false,
            false,
          );
          await completeResume(loaded, originalModel, false);
        } else if (resolved.available.length > 0) {
          replaceCommandView({
            kind: "model-picker",
            title: `原模型 ${loaded.summary.model.model_name} 不可用，请选择替代模型`,
            models: resolved.available,
            resumeSession: loaded,
          });
        } else {
          replaceCommandView(infoView(
            "/resume · 恢复失败",
            "原 Session 模型不可用；请先使用 /login 注册模型。",
            "error",
          ));
        }
      } catch (error) {
        if (!isCurrentCommandOperation(operation)) return;
        replaceCommandView(infoView(
          "/resume · 恢复失败",
          `Session restore failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        ));
      }
    },
    [
      completeResume,
      dependencies.registry,
      dependencies.sessionStore,
      isCurrentCommandOperation,
      replaceCommandView,
      startCommandLoad,
    ],
  );

  const openResume = useCallback(async () => {
    const operation = startCommandLoad(
      "/resume · 恢复 Session",
      "正在读取 Session",
    );
    try {
      const result = await dependencies.sessionStore.list();
      if (!isCurrentCommandOperation(operation)) return;
      const notice = result.skipped > 0
        ? `已跳过 ${result.skipped} 个损坏的 Session 文件。`
        : undefined;
      if (result.sessions.length === 0) {
        replaceCommandView(infoView(
          "/resume · 恢复 Session",
          [notice, "没有可恢复的 Session。"].filter(Boolean).join("\n"),
          notice ? "error" : "default",
        ));
        return;
      }
      replaceCommandView({
        kind: "session-picker",
        sessions: result.sessions,
        ...(notice === undefined ? {} : { notice }),
      });
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        "/resume · 读取失败",
        `Session list failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      ));
    }
  }, [
    dependencies.sessionStore,
    isCurrentCommandOperation,
    replaceCommandView,
    startCommandLoad,
  ]);

  const startTitleGeneration = useCallback(
    (sessionId: string, model: RegisteredModel, firstQuestion: string) => {
      const titleController = new AbortController();
      titleControllers.current.add(titleController);
      void dependencies
        .generateSessionTitle(model, firstQuestion, titleController.signal)
        .then((title) => dependencies.sessionStore.updateTitle(sessionId, title))
        .catch(() => undefined)
        .finally(() => titleControllers.current.delete(titleController));
    },
    [dependencies],
  );

  const createNewSession = useCallback(async () => {
    if (!activeModel) {
      openInfo(
        "/new · 无法创建 Session",
        "尚未启用模型，请先使用 /login 或 /model。",
        "error",
      );
      return;
    }

    setBusyLabel("正在创建新 Session");
    const message = "已创建新 Session；发送第一条消息后会自动生成名称。";
    try {
      const session = await dependencies.sessionStore.create({
        title: "新 Session",
        titlePending: true,
        workspacePath,
        model: toSessionModel(activeModel),
      });

      abortController.current?.abort();
      activeSessionId.current = session.id;
      sessionTitlePending.current = true;
      nextId.current = 2;
      onReplayOutput(() => {
        setTimeline([
          { id: 0, kind: "banner", modelName: activeModel.model_name },
          { id: 1, kind: "system", text: message },
        ]);
        setTimelineEpoch((current) => current + 1);
        setSessionContext([]);
        setSessionUsage(createEmptySessionUsage());
        setResumedInputHistory(undefined);
        historyNavigationRef.current = { index: undefined, draft: "" };
        setSessionEpoch((current) => current + 1);
        setInputKey((current) => current + 1);
        setView({ kind: "chat" });
      });
    } catch (error) {
      openInfo(
        "/new · 创建失败",
        `Session creation failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      setBusyLabel(undefined);
    }
  }, [activeModel, dependencies.sessionStore, onReplayOutput, openInfo, workspacePath]);

  const clearConversation = useCallback(() => {
    setResumedInputHistory(undefined);
    editorRef.current = createComposerState();
    historyNavigationRef.current = { index: undefined, draft: "" };
    abortController.current?.abort();
    activeSessionId.current = undefined;
    sessionTitlePending.current = false;
    setSessionContext([]);
    setSessionUsage(createEmptySessionUsage());
    const banner: TimelineEntry = {
      id: nextId.current++,
      kind: "banner",
      ...(activeModel === undefined ? {} : { modelName: activeModel.model_name }),
    };
    onReplayOutput(() => {
      setTimeline([banner]);
      setTimelineEpoch((current) => current + 1);
      setSessionEpoch((current) => current + 1);
    });
  }, [activeModel, onReplayOutput]);

  const showStatus = useCallback(() => {
    const metadata = activeModel
      ? resolveModelStatusMetadata(activeModel.base_url, activeModel.model_name)
      : undefined;
    enterCommandView({
      kind: "status",
      snapshot: {
        version: dependencies.version,
        model_name: activeModel?.model_name ?? null,
        provider: metadata?.provider ?? "N/A",
        base_url: activeModel?.base_url ?? null,
        workspace_path: workspacePath,
        session_id: activeSessionId.current ?? null,
        context_window: metadata?.context_window ?? null,
        context_tokens: activeModel ? sessionUsage.context_tokens : null,
        input_tokens: sessionUsage.input_tokens,
        output_tokens: sessionUsage.output_tokens,
        usage_complete: sessionUsage.complete,
      },
    });
  }, [
    activeModel,
    dependencies.version,
    enterCommandView,
    sessionUsage,
    workspacePath,
  ]);

  const runChat = useCallback(
    async (text: string) => {
      if (abortController.current || directController.current) return;
      if (!agent || !activeModel) {
        append("error", "尚未启用模型，请先使用 /login 或 /model。");
        return;
      }
      const controller = new AbortController();
      abortController.current = controller;

      if (activeSessionId.current === undefined) {
        setBusyLabel("正在创建 Session");
        try {
          const session = await dependencies.sessionStore.create({
            title: fallbackSessionTitle(text),
            titlePending: false,
            workspacePath,
            model: toSessionModel(activeModel),
          });
          activeSessionId.current = session.id;
          sessionTitlePending.current = false;
          startTitleGeneration(session.id, activeModel, text);
        } catch (error) {
          append("error", `Session creation failed: ${error instanceof Error ? error.message : String(error)}`);
          setBusyLabel(undefined);
          abortController.current = undefined;
          return;
        }
      } else if (sessionTitlePending.current) {
        setBusyLabel("正在初始化 Session");
        const sessionId = activeSessionId.current;
        try {
          await dependencies.sessionStore.updateTitle(
            sessionId,
            fallbackSessionTitle(text),
          );
          sessionTitlePending.current = false;
          startTitleGeneration(sessionId, activeModel, text);
        } catch (error) {
          append("error", `Session initialization failed: ${error instanceof Error ? error.message : String(error)}`);
          setBusyLabel(undefined);
          abortController.current = undefined;
          return;
        }
      }

      append("user", text);
      setBusyLabel(`正在等待 ${activeModel?.model_name ?? "模型"}`);
      try {
        await agent.runTurn(text, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          append("system", "模型请求已取消。");
        } else {
          append("error", `Model request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        if (abortController.current === controller) abortController.current = undefined;
        setBusyLabel(undefined);
      }
    },
    [activeModel, agent, append, dependencies.sessionStore, startTitleGeneration, workspacePath],
  );

  const runDirectBash = useCallback(
    async (command: string) => {
      if (abortController.current || directController.current) return;
      if (!command) {
        append("error", "Usage: !<command>");
        return;
      }
      append("tool", `! ${command}`);
      directController.current = new AbortController();
      setTerminalOutput(undefined);
      setTerminalBusy(true);
      try {
        await executeTerminalCommand(command, setTerminalOutput);
      } catch (error) {
        append("error", error instanceof Error ? error.message : String(error));
      } finally {
        directController.current = undefined;
        setTerminalOutput(undefined);
        setTerminalBusy(false);
      }
    },
    [append, executeTerminalCommand],
  );

  const handleSubmit = useCallback(
    (input: string) => {
      const parsed = parseTuiInput(input);
      if (parsed.kind === "empty") return;
      setInputHistory((current) => current.at(-1) === input ? current : [...current, input].slice(-1000));
      setResumedInputHistory((current) => current === undefined ? undefined : current.at(-1) === input ? current : [...current, input].slice(-1000));
      void dependencies.inputHistory?.append(input).catch(() => appendTransient("error", "Input history could not be saved"));
      setInputKey((current) => current + 1);

      if (parsed.kind === "chat") {
        void runChat(parsed.text);
        return;
      }
      if (parsed.kind === "bash") {
        void runDirectBash(parsed.command);
        return;
      }
      if (parsed.kind === "unknown") {
        openInfo(
          "Slash command 错误",
          `未知命令：${parsed.command}。输入 /help 查看可用命令。`,
          "error",
        );
        return;
      }

      if (parsed.command === "/login") enterCommandView({ kind: "login" });
      if (parsed.command === "/model") void openModelPicker();
      if (parsed.command === "/models") void showModels();
      if (parsed.command === "/status") showStatus();
      if (parsed.command === "/permissions") enterCommandView({ kind: "permissions" });
      if (parsed.command === "/outputs") enterCommandView({ kind: "outputs" });
      if (parsed.command === "/history") enterCommandView({ kind: "input-history" });
      if (parsed.command === "/terminal-setup") enterCommandView({ kind: "terminal-setup" });
      if (parsed.command === "/new") void createNewSession();
      if (parsed.command === "/resume") void openResume();
      if (parsed.command === "/logout") void openLogout();
      if (parsed.command === "/clear") clearConversation();
      if (parsed.command === "/help") openInfo("/help · 帮助", TUI_HELP);
      if (parsed.command === "/exit") exit(0);
    },
    [
      clearConversation,
      createNewSession,
      enterCommandView,
      exit,
      openLogout,
      openModelPicker,
      openResume,
      openInfo,
      runChat,
      runDirectBash,
      showModels,
      showStatus,
    ],
  );

  const finishLogout = useCallback(
    (removedIds: string[]) => {
      const message = `已删除 ${removedIds.length} 个模型及对应系统凭据。`;
      if (!activeModel || !removedIds.includes(activeModel.id)) {
        returnToChat(() => appendTransient("system", message));
        return;
      }

      appendTransient("system", message);
      setActiveModel(undefined);
      setSessionContext([]);
      setSessionUsage((current) => resetContextUsage(current, false));
      setSessionEpoch((current) => current + 1);
      const operation = startCommandLoad(
        "/logout · 注销模型",
        "正在刷新可用模型",
        false,
        false,
      );
      void dependencies.registry
        .resolveAll()
        .then((resolved) => {
          if (!isCurrentCommandOperation(operation)) return;
          if (resolved.available.length === 1) {
            activateModel(resolved.available[0]!, `已自动切换到 ${resolved.available[0]!.model_name}`);
          } else if (resolved.available.length > 1) {
            replaceCommandView({
              kind: "model-picker",
              title: "当前模型已注销，请选择新模型",
              models: resolved.available,
            });
          } else {
            returnToChat(() => {
              appendTransient("system", "当前没有可用模型，请使用 /login。");
            });
          }
        })
        .catch((error: unknown) => {
          if (!isCurrentCommandOperation(operation)) return;
          replaceCommandView(infoView(
            "/logout · 刷新失败",
            error instanceof Error ? error.message : String(error),
            "error",
          ));
        });
    },
    [
      activeModel,
      activateModel,
      appendTransient,
      dependencies.registry,
      isCurrentCommandOperation,
      replaceCommandView,
      returnToChat,
      startCommandLoad,
    ],
  );

  usePaste((text) => commandInput.current?.(text), { isActive: terminalBusy && directController.current !== undefined });
  useInput(
    (input, key) => {
      if (key.eventType === "release") return;
      if (!(key.ctrl && input === "c")) {
        if (commandInput.current) {
          const encoded = key.return ? "\r" : key.backspace ? "\u007f" : key.tab ? "\t" : key.escape ? "\u001b" : key.upArrow ? "\u001b[A" : key.downArrow ? "\u001b[B" : key.rightArrow ? "\u001b[C" : key.leftArrow ? "\u001b[D" : key.home ? "\u001b[H" : key.end ? "\u001b[F" : key.delete ? "\u001b[3~" : key.ctrl && input.length === 1 ? String.fromCharCode(input.toUpperCase().charCodeAt(0) & 31) : input;
          if (encoded) commandInput.current(encoded);
        }
        return;
      }
      if (directController.current) { setActiveCommand((current) => current ? { ...current, cancelling: true } : current); directController.current.abort(); return; }
      if (abortController.current) {
        abortController.current.abort();
        setActiveCommand((current) => current ? { ...current, cancelling: true } : current);
        if (confirmationRef.current) finishConfirmation(false);
        return;
      }
      if (confirmationRef.current) {
        finishConfirmation(false);
        return;
      }
    },
    { isActive: view.kind === "chat" || confirmation !== undefined },
  );

  useEffect(
    () => () => {
      abortController.current?.abort();
      titleControllers.current.forEach((controller) => controller.abort());
      titleControllers.current.clear();
      confirmationRef.current?.resolve(false);
      confirmationRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    let redrawTimer: ReturnType<typeof setTimeout> | undefined;
    const redrawAfterResize = () => {
      if (redrawTimer !== undefined) clearTimeout(redrawTimer);
      redrawTimer = setTimeout(() => {
        // Rebuild the complete source-backed timeline at the final width, like
        // Codex's transcript reflow. The active composer has already followed
        // the viewport through Ink's immediate resize render.
        onReplayOutput(() => {
          setTimelineEpoch((current) => current + 1);
        });
      }, RESIZE_REDRAW_DEBOUNCE_MS);
    };

    stdout.on("resize", redrawAfterResize);
    return () => {
      stdout.off("resize", redrawAfterResize);
      if (redrawTimer !== undefined) clearTimeout(redrawTimer);
    };
  }, [onReplayOutput, stdout]);

  if (view.kind !== "chat") {
    return (
      <CommandScreen>
        {view.kind === "outputs" ? (
          <TextBrowser title="/outputs" entries={timeline.filter((entry) => entry.kind === "output").map((entry) => ({ label: entry.kind === "output" ? entry.command?.command ?? entry.text.split("\n")[0] ?? "Output" : "", text: entry.kind === "output" ? `${entry.command ? `${entry.command.shell} | ${entry.command.status} | ${entry.command.durationMs}ms\n${entry.command.command}\n${entry.command.truncated ? "[output truncated]\n" : ""}` : ""}${entry.text}` : "" })).reverse()} onBack={returnToChat} />
        ) : view.kind === "input-history" ? (
          <TextBrowser title="/history" entries={[...inputHistory].reverse().map((text) => ({ label: text, text }))} onBack={returnToChat} onClear={async () => { await dependencies.inputHistory?.clear(); setInputHistory([]); }} />
        ) : view.kind === "terminal-setup" ? (
          <TerminalSetup onBack={returnToChat} />
        ) : view.kind === "permissions" ? (
          <PermissionsPicker
            policy={permissions.current}
            workspace={workspacePath}
            onChange={(policy) => {
              permissions.current = policy;
              returnToChat();
            }}
            onBack={returnToChat}
          />
        ) : view.kind === "login" ? (
          <LoginWizard
            dependencies={dependencies}
            onComplete={(model) => activateModel(model, `已登录并启用 ${model.model_name}`)}
            onCancel={returnToChat}
          />
        ) : view.kind === "model-picker" ? (
          <ModelPicker
            title={view.title}
            models={view.models}
            onSelect={(model) => {
              if (!view.resumeSession) {
                activateModel(model);
                return;
              }
              const loaded = view.resumeSession;
              const operation = startCommandLoad(
                "/resume · 恢复 Session",
                "正在恢复 Session",
                false,
                false,
              );
              void completeResume(loaded, model, true)
                .catch((error: unknown) => {
                  if (!isCurrentCommandOperation(operation)) return;
                  replaceCommandView(infoView(
                    "/resume · 恢复失败",
                    `Session restore failed: ${error instanceof Error ? error.message : String(error)}`,
                    "error",
                  ));
                });
            }}
            onCancel={returnToChat}
          />
        ) : view.kind === "session-picker" ? (
          <SessionPicker
            sessions={view.sessions}
            {...(view.notice === undefined ? {} : { notice: view.notice })}
            onSelect={(session) => void chooseSession(session)}
            onCancel={returnToChat}
          />
        ) : view.kind === "logout" ? (
          <LogoutWizard
            dependencies={dependencies}
            models={view.models}
            onComplete={finishLogout}
            onCancel={returnToChat}
          />
        ) : view.kind === "loading" ? (
          <CommandLoadingSurface
            title={view.title}
            label={view.label}
            {...(view.cancellable ? { onBack: returnToChat } : {})}
          />
        ) : view.kind === "info" ? (
          <CommandInfoSurface
            title={view.title}
            text={view.text}
            tone={view.tone}
            onBack={returnToChat}
          />
        ) : (
          <StatusSurface
            snapshot={(view as Extract<View, { kind: "status" }>).snapshot}
            onBack={returnToChat}
          />
        )}
      </CommandScreen>
    );
  }

  return (
    <Box width="100%" paddingRight={1} flexDirection="column">
      <History
        key={`history-${timelineEpoch}`}
        entries={timeline}
        version={dependencies.version}
        workspacePath={workspacePath}
      />

      {confirmation ? (
        <BashConfirmation
          command={confirmation.command}
          onConfirm={() => finishConfirmation(true)}
          onCancel={() => finishConfirmation(false)}
        />
      ) : terminalBusy ? (
        <Box flexDirection="column">
          <Text wrap="truncate-end">{activeCommand?.cancelling ? "Cancelling" : "Running"} {activeCommand?.shell}: {activeCommand?.command}</Text>
          <TerminalActivity output={terminalOutput} />
        </Box>
      ) : busyLabel ? (
        <Spinner label={busyLabel} />
      ) : (
        <Prompt
          key={`prompt-${inputKey}`}
          activeModelName={activeModel?.model_name}
          history={resumedInputHistory ?? inputHistory}
            editorRef={editorRef}
            historyNavigationRef={historyNavigationRef}
          onEmptyInterrupt={() => exit(0)}
          onSubmit={handleSubmit}
        />
      )}

      <StatusBar
        modelName={activeModel?.model_name}
        workspacePath={workspacePath}
      />
    </Box>
  );
}
