import { Spinner } from "@inkjs/ui";
import { Box, Text, useApp, useInput, usePaste, useStdout, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentIO } from "../../agent/react-agent.js";
import type { LoopPhase } from "../../agent/agent-loop.js";
import { defaultPermissions } from "../../permissions/policy.js";
import { PermissionsPicker } from "../components/navigation/permissions-picker.js";
import { renderTerminalOutput } from "../../tools/terminal.js";
import { TextBrowser } from "../components/screens/text-browser.js";
import { TerminalSetup } from "../components/wizards/terminal-setup.js";
import { retainOutput, type CommandRecord } from "../../tools/command-record.js";
import { randomUUID } from "node:crypto";
import { createComposerState } from "../composer/editor.js";
import type {
  RegisteredModel,
  RegisteredModelStatus,
  ResolvedModels,
} from "../../storage/model-registry.js";
import type {
  LoadedSession,
  SessionModelRef,
  SessionSummary,
} from "../../storage/session-store.js";
import {
  applyUsageSample,
  createEmptySessionUsage,
  resetContextUsage,
  resolveModelStatusMetadata,
  type StatusSnapshot,
} from "../../status/model-status.js";
import type { BashOutputPreview, BashResult } from "../../tools/bash.js";
import { selectAgentOutputPreview } from "../rendering/command-output-preview.js";
import { parseTuiInput, TUI_HELP } from "../commands/slash-commands.js";
import { ApprovalConfirmation } from "../components/feedback/approval-confirmation.js";
import {
  CommandInfoSurface,
  CommandLoadingSurface,
  CommandScreen,
  StatusSurface,
  type CommandSurfaceTone,
} from "../components/screens/command-surface.js";
import { History } from "../components/conversation/history.js";
import { visibleHistory } from "../rendering/history-window.js";
import { LoginWizard } from "../components/wizards/login-wizard.js";
import { LogoutWizard } from "../components/wizards/logout-wizard.js";
import { ModelPicker } from "../components/navigation/model-picker.js";
import { Prompt } from "../composer/prompt.js";
import { SessionPicker } from "../components/navigation/session-picker.js";
import { StatusBar } from "../components/conversation/status-bar.js";
import { SkillWizard } from "../components/wizards/skill-wizard.js";
import { HighlightedCommand, RichOutput } from "../rendering/rich-text.js";
import { TUI_COLORS } from "../rendering/palette.js";
import { truncateEnd } from "../rendering/text-width.js";
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
  | { kind: "skills" }
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
  kind: "bash" | "web" | "mcp";
  request: string;
  resolve(accepted: boolean): void;
}

