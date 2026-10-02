import { Spinner } from "@inkjs/ui";
import { Box, Text, useApp, useInput, usePaste, useStdout, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentIO } from "../../agent/react-agent.js";
import type { LoopPhase } from "../../agent/agent-loop.js";
import { commandPermission, defaultPermissions, permissionPolicyRevision } from "../../permissions/policy.js";
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
  SessionSearchResult,
  SessionSummary,
} from "../../storage/session-store.js";
import {
  applyUsageSample,
  applyCompactionUsage,
  createEmptySessionUsage,
  resetContextUsage,
  resolveModelStatusMetadata,
  type StatusSnapshot,
} from "../../status/model-status.js";
import type { BashOutputPreview, BashResult } from "../../tools/bash.js";
import { CodingWorkflowRuntime } from "../../workflow/runtime.js";
import { CodingTaskRunner } from "../../workflow/task-runner.js";
import { createProductionWorkflowAgentIO } from "../../runtime/production.js";
import type { WorkflowState, WorkflowTaskSource } from "../../workflow/types.js";
import { discoverVerificationCommands, selectVerificationCommands } from "../../workflow/verifier.js";
import {
  listWorkspaceChanges,
  readWorkspaceChange,
  type WorkspaceChangeIndex,
} from "../../tools/workspace-review.js";
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
import { MemorySurface } from "../components/screens/memory-surface.js";
import { PlanQuestionsSurface, PlanReviewSurface } from "../components/screens/plan-surface.js";
import { GoalConfirmationSurface, GoalStatusSurface } from "../components/screens/goal-surface.js";
import { WorkspaceDiffSurface } from "../components/screens/workspace-diff-surface.js";
import { ContextSurface } from "../components/screens/context-surface.js";
import { TaskProgressSurface } from "../components/screens/task-progress-surface.js";
import { HighlightedCommand, RichOutput } from "../rendering/rich-text.js";
import { TUI_COLORS } from "../rendering/palette.js";
import { truncateEnd } from "../rendering/text-width.js";
import type {
  HistoryKind,
  TimelineEntry,
  TuiDependencies,
} from "./types.js";
import type { LearnedMemoryPolicy, LearnedMemoryStatus, LearnedScope } from "../../memory/learned-memory.js";
import type { AgentMode, PlanRequest, PlanReviewDecision, SubmittedPlan } from "../../plan/runtime.js";
import { GoalRuntime, parseGoalCommand } from "../../goal/runtime.js";
import type { SessionGoal } from "../../storage/session-store.js";
import { modelErrorGuidance } from "../../agent/response-errors.js";
import {
  canReuseOpaqueProviderContext,
  defaultModelRequestSettings,
  hasOpaqueProviderContext,
  isReasoningEffort,
  resolveProviderCapabilities,
  type ModelRequestSettings,
} from "../../providers/capabilities.js";
import {
  listFileReferenceSuggestions,
  parseFileReferences,
  resolveFileAttachments,
  type FileAttachment,
} from "../../agent/file-attachments.js";
import { cloneTaskProgress, type TaskProgress } from "../../workflow/task-progress.js";

type View =
  | { kind: "outputs" }
  | { kind: "input-history" }
  | { kind: "terminal-setup" }
  | { kind: "permissions" }
  | { kind: "skills" }
  | { kind: "memory"; status: LearnedMemoryStatus; policy: LearnedMemoryPolicy }
  | { kind: "plan-questions"; request: PlanRequest; mode: AgentMode; complete(answers: Record<string, string>): void; cancel(): void }
  | { kind: "plan-review"; submitted: SubmittedPlan; decide(decision: PlanReviewDecision): void }
  | { kind: "goal-confirm"; objective: string; tokenBudget?: number; confirm(): void; cancel(): void }
  | { kind: "goal-status"; goal?: SessionGoal }
  | { kind: "workspace-diff"; index: WorkspaceChangeIndex; workflow?: WorkflowState }
  | { kind: "context" }
  | { kind: "tasks"; progress?: TaskProgress; workflow?: WorkflowState }
  | { kind: "chat" }
  | { kind: "login" }
  | {
      kind: "model-picker";
      title: string;
      models: RegisteredModel[];
      resumeSession?: LoadedSession;
    }
  | { kind: "session-picker"; result: SessionSearchResult; initialQuery?: string }
  | { kind: "logout"; models: RegisteredModelStatus[] }
  | {
      kind: "loading";
      title: string;
      label: string;
      cancellable: boolean;
      onCancel?: () => void;
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
  kind: "bash" | "patch" | "web" | "mcp" | "goal";
  request: string;
  resolve(accepted: boolean): void;
}

interface QueuedGuidance {
  text: string;
  timelineRecorded: boolean;
  attachments: readonly FileAttachment[];
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

function toSessionModel(
  model: RegisteredModel,
  requestSettings: ModelRequestSettings | undefined = model.request_settings,
): SessionModelRef {
  return {
    id: model.id,
    model_name: model.model_name,
    base_url: model.base_url,
    ...(requestSettings ? { request_settings: { ...requestSettings } } : {}),
  };
}

function settingsForModel(model: RegisteredModel | undefined): ModelRequestSettings {
  return defaultModelRequestSettings(
    resolveProviderCapabilities(model?.base_url ?? "", model?.model_name),
    model?.request_settings,
  );
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
  const permissionsReady = useRef<Promise<void>>(Promise.resolve());
  const terminalCommandRunning = useRef(false);
  const commandOperation = useRef(0);
  const activeSessionId = useRef<string | undefined>(undefined);
  const workflowRuntime = useRef<CodingWorkflowRuntime | undefined>(undefined);
  const sessionTitlePending = useRef(false);
  const forkResumePending = useRef(false);
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
  const [requestSettings, setRequestSettings] = useState(() => settingsForModel(firstActiveModel));
  const [agentMode, setAgentMode] = useState<AgentMode>("default");
  const [activeGoal, setActiveGoal] = useState<SessionGoal>();
  const activeGoalProjection = useRef<SessionGoal | undefined>(undefined);
  const [activeTaskProgress, setActiveTaskProgress] = useState<TaskProgress>();
  const activeTaskProgressProjection = useRef<TaskProgress | undefined>(undefined);
  const [memoryPolicy, setMemoryPolicy] = useState<LearnedMemoryPolicy>({ readExisting: true, captureFuture: true });
  const [workspacePath, setWorkspacePath] = useState(dependencies.workspacePath);
  const [view, setView] = useState<View>(() => initialView(initialModels.available));
  const [busyLabel, setBusyLabel] = useState<string>();
  const [agentPhase, setAgentPhase] = useState<LoopPhase>();
  const [turnStartedAt, setTurnStartedAt] = useState<number>();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [reasoningStartedAt, setReasoningStartedAt] = useState<number>();
  const [reasoningElapsedSeconds, setReasoningElapsedSeconds] = useState(0);
  const [queuedGuidanceCount, setQueuedGuidanceCount] = useState(0);
  const [liveAssistant, setLiveAssistant] = useState("");
  const pendingAssistantDelta = useRef("");
  const assistantDeltaTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushAssistantDelta = useCallback(() => {
    if (assistantDeltaTimer.current) clearTimeout(assistantDeltaTimer.current);
    assistantDeltaTimer.current = undefined;
    const delta = pendingAssistantDelta.current;
    pendingAssistantDelta.current = "";
    if (delta) setLiveAssistant((current) => current + delta);
  }, []);
  const clearLiveAssistant = useCallback(() => {
    if (assistantDeltaTimer.current) clearTimeout(assistantDeltaTimer.current);
    assistantDeltaTimer.current = undefined;
    pendingAssistantDelta.current = "";
    setLiveAssistant("");
  }, []);
  const queueAssistantDelta = useCallback((text: string) => {
    pendingAssistantDelta.current += text;
    assistantDeltaTimer.current ??= setTimeout(flushAssistantDelta, 40);
  }, [flushAssistantDelta]);
  useEffect(() => () => {
    if (assistantDeltaTimer.current) clearTimeout(assistantDeltaTimer.current);
    assistantDeltaTimer.current = undefined;
    pendingAssistantDelta.current = "";
  }, []);
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
  const attachmentController = useRef<AbortController | undefined>(undefined);
  useEffect(() => { activeGoalProjection.current = activeGoal; }, [activeGoal]);
  useEffect(() => { activeTaskProgressProjection.current = activeTaskProgress; }, [activeTaskProgress]);
  const resumeGoalPending = useRef(false);
  const runChatRef = useRef<((text: string, timelineRecorded?: boolean, mode?: AgentMode, taskSource?: WorkflowTaskSource, attachments?: readonly FileAttachment[]) => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void dependencies.inputHistory?.load().then((entries) => { if (active) setInputHistory((current) => [...entries, ...current].slice(-1000)); }).catch(() => undefined);
    return () => { active = false; directController.current?.abort(); };
  }, [dependencies.inputHistory]);
  useEffect(() => () => {
    attachmentController.current?.abort(new Error("Session or workspace changed"));
    attachmentController.current = undefined;
  }, [sessionEpoch, workspacePath]);
  useEffect(() => {
    let active = true;
    const load = dependencies.loadPermissions
      ? dependencies.loadPermissions(workspacePath).then((policy) => {
        if (active) permissions.current = policy;
      })
      : Promise.resolve();
    permissionsReady.current = load.catch(() => undefined);
    return () => { active = false; };
  }, [dependencies, workspacePath]);
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
  useEffect(() => {
    if (reasoningStartedAt === undefined) {
      setReasoningElapsedSeconds(0);
      return;
    }
    const update = () => setReasoningElapsedSeconds(Math.max(0, Math.floor((Date.now() - reasoningStartedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [reasoningStartedAt]);

  const clearQueuedGuidance = useCallback(() => {
    queuedGuidance.current = [];
    setQueuedGuidanceCount(0);
    clearLiveAssistant();
    setLiveToolStatus(undefined);
  }, [clearLiveAssistant]);

  const getFileSuggestions = useCallback(
    (query: string, signal?: AbortSignal) => listFileReferenceSuggestions(workspacePath, query, signal),
    [workspacePath],
  );

  const ensureWorkflow = useCallback((initialState?: WorkflowState, workflowWorkspace = workspacePath): CodingWorkflowRuntime => {
    const runtimeOptions = {
      workspacePath: workflowWorkspace,
      ...(initialState ? { initialState } : {}),
      onState: async (state: WorkflowState) => {
        const sessionId = activeSessionId.current;
        if (sessionId) await dependencies.sessionStore.setWorkflow?.(sessionId, state);
      },
    };
    if (workflowRuntime.current?.workspacePath !== workflowWorkspace || initialState !== undefined) {
      workflowRuntime.current = new CodingWorkflowRuntime(runtimeOptions);
    }
    if (!workflowRuntime.current) workflowRuntime.current = new CodingWorkflowRuntime(runtimeOptions);
    return workflowRuntime.current;
  }, [dependencies.sessionStore, workspacePath]);

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
    onCancel?: () => void,
  ): number => {
    const operation = ++commandOperation.current;
    const nextView: CommandView = {
      kind: "loading",
      title,
      label,
      cancellable,
      ...(onCancel ? { onCancel } : {}),
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
            : pending?.kind === "goal"
            ? "Goal change rejected"
            : pending?.kind === "patch"
              ? "Patch rejected"
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

  const requestPatchConfirmation = useCallback(
    (summary: string): Promise<boolean> => new Promise((resolve) => {
      const pending = { kind: "patch" as const, request: summary, resolve };
      confirmationRef.current = pending;
      setConfirmation(pending);
    }),
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

  const requestGoalConfirmation = useCallback(
    (request: string): Promise<boolean> => new Promise((resolve) => {
      const pending = { kind: "goal" as const, request, resolve };
      confirmationRef.current = pending;
      setConfirmation(pending);
    }),
    [],
  );

  const requestUserInput = useCallback((request: PlanRequest, signal?: AbortSignal, mode: AgentMode = "default"): Promise<Record<string, string>> => (
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Question cancelled"));
        return;
      }
      let finished = false;
      const finish = (answers: Record<string, string>) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", cancel);
        returnToChat();
        resolve(answers);
      };
      const cancel = () => finish({ __cancelled: "true" });
      signal?.addEventListener("abort", cancel, { once: true });
      enterCommandView({
        kind: "plan-questions",
        request,
        mode,
        complete: finish,
        cancel: mode === "plan"
          ? cancel
          : () => abortController.current?.abort(new Error("Question cancelled by user")),
      });
    })
  ), [enterCommandView, returnToChat]);

  const reviewPlan = useCallback((submitted: SubmittedPlan, signal?: AbortSignal): Promise<PlanReviewDecision> => (
    new Promise((resolve) => {
      let finished = false;
      const decide = (decision: PlanReviewDecision) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", cancel);
        returnToChat();
        resolve(decision);
      };
      const cancel = () => decide("cancel");
      signal?.addEventListener("abort", cancel, { once: true });
      enterCommandView({ kind: "plan-review", submitted, decide });
    })
  ), [enterCommandView, returnToChat]);

  const executeBash = useCallback(
    async (command: string, signal?: AbortSignal, timeoutMs?: number): Promise<BashResult> => {
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
      try { result = await dependencies.runBash(command, permissions.current, signal, preview, timeoutMs); }
      finally { finished = true; setTerminalBusy(false); setTerminalOutput(undefined); setAgentTerminalPreview(undefined); setActiveCommand(undefined); }
      if (result === undefined) throw new Error("Bash did not return a result");
      const output = await renderTerminalOutput(commandOutput(result));
      const retained = retainOutput(output);
      appendCommand(retained.text, { id: randomUUID(), command, shell: process.platform === "win32" ? "PowerShell" : "Bash", workspace: workspacePath, source: "model", status: result.cancelled ? "cancelled" : result.error || result.exitCode !== 0 ? "failed" : "completed", durationMs: Date.now() - started, truncated: retained.truncated || result.truncated === true });
      return result;
    },
    [appendCommand, dependencies, workspacePath],
  );

  const executeVerification = useCallback(
    async (command: string, signal?: AbortSignal, timeoutMs?: number, userInitiated = false): Promise<BashResult> => {
      const reviewedPolicy = permissions.current;
      const revision = permissionPolicyRevision(reviewedPolicy);
      const permission = commandPermission(command, reviewedPolicy);
      if (permission === "deny") {
        return { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: false, error: "Verification command denied by the active command rules" };
      }
      if (!userInitiated && permission === "ask" && !(await requestBashConfirmation(`Run verification: ${command}`))) {
        return { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: false, error: "Verification command was not approved" };
      }
      if (!userInitiated && permissionPolicyRevision(permissions.current) !== revision) {
        return { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: false, error: "Permission policy changed while the verification command was being reviewed" };
      }
      return executeBash(command, signal, timeoutMs);
    },
    [executeBash, requestBashConfirmation],
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
    () => createProductionWorkflowAgentIO({
      workspacePath,
      policy: () => permissions.current,
      workflow: ensureWorkflow,
      execute: (command, signal, timeoutMs) => executeBash(command, signal, timeoutMs),
      executeBackground: (command, signal, timeoutMs, onOutput) =>
        dependencies.runBash(command, permissions.current, signal, onOutput, timeoutMs),
      executeVerification: (command, signal, timeoutMs) => executeVerification(command, signal, timeoutMs),
      session: {
        getId: () => activeSessionId.current,
        async getGoal() {
          return activeSessionId.current ? activeGoalProjection.current : undefined;
        },
        async setGoal(goal) {
          const sessionId = activeSessionId.current;
          if (!sessionId) throw new Error("Goals require an active session");
          await dependencies.sessionStore.setGoal(sessionId, goal);
          activeGoalProjection.current = goal;
          setActiveGoal(goal);
        },
        getTaskProgress() {
          return activeTaskProgressProjection.current === undefined
            ? undefined
            : cloneTaskProgress(activeTaskProgressProjection.current);
        },
        async setTaskProgress(progress) {
          const sessionId = activeSessionId.current;
          if (!sessionId) throw new Error("Task progress requires an active session");
          if (!dependencies.sessionStore.setTaskProgress) throw new Error("Task progress persistence is unavailable");
          await dependencies.sessionStore.setTaskProgress(sessionId, progress);
          const next = cloneTaskProgress(progress);
          activeTaskProgressProjection.current = next;
          setActiveTaskProgress(next);
        },
      },
      interaction: {
        confirm(_kind, tool, prompt) {
          if (tool === "bash") return requestBashConfirmation(prompt);
          if (tool === "patch") return requestPatchConfirmation(prompt);
          if (tool === "web") return requestWebConfirmation(prompt);
          if (tool === "mcp") return requestMcpConfirmation(prompt);
          return requestGoalConfirmation(prompt);
        },
        requestUserInput,
        reviewPlan,
      },
      output: {
        assistant(text) {
          clearLiveAssistant();
          append("assistant", text);
        },
        assistantDelta: queueAssistantDelta,
        tool(text) {
          setLiveToolStatus(text);
          append("tool", text);
        },
        toolProgress(event) {
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
      },
    }),
    [append, clearLiveAssistant, dependencies.sessionStore, ensureWorkflow, executeBash, executeVerification, queueAssistantDelta, requestBashConfirmation, requestGoalConfirmation, requestMcpConfirmation, requestPatchConfirmation, requestUserInput, requestWebConfirmation, reviewPlan, workspacePath],
  );

  const contextWindow = activeModel
    ? resolveModelStatusMetadata(activeModel.base_url, activeModel.model_name).context_window
    : null;
  const agent = useMemo(
    () =>
      activeModel === undefined
        ? undefined
        : dependencies.createAgent({ ...activeModel, request_settings: requestSettings }, agentIo, {
            initialContext: sessionContext,
            contextWindow,
            initialContextTokens: sessionUsage.context_tokens,
            ...(activeTaskProgressProjection.current === undefined ? {} : { initialTaskProgress: cloneTaskProgress(activeTaskProgressProjection.current) }),
            async onContextAppend(items) {
              const sessionId = activeSessionId.current;
              if (sessionId !== undefined) {
                await dependencies.sessionStore.appendContext(sessionId, items);
              }
            },
            async onContextCompacted(items, automatic, usage) {
              const sessionId = activeSessionId.current;
              if (sessionId === undefined) throw new Error("Context compaction requires an active session");
              await dependencies.sessionStore.compactContext(sessionId, items, automatic, usage);
              setSessionUsage((current) => applyCompactionUsage(current, usage));
            },
            async onContextPruned(items, metadata) {
              const sessionId = activeSessionId.current;
              if (sessionId === undefined || !dependencies.sessionStore.pruneContext) {
                throw new Error("Context pruning requires an active persistent session");
              }
              await dependencies.sessionStore.pruneContext(sessionId, items, metadata);
              setSessionUsage((current) => ({ ...current, context_tokens: null }));
            },
            async onUsage(usage) {
              const sessionId = activeSessionId.current;
              if (sessionId !== undefined) {
                await dependencies.sessionStore.appendUsage(sessionId, usage);
              }
              setSessionUsage((current) => applyUsageSample(current, usage));
            },
            onPhase(phase) {
              setAgentPhase(phase);
            },
            onEvent(event) {
              if (event.type === "sampling_started") {
                clearLiveAssistant();
                setLiveToolStatus(undefined);
                setReasoningStartedAt(undefined);
              } else if (event.type === "reasoning_started") {
                setLiveToolStatus("Thinking");
                setReasoningStartedAt(Date.now());
              } else if (event.type === "reasoning_finished") {
                setLiveToolStatus(undefined);
                setReasoningStartedAt(undefined);
              } else if (event.type === "retrying") {
                clearLiveAssistant();
                setLiveToolStatus(`Retrying model request (attempt ${event.attempt}${event.category ? ` · ${event.category.replace(/_/g, " ")}` : ""})`);
              } else if (event.type === "stream_recovery_started") {
                setLiveToolStatus("Resuming interrupted model stream");
              } else if (event.type === "stream_recovery_finished") {
                setLiveToolStatus(event.success === false ? "Stream resume failed; retrying request" : "Model stream resumed");
              } else if (event.type === "steering_applied") {
                setQueuedGuidanceCount((current) => Math.max(0, current - event.count));
                clearLiveAssistant();
                setLiveToolStatus("Guidance applied; continuing with the updated task");
              } else if (event.type === "tool_started") {
                setLiveToolStatus(`Preparing ${event.call.name}`);
              } else if (event.type === "tool_finished") {
                setLiveToolStatus(`${event.call.name} finished`);
              } else if (event.type === "tool_batch_started") {
                setLiveToolStatus(`Running ${event.calls.length} read-only tools in parallel`);
              } else if (event.type === "tool_batch_finished") {
                setLiveToolStatus(`Finished ${event.calls.length} parallel tools`);
              } else if (event.type === "compaction_started") {
                setLiveToolStatus(event.automatic ? "Compacting context automatically" : "Compacting context");
              } else if (event.type === "compaction_completed") {
                setLiveToolStatus("Context compacted");
              }
            },
          }),
    [activeModel, agentIo, clearLiveAssistant, contextWindow, dependencies, requestSettings, sessionContext, sessionEpoch],
  );

  useEffect(() => {
    agent?.setMemoryPolicy?.(memoryPolicy);
  }, [agent, memoryPolicy]);

  useEffect(() => {
    agent?.setRequestSettings?.(requestSettings);
  }, [agent, requestSettings]);

  const activateModel = useCallback(
    (model: RegisteredModel, message = `Enabled model ${model.model_name}`) => {
      const nextSettings = settingsForModel(model);
      clearQueuedGuidance();
      abortController.current?.abort();
      const sessionId = activeSessionId.current;
      if (sessionId !== undefined) {
        void dependencies.sessionStore
          .selectModel(sessionId, toSessionModel(model, nextSettings), false)
          .catch((error: unknown) => {
            appendTransient("error", `Session save failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
      returnToChat(() => {
        setActiveModel(model);
        setRequestSettings(nextSettings);
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

  const showMemory = useCallback(async (enterFromChat = true) => {
    const operation = startCommandLoad(
      "/memory · Learned experience",
      "Reading learned experience",
      enterFromChat,
    );
    try {
      const status = dependencies.getMemoryStatus
        ? await dependencies.getMemoryStatus(workspacePath)
        : { enabled: false, projectEntries: 0, userEntries: 0, recent: [] };
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView({ kind: "memory", status, policy: agent?.getMemoryPolicy?.() ?? memoryPolicy });
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        "/memory · Could not load",
        error instanceof Error ? error.message : String(error),
        "error",
      ));
    }
  }, [agent, dependencies, isCurrentCommandOperation, memoryPolicy, replaceCommandView, startCommandLoad, workspacePath]);

  const showMemoryPrompt = useCallback(async () => {
    const operation = startCommandLoad(
      "/memory view · Injected experience",
      "Reading memory snapshot",
    );
    try {
      const snapshot = agent?.getMemorySnapshot?.();
      const text = snapshot
        ? `Snapshot ${snapshot.revision} loaded ${snapshot.loadedAt}\n\n${snapshot.text || "No learned experience was injected."}`
        : dependencies.getMemoryPrompt
          ? await dependencies.getMemoryPrompt(workspacePath)
          : "Memory is unavailable in this integration.";
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        "/memory view · Injected experience",
        text || "No learned experience is currently injected.",
      ));
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        "/memory view · Could not load",
        error instanceof Error ? error.message : String(error),
        "error",
      ));
    }
  }, [agent, dependencies, isCurrentCommandOperation, replaceCommandView, startCommandLoad, workspacePath]);

  const toggleMemory = useCallback((enabled: boolean) => {
    void (async () => {
      try {
        await dependencies.setMemoryEnabled?.(enabled);
        await showMemory(false);
      } catch (error) {
        replaceCommandView(infoView(
          "/memory · Could not update",
          error instanceof Error ? error.message : String(error),
          "error",
        ));
      }
    })();
  }, [dependencies, replaceCommandView, showMemory]);

  const updateMemoryPolicy = useCallback((patch: Partial<LearnedMemoryPolicy>) => {
    const next = { ...memoryPolicy, ...patch };
    setMemoryPolicy(next);
    agent?.setMemoryPolicy?.(patch);
    const sessionId = activeSessionId.current;
    if (sessionId) void dependencies.sessionStore.setMemoryPolicy?.(sessionId, next).catch((error: unknown) => {
      appendTransient("error", `Memory policy save failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    void showMemory(false);
  }, [agent, appendTransient, dependencies.sessionStore, memoryPolicy, showMemory]);

  const clearMemory = useCallback((scope: LearnedScope) => {
    void (async () => {
      try {
        await dependencies.clearMemory?.(scope, workspacePath);
        await showMemory(false);
      } catch (error) {
        replaceCommandView(infoView(
          "/memory · Could not clear",
          error instanceof Error ? error.message : String(error),
          "error",
        ));
      }
    })();
  }, [dependencies, replaceCommandView, showMemory, workspacePath]);

  const archiveMemory = useCallback((entry: LearnedMemoryStatus["recent"][number]) => {
    void (async () => {
      try {
        await dependencies.archiveMemory?.(entry.scope, workspacePath, entry.id);
        await showMemory(false);
      } catch (error) {
        replaceCommandView(infoView(
          "/memory · Could not archive",
          error instanceof Error ? error.message : String(error),
          "error",
        ));
      }
    })();
  }, [dependencies, replaceCommandView, showMemory, workspacePath]);

  const rememberMemory = useCallback((text: string) => {
    if (!activeModel || !dependencies.rememberMemory) {
      openInfo("/memory · Cannot remember", "No active model is available for memory extraction.", "error");
      return;
    }
    const operation = startCommandLoad("/memory · Remember preference", "Extracting user preference");
    void dependencies.rememberMemory(activeModel, workspacePath, text)
      .then(() => showMemory(false))
      .catch((error: unknown) => {
        if (!isCurrentCommandOperation(operation)) return;
        replaceCommandView(infoView(
          "/memory · Could not remember",
          error instanceof Error ? error.message : String(error),
          "error",
        ));
      });
  }, [activeModel, dependencies, isCurrentCommandOperation, openInfo, replaceCommandView, showMemory, startCommandLoad, workspacePath]);

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
        const pendingForkResume = loaded.forkPendingResume ?? loaded.summary.fork_pending_resume ?? false;
        if (
          replacementModel &&
          !canReuseOpaqueProviderContext(loaded.summary.model.base_url, model.base_url) &&
          hasOpaqueProviderContext(loaded.context)
        ) {
          throw new Error("This session contains provider-specific opaque context. Select the original provider or start a new session; the saved session was left unchanged.");
        }
        const restoredWorkspace = await dependencies.changeWorkspace(
          loaded.summary.workspace_path,
        );
        changedWorkspace = restoredWorkspace !== previousWorkspace;
        const restoredSettings = defaultModelRequestSettings(
          resolveProviderCapabilities(model.base_url, model.model_name),
          replacementModel
            ? model.request_settings
            : loaded.summary.model.request_settings ?? model.request_settings,
        );
        if (replacementModel) {
          await dependencies.sessionStore.selectModel(
            loaded.summary.id,
            toSessionModel(model, restoredSettings),
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
        workflowRuntime.current = undefined;
        ensureWorkflow(loaded.workflow, restoredWorkspace);
        sessionTitlePending.current = loaded.summary.title_pending;
        forkResumePending.current = pendingForkResume;
        nextId.current = restoredTimeline.length;
        resumeGoalPending.current = !pendingForkResume && loaded.goal?.status === "active" && loaded.workflow?.phase !== "blocked";
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
          setRequestSettings(restoredSettings);
          setAgentMode("default");
          activeGoalProjection.current = loaded.goal;
          setActiveGoal(loaded.goal);
          activeTaskProgressProjection.current = loaded.taskProgress === undefined ? undefined : cloneTaskProgress(loaded.taskProgress);
          setActiveTaskProgress(loaded.taskProgress === undefined ? undefined : cloneTaskProgress(loaded.taskProgress));
          setMemoryPolicy(loaded.memoryPolicy ?? { readExisting: true, captureFuture: true });
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
    [clearQueuedGuidance, dependencies, ensureWorkflow, onReplayOutput, workspacePath],
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

  const searchSessions = useCallback(async (
    query: string,
    allWorkspaces: boolean,
    offset: number,
    signal?: AbortSignal,
  ): Promise<SessionSearchResult> => {
    if (dependencies.sessionStore.search) {
      return dependencies.sessionStore.search({
        query,
        offset,
        limit: 50,
        ...(allWorkspaces ? {} : { workspacePath }),
        ...(signal ? { signal } : {}),
      });
    }
    const listed = await dependencies.sessionStore.list();
    const normalized = query.trim().toLocaleLowerCase();
    const sessions = listed.sessions.filter((session) =>
      (allWorkspaces || session.workspace_path === workspacePath) &&
      (!normalized || session.title.toLocaleLowerCase().includes(normalized)));
    return {
      matches: sessions.slice(offset, offset + 50).map((summary) => ({ summary })),
      total: sessions.length,
      skipped: listed.skipped,
    };
  }, [dependencies.sessionStore, workspacePath]);

  const openResume = useCallback(async (initialQuery = "") => {
    const operation = startCommandLoad(
      "/resume · Resume session",
      "Reading sessions",
    );
    try {
      const result = await searchSessions(initialQuery, false, 0);
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView({
        kind: "session-picker",
        result,
        ...(initialQuery ? { initialQuery } : {}),
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
    isCurrentCommandOperation,
    replaceCommandView,
    searchSessions,
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
        model: toSessionModel(activeModel, requestSettings),
      });

      abortController.current?.abort();
      activeSessionId.current = session.id;
      workflowRuntime.current = undefined;
      sessionTitlePending.current = true;
      forkResumePending.current = false;
      resumeGoalPending.current = false;
      nextId.current = 2;
      onReplayOutput(() => {
        setTimeline([
          { id: 0, kind: "banner", modelName: activeModel.model_name },
          { id: 1, kind: "system", text: message },
        ]);
        setTimelineEpoch((current) => current + 1);
        setSessionContext([]);
        setSessionUsage(createEmptySessionUsage());
        setAgentMode("default");
        activeGoalProjection.current = undefined;
        setActiveGoal(undefined);
        activeTaskProgressProjection.current = undefined;
        setActiveTaskProgress(undefined);
        setMemoryPolicy({ readExisting: true, captureFuture: true });
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
  }, [activeModel, clearQueuedGuidance, dependencies.sessionStore, onReplayOutput, openInfo, requestSettings, workspacePath]);

  const clearConversation = useCallback(() => {
    clearQueuedGuidance();
    setResumedInputHistory(undefined);
    editorRef.current = createComposerState();
    historyNavigationRef.current = { index: undefined, draft: "" };
    abortController.current?.abort();
    activeSessionId.current = undefined;
    workflowRuntime.current = undefined;
    sessionTitlePending.current = false;
    forkResumePending.current = false;
    setSessionContext([]);
    setSessionUsage(createEmptySessionUsage());
    resumeGoalPending.current = false;
    setAgentMode("default");
    activeGoalProjection.current = undefined;
    setActiveGoal(undefined);
    activeTaskProgressProjection.current = undefined;
    setActiveTaskProgress(undefined);
    setMemoryPolicy({ readExisting: true, captureFuture: true });
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
      setInputKey((current) => current + 1);
    });
  }, [activeModel, clearQueuedGuidance, onReplayOutput]);

  const forkCurrentSession = useCallback(async (requestedTitle: string) => {
    if (
      abortController.current ||
      directController.current ||
      confirmationRef.current ||
      terminalCommandRunning.current ||
      attachmentController.current
    ) {
      openInfo(
        "/fork · Busy",
        "Wait for the active task, approval, command, or cleanup to finish before forking.",
        "error",
      );
      return;
    }
    const sourceSessionId = activeSessionId.current;
    if (!sourceSessionId) {
      openInfo(
        "/fork · No active session",
        "Start or resume a local session before forking it.",
        "error",
      );
      return;
    }
    if (!dependencies.sessionStore.fork) {
      openInfo(
        "/fork · Unavailable",
        "This session store does not support forking.",
        "error",
      );
      return;
    }

    const controller = new AbortController();
    directController.current = controller;
    const cancel = () => {
      controller.abort(new Error("Session fork cancelled"));
      if (directController.current === controller) directController.current = undefined;
      returnToChat();
    };
    let operation = startCommandLoad(
      "/fork · Fork session",
      "Preparing an independent session copy",
      true,
      true,
      cancel,
    );
    try {
      const [source, resolved] = await Promise.all([
        dependencies.sessionStore.load(sourceSessionId),
        dependencies.registry.resolveAll(),
      ]);
      controller.signal.throwIfAborted();
      if (!isCurrentCommandOperation(operation) || activeSessionId.current !== sourceSessionId) return;
      const sourceModel = resolved.available.find(
        (candidate) =>
          candidate.id === source.summary.model.id ||
          (candidate.model_name === source.summary.model.model_name &&
            candidate.base_url === source.summary.model.base_url),
      );
      if (!sourceModel) {
        throw new Error(`The session model ${source.summary.model.model_name} is unavailable. Register it before forking.`);
      }

      const title = requestedTitle.trim();
      const child = await dependencies.sessionStore.fork(sourceSessionId, {
        ...(title ? { title } : {}),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!isCurrentCommandOperation(operation) || activeSessionId.current !== sourceSessionId) return;
      const loaded = await dependencies.sessionStore.load(child.id);
      controller.signal.throwIfAborted();
      if (!isCurrentCommandOperation(operation) || activeSessionId.current !== sourceSessionId) return;

      operation = startCommandLoad(
        "/fork · Fork session",
        "Entering the forked session",
        false,
        false,
      );
      if (directController.current === controller) directController.current = undefined;
      await completeResume(loaded, sourceModel, false);
      if (!isCurrentCommandOperation(operation)) return;
      appendTransient("system", `Forked session created: ${child.title}`);
    } catch (error) {
      if (controller.signal.aborted) {
        if (isCurrentCommandOperation(operation)) returnToChat();
        return;
      }
      if (isCurrentCommandOperation(operation)) {
        replaceCommandView(infoView(
          "/fork · Could not fork",
          error instanceof Error ? error.message : String(error),
          "error",
        ));
      }
    } finally {
      if (directController.current === controller) directController.current = undefined;
    }
  }, [appendTransient, completeResume, dependencies.registry, dependencies.sessionStore, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, startCommandLoad]);

  const deleteSessions = useCallback(async (sessionIds: string[]): Promise<void> => {
    if (abortController.current || directController.current) {
      throw new Error("A model turn or direct command is active. Wait for it to finish before deleting sessions.");
    }
    await dependencies.sessionStore.deleteMany(sessionIds);
    if (activeSessionId.current && sessionIds.includes(activeSessionId.current)) {
      clearConversation();
      returnToChat();
    }
  }, [clearConversation, dependencies.sessionStore, returnToChat]);

  const runtimeForGoal = useCallback((sessionId: string) => new GoalRuntime({
    getGoal: async () => activeSessionId.current === sessionId
      ? activeGoalProjection.current
      : (await dependencies.sessionStore.load(sessionId)).goal,
    setGoal: async (goal) => {
      await dependencies.sessionStore.setGoal(sessionId, goal);
      if (activeSessionId.current === sessionId) activeGoalProjection.current = goal;
      setActiveGoal(goal);
    },
  }), [dependencies.sessionStore]);

  const showGoalStatus = useCallback(async () => {
    const sessionId = activeSessionId.current;
    const goal = sessionId ? (await dependencies.sessionStore.load(sessionId)).goal : undefined;
    activeGoalProjection.current = goal;
    setActiveGoal(goal);
    enterCommandView({ kind: "goal-status", ...(goal ? { goal } : {}) });
  }, [dependencies.sessionStore, enterCommandView]);

  const pauseGoal = useCallback(() => {
    const sessionId = activeSessionId.current;
    if (!sessionId) { void showGoalStatus(); return; }
    void runtimeForGoal(sessionId).update("paused").then((goal) => {
      activeGoalProjection.current = goal;
      setActiveGoal(goal);
      returnToChat(() => appendTransient("system", "Goal paused."));
    }).catch((error: unknown) => openInfo("/goal · Could not pause", error instanceof Error ? error.message : String(error), "error"));
  }, [appendTransient, openInfo, returnToChat, runtimeForGoal, showGoalStatus]);

  const resumeGoal = useCallback(() => {
    const sessionId = activeSessionId.current;
    if (!sessionId) { void showGoalStatus(); return; }
    void runtimeForGoal(sessionId).resume().then((goal) => {
      activeGoalProjection.current = goal;
      setActiveGoal(goal);
      returnToChat(() => appendTransient("system", "Goal resumed."));
      setTimeout(() => void runChatRef.current?.("Continue working toward the active session goal. Call get_goal first, then proceed until the objective is verified complete.", true, "default"), 0);
    }).catch((error: unknown) => openInfo("/goal · Could not resume", error instanceof Error ? error.message : String(error), "error"));
  }, [appendTransient, openInfo, returnToChat, runtimeForGoal, showGoalStatus]);

  const createGoal = useCallback(async (objective: string, tokenBudget?: number) => {
    if (!activeModel) {
      openInfo("/goal · Cannot create", "No model is active. Use /login or /model first.", "error");
      return;
    }
    let sessionId = activeSessionId.current;
    if (!sessionId) {
      const session = await dependencies.sessionStore.create({ title: fallbackSessionTitle(objective), titlePending: false, workspacePath, model: toSessionModel(activeModel, requestSettings) });
      sessionId = session.id;
      activeSessionId.current = sessionId;
      sessionTitlePending.current = false;
      startTitleGeneration(sessionId, activeModel, objective);
    }
    const goal = await runtimeForGoal(sessionId).create({ objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) });
    setAgentMode("default");
    returnToChat(() => appendTransient("system", "Goal created; continuing until it is complete, paused, blocked, or limited."));
    setTimeout(() => void runChatRef.current?.(objective, false, "default"), 0);
    activeGoalProjection.current = goal;
    setActiveGoal(goal);
  }, [activeModel, appendTransient, dependencies.sessionStore, openInfo, requestSettings, returnToChat, runtimeForGoal, startTitleGeneration, workspacePath]);

  const handleGoal = useCallback((args: string) => {
    try {
      const command = parseGoalCommand(args);
      if (command.action === "status") { void showGoalStatus(); return; }
      if (command.action === "pause") { pauseGoal(); return; }
      if (command.action === "resume") { resumeGoal(); return; }
      if (command.action !== "create") return;
      enterCommandView({
        kind: "goal-confirm", objective: command.objective,
        ...(command.tokenBudget === undefined ? {} : { tokenBudget: command.tokenBudget }),
        confirm: () => void createGoal(command.objective, command.tokenBudget).catch((error: unknown) => openInfo("/goal · Could not create", error instanceof Error ? error.message : String(error), "error")),
        cancel: returnToChat,
      });
    } catch (error) {
      openInfo("/goal · Invalid command", error instanceof Error ? error.message : String(error), "error");
    }
  }, [createGoal, enterCommandView, openInfo, pauseGoal, resumeGoal, returnToChat, showGoalStatus]);

  const showStatus = useCallback(() => {
    const auxiliaryUsage = dependencies.getAuxiliaryUsage?.();
    const metadata = activeModel
      ? resolveModelStatusMetadata(activeModel.base_url, activeModel.model_name)
      : undefined;
    const capabilities = activeModel
      ? resolveProviderCapabilities(activeModel.base_url, activeModel.model_name)
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
        protocol: capabilities?.protocol ?? "responses",
        ...(capabilities ? { compaction: capabilities.compaction } : {}),
        reasoning_effort: requestSettings.reasoningEffort,
        ...(sessionUsage.reasoning_tokens === undefined ? {} : { reasoning_tokens: sessionUsage.reasoning_tokens }),
        ...(auxiliaryUsage === undefined ? {} : {
          auxiliary_input_tokens: auxiliaryUsage.input_tokens,
          auxiliary_output_tokens: auxiliaryUsage.output_tokens,
          ...(auxiliaryUsage.reasoning_tokens === undefined ? {} : { auxiliary_reasoning_tokens: auxiliaryUsage.reasoning_tokens }),
          auxiliary_usage_complete: auxiliaryUsage.complete,
        }),
        ...(sessionUsage.cached_input_tokens === undefined ? {} : { cached_input_tokens: sessionUsage.cached_input_tokens }),
        ...(sessionUsage.cache_write_input_tokens === undefined ? {} : { cache_write_input_tokens: sessionUsage.cache_write_input_tokens }),
        ...(sessionUsage.cache_observed_input_tokens === undefined ? {} : { cache_observed_input_tokens: sessionUsage.cache_observed_input_tokens }),
        ...(sessionUsage.cache_usage_complete === undefined ? {} : { cache_usage_complete: sessionUsage.cache_usage_complete }),
        ...(sessionUsage.cache_write_usage_complete === undefined ? {} : { cache_write_usage_complete: sessionUsage.cache_write_usage_complete }),
        usage_complete: sessionUsage.complete,
      },
    });
  }, [
    activeModel,
    dependencies,
    enterCommandView,
    sessionUsage,
    requestSettings,
    workspacePath,
  ]);

  const setReasoning = useCallback((args: string) => {
    const effort = args.trim().toLowerCase();
    if (!isReasoningEffort(effort)) {
      openInfo("/reasoning · Invalid setting", "Use /reasoning off|low|high|max.", "error");
      return;
    }
    if (abortController.current || directController.current) {
      openInfo("/reasoning · Busy", "Wait for the active task to finish. The setting is captured at the start of a turn.", "error");
      return;
    }
    if (!activeModel || !agent) {
      openInfo("/reasoning · No model", "Select a model with /login or /model first.", "error");
      return;
    }
    if (!resolveProviderCapabilities(activeModel.base_url, activeModel.model_name).reasoningEffort) {
      openInfo("/reasoning · Unsupported", "This endpoint and model do not declare a reasoning-effort request capability.", "error");
      return;
    }
    const next = { ...requestSettings, reasoningEffort: effort };
    agent.setRequestSettings?.(next);
    setRequestSettings(next);
    const sessionId = activeSessionId.current;
    if (sessionId) {
      void dependencies.sessionStore.selectModel(sessionId, toSessionModel(activeModel, next), true)
        .catch((error: unknown) => appendTransient("error", `Reasoning setting could not be saved: ${error instanceof Error ? error.message : String(error)}`));
    }
    openInfo("/reasoning · Request setting", `Reasoning is ${effort}. The next task will use this setting.`);
  }, [activeModel, agent, appendTransient, dependencies.sessionStore, openInfo, requestSettings]);

  const runDoctor = useCallback((args: string) => {
    const normalized = args.trim().toLowerCase();
    if (normalized && normalized !== "--live") {
      openInfo("/doctor · Invalid command", "Use /doctor or /doctor --live.", "error");
      return;
    }
    if (!dependencies.doctor) {
      openInfo("/doctor · Unavailable", "Runtime diagnostics are unavailable in this host.", "error");
      return;
    }
    const controller = new AbortController();
    const operation = startCommandLoad(
      "/doctor · Runtime diagnostics",
      normalized === "--live" ? "Checking runtime and model connectivity" : "Checking local runtime",
      true,
      normalized === "--live",
      () => {
        controller.abort();
        returnToChat();
      },
    );
    void dependencies.doctor(activeModel, permissions.current, normalized === "--live", controller.signal)
      .then((result) => {
        if (!isCurrentCommandOperation(operation)) return;
        replaceCommandView(infoView("/doctor · Runtime diagnostics", result));
      })
      .catch((error: unknown) => {
        if (!isCurrentCommandOperation(operation) || controller.signal.aborted) return;
        replaceCommandView(infoView("/doctor · Diagnostics failed", modelErrorGuidance(error), "error"));
      });
  }, [activeModel, dependencies, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, startCommandLoad]);

  const runCompact = useCallback((args: string) => {
    if (args.trim()) {
      openInfo("/compact · Invalid command", "Use /compact without arguments.", "error");
      return;
    }
    if (abortController.current || directController.current) {
      openInfo("/compact · Busy", "A model turn or direct command is active. Wait for it to finish before compacting context.", "error");
      return;
    }
    if (!activeModel) {
      openInfo("/compact · Cannot compact", "No model is active. Use /login or /model first.", "error");
      return;
    }
    if (!activeSessionId.current) {
      openInfo("/compact · Nothing to compact", "There is no active session context to compact.", "error");
      return;
    }
    if (!agent?.compact) {
      openInfo("/compact · Unsupported", "The active provider does not support Responses context compaction.", "error");
      return;
    }
    const controller = new AbortController();
    const operation = startCommandLoad(
      "/compact · Compacting context",
      "Compacting context",
      true,
      true,
      () => {
        controller.abort();
        returnToChat();
      },
    );
    void agent.compact(controller.signal)
      .then(() => {
        if (!isCurrentCommandOperation(operation)) return;
        returnToChat(() => appendTransient("system", "Context compacted; the full transcript remains available."));
      })
      .catch((error: unknown) => {
        if (!isCurrentCommandOperation(operation) || controller.signal.aborted) return;
        replaceCommandView(infoView(
          "/compact · Could not compact",
          error instanceof Error ? error.message : String(error),
          "error",
        ));
      });
  }, [activeModel, agent, appendTransient, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, startCommandLoad]);

  const runChat = useCallback(
    async (
      text: string,
      timelineRecorded = false,
      mode: AgentMode = agentMode,
      taskSource: WorkflowTaskSource = "user",
      attachments: readonly FileAttachment[] = [],
    ) => {
      await permissionsReady.current;
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
            model: toSessionModel(activeModel, requestSettings),
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
      clearLiveAssistant();
      setLiveToolStatus(undefined);
      let approvedPlan = false;
      try {
        const effectiveTaskSource = mode === "default" && forkResumePending.current
          ? "session_resume"
          : taskSource;
        const runner = new CodingTaskRunner({
          agent,
          workflow: ensureWorkflow(),
          host: {
            executeVerification,
            getGoal: async () => activeGoalProjection.current,
            async addGoalTime(seconds) {
              const sessionId = activeSessionId.current;
              const current = activeGoalProjection.current;
              if (!sessionId || !current) return current;
              const goal = { ...current, time_used_seconds: current.time_used_seconds + seconds, updated_at: new Date().toISOString() };
              await dependencies.sessionStore.setGoal(sessionId, goal);
              activeGoalProjection.current = goal;
              return goal;
            },
            onGoal(goal) {
              activeGoalProjection.current = goal;
              setActiveGoal(goal);
            },
            onSystemMessage(message) { append("system", message); },
            onStatus(status) { setLiveToolStatus(status); },
            resetAssistant: clearLiveAssistant,
          },
        });
        const result = await runner.run({
          text,
          mode,
          source: effectiveTaskSource,
          signal: controller.signal,
          ...(attachments.length === 0 ? {} : { attachments }),
        });
        const forkResumeSettled =
          mode === "default" &&
          forkResumePending.current &&
          result.disposition === "completed" &&
          (result.workflowResult?.state.result === "verified" ||
            result.workflowResult?.state.result === "no_changes");
        if (forkResumeSettled) {
          const sessionId = activeSessionId.current;
          if (!sessionId || !dependencies.sessionStore.setForkPendingResume) {
            throw new Error("Fork continuation state could not be persisted");
          }
          await dependencies.sessionStore.setForkPendingResume(sessionId, false);
          if (activeSessionId.current === sessionId) forkResumePending.current = false;
        }
        if (result.disposition === "plan_approved") {
          approvedPlan = true;
          setAgentMode("default");
        } else if (result.disposition === "plan_cancelled") {
          setAgentMode("default");
          appendTransient("system", "Plan mode cancelled.");
        }
      } catch (error) {
        await agent.finalizePendingGoalCompletion?.(false).catch(() => undefined);
        await agent.finishMemoryTurn?.(controller.signal.aborted ? "cancelled" : "failed").catch(() => undefined);
        if (controller.signal.aborted) {
          const sessionId = activeSessionId.current;
          if (mode === "default" && sessionId) {
            const goal = activeGoalProjection.current;
            if (goal?.status === "active") {
              const paused = { ...goal, status: "paused" as const, updated_at: new Date().toISOString() };
              await dependencies.sessionStore.setGoal(sessionId, paused).catch(() => undefined);
              activeGoalProjection.current = paused;
              setActiveGoal(paused);
            }
          }
          append("system", "Model request cancelled.");
        } else {
          append("error", `Model request failed: ${modelErrorGuidance(error)}`);
        }
      } finally {
        const ownsController = abortController.current === controller;
        if (ownsController) abortController.current = undefined;
        setBusyLabel(undefined);
        setAgentPhase(undefined);
        setTurnStartedAt(undefined);
        setReasoningStartedAt(undefined);
        clearLiveAssistant();
        setLiveToolStatus(undefined);
        if (controller.signal.aborted && queuedGuidance.current.length === 0) {
          setQueuedGuidanceCount(0);
        }
        if (ownsController) {
          if (approvedPlan) {
            queueMicrotask(() => void runChatRef.current?.("The user approved the immediately preceding plan. Implement it now and verify the result.", true, "default"));
            return;
          }
          const next = queuedGuidance.current.shift();
          setQueuedGuidanceCount(queuedGuidance.current.length);
          if (next) {
            // Let React render the completed turn before starting the queued
            // guidance, keeping the transcript and spinner ordering stable.
            queueMicrotask(() => void runChatRef.current?.(next.text, next.timelineRecorded, undefined, undefined, next.attachments));
          }
        }
      }
    },
    [activeModel, agent, agentMode, append, appendTransient, clearLiveAssistant, clearQueuedGuidance, dependencies.sessionStore, ensureWorkflow, executeVerification, requestSettings, startTitleGeneration, workspacePath],
  );

  useEffect(() => {
    runChatRef.current = runChat;
    return () => {
      if (runChatRef.current === runChat) runChatRef.current = undefined;
    };
  }, [runChat]);

  useEffect(() => () => { void agent?.dispose?.(); }, [agent]);

  useEffect(() => {
    if (!resumeGoalPending.current || activeGoal?.status !== "active" || !agent) return;
    resumeGoalPending.current = false;
    queueMicrotask(() => void runChatRef.current?.("Continue working toward the restored active session goal. Call get_goal first and proceed until the objective is verified complete.", true, "default", "session_resume"));
  }, [activeGoal, agent, sessionEpoch]);

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

  const queueGuidance = useCallback((text: string, attachments: readonly FileAttachment[] = []) => {
    const timelineRecorded = activeSessionId.current !== undefined;
    if (timelineRecorded) append("user", text);
    if (confirmationRef.current) finishConfirmation(false);
    if (agent?.requestSteering?.(text, attachments)) {
      setQueuedGuidanceCount((current) => current + 1);
      setLiveToolStatus("Guidance received; applying at the next safe checkpoint");
      return;
    }
    queuedGuidance.current.push({ text, timelineRecorded, attachments });
    setQueuedGuidanceCount(queuedGuidance.current.length);
  }, [agent, append, finishConfirmation]);

  const showWorkspaceDiff = useCallback(async () => {
    const operation = startCommandLoad("/diff · Workspace changes", "Reading Git diff");
    try {
      const index = await listWorkspaceChanges(workspacePath);
      if (isCurrentCommandOperation(operation)) {
        const workflow = workflowRuntime.current?.state;
        replaceCommandView({
          kind: "workspace-diff",
          index,
          ...(workflow === undefined ? {} : { workflow }),
        });
      }
    } catch (error) {
      if (isCurrentCommandOperation(operation)) replaceCommandView(infoView(
        "/diff · Could not inspect workspace",
        error instanceof Error ? error.message : String(error),
        "error",
      ));
    }
  }, [isCurrentCommandOperation, replaceCommandView, startCommandLoad, workspacePath]);

  const runManualVerification = useCallback(async (requested: string) => {
    await permissionsReady.current;
    if (abortController.current || directController.current) {
      openInfo("/verify · Busy", "Wait for the active task or command to finish.", "error");
      return;
    }
    const controller = new AbortController();
    directController.current = controller;
    const cancel = () => {
      controller.abort();
      if (directController.current === controller) directController.current = undefined;
      returnToChat();
    };
    const operation = startCommandLoad("/verify · Workspace checks", "Discovering verification commands", true, true, cancel);
    try {
      const commands = await discoverVerificationCommands(workspacePath);
      controller.signal.throwIfAborted();
      if (!isCurrentCommandOperation(operation)) return;
      const supplemental = requested.trim().length > 0;
      const selected = supplemental
        ? [{ id: "manual", label: "Manual verification", command: requested.trim(), tier: "full" as const, timeoutMs: 120_000 }]
        : selectVerificationCommands(commands, "full");
      if (selected.length === 0) {
        replaceCommandView(infoView("/verify · No checks discovered", "No conventional verification command was found. Use /verify <command> to run an explicit supplemental check."));
        return;
      }
      replaceCommandView({ kind: "loading", title: "/verify · Running", label: selected.map((command) => command.command).join(" · "), cancellable: true, onCancel: cancel });
      const verificationPermissionRevision = permissionPolicyRevision(permissions.current);
      const result = await ensureWorkflow().runManualVerification(
        selected,
        async (value, signal, timeoutMs) => {
          if (permissionPolicyRevision(permissions.current) !== verificationPermissionRevision) {
            return { stdout: "", stderr: "", exitCode: null, signal: null, error: "Permission policy changed during manual verification" };
          }
          const executed = await executeVerification(value, signal, timeoutMs, true);
          return permissionPolicyRevision(permissions.current) === verificationPermissionRevision
            ? executed
            : { ...executed, exitCode: null, error: "Permission policy changed during manual verification" };
        },
        { supplemental, signal: controller.signal },
      );
      if (isCurrentCommandOperation(operation)) {
        const note = supplemental ? "\n\nThis explicit command is supplemental evidence and does not replace the complete project suite." : "";
        replaceCommandView(infoView("/verify · Result", `${JSON.stringify(result, null, 2)}${note}`, result.status === "passed" ? "default" : "error"));
      }
    } catch (error) {
      if (!controller.signal.aborted && isCurrentCommandOperation(operation)) replaceCommandView(infoView("/verify · Failed", error instanceof Error ? error.message : String(error), "error"));
    } finally {
      if (directController.current === controller) directController.current = undefined;
    }
  }, [executeVerification, ensureWorkflow, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, startCommandLoad, workspacePath]);

  const undoWorkflow = useCallback(async () => {
    if (abortController.current || directController.current) {
      appendTransient("system", "Cannot undo while a command or model turn is active.");
      return;
    }
    const result = await ensureWorkflow().undo();
    appendTransient("system", result.status === "undone"
      ? `Undid Agent changes: ${result.restored.join(", ") || "none"}`
      : result.status === "conflict"
        ? `Undo skipped files changed after the Agent turn: ${result.conflicts.join(", ")}`
        : result.status === "empty"
          ? "There is no Agent turn to undo."
          : "The last Agent checkpoint is unavailable after restart.");
  }, [appendTransient, ensureWorkflow]);

  const handleSubmit = useCallback(
    (input: string): boolean | Promise<boolean> => {
      const parsed = parseTuiInput(input);
      if (parsed.kind === "empty") return false;
      const submitResolved = (attachments: readonly FileAttachment[]): boolean => {
        setInputHistory((current) => current.at(-1) === input ? current : [...current, input].slice(-1000));
        setResumedInputHistory((current) => current === undefined ? undefined : current.at(-1) === input ? current : [...current, input].slice(-1000));
        void dependencies.inputHistory?.append(input).catch(() => appendTransient("error", "Input history could not be saved"));

        if (parsed.kind === "chat") {
          if (abortController.current) queueGuidance(parsed.text, attachments);
          else void runChat(parsed.text, false, agentMode, "user", attachments);
          return true;
        }
        if (parsed.kind === "bash") {
          if (abortController.current) {
            appendTransient("system", "A model turn is active. Add guidance as a message or press Ctrl+C first.");
            return true;
          }
          void runDirectBash(parsed.command);
          return true;
        }
        if (parsed.kind === "unknown") {
          openInfo(
            "Slash command error",
            `Unknown command: ${parsed.command}. Enter /help to see available commands.`,
            "error",
          );
          return true;
        }

        if (parsed.command === "/login") enterCommandView({ kind: "login" });
        if (parsed.command === "/model") void openModelPicker();
        if (parsed.command === "/models") void showModels();
        if (parsed.command === "/status") showStatus();
        if (parsed.command === "/context") enterCommandView({ kind: "context" });
        if (parsed.command === "/tasks") enterCommandView({
          kind: "tasks",
          ...(activeTaskProgressProjection.current === undefined ? {} : { progress: cloneTaskProgress(activeTaskProgressProjection.current) }),
          ...(workflowRuntime.current === undefined ? {} : { workflow: { ...workflowRuntime.current.state, changed_paths: [...workflowRuntime.current.state.changed_paths] } }),
        });
        if (parsed.command === "/diff") void showWorkspaceDiff();
        if (parsed.command === "/verify") void runManualVerification(parsed.args ?? "");
        if (parsed.command === "/undo") void undoWorkflow();
        if (parsed.command === "/compact") runCompact(parsed.args ?? "");
        if (parsed.command === "/reasoning") setReasoning(parsed.args ?? "");
        if (parsed.command === "/doctor") runDoctor(parsed.args ?? "");
        if (parsed.command === "/permissions") enterCommandView({ kind: "permissions" });
        if (parsed.command === "/mcp") void showMcp();
        if (parsed.command === "/skills") enterCommandView({ kind: "skills" });
        if (parsed.command === "/memory") {
          const args = parsed.args?.trim() ?? "";
          if (args.toLowerCase().startsWith("remember ")) rememberMemory(args.slice("remember ".length).trim());
          else if (args.toLowerCase() === "pause") toggleMemory(false);
          else if (args.toLowerCase() === "resume") toggleMemory(true);
          else if (args.toLowerCase() === "view") void showMemoryPrompt();
          else void showMemory();
        }
        if (parsed.command === "/plan") {
          const args = parsed.args?.trim() ?? "";
          if (args.toLowerCase() === "exit") {
            setAgentMode("default");
            appendTransient("system", "Plan mode disabled.");
          } else if (!args) {
            setAgentMode("plan");
            appendTransient("system", "Plan mode enabled. The agent can inspect and plan, but cannot use mutating tools.");
          } else {
            setAgentMode("plan");
            void runChat(args, false, "plan");
          }
        }
        if (parsed.command === "/goal") handleGoal(parsed.args?.trim() ?? "");
        if (parsed.command === "/outputs") enterCommandView({ kind: "outputs" });
        if (parsed.command === "/history") enterCommandView({ kind: "input-history" });
        if (parsed.command === "/terminal-setup") enterCommandView({ kind: "terminal-setup" });
        if (parsed.command === "/new") void createNewSession();
        if (parsed.command === "/fork") void forkCurrentSession(parsed.args ?? "");
        if (parsed.command === "/resume") void openResume(parsed.args ?? "");
        if (parsed.command === "/logout") void openLogout();
        if (parsed.command === "/clear") clearConversation();
        if (parsed.command === "/help") openInfo("/help · Help", TUI_HELP);
        if (parsed.command === "/exit") exit(0);
        return true;
      };

      if (parsed.kind !== "chat" || (parseFileReferences(parsed.text).length === 0 && !parsed.text.includes('@"'))) {
        return submitResolved([]);
      }
      return (async () => {
        const controller = new AbortController();
        attachmentController.current?.abort(new Error("Superseded attachment resolution"));
        attachmentController.current = controller;
        const capturedSessionId = activeSessionId.current;
        const capturedWorkspace = workspacePath;
        try {
          const attachments = await resolveFileAttachments(parsed.text, capturedWorkspace, controller.signal);
          if (activeSessionId.current !== capturedSessionId || workspacePath !== capturedWorkspace) {
            appendTransient("error", "File attachments were cancelled because the session or workspace changed.");
            return false;
          }
          return submitResolved(attachments);
        } catch (error) {
          if (!controller.signal.aborted) {
            appendTransient("error", `File attachment failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          return false;
        } finally {
          if (attachmentController.current === controller) attachmentController.current = undefined;
        }
      })();
    },
    [
      clearConversation,
      createNewSession,
      forkCurrentSession,
      enterCommandView,
      exit,
      appendTransient,
      agentMode,
      openLogout,
      openModelPicker,
      openResume,
      openInfo,
      runManualVerification,
      showWorkspaceDiff,
      undoWorkflow,
      handleGoal,
      rememberMemory,
      showMemory,
      showMemoryPrompt,
      toggleMemory,
      runChat,
      runDirectBash,
      queueGuidance,
      showModels,
      showMcp,
      showStatus,
      runCompact,
      setReasoning,
      runDoctor,
      workspacePath,
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
      if (view.kind === "plan-questions" && (key.escape || (key.ctrl && input === "c"))) {
        view.cancel();
        return;
      }
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
    { isActive: view.kind === "chat" || view.kind === "context" || view.kind === "plan-questions" || confirmation !== undefined || (view.kind === "loading" && directController.current !== undefined) },
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

  const displayedToolStatus = liveToolStatus === "Thinking"
    ? `Thinking · ${formatElapsed(reasoningElapsedSeconds)}`
    : liveToolStatus;

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
              void (async () => {
                try {
                  abortController.current?.abort(new Error("Permission policy changed"));
                  await dependencies.savePermissions?.(workspacePath, policy);
                  permissions.current = dependencies.loadPermissions
                    ? await dependencies.loadPermissions(workspacePath)
                    : policy;
                } catch {
                  // Keep the prior effective policy when persistence or reload fails.
                } finally {
                  returnToChat();
                }
              })();
            }}
            onSaveProject={(policy) => {
              void (async () => {
                try {
                  abortController.current?.abort(new Error("Permission policy changed"));
                  await dependencies.savePermissions?.(workspacePath, policy, "project");
                  if (dependencies.loadPermissions) permissions.current = await dependencies.loadPermissions(workspacePath);
                } catch {
                  // Keep the prior effective policy when persistence or reload fails.
                } finally {
                  returnToChat();
                }
              })();
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
        ) : view.kind === "memory" ? (
          <MemorySurface
            status={view.status}
            policy={view.policy}
            onBack={returnToChat}
            onToggle={toggleMemory}
            onPolicyChange={updateMemoryPolicy}
            onArchive={archiveMemory}
            onClear={clearMemory}
          />
        ) : view.kind === "plan-questions" ? (
          <PlanQuestionsSurface request={view.request} mode={view.mode} onComplete={view.complete} onCancel={view.cancel} />
        ) : view.kind === "plan-review" ? (
          <PlanReviewSurface submitted={view.submitted} onDecision={view.decide} />
        ) : view.kind === "goal-confirm" ? (
          <GoalConfirmationSurface
            objective={view.objective}
            {...(view.tokenBudget === undefined ? {} : { tokenBudget: view.tokenBudget })}
            onConfirm={view.confirm}
            onCancel={view.cancel}
          />
        ) : view.kind === "goal-status" ? (
          <GoalStatusSurface {...(view.goal ? { goal: view.goal } : {})} onPause={pauseGoal} onResume={resumeGoal} onBack={returnToChat} />
        ) : view.kind === "workspace-diff" ? (
          <WorkspaceDiffSurface
            initialIndex={view.index}
            {...(view.workflow === undefined ? {} : { workflow: view.workflow })}
            readDetail={(entry, signal) => readWorkspaceChange(workspacePath, entry, signal)}
            refresh={(signal) => listWorkspaceChanges(workspacePath, signal)}
            onBack={returnToChat}
          />
        ) : view.kind === "context" ? (
          <ContextSurface
            {...(agent?.getContextSnapshot ? { getSnapshot: () => agent.getContextSnapshot?.() } : {})}
            onBack={returnToChat}
          />
        ) : view.kind === "tasks" ? (
          <TaskProgressSurface progress={view.progress} workflow={view.workflow} onBack={returnToChat} />
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
            initialResult={view.result}
            {...(view.initialQuery === undefined ? {} : { initialQuery: view.initialQuery })}
            search={searchSessions}
            onSelect={(session) => void chooseSession(session)}
            onDelete={deleteSessions}
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
            {...(view.cancellable ? { onBack: view.onCancel ?? returnToChat } : {})}
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
          {displayedToolStatus ? <Text color={TUI_COLORS.secondary}>• {displayedToolStatus}</Text> : null}
          <Prompt
            key={`prompt-${inputKey}`}
            activeModelName={activeModel?.model_name}
            placeholder="Add guidance while waiting for approval"
            history={resumedInputHistory ?? inputHistory}
            editorRef={editorRef}
            historyNavigationRef={historyNavigationRef}
            getFileSuggestions={getFileSuggestions}
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
              {displayedToolStatus ? <Text color={TUI_COLORS.secondary}>• {displayedToolStatus}</Text> : null}
              {queuedGuidanceCount > 0 ? <Text dimColor>{queuedGuidanceCount} guidance message{queuedGuidanceCount === 1 ? "" : "s"} pending</Text> : null}
              <Prompt
                key={`prompt-${inputKey}`}
                activeModelName={activeModel?.model_name}
                placeholder="Add guidance while working"
                history={resumedInputHistory ?? inputHistory}
                editorRef={editorRef}
                historyNavigationRef={historyNavigationRef}
                getFileSuggestions={getFileSuggestions}
                onEmptyInterrupt={() => abortController.current?.abort()}
                onSubmit={handleSubmit}
              />
            </>
          ) : null}
        </Box>
      ) : busyLabel ? (
        <Box flexDirection="column">
          <Spinner label={`${agentPhase === "tools" ? "Working" : agentPhase === "sampling" ? `Waiting · ${busyLabel}` : busyLabel}${turnStartedAt === undefined ? "" : ` (${formatElapsed(elapsedSeconds)} • ctrl+c to interrupt)`}`} />
          {liveAssistant ? <Box marginLeft={2}><RichOutput text={liveAssistant} /></Box> : null}
          {displayedToolStatus ? <Text color={TUI_COLORS.secondary}>• {displayedToolStatus}</Text> : null}
          {queuedGuidanceCount > 0 ? <Text dimColor>{queuedGuidanceCount} guidance message{queuedGuidanceCount === 1 ? "" : "s"} pending</Text> : null}
          <Prompt
            key={`prompt-${inputKey}`}
            activeModelName={activeModel?.model_name}
            placeholder="Add guidance while working"
            history={resumedInputHistory ?? inputHistory}
            editorRef={editorRef}
            historyNavigationRef={historyNavigationRef}
            getFileSuggestions={getFileSuggestions}
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
          getFileSuggestions={getFileSuggestions}
          onEmptyInterrupt={() => exit(0)}
          onSubmit={handleSubmit}
        />
      )}

      <StatusBar
        modelName={activeModel?.model_name}
        workspacePath={workspacePath}
        mode={agentMode}
        reasoningEffort={requestSettings.reasoningEffort}
        {...(activeGoal ? { goalStatus: activeGoal.status } : {})}
        {...(activeTaskProgress ? { taskProgress: activeTaskProgress } : {})}
      />
    </Box>
  );
}