interface QueuedGuidance {
  text: string;
  timelineRecorded: boolean;
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
    ? { kind: "model-picker", title: "Choose a model for this session", models }
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

export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remaining}s`;
  if (minutes > 0) return `${minutes}m ${remaining}s`;
  return `${remaining}s`;
}

function commandOutput(result: BashResult): string {
  return [result.stdout.trimEnd(), result.stderr.trimEnd()]
    .filter((text) => text.length > 0)
    .join("\n");
}

async function renderBashOutputPreview(
  preview: BashOutputPreview,
): Promise<BashOutputPreview> {
  const renderLines = async (lines: readonly string[]): Promise<string[]> => {
    if (lines.length === 0) return [];
    const rendered = await renderTerminalOutput(lines.join("\n"));
    return rendered.length > 0 ? rendered.split("\n") : [];
  };

  if (preview.omittedLines === 0) {
    return {
      headLines: await renderLines([
        ...preview.headLines,
        ...preview.tailLines,
      ]),
      tailLines: [],
      omittedLines: 0,
    };
  }

  const [headLines, tailLines] = await Promise.all([
    renderLines(preview.headLines),
    renderLines(preview.tailLines),
  ]);
  return { headLines, tailLines, omittedLines: preview.omittedLines };
}

function TerminalActivity({
  output,
  agentPreview,
}: {
  output: string | undefined;
  agentPreview: BashOutputPreview | undefined;
}) {
  const { rows } = useWindowSize();
  const maximumOutputLines = Math.max(1, Math.min(10, rows - 4));
  const allLines = output ? output.split("\n") : [];
  const directOutputLines = Math.min(5, maximumOutputLines);
  const hiddenLineCount = Math.max(0, allLines.length - directOutputLines);
  const visibleLines = allLines.slice(hiddenLineCount);
  const selectedAgentPreview = selectAgentOutputPreview(
    agentPreview,
    maximumOutputLines,
  );
  const isAgentPreview = agentPreview !== undefined;
  const headLines = isAgentPreview
    ? selectedAgentPreview.headLines
    : [];
  const tailLines = isAgentPreview
    ? selectedAgentPreview.tailLines
    : visibleLines;
  const omittedLines = isAgentPreview
    ? selectedAgentPreview.omittedLines
    : hiddenLineCount;
  const previewLines = [
    ...headLines,
    ...(omittedLines > 0
      ? [isAgentPreview ? `… +${omittedLines} lines` : `… ${omittedLines} earlier lines`]
      : []),
    ...tailLines,
  ];

  return (
    <Box flexDirection="column">
      {previewLines.length ? <RichOutput text={previewLines.join("\n")} marginLeft={3} /> : null}
      <Box paddingLeft={1}>
        <Text dimColor>└ Command is still running</Text>
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
        text: `Missing credentials for ${model.model_name}. Use /login to repair or /logout to remove it.`,
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
  const [terminalColumns, setTerminalColumns] = useState(() => Math.max(1, stdout.columns ?? 80));
  const displayTimeline = useMemo(
    () => visibleHistory(timeline, { columns: terminalColumns }),
    [terminalColumns, timeline],
  );
  const firstDisplayedId = displayTimeline[0]?.id;
  const previousFirstDisplayedId = useRef(firstDisplayedId);
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
  const [agentPhase, setAgentPhase] = useState<LoopPhase>();
  const [turnStartedAt, setTurnStartedAt] = useState<number>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [queuedGuidanceCount, setQueuedGuidanceCount] = useState(0);
  const [liveAssistant, setLiveAssistant] = useState("");
  const [liveToolStatus, setLiveToolStatus] = useState<string>();
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState<string>();
  const [agentTerminalPreview, setAgentTerminalPreview] = useState<BashOutputPreview>();
  const [activeCommand, setActiveCommand] = useState<{ command: string; shell: string; source: "model" | "user"; cancelling?: boolean }>();
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [resumedInputHistory, setResumedInputHistory] = useState<string[]>();
  const editorRef = useRef(createComposerState());
  const historyNavigationRef = useRef<{ index: number | undefined; draft: string }>({ index: undefined, draft: "" });
  const directController = useRef<AbortController | undefined>(undefined);
  const commandInput = useRef<((input: string) => void) | undefined>(undefined);
  const queuedGuidance = useRef<QueuedGuidance[]>([]);
  const runChatRef = useRef<((text: string, timelineRecorded?: boolean) => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void dependencies.inputHistory?.load().then((entries) => { if (active) setInputHistory((current) => [...entries, ...current].slice(-1000)); }).catch(() => undefined);
    return () => { active = false; directController.current?.abort(); };
  }, [dependencies.inputHistory]);
  const [confirmation, setConfirmation] = useState<PendingConfirmation>();
  useEffect(() => {
    const previous = previousFirstDisplayedId.current;
    previousFirstDisplayedId.current = firstDisplayedId;
    if (previous === firstDisplayedId || view.kind !== "chat") return;
    // Static output already lives in native scrollback; slicing alone cannot
    // evict it. Replay through the same atomic reset used for terminal resize.
    onReplayOutput(() => setTimelineEpoch((current) => current + 1));
  }, [firstDisplayedId, view.kind, onReplayOutput]);
  useEffect(() => {
    if (turnStartedAt === undefined) {
      setElapsedSeconds(0);
      return;
    }
    const update = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - turnStartedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [turnStartedAt]);

  const clearQueuedGuidance = useCallback(() => {
    queuedGuidance.current = [];
    setQueuedGuidanceCount(0);
    setLiveAssistant("");
    setLiveToolStatus(undefined);
  }, []);

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
      if (!accepted) {
        const label = pending?.kind === "web"
          ? "Web request rejected"
          : pending?.kind === "mcp"
            ? "MCP tool call rejected"
            : "Shell command rejected";
        append("system", pending?.kind === "mcp" ? label : `${label}: ${pending?.request ?? "unknown request"}`);
      }
      pending?.resolve(accepted);
    },
    [append],
  );

  const requestBashConfirmation = useCallback(
    (command: string): Promise<boolean> => {
      return new Promise((resolve) => {
        const pending = { kind: "bash" as const, request: command, resolve };
        confirmationRef.current = pending;
        setConfirmation(pending);
      });
    },
    [],
  );

  const requestWebConfirmation = useCallback(
    (request: string): Promise<boolean> => {
      return new Promise((resolve) => {
        const pending = { kind: "web" as const, request, resolve };
        confirmationRef.current = pending;
        setConfirmation(pending);
      });
    },
    [],
  );

  const requestMcpConfirmation = useCallback(
    (request: string): Promise<boolean> => {
      return new Promise((resolve) => {
        const pending = { kind: "mcp" as const, request, resolve };
        confirmationRef.current = pending;
        setConfirmation(pending);
      });
    },
    [],
  );

  const executeBash = useCallback(
    async (command: string, signal?: AbortSignal): Promise<BashResult> => {
      const started = Date.now();
      setActiveCommand({ command, shell: process.platform === "win32" ? "PowerShell · Codex sandbox" : "Bash · Codex sandbox", source: "model" });
      let generation = 0;
      let finished = false;
      setTerminalBusy(true);
      setTerminalOutput(undefined);
      setAgentTerminalPreview(undefined);
      const preview = (output: BashOutputPreview) => {
        const id = ++generation;
        void renderBashOutputPreview(output).then((clean) => {
          if (!finished && id === generation) setAgentTerminalPreview(clean);
        });
      };
      let result: BashResult;
      try { result = await dependencies.runBash(command, permissions.current, signal, preview); }
      finally { finished = true; setTerminalBusy(false); setTerminalOutput(undefined); setAgentTerminalPreview(undefined); setActiveCommand(undefined); }
      if (result === undefined) throw new Error("Bash did not return a result");
      const output = await renderTerminalOutput(commandOutput(result));
      const retained = retainOutput(output);
      appendCommand(retained.text, { id: randomUUID(), command, shell: process.platform === "win32" ? "PowerShell" : "Bash", workspace: workspacePath, source: "model", status: result.cancelled ? "cancelled" : result.error || result.exitCode !== 0 ? "failed" : "completed", durationMs: Date.now() - started, truncated: retained.truncated || result.truncated === true });
      return result;
    },
    [appendCommand, dependencies, workspacePath],
  );

  const executeTerminalCommand = useCallback(
    async (
      command: string,
      onOutput?: (output: string) => void,
    ): Promise<BashResult> => {
      const started = Date.now();
      const shell = process.platform === "win32" ? "PowerShell" : "Bash";
      setActiveCommand({ command, shell, source: "user" });
      setAgentTerminalPreview(undefined);
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
      return result;
    },
    [appendCommand, dependencies, workspacePath],
  );

  const agentIo = useMemo<AgentIO>(
    () => ({
      getPermissions: () => ({ ...permissions.current }),
      confirmBash: requestBashConfirmation,
      confirmWeb: requestWebConfirmation,
      confirmMcp: requestMcpConfirmation,
      runBash: executeBash,
      writeAssistant(text) {
        setLiveAssistant("");
        append("assistant", text);
      },
      writeAssistantDelta(text) {
        setLiveAssistant((current) => current + text);
      },
      writeTool(text) {
        setLiveToolStatus(text);
        append("tool", text);
      },
            onToolProgress(event) {
              const detail = event.detail?.replace(/\s+/g, " ").trim();
              const suffix = detail ? ` ${truncateEnd(detail, 160)}` : "";
              if (event.phase === "approval") {
                setLiveToolStatus(`Waiting for approval: ${event.name}${suffix}`);
              } else if (event.phase === "streaming") {
                setLiveToolStatus(`Preparing ${event.name}${suffix}`);
              } else if (event.phase === "started") {
                setLiveToolStatus(`${event.name}${detail ? `: ${truncateEnd(detail, 160)}` : ""}`);
        } else if (event.phase === "finished") {
          setLiveToolStatus(`${event.name} finished`);
        }
      },
    }),
    [append, executeBash, requestBashConfirmation, requestMcpConfirmation, requestWebConfirmation],
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
            onPhase(phase) {
              setAgentPhase(phase);
            },
            onEvent(event) {
              if (event.type === "sampling_started") {
                setLiveAssistant("");
                setLiveToolStatus(undefined);
              } else if (event.type === "retrying") {
                setLiveAssistant("");
                setLiveToolStatus(`Retrying model request (attempt ${event.attempt})`);
              } else if (event.type === "steering_applied") {
                setQueuedGuidanceCount((current) => Math.max(0, current - event.count));
                setLiveAssistant("");
                setLiveToolStatus("Guidance applied; continuing with the updated task");
              } else if (event.type === "tool_started") {
                setLiveToolStatus(`Preparing ${event.call.name}`);
              } else if (event.type === "tool_finished") {
                setLiveToolStatus(`${event.call.name} finished`);
              }
            },
          }),
    [activeModel, agentIo, dependencies, sessionContext, sessionEpoch],
  );

  const activateModel = useCallback(
    (model: RegisteredModel, message = `Enabled model ${model.model_name}`) => {
      clearQueuedGuidance();
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
        appendTransient("system", `${message}; conversation context was reset.`);
      });
    },
    [appendTransient, clearQueuedGuidance, dependencies.sessionStore, returnToChat],
  );

  const showModels = useCallback(async () => {
    const operation = startCommandLoad(
      "/models · Model status",
      "Reading model registry",
    );
    try {
      const models = await dependencies.registry.listStatuses();
      if (!isCurrentCommandOperation(operation)) return;
      if (models.length === 0) {
        replaceCommandView(infoView(
          "/models · Model status",
          "No models are registered. Use /login first.",
        ));
        return;
      }
      replaceCommandView(infoView(
        "/models · Model status",
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
        "/models · Could not load",
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

  const showMcp = useCallback(async () => {
    const operation = startCommandLoad("/mcp · MCP servers", "Connecting to MCP servers");
    try {
      const text = dependencies.getMcpStatus
        ? await dependencies.getMcpStatus()
        : "MCP runtime is unavailable in this integration.";
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView("/mcp · MCP servers", text));
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView("/mcp · Could not load", error instanceof Error ? error.message : String(error), "error"));
    }
  }, [dependencies, isCurrentCommandOperation, replaceCommandView, startCommandLoad]);

  const openModelPicker = useCallback(async () => {
    const operation = startCommandLoad(
      "/model · Switch model",
      "Reading available models",
    );
    try {
      const resolved = await dependencies.registry.resolveAll();
      if (!isCurrentCommandOperation(operation)) return;
      if (resolved.available.length === 0) {
        replaceCommandView(infoView(
          "/model · Switch model",
          "No models are available. Use /login first.",
        ));
        return;
      }
      replaceCommandView({
        kind: "model-picker",
        title: "Switch the active model",
        models: resolved.available,
      });
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        "/model · Could not load",
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
      "/logout · Remove models",
      "Reading model registry",
    );
    try {
      const models = await dependencies.registry.listStatuses();
      if (!isCurrentCommandOperation(operation)) return;
      if (models.length === 0) {
        replaceCommandView(infoView(
          "/logout · Remove models",
          "No models are registered.",
        ));
        return;
      }
      replaceCommandView({ kind: "logout", models });
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        "/logout · Could not load",
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

        clearQueuedGuidance();
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
    [clearQueuedGuidance, dependencies, onReplayOutput, workspacePath],
  );

  const chooseSession = useCallback(
    async (summary: SessionSummary) => {
      let operation = startCommandLoad(
        "/resume · Resume session",
        "Reading session",
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
            "/resume · Resume session",
            "Restoring session",
            false,
            false,
          );
          await completeResume(loaded, originalModel, false);
        } else if (resolved.available.length > 0) {
          replaceCommandView({
            kind: "model-picker",
            title: `The original model ${loaded.summary.model.model_name} is unavailable; choose a replacement`,
            models: resolved.available,
            resumeSession: loaded,
          });
        } else {
          replaceCommandView(infoView(
            "/resume · Restore failed",
            "The original session model is unavailable. Register a model with /login first.",
            "error",
          ));
        }
      } catch (error) {
        if (!isCurrentCommandOperation(operation)) return;
        replaceCommandView(infoView(
          "/resume · Restore failed",
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
      "/resume · Resume session",
      "Reading sessions",
    );
    try {
      const result = await dependencies.sessionStore.list();
      if (!isCurrentCommandOperation(operation)) return;
      const notice = result.skipped > 0
        ? `Skipped ${result.skipped} damaged session file${result.skipped === 1 ? "" : "s"}.`
        : undefined;
      if (result.sessions.length === 0) {
        replaceCommandView(infoView(
          "/resume · Resume session",
          [notice, "No sessions are available to resume."].filter(Boolean).join("\n"),
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
        "/resume · Could not load",
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
        "/new · Cannot create session",
        "No model is active. Use /login or /model first.",
        "error",
      );
      return;
    }

    clearQueuedGuidance();
    setBusyLabel("Creating a new session");
    const message = "New session created. Its title will be generated after your first message.";
    try {
      const session = await dependencies.sessionStore.create({
        title: "New Session",
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
        "/new · Creation failed",
        `Session creation failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      setBusyLabel(undefined);
    }
  }, [activeModel, clearQueuedGuidance, dependencies.sessionStore, onReplayOutput, openInfo, workspacePath]);

  const clearConversation = useCallback(() => {
    clearQueuedGuidance();
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
    // The explicit replay below already clears the prior native scrollback.
    // Keep the history-window effect from scheduling a redundant second replay.
    previousFirstDisplayedId.current = banner.id;
    onReplayOutput(() => {
      setTimeline([banner]);
      setTimelineEpoch((current) => current + 1);
      setSessionEpoch((current) => current + 1);
    });
  }, [activeModel, clearQueuedGuidance, onReplayOutput]);

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
    async (text: string, timelineRecorded = false) => {
      if (abortController.current || directController.current) return;
      if (!agent || !activeModel) {
        append("error", "No model is active. Use /login or /model first.");
        return;
      }
      const controller = new AbortController();
      abortController.current = controller;

      if (activeSessionId.current === undefined) {
        setBusyLabel("Creating session");
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
          clearQueuedGuidance();
          setBusyLabel(undefined);
          abortController.current = undefined;
          return;
        }
      } else if (sessionTitlePending.current) {
        setBusyLabel("Initializing session");
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
          clearQueuedGuidance();
          setBusyLabel(undefined);
          abortController.current = undefined;
          return;
        }
      }

      if (!timelineRecorded) append("user", text);
      const metadata = resolveModelStatusMetadata(activeModel.base_url, activeModel.model_name);
      const waitingTarget = metadata.provider === "OpenAI-compatible"
        ? activeModel.model_name
        : metadata.provider;
      setAgentPhase("sampling");
      setTurnStartedAt(Date.now());
      setBusyLabel(`Waiting for ${waitingTarget}`);
      setLiveAssistant("");
      setLiveToolStatus(undefined);
      try {
        await agent.runTurn(text, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) {
          append("system", "Model request cancelled.");
        } else {
          append("error", `Model request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        const ownsController = abortController.current === controller;
        if (ownsController) abortController.current = undefined;
        setBusyLabel(undefined);
        setAgentPhase(undefined);
        setTurnStartedAt(undefined);
        setLiveAssistant("");
        setLiveToolStatus(undefined);
        if (controller.signal.aborted && queuedGuidance.current.length === 0) {
          setQueuedGuidanceCount(0);
        }
        if (ownsController) {
          const next = queuedGuidance.current.shift();
          setQueuedGuidanceCount(queuedGuidance.current.length);
          if (next) {
            // Let React render the completed turn before starting the queued
            // guidance, keeping the transcript and spinner ordering stable.
            queueMicrotask(() => void runChatRef.current?.(next.text, next.timelineRecorded));
          }
        }
      }
    },
    [activeModel, agent, append, clearQueuedGuidance, dependencies.sessionStore, startTitleGeneration, workspacePath],
  );

  useEffect(() => {
    runChatRef.current = runChat;
    return () => {
      if (runChatRef.current === runChat) runChatRef.current = undefined;
    };
  }, [runChat]);

  const runDirectBash = useCallback(
    async (command: string) => {
      if (abortController.current || directController.current) return;
      if (!command) {
        append("error", "Usage: !<command>");
        return;
      }
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

  const queueGuidance = useCallback((text: string) => {
    const timelineRecorded = activeSessionId.current !== undefined;
    if (timelineRecorded) append("user", text);
    if (confirmationRef.current) finishConfirmation(false);
    if (agent?.requestSteering?.(text)) {
      setQueuedGuidanceCount((current) => current + 1);
      setLiveToolStatus("Guidance received; applying at the next safe checkpoint");
      return;
    }
    queuedGuidance.current.push({ text, timelineRecorded });
    setQueuedGuidanceCount(queuedGuidance.current.length);
  }, [agent, append, finishConfirmation]);

  const handleSubmit = useCallback(
    (input: string) => {
      const parsed = parseTuiInput(input);
      if (parsed.kind === "empty") return;
      setInputHistory((current) => current.at(-1) === input ? current : [...current, input].slice(-1000));
      setResumedInputHistory((current) => current === undefined ? undefined : current.at(-1) === input ? current : [...current, input].slice(-1000));
      void dependencies.inputHistory?.append(input).catch(() => appendTransient("error", "Input history could not be saved"));
      setInputKey((current) => current + 1);

      if (parsed.kind === "chat") {
        if (abortController.current) queueGuidance(parsed.text);
        else void runChat(parsed.text);
        return;
      }
      if (parsed.kind === "bash") {
        if (abortController.current) {
          appendTransient("system", "A model turn is active. Add guidance as a message or press Ctrl+C first.");
          return;
        }
        void runDirectBash(parsed.command);
        return;
      }
      if (parsed.kind === "unknown") {
        openInfo(
          "Slash command error",
          `Unknown command: ${parsed.command}. Enter /help to see available commands.`,
          "error",
        );
        return;
      }

      if (parsed.command === "/login") enterCommandView({ kind: "login" });
      if (parsed.command === "/model") void openModelPicker();
      if (parsed.command === "/models") void showModels();
      if (parsed.command === "/status") showStatus();
      if (parsed.command === "/permissions") enterCommandView({ kind: "permissions" });
      if (parsed.command === "/mcp") void showMcp();
      if (parsed.command === "/skills") enterCommandView({ kind: "skills" });
      if (parsed.command === "/outputs") enterCommandView({ kind: "outputs" });
      if (parsed.command === "/history") enterCommandView({ kind: "input-history" });
      if (parsed.command === "/terminal-setup") enterCommandView({ kind: "terminal-setup" });
      if (parsed.command === "/new") void createNewSession();
      if (parsed.command === "/resume") void openResume();
      if (parsed.command === "/logout") void openLogout();
      if (parsed.command === "/clear") clearConversation();
      if (parsed.command === "/help") openInfo("/help · Help", TUI_HELP);
      if (parsed.command === "/exit") exit(0);
    },
    [
      clearConversation,
      createNewSession,
      enterCommandView,
      exit,
      appendTransient,
      openLogout,
      openModelPicker,
      openResume,
      openInfo,
      runChat,
      runDirectBash,
      queueGuidance,
      showModels,
      showMcp,
      showStatus,
    ],
  );

  const finishLogout = useCallback(
    (removedIds: string[]) => {
      const message = `Removed ${removedIds.length} model${removedIds.length === 1 ? "" : "s"} and associated system credentials.`;
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
        "/logout · Remove models",
        "Refreshing available models",
        false,
        false,
      );
      void dependencies.registry
        .resolveAll()
        .then((resolved) => {
          if (!isCurrentCommandOperation(operation)) return;
          if (resolved.available.length === 1) {
            activateModel(resolved.available[0]!, `Automatically switched to ${resolved.available[0]!.model_name}`);
          } else if (resolved.available.length > 1) {
            replaceCommandView({
              kind: "model-picker",
              title: "The active model was removed; choose a new model",
              models: resolved.available,
            });
          } else {
            returnToChat(() => {
              appendTransient("system", "No models are available. Use /login first.");
            });
          }
        })
        .catch((error: unknown) => {
          if (!isCurrentCommandOperation(operation)) return;
          replaceCommandView(infoView(
            "/logout · Refresh failed",
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
      queuedGuidance.current = [];
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
      setTerminalColumns(Math.max(1, stdout.columns ?? 80));
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
          <TextBrowser title="/outputs" entries={timeline.filter((entry) => entry.kind === "output").map((entry) => ({ label: entry.kind === "output" ? entry.command?.command ?? entry.text.split("\n")[0] ?? "Output" : "", text: entry.kind === "output" ? entry.text : "", ...(entry.kind === "output" && entry.command ? { command: entry.command } : {}) })).reverse()} onBack={returnToChat} />
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
        ) : view.kind === "skills" ? (
          <SkillWizard
            {...(dependencies.skillManager ? { manager: dependencies.skillManager } : {})}
            {...(activeModel ? { activeModel } : {})}
            {...(dependencies.generateSkillDraft ? { generateDraft: dependencies.generateSkillDraft } : {})}
            {...(dependencies.reviseSkillDraft ? { reviseDraft: dependencies.reviseSkillDraft } : {})}
            onUse={(name) => returnToChat(() => {
              editorRef.current = createComposerState(`$${name} `);
              historyNavigationRef.current = { index: undefined, draft: "" };
            })}
            onBack={returnToChat}
          />
        ) : view.kind === "login" ? (
          <LoginWizard
            dependencies={dependencies}
            onComplete={(model) => activateModel(model, `Signed in and enabled ${model.model_name}`)}
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
                "/resume · Resume session",
                "Restoring session",
                false,
                false,
              );
              void completeResume(loaded, model, true)
                .catch((error: unknown) => {
                  if (!isCurrentCommandOperation(operation)) return;
                  replaceCommandView(infoView(
                    "/resume · Restore failed",
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
        entries={displayTimeline}
        version={dependencies.version}
        workspacePath={workspacePath}
      />

      {confirmation ? (
        <Box flexDirection="column">
          <ApprovalConfirmation
            kind={confirmation.kind}
            request={confirmation.request}
            onConfirm={() => finishConfirmation(true)}
            onCancel={() => finishConfirmation(false)}
          />
          {turnStartedAt !== undefined ? <Text dimColor>Waiting for approval · {formatElapsed(elapsedSeconds)}</Text> : null}
          {liveAssistant ? <Box marginLeft={2}><RichOutput text={liveAssistant} /></Box> : null}
          {liveToolStatus ? <Text color={TUI_COLORS.secondary}>• {liveToolStatus}</Text> : null}
          <Prompt
            key={`prompt-${inputKey}`}
            activeModelName={activeModel?.model_name}
            placeholder="Add guidance while waiting for approval"
            history={resumedInputHistory ?? inputHistory}
            editorRef={editorRef}
            historyNavigationRef={historyNavigationRef}
            onEmptyInterrupt={() => abortController.current?.abort()}
            onSubmit={handleSubmit}
          />
        </Box>
      ) : terminalBusy ? (
        <Box flexDirection="column">
          <Text bold color={activeCommand?.cancelling ? TUI_COLORS.warning : TUI_COLORS.status} wrap="truncate-end">
            • {activeCommand?.cancelling ? "Cancelling" : "Running"} <Text color={TUI_COLORS.secondary}>{activeCommand?.shell}</Text>{turnStartedAt === undefined ? "" : ` (${formatElapsed(elapsedSeconds)})`}
          </Text>
          {activeCommand ? <HighlightedCommand command={activeCommand.command} shell={activeCommand.shell} /> : null}
          <TerminalActivity
            output={terminalOutput}
            agentPreview={activeCommand?.source === "model" ? agentTerminalPreview : undefined}
          />
          {activeCommand?.source === "model" ? (
            <>
              {liveAssistant ? <Box marginLeft={2}><RichOutput text={liveAssistant} /></Box> : null}
              {liveToolStatus ? <Text color={TUI_COLORS.secondary}>• {liveToolStatus}</Text> : null}
              {queuedGuidanceCount > 0 ? <Text dimColor>{queuedGuidanceCount} guidance message{queuedGuidanceCount === 1 ? "" : "s"} pending</Text> : null}
              <Prompt
                key={`prompt-${inputKey}`}
                activeModelName={activeModel?.model_name}
                placeholder="Add guidance while working"
                history={resumedInputHistory ?? inputHistory}
                editorRef={editorRef}
                historyNavigationRef={historyNavigationRef}
                onEmptyInterrupt={() => abortController.current?.abort()}
                onSubmit={handleSubmit}
              />
            </>
          ) : null}
        </Box>
      ) : busyLabel ? (
        <Box flexDirection="column">
          <Spinner label={`${agentPhase === "tools" ? "Working" : busyLabel}${turnStartedAt === undefined ? "" : ` (${formatElapsed(elapsedSeconds)} • ctrl+c to interrupt)`}`} />
          {liveAssistant ? <Box marginLeft={2}><RichOutput text={liveAssistant} /></Box> : null}
          {liveToolStatus ? <Text color={TUI_COLORS.secondary}>• {liveToolStatus}</Text> : null}
          {queuedGuidanceCount > 0 ? <Text dimColor>{queuedGuidanceCount} guidance message{queuedGuidanceCount === 1 ? "" : "s"} pending</Text> : null}
          <Prompt
            key={`prompt-${inputKey}`}
            activeModelName={activeModel?.model_name}
            placeholder="Add guidance while working"
            history={resumedInputHistory ?? inputHistory}
            editorRef={editorRef}
            historyNavigationRef={historyNavigationRef}
            onEmptyInterrupt={() => abortController.current?.abort()}
            onSubmit={handleSubmit}
          />
        </Box>
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
