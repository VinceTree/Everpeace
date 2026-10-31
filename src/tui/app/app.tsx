import { sensitiveText, sensitiveDigest } from "../../permissions/sensitive-access.js";
import {localizeHostReport} from '../../localization/reports.js';
import {uiText,translateHostText} from '../../localization/messages.js';
import {subscribeLanguage,currentLanguage,changeLanguage,isLanguagePreference}from'../../localization/language.js';
import {projectTaskStatus,type TaskStatusFacts}from'../../status/task-status.js';
import {TaskStatus}from'../components/conversation/task-status.js';
import {ResourceCleanupError}from'../../util/resource-cleanup-error.js';
import {PersistenceError}from'../../storage/persistence-error.js';
import {ProcessCleanupError}from'../../tools/process-completion.js';
import { TeamSurface } from "../components/screens/team-surface.js";
import { normalizeTeamOptions, type TeamOptions, type TeamSnapshot } from "../../team/types.js";
import { Spinner } from "@inkjs/ui";
import { Box, Text, useApp, useInput, usePaste, useStdout, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentIO } from "../../agent/react-agent.js";
import { LoopStoppedError, type LoopPhase } from "../../agent/agent-loop.js";
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
import { ApplicationCoordinator } from "../../runtime/application-coordinator.js";
import { createProductionWorkflowAgentIO } from "../../runtime/production.js";
import type { WorkflowState, WorkflowTaskSource } from "../../workflow/types.js";
import { discoverVerificationCommands, selectVerificationCommands } from "../../workflow/verifier.js";
import {
  listWorkspaceChanges,
  readWorkspaceChange,
  type WorkspaceChangeIndex,
} from "../../tools/workspace-review.js";
import { selectAgentOutputPreview } from "../rendering/command-output-preview.js";
import { parseTuiInput, getTuiHelp } from "../commands/slash-commands.js";
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
import { ApprovedPlanSurface, PlanQuestionsSurface, PlanReviewSurface } from "../components/screens/plan-surface.js";
import { GoalConfirmationSurface, GoalStatusSurface } from "../components/screens/goal-surface.js";
import { McpTrustSurface } from "../components/screens/mcp-trust-surface.js";
import { WebSurface } from "../components/screens/web-surface.js";
import { CostSurface } from "../components/screens/cost-surface.js";
import { ActionConfirmation } from "../components/screens/action-confirmation.js";
import { diagnosticEndpoint } from "../../providers/doctor.js";
import type { McpTrustPreview } from "../../mcp/trust.js";
import { WorkspaceDiffSurface } from "../components/screens/workspace-diff-surface.js";
import { ContextSurface } from "../components/screens/context-surface.js";
import { TaskProgressSurface } from "../components/screens/task-progress-surface.js";
import { HighlightedCommand, RichOutput } from "../rendering/rich-text.js";
import { TUI_COLORS } from "../rendering/palette.js";
import { truncateEnd } from "../rendering/text-width.js";
import type {
  AgentSession,
  HistoryKind,
  TimelineEntry,
  TuiDependencies,
} from "./types.js";
import type { LearnedMemoryPolicy, LearnedMemoryStatus, LearnedScope } from "../../memory/learned-memory.js";
import type { AgentMode, PlanRequest, PlanReviewResult, SubmittedPlan } from "../../plan/runtime.js";
import { GoalRuntime, parseGoalCommand } from "../../goal/runtime.js";
import type { SessionGoal } from "../../storage/session-store.js";
import { modelErrorGuidance } from "../../agent/response-errors.js";
import {
  canReuseOpaqueProviderContext,
  defaultModelRequestSettings,
  hasOpaqueProviderContext,
  isReasoningEffort,
  resolveProviderCapabilities,
  isResponsesProfile,
  requestReasoningEffort,
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
  | { kind: "cost" }
  | { kind: "action-confirm"; text: string; startLabel?: string; start(): void; cancel(): void }
  | { kind: "web" }
  | { kind: "outputs" }
  | { kind: "input-history" }
  | { kind: "terminal-setup" }
  | { kind: "permissions" }
  | { kind: "skills" }
  | { kind: "mcp-trust"; preview: McpTrustPreview; approve(): void; cancel(): void }
  | { kind: "memory"; status: LearnedMemoryStatus; policy: LearnedMemoryPolicy }
  | { kind: "plan-questions"; request: PlanRequest; mode: AgentMode; complete(answers: Record<string, string>): void; cancel(): void }
  | { kind: "plan-review"; submitted: SubmittedPlan; decide(decision: PlanReviewResult): void; cancelTask(): void }
  | { kind: "approved-plan"; submitted: SubmittedPlan }
  | { kind: "goal-confirm"; objective: string; tokenBudget?: number; confirm(): void; cancel(): void }
  | { kind: "goal-status"; goal?: SessionGoal }
  | { kind: "workspace-diff"; index: WorkspaceChangeIndex; workflow?: WorkflowState }
  | { kind: "context" }
  | { kind: "team"; models: Array<{ id: string; name: string }>; snapshot?: TeamSnapshot }
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
  kind: "bash" | "patch" | "web" | "mcp" | "goal" | "verification_basis";
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
    ? { kind: "model-picker", title: uiText('m9401a005aae1'), models }
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
    ...(model.responses_profile === undefined ? {} : { responses_profile: model.responses_profile }),
  };
}

function settingsForModel(model: RegisteredModel | undefined): ModelRequestSettings {
  return defaultModelRequestSettings(
    resolveProviderCapabilities(model?.base_url ?? "", model?.model_name, model?.responses_profile),
    model?.request_settings,
  );
}

function fallbackSessionTitle(firstQuestion: string): string {
  const normalized = firstQuestion.replace(/\s+/g, " ").trim();
  return truncateEnd(normalized || uiText('me8580917ff93'), 60);
}

export function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remaining = total % 60;
  if (hours > 0) return uiText('m9ea05ef23384', {p0: hours, p1: minutes, p2: remaining});
  if (minutes > 0) return uiText('mb9e8aac7e53d', {p0: minutes, p1: remaining});
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
      ? [isAgentPreview ? uiText('m92786c92b3fe', {p0: omittedLines}) : uiText('m6f6a29c2655d', {p0: omittedLines})]
      : []),
    ...tailLines,
  ];

  return (
    <Box flexDirection="column">
      {previewLines.length ? <RichOutput text={previewLines.join("\n")} marginLeft={3} /> : null}
      <Box paddingLeft={1}>
        <Text dimColor>{uiText('m1d604b51d0dc')}</Text>
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
  const { columns } = useWindowSize();
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
        text: uiText('mb939d0c8ef6e', {p0: model.model_name}),
      });
    });
    return entries;
  }, [firstActiveModel, initialModels.missing]);

  const nextId = useRef(initialTimeline.length);
  const [coordinator] = useState(() => new ApplicationCoordinator<AgentSession>());
  const language=useSyncExternalStore(subscribeLanguage,currentLanguage,currentLanguage);
  const previousLanguage=useRef(language);
  const [workflowProjection,setWorkflowProjection]=useState<WorkflowState>();
  const [taskOutcome,setTaskOutcome]=useState<TaskStatusFacts['outcome']>();
  const [taskFailure,setTaskFailure]=useState<TaskStatusFacts['failure']>();
  const [taskFinishedAt,setTaskFinishedAt]=useState<number>();
  const [taskStageStartedAt,setTaskStageStartedAt]=useState(Date.now);
  const [cleanupFailed,setCleanupFailed]=useState(false);
  const [lastTaskStartedAt,setLastTaskStartedAt]=useState<number>();
  const titleControllers = useRef(new Set<AbortController>());
  const confirmationRef = useRef<PendingConfirmation | undefined>(undefined);
  const verificationBasisReview = useRef<(summary: string, signal?: AbortSignal) => Promise<boolean>>(() => Promise.resolve(false));
  const permissions = useRef(defaultPermissions());
  const permissionsReady = useRef<Promise<void>>(Promise.resolve());
  const terminalCommandRunning = useRef(false);
  const workflowRuntime = useRef<CodingWorkflowRuntime | undefined>(undefined);
  const sessionTitlePending = useRef(false);
  const forkResumePending = useRef(false);
  const [timeline, setTimeline] = useState(initialTimeline);
  const [timelineEpoch, setTimelineEpoch] = useState(0);
  useEffect(()=>{if(previousLanguage.current===language)return;previousLanguage.current=language;onReplayOutput(()=>setTimelineEpoch(epoch=>epoch+1));},[language,onReplayOutput]);
  const terminalColumns = Math.max(1, columns);
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
  const [agentMode, projectAgentMode] = useState<AgentMode>(coordinator.mode);
  const setAgentMode = useCallback((mode: AgentMode) => {
    coordinator.setMode(mode);
    projectAgentMode(coordinator.mode);
  }, [coordinator]);
  const [activeGoal, setActiveGoal] = useState<SessionGoal>();
  const activeGoalProjection = useRef<SessionGoal | undefined>(undefined);
  const [activeTaskProgress, setActiveTaskProgress] = useState<TaskProgress>();
  const activeTaskProgressProjection = useRef<TaskProgress | undefined>(undefined);
  const [memoryPolicy, setMemoryPolicy] = useState<LearnedMemoryPolicy>({ readExisting: true, captureFuture: true });
  const [teamConfig, setTeamConfig] = useState<TeamOptions>({ enabled: false });
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
  const sensitiveInputGrants = useRef(new Map<string, string>());
  const skipInputHistory = useRef(false);
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
  useEffect(()=>{if(coordinator.activeTask||directController.current||coordinator.cleanupBlocked||cleanupFailed)return;setTaskOutcome(undefined);setTaskFailure(undefined);setTaskFinishedAt(undefined);setLastTaskStartedAt(undefined);setWorkflowProjection(undefined);},[sessionEpoch,workspacePath]);
  const resumeGoalPending = useRef(false);
  const runChatRef = useRef<((text: string, timelineRecorded?: boolean, mode?: AgentMode, taskSource?: WorkflowTaskSource, attachments?: readonly FileAttachment[]) => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void dependencies.inputHistory?.load().then((entries) => { if (active) setInputHistory((current) => [...entries, ...current].slice(-1000)); }).catch(() => undefined);
    return () => { active = false; directController.current?.abort(); };
  }, [dependencies.inputHistory]);
  useEffect(() => () => {
    attachmentController.current?.abort(new Error(uiText('m9ae3e8b0bdcb')));
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
    let owner:CodingWorkflowRuntime;
    let ownerSessionId=coordinator.sessionId;
    const runtimeOptions = {
      workspacePath: workflowWorkspace,
      confirmVerificationBasis: (summary: string, signal?: AbortSignal) => verificationBasisReview.current(summary, signal),
      permissionRevision: () => permissionPolicyRevision(permissions.current),
      ...(initialState ? { initialState } : {}),
      onState: async (state: WorkflowState) => {
        if(owner===workflowRuntime.current)ownerSessionId??=coordinator.sessionId;
        const sessionId = ownerSessionId;
        const runtime=owner;
        const task=coordinator.activeTask;
        if (sessionId) await dependencies.sessionStore.setWorkflow?.(sessionId, state);
        if(sessionId===coordinator.sessionId&&runtime===workflowRuntime.current&&task===coordinator.activeTask&&runtime?.state.task_id===state.task_id)setWorkflowProjection(state);
      },
    };
    if (workflowRuntime.current?.workspacePath !== workflowWorkspace || initialState !== undefined) {
      owner=new CodingWorkflowRuntime(runtimeOptions);
      workflowRuntime.current = owner;
    }
    if (!workflowRuntime.current) {owner=new CodingWorkflowRuntime(runtimeOptions);workflowRuntime.current=owner;}
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

    const sessionId = coordinator.sessionId;
    if (sessionId !== undefined) {
      void dependencies.sessionStore
        .appendTimeline(sessionId, { kind, text })
        .catch((error: unknown) => {
          const errorId = nextId.current++;
          const message = error instanceof Error ? error.message : String(error);
          setTimeline((current) => [
            ...current,
            { id: errorId, kind: "error", text: uiText('me4c6f6efcfb7', {p0: message}) },
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
    const sessionId = coordinator.sessionId;
    if (sessionId) void dependencies.sessionStore.appendTimeline(sessionId, entry).catch((e: unknown) => appendTransient("error", uiText('me4c6f6efcfb7', {p0: String(e)})));
  }, [dependencies.sessionStore, appendTransient]);

  const returnQueuedGuidanceToDraft = useCallback(() => {
    const pending = queuedGuidance.current.splice(0);
    setQueuedGuidanceCount(0);
    if (pending.length === 0) return;
    const draft = [editorRef.current.value, ...pending.map((item) => item.text)].filter(Boolean).join("\n\n");
    editorRef.current = createComposerState(draft);
    historyNavigationRef.current = { index: undefined, draft: "" };
    setInputKey((current) => current + 1);
    appendTransient("system", uiText('m1bb38300b1e9'));
  }, [appendTransient]);

  const enterCommandView = useCallback((nextView: CommandView) => {
    coordinator.nextCommandOperation();
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
    const operation = coordinator.nextCommandOperation();
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
    (operation: number): boolean => coordinator.isCurrentCommandOperation(operation),
    [],
  );

  const returnToChat = useCallback((update?: () => void) => {
    coordinator.nextCommandOperation();
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
          ? uiText('m88748080c82c')
          : pending?.kind === "mcp"
            ? uiText('m58879d3f6629')
            : pending?.kind === "goal"
            ? uiText('m1f10522dfa61')
            : pending?.kind === "patch"
              ? uiText('md423169c838d')
            : uiText('maae9fd3dfc9b');
        append("system", pending?.kind === "mcp" ? label : `${label}: ${pending?.request ?? uiText('mc46f95764b82')}`);
      }
      pending?.resolve(accepted);
    },
    [append],
  );

  const approvalQueue = useRef(Promise.resolve());
  const requestApproval = useCallback((kind: PendingConfirmation["kind"], request: string, signal?: AbortSignal): Promise<boolean> => {
    const result = approvalQueue.current.then(() => new Promise<boolean>((resolve) => {
      if (signal?.aborted) { resolve(false); return; }
      const settle = (accepted: boolean) => { signal?.removeEventListener("abort", aborted); resolve(accepted); };
      const pending: PendingConfirmation = { kind, request, resolve: settle };
      const aborted = () => {
        if (confirmationRef.current === pending) { confirmationRef.current = undefined; setConfirmation(undefined); }
        settle(false);
      };
      confirmationRef.current = pending; setConfirmation(pending);
      signal?.addEventListener("abort", aborted, { once: true });
      if (signal?.aborted) aborted();
    }));
    approvalQueue.current = result.then(() => {}, () => {});
    return result;
  }, []);
  const requestBashConfirmation = useCallback((request: string, signal?: AbortSignal) => requestApproval("bash", request, signal), [requestApproval]);
  const requestPatchConfirmation = useCallback((request: string, signal?: AbortSignal) => requestApproval("patch", request, signal), [requestApproval]);
  verificationBasisReview.current = (summary, signal) => requestApproval("verification_basis", summary, signal);
  const requestWebConfirmation = useCallback((request: string, signal?: AbortSignal) => requestApproval("web", request, signal), [requestApproval]);
  const requestMcpConfirmation = useCallback((request: string, signal?: AbortSignal) => requestApproval("mcp", request, signal), [requestApproval]);
  const requestGoalConfirmation = useCallback((request: string, signal?: AbortSignal) => requestApproval("goal", request, signal), [requestApproval]);

  const requestUserInput = useCallback((request: PlanRequest, signal?: AbortSignal, mode: AgentMode = "default"): Promise<Record<string, string>> => (
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error(uiText('me8960873b52b')));
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
          : () => coordinator.cancelTask(new Error(uiText('m2cf21d4057cf'))),
      });
    })
  ), [enterCommandView, returnToChat]);

  const reviewPlan = useCallback((submitted: SubmittedPlan, signal?: AbortSignal): Promise<PlanReviewResult> => (
    new Promise((resolve) => {
      if (signal?.aborted) {
        resolve("cancel");
        return;
      }
      let finished = false;
      const decide = (decision: PlanReviewResult) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", cancel);
        returnToChat();
        resolve(signal?.aborted ? "cancel" : decision);
      };
      const cancel = () => decide("cancel");
      signal?.addEventListener("abort", cancel, { once: true });
      enterCommandView({ kind: "plan-review", submitted, decide, cancelTask: () => {
        coordinator.cancelTask(new Error(uiText('mc68128be37ac')));
        cancel();
      } });
    })
  ), [enterCommandView, returnToChat]);

  const executeBash = useCallback(
    async (command: string, signal?: AbortSignal, timeoutMs?: number): Promise<BashResult> => {
      const started = Date.now();
      setActiveCommand({ command, shell: process.platform === "win32" ? uiText('m9543cbaf45a8') : uiText('m20eb47762dd7'), source: "model" });
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
      if (result === undefined) throw new Error(uiText('m3306b05f39bd'));
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
        return { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: false, error: uiText('m1362815cc293') };
      }
      if (!userInitiated && permission === "ask" && !(await requestBashConfirmation(uiText('mc2b87b48c813', {p0: command})))) {
        return { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: false, error: uiText('m8e9d6272e54a') };
      }
      if (!userInitiated && permissionPolicyRevision(permissions.current) !== revision) {
        return { stdout: "", stderr: "", exitCode: null, signal: null, cancelled: false, error: uiText('m8c7c4cbae03e') };
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
      if(result.cleanupFailed) { const error = new ProcessCleanupError(result.error ?? uiText('task.cleanupFailed')); await ensureWorkflow().recordCleanupFailure(error); throw error; }
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
        getId: () => coordinator.sessionId,
        async getGoal() {
          return coordinator.sessionId ? activeGoalProjection.current : undefined;
        },
        async setGoal(goal) {
          const sessionId = coordinator.sessionId;
          if (!sessionId) throw new Error(uiText('mc37e4cde06b1'));
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
          const sessionId = coordinator.sessionId;
          if (!sessionId) throw new Error(uiText('m5bb9ac28b375'));
          if (!dependencies.sessionStore.setTaskProgress) throw new Error(uiText('m0bfb5c833e38'));
          await dependencies.sessionStore.setTaskProgress(sessionId, progress);
          const next = cloneTaskProgress(progress);
          activeTaskProgressProjection.current = next;
          setActiveTaskProgress(next);
        },
      },
      interaction: {
        takeSensitiveInputAuthorization(digest) { const allowed = sensitiveInputGrants.current.get(digest) === permissionPolicyRevision(permissions.current); sensitiveInputGrants.current.delete(digest); return allowed; },
        confirm(_kind, tool, prompt, signal) {
          if (tool === "verification_basis") return requestApproval("verification_basis", prompt, signal);
          if (tool === "bash") return requestBashConfirmation(prompt, signal);
          if (tool === "patch") return requestPatchConfirmation(prompt, signal);
          if (tool === "web") return requestWebConfirmation(prompt, signal);
          if (tool === "mcp") return requestMcpConfirmation(prompt, signal);
          return requestGoalConfirmation(prompt, signal);
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
            setLiveToolStatus(uiText('m64d54f47f8f1', {p0: event.name, p1: suffix}));
          } else if (event.phase === "streaming") {
            setLiveToolStatus(uiText('m29fb8dfed7f8', {p0: event.name, p1: suffix}));
          } else if (event.phase === "started") {
            setLiveToolStatus(`${event.name}${detail ? `: ${truncateEnd(detail, 160)}` : ""}`);
          } else if (event.phase === "finished") {
            setLiveToolStatus(uiText('m5c56ad59190c', {p0: event.name}));
          }
        },
      },
    }),
    [append, clearLiveAssistant, dependencies.sessionStore, ensureWorkflow, executeBash, executeVerification, queueAssistantDelta, requestApproval, requestBashConfirmation, requestGoalConfirmation, requestMcpConfirmation, requestPatchConfirmation, requestUserInput, requestWebConfirmation, reviewPlan, workspacePath],
  );

  useEffect(() => {
    let active = true;
    void dependencies.getTeamConfig?.().then((config) => { if (active && !coordinator.activeTask) setTeamConfig(config); }).catch(() => appendTransient("error", uiText('m9604b9c46a33')));
    return () => { active = false; };
  }, [dependencies]);
  const contextWindow = activeModel
    ? resolveModelStatusMetadata(activeModel.base_url, activeModel.model_name).context_window
    : null;
  const agent = useMemo(
    () =>
      activeModel === undefined
        ? undefined
        : dependencies.createAgent({ ...activeModel, request_settings: requestSettings }, agentIo, {
            ...(teamConfig.enabled ? { team: teamConfig } : {}),
            initialContext: sessionContext,
            contextWindow,
            initialContextTokens: sessionUsage.context_tokens,
            ...(activeTaskProgressProjection.current === undefined ? {} : { initialTaskProgress: cloneTaskProgress(activeTaskProgressProjection.current) }),
            async onContextAppend(items) {
              const sessionId = coordinator.sessionId;
              if (sessionId !== undefined) {
                await dependencies.sessionStore.appendContext(sessionId, items);
              }
            },
            async onContextCompacted(items, automatic, usage) {
              const sessionId = coordinator.sessionId;
              if (sessionId === undefined) throw new Error(uiText('mce021e50b209'));
              await dependencies.sessionStore.compactContext(sessionId, items, automatic, usage);
              setSessionUsage((current) => applyCompactionUsage(current, usage));
            },
            async onContextPruned(items, metadata) {
              const sessionId = coordinator.sessionId;
              if (sessionId === undefined || !dependencies.sessionStore.pruneContext) {
                throw new Error(uiText('ma038c3ea984d'));
              }
              await dependencies.sessionStore.pruneContext(sessionId, items, metadata);
              setSessionUsage((current) => ({ ...current, context_tokens: null }));
            },
            async onUsage(usage) {
              const sessionId = coordinator.sessionId;
              if (sessionId !== undefined) {
                await dependencies.sessionStore.appendUsage(sessionId, usage);
              }
              setSessionUsage((current) => applyUsageSample(current, usage));
            },
            async onMemberUsage(usage) {
              const sessionId = coordinator.sessionId;
              if (sessionId !== undefined) await dependencies.sessionStore.appendUsage(sessionId, usage, { preserveContext: true });
              setSessionUsage((current) => ({ ...applyUsageSample(current, usage), context_tokens: usage === null ? null : current.context_tokens }));
            },
            onPhase(phase) {
              setAgentPhase(phase);
            },
            onEvent(event) {
              if (event.type === "cost_estimated" && event.estimate.warning) appendTransient("system", uiText('m36dafc16eeba'));
              if (event.type === "sampling_started") {
                clearLiveAssistant();
                setLiveToolStatus(undefined);
                setReasoningStartedAt(undefined);
              } else if (event.type === "reasoning_started") {
                setLiveToolStatus(uiText('ma20d12c5e9c4'));
                setReasoningStartedAt(Date.now());
              } else if (event.type === "reasoning_finished") {
                setLiveToolStatus(undefined);
                setReasoningStartedAt(undefined);
              } else if (event.type === "retrying") {
                clearLiveAssistant();
                setLiveToolStatus(uiText('ma3b29557426e', {p0: event.attempt, p1: event.category ? ` · ${event.category.replace(/_/g, " ")}` : ""}));
              } else if (event.type === "stream_recovery_started") {
                setLiveToolStatus(uiText('md7c1670069d9'));
              } else if (event.type === "stream_recovery_finished") {
                setLiveToolStatus(event.success === false ? uiText('md53e91ac8869') : uiText('m2a233558efbd'));
              } else if (event.type === "steering_applied") {
                setQueuedGuidanceCount((current) => Math.max(0, current - event.count));
                clearLiveAssistant();
                setLiveToolStatus(uiText('me357e27b5210'));
              } else if (event.type === "tool_started") {
                setLiveToolStatus(uiText('m2706eac57fae', {p0: event.call.name}));
              } else if (event.type === "tool_finished") {
                setLiveToolStatus(uiText('m5c56ad59190c', {p0: event.call.name}));
              } else if (event.type === "tool_batch_started") {
                setLiveToolStatus(uiText('m8c00ce9df2a0', {p0: event.calls.length}));
              } else if (event.type === "tool_batch_finished") {
                setLiveToolStatus(uiText('m5db96086042c', {p0: event.calls.length}));
              } else if (event.type === "compaction_started") {
                setLiveToolStatus(event.automatic ? uiText('m70b8c999b0ea') : uiText('m67afcd229f27'));
              } else if (event.type === "compaction_completed") {
                setLiveToolStatus(uiText('m99ca2ce25713'));
              }
            },
          }),
    [activeModel, agentIo, clearLiveAssistant, contextWindow, dependencies, requestSettings, sessionContext, sessionEpoch, teamConfig],
  );

  coordinator.setAgent(agent);
  const configureTeam = async (config: TeamOptions) => {
    if (coordinator.activeTask || directController.current) throw new Error(uiText('mf92cb5a0a043'));
    const next = normalizeTeamOptions(config);
    await dependencies.configureTeam?.(next);
    const sessionId = coordinator.sessionId;
    if (sessionId) { const loaded = await dependencies.sessionStore.load(sessionId); setSessionContext(loaded.context); setSessionUsage(loaded.usage); }
    setTeamConfig(next);
  };
  const showTeam = async (args = "") => {
    try {
      if (args === "on" || args === "off") await configureTeam({ ...teamConfig, enabled: args === "on" });
      const resolved = await dependencies.registry.resolveAll();
      const requestedTeam = args && args !== "on" && args !== "off" ? args : undefined;
      if (requestedTeam && !/^[a-f0-9-]{36}$/u.test(requestedTeam)) throw new Error(uiText('m4d54c33d4447'));
      if (requestedTeam && !coordinator.sessionId) throw new Error(uiText('m045366e71893'));
      const snapshot = requestedTeam ? await dependencies.inspectTeam?.(coordinator.sessionId!, requestedTeam) : dependencies.getTeamSnapshot?.() ?? (coordinator.sessionId ? await dependencies.inspectTeam?.(coordinator.sessionId) : undefined);
      enterCommandView({ kind: "team", models: resolved.available.map((model) => ({ id: model.id, name: model.model_name })), ...(snapshot ? { snapshot } : {}) });
    } catch (error) { openInfo(uiText('m58fca75f9b7e'), error instanceof Error ? error.message : uiText('m4a0487b903a3'), "error"); }
  };


  useEffect(() => {
    agent?.setMemoryPolicy?.(memoryPolicy);
  }, [agent, memoryPolicy]);

  useEffect(() => {
    agent?.setRequestSettings?.(requestSettings);
  }, [agent, requestSettings]);

  useEffect(() => {
    void agent?.ensureSessionActivity?.().catch(() => appendTransient("error", uiText('m768be4e3cb8e')));
  }, [agent, sessionEpoch, appendTransient]);

  useEffect(() => {
    let ended = false; let lease: import("../../storage/session-activity.js").ActivityLease | undefined;
    void (async () => {
      const id = coordinator.sessionId;
      if (id && dependencies.acquireSessionActivity) lease = await dependencies.acquireSessionActivity(id);
      if (ended) { await lease?.(); return; }
      const result = await dependencies.privacy?.autoCleanup();
      if (result && !ended) appendTransient("system", uiText('m3100c73c9c2b', {p0: result.deleted, p1: result.failed, p2: result.excluded}));
    })().catch(() => { if (!ended) appendTransient("error", uiText('mf2b83dd35718')); });
    return () => { ended = true; void lease?.().catch(() => undefined); };
  }, [dependencies.acquireSessionActivity, dependencies.privacy, sessionEpoch, appendTransient]);

  const activateModel = useCallback(
    (model: RegisteredModel, message = uiText('mc75afeb23340', {p0: model.model_name})) => {
      const nextSettings = settingsForModel(model);
      coordinator.invalidatePlan();
      clearQueuedGuidance();
      coordinator.cancelTask();
      const sessionId = coordinator.sessionId;
      if (sessionId !== undefined) {
        void dependencies.sessionStore
          .selectModel(sessionId, toSessionModel(model, nextSettings), false)
          .catch((error: unknown) => {
            appendTransient("error", uiText('me4c6f6efcfb7', {p0: error instanceof Error ? error.message : String(error)}));
          });
      }
      returnToChat(() => {
        setActiveModel(model);
        setRequestSettings(nextSettings);
        setSessionContext([]);
        setSessionUsage((current) => resetContextUsage(current, false));
        setSessionEpoch((current) => current + 1);
        appendTransient("system", uiText('mf9eab913dd9e', {p0: message}));
      });
    },
    [appendTransient, clearQueuedGuidance, dependencies.sessionStore, returnToChat],
  );

  const showModels = useCallback(async () => {
    const operation = startCommandLoad(
      uiText('mec7cb903c497'),
      uiText('m60d658dbe1e4'),
    );
    try {
      const models = await dependencies.registry.listStatuses();
      if (!isCurrentCommandOperation(operation)) return;
      if (models.length === 0) {
        replaceCommandView(infoView(
          uiText('mec7cb903c497'),
          uiText('me5f62626e5d0'),
        ));
        return;
      }
      replaceCommandView(infoView(
        uiText('mec7cb903c497'),
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
        uiText('me5f5eb796893'),
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
    const operation = startCommandLoad(uiText('m17cf1e9a821e'), uiText('m8c6c68dbc8ab'));
    try {
      const text = dependencies.getMcpStatus
        ? await dependencies.getMcpStatus()
        : uiText('m42ddd6b00014');
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(uiText('m17cf1e9a821e'), text));
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(uiText('m3b0640dc8813'), error instanceof Error ? error.message : String(error), "error"));
    }
  }, [dependencies, isCurrentCommandOperation, replaceCommandView, startCommandLoad]);

  const reviewMcpTrust = useCallback(async (name: string) => {
    const controller = new AbortController();
    const cancel = () => { controller.abort(); returnToChat(); };
    const operation = startCommandLoad(uiText('m741279c7487a'), uiText('m6e65c2412f43'), true, true, cancel);
    try {
      if (!dependencies.previewMcpTrust || !dependencies.approveMcpTrust) throw new Error(uiText('m5b9291a0cf22'));
      const preview = await dependencies.previewMcpTrust(name, controller.signal);
      if (!isCurrentCommandOperation(operation)) return;
      let submitted = false;
      replaceCommandView({ kind: "mcp-trust", preview, cancel, approve() {
        if (submitted || !isCurrentCommandOperation(operation)) return;
        submitted = true;
        const approval = startCommandLoad(uiText('m741279c7487a'), uiText('md7018da0e36f'), true, true, cancel);
        void dependencies.approveMcpTrust!(preview, controller.signal).then(() => {
          if (isCurrentCommandOperation(approval)) replaceCommandView(infoView(uiText('m26a4279d9f7f'), uiText('m4d3846c83688')));
        }).catch(() => {
          if (isCurrentCommandOperation(approval)) replaceCommandView(infoView(uiText('m97093e4d27ba'), uiText('m60ef53fa9bd8'), "error"));
        });
      } });
    } catch {
      if (isCurrentCommandOperation(operation)) replaceCommandView(infoView(uiText('mc87904e38258'), uiText('m2e5d2edfc42b'), "error"));
    }
  }, [dependencies, isCurrentCommandOperation, replaceCommandView, returnToChat, startCommandLoad]);

  const showMemory = useCallback(async (enterFromChat = true) => {
    const operation = startCommandLoad(
      uiText('medeae9cc8394'),
      uiText('m0b8a57645714'),
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
        uiText('m4c4767a2290e'),
        error instanceof Error ? error.message : String(error),
        "error",
      ));
    }
  }, [agent, dependencies, isCurrentCommandOperation, memoryPolicy, replaceCommandView, startCommandLoad, workspacePath]);

  const showMemoryPrompt = useCallback(async () => {
    const operation = startCommandLoad(
      uiText('md8fa10ae6778'),
      uiText('m9d7159068408'),
    );
    try {
      const snapshot = agent?.getMemorySnapshot?.();
      const text = snapshot
        ? uiText('m7061decf5008', {p0: snapshot.revision, p1: snapshot.loadedAt, p2: snapshot.text || uiText('m2b5501316f7b')})
        : dependencies.getMemoryPrompt
          ? await dependencies.getMemoryPrompt(workspacePath)
          : uiText('m02f9e2933d63');
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        uiText('md8fa10ae6778'),
        text || uiText('m21c42184b890'),
      ));
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        uiText('m59edbfa760ab'),
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
          uiText('ma0b1f3635165'),
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
    const sessionId = coordinator.sessionId;
    if (sessionId) void dependencies.sessionStore.setMemoryPolicy?.(sessionId, next).catch((error: unknown) => {
      appendTransient("error", uiText('m867143612558', {p0: error instanceof Error ? error.message : String(error)}));
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
          uiText('m2aafc055b558'),
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
          uiText('ma9cfbb692002'),
          error instanceof Error ? error.message : String(error),
          "error",
        ));
      }
    })();
  }, [dependencies, replaceCommandView, showMemory, workspacePath]);

  const rememberMemory = useCallback((text: string) => {
    if (!activeModel || !dependencies.rememberMemory) {
      openInfo(uiText('mb5cdfe71a027'), uiText('mb2754b3a5cf9'), "error");
      return;
    }
    const controller = new AbortController();
    const operation = startCommandLoad(uiText('m68be26ae1efd'), uiText('m85fd7ed9aae0'), true, true, () => {
      controller.abort();
      returnToChat();
    });
    void dependencies.rememberMemory(activeModel, workspacePath, text, controller.signal)
      .then(() => { if (isCurrentCommandOperation(operation) && !controller.signal.aborted) return showMemory(false); })
      .catch((error: unknown) => {
        if (!isCurrentCommandOperation(operation) || controller.signal.aborted) return;
        replaceCommandView(infoView(
          uiText('m7be662aefeab'),
          error instanceof Error ? error.message : String(error),
          "error",
        ));
      });
  }, [activeModel, dependencies, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, showMemory, startCommandLoad, workspacePath]);

  const openModelPicker = useCallback(async () => {
    const operation = startCommandLoad(
      uiText('md8e1d3abdb55'),
      uiText('m0cfe5e8b3e36'),
    );
    try {
      const resolved = await dependencies.registry.resolveAll();
      if (!isCurrentCommandOperation(operation)) return;
      if (resolved.available.length === 0) {
        replaceCommandView(infoView(
          uiText('md8e1d3abdb55'),
          uiText('md41f04a008d1'),
        ));
        return;
      }
      replaceCommandView({
        kind: "model-picker",
        title: uiText('m058220d40b4a'),
        models: resolved.available,
      });
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        uiText('m43f53417b72e'),
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
      uiText('m64cf305db8b5'),
      uiText('m60d658dbe1e4'),
    );
    try {
      const models = await dependencies.registry.listStatuses();
      if (!isCurrentCommandOperation(operation)) return;
      if (models.length === 0) {
        replaceCommandView(infoView(
          uiText('m64cf305db8b5'),
          uiText('mefc970475c5e'),
        ));
        return;
      }
      replaceCommandView({ kind: "logout", models });
    } catch (error) {
      if (!isCurrentCommandOperation(operation)) return;
      replaceCommandView(infoView(
        uiText('m5477dd064d57'),
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
          (replacementModel && !canReuseOpaqueProviderContext(loaded.summary.model.base_url, model.base_url) ||
            !resolveProviderCapabilities(model.base_url, model.model_name, model.responses_profile).encryptedReasoning) &&
          hasOpaqueProviderContext(loaded.context)
        ) {
          throw new Error(uiText('m1bcf0af0d680'));
        }
        const restoredWorkspace = await dependencies.changeWorkspace(
          loaded.summary.workspace_path,
        );
        changedWorkspace = restoredWorkspace !== previousWorkspace;
        const restoredSettings = defaultModelRequestSettings(
          resolveProviderCapabilities(model.base_url, model.model_name, model.responses_profile),
          replacementModel || model.responses_profile !== loaded.summary.model.responses_profile
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
        coordinator.replaceSession(loaded.summary.id);
        workflowRuntime.current = undefined;
        ensureWorkflow(loaded.workflow, restoredWorkspace);
        sessionTitlePending.current = loaded.summary.title_pending;
        forkResumePending.current = pendingForkResume;
        nextId.current = restoredTimeline.length;
        resumeGoalPending.current = !pendingForkResume && loaded.goal?.status === "active" && loaded.workflow?.phase !== "blocked";
        onReplayOutput(() => {
          setTimeline(restoredTimeline);
          setResumedInputHistory(undefined);
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
        uiText('mfe2ee5028847'),
        uiText('m1d70e0029cf2'),
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
            uiText('mfe2ee5028847'),
            uiText('mfe958bef9fde'),
            false,
            false,
          );
          await completeResume(loaded, originalModel, false);
        } else if (resolved.available.length > 0) {
          replaceCommandView({
            kind: "model-picker",
            title: uiText('me53e089bf5fc', {p0: loaded.summary.model.model_name}),
            models: resolved.available,
            resumeSession: loaded,
          });
        } else {
          replaceCommandView(infoView(
            uiText('m8d94f4cf7cd3'),
            uiText('m28d2d8520375'),
            "error",
          ));
        }
      } catch (error) {
        if (!isCurrentCommandOperation(operation)) return;
        replaceCommandView(infoView(
          uiText('m8d94f4cf7cd3'),
          uiText('m3905310128fc', {p0: error instanceof Error ? error.message : String(error)}),
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
      uiText('mfe2ee5028847'),
      uiText('m0b859f50a5c9'),
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
        uiText('m01d2c013f8cf'),
        uiText('madcbddea31b9', {p0: error instanceof Error ? error.message : String(error)}),
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
      if (teamConfig.enabled) { void dependencies.sessionStore.updateTitle(sessionId, fallbackSessionTitle(firstQuestion)).catch(() => undefined); return; }
      const titleController = new AbortController();
      titleControllers.current.add(titleController);
      void dependencies
        .generateSessionTitle(model, firstQuestion, titleController.signal)
        .then((title) => dependencies.sessionStore.updateTitle(sessionId, title))
        .catch(() => undefined)
        .finally(() => titleControllers.current.delete(titleController));
    },
    [dependencies, teamConfig.enabled],
  );

  const createNewSession = useCallback(async () => {
    if (!activeModel) {
      openInfo(
        uiText('ma0c53930b530'),
        uiText('m805ea5bb295f'),
        "error",
      );
      return;
    }

    clearQueuedGuidance();
    setBusyLabel(uiText('m1477ce4e3c37'));
    const message = uiText('m9b18f23cbe8d');
    try {
      const session = await dependencies.sessionStore.create({
        title: uiText('mfc0bb85f3867'),
        titlePending: true,
        workspacePath,
        model: toSessionModel(activeModel, requestSettings),
      });

      coordinator.replaceSession(session.id);
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
        uiText('m2a555b5e93c0'),
        uiText('mfbae80eb57f5', {p0: error instanceof Error ? error.message : String(error)}),
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
    coordinator.replaceSession(undefined);
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
      coordinator.activeTask ||
      directController.current ||
      confirmationRef.current ||
      terminalCommandRunning.current ||
      attachmentController.current
    ) {
      openInfo(
        uiText('m3dc905bb389a'),
        uiText('mdcff5ff640b3'),
        "error",
      );
      return;
    }
    const sourceSessionId = coordinator.sessionId;
    if (!sourceSessionId) {
      openInfo(
        uiText('ma33b5c335733'),
        uiText('mbec9e31c112f'),
        "error",
      );
      return;
    }
    if (!dependencies.sessionStore.fork) {
      openInfo(
        uiText('m7a3157774743'),
        uiText('me8ff70266048'),
        "error",
      );
      return;
    }

    const controller = new AbortController();
    directController.current = controller;
    const cancel = () => {
      controller.abort(new Error(uiText('mb053ddab14a3')));
      if (directController.current === controller) directController.current = undefined;
      returnToChat();
    };
    let operation = startCommandLoad(
      uiText('m8eb20c2a1a80'),
      uiText('ma264d9066b30'),
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
      if (!isCurrentCommandOperation(operation) || coordinator.sessionId !== sourceSessionId) return;
      const sourceModel = resolved.available.find(
        (candidate) =>
          candidate.id === source.summary.model.id ||
          (candidate.model_name === source.summary.model.model_name &&
            candidate.base_url === source.summary.model.base_url),
      );
      if (!sourceModel) {
        throw new Error(uiText('m3a34c0d87833', {p0: source.summary.model.model_name}));
      }

      const title = requestedTitle.trim();
      const child = await dependencies.sessionStore.fork(sourceSessionId, {
        ...(title ? { title } : {}),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!isCurrentCommandOperation(operation) || coordinator.sessionId !== sourceSessionId) return;
      const loaded = await dependencies.sessionStore.load(child.id);
      controller.signal.throwIfAborted();
      if (!isCurrentCommandOperation(operation) || coordinator.sessionId !== sourceSessionId) return;

      operation = startCommandLoad(
        uiText('m8eb20c2a1a80'),
        uiText('mff64277b0ad2'),
        false,
        false,
      );
      if (directController.current === controller) directController.current = undefined;
      await completeResume(loaded, sourceModel, false);
      if (!isCurrentCommandOperation(operation)) return;
      appendTransient("system", uiText('mf694aae288e6', {p0: child.title}));
    } catch (error) {
      if (controller.signal.aborted) {
        if (isCurrentCommandOperation(operation)) returnToChat();
        return;
      }
      if (isCurrentCommandOperation(operation)) {
        replaceCommandView(infoView(
          uiText('me2b412a6ecb6'),
          error instanceof Error ? error.message : String(error),
          "error",
        ));
      }
    } finally {
      if (directController.current === controller) directController.current = undefined;
    }
  }, [appendTransient, completeResume, dependencies.registry, dependencies.sessionStore, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, startCommandLoad]);

  const deleteSessions = useCallback(async (sessionIds: string[]): Promise<void> => {
    if (coordinator.activeTask || directController.current) {
      throw new Error(uiText('md5910ed75003'));
    }
    await dependencies.sessionStore.deleteMany(sessionIds);
    if (coordinator.sessionId && sessionIds.includes(coordinator.sessionId)) {
      clearConversation();
      returnToChat();
    }
  }, [clearConversation, dependencies.sessionStore, returnToChat]);

  const runtimeForGoal = useCallback((sessionId: string) => new GoalRuntime({
    getGoal: async () => coordinator.sessionId === sessionId
      ? activeGoalProjection.current
      : (await dependencies.sessionStore.load(sessionId)).goal,
    setGoal: async (goal) => {
      await dependencies.sessionStore.setGoal(sessionId, goal);
      if (coordinator.sessionId === sessionId) activeGoalProjection.current = goal;
      setActiveGoal(goal);
    },
  }), [dependencies.sessionStore]);

  const showGoalStatus = useCallback(async () => {
    const sessionId = coordinator.sessionId;
    const goal = sessionId ? (await dependencies.sessionStore.load(sessionId)).goal : undefined;
    activeGoalProjection.current = goal;
    setActiveGoal(goal);
    enterCommandView({ kind: "goal-status", ...(goal ? { goal } : {}) });
  }, [dependencies.sessionStore, enterCommandView]);

  const pauseGoal = useCallback(() => {
    const sessionId = coordinator.sessionId;
    if (!sessionId) { void showGoalStatus(); return; }
    void runtimeForGoal(sessionId).update("paused").then((goal) => {
      activeGoalProjection.current = goal;
      setActiveGoal(goal);
      returnToChat(() => appendTransient("system", uiText('m79e2d50db66c')));
    }).catch((error: unknown) => openInfo(uiText('m742b8e3895ad'), error instanceof Error ? error.message : String(error), "error"));
  }, [appendTransient, openInfo, returnToChat, runtimeForGoal, showGoalStatus]);

  const resumeGoal = useCallback(() => {
    const sessionId = coordinator.sessionId;
    if (!sessionId) { void showGoalStatus(); return; }
    void runtimeForGoal(sessionId).resume().then((goal) => {
      activeGoalProjection.current = goal;
      setActiveGoal(goal);
      returnToChat(() => appendTransient("system", uiText('ma8a9ed0fe1df')));
      setTimeout(() => void runChatRef.current?.("Continue working toward the active session goal. Call get_goal first, then proceed until the objective is verified complete.", true, "default"), 0);
    }).catch((error: unknown) => openInfo(uiText('mc13800578b5e'), error instanceof Error ? error.message : String(error), "error"));
  }, [appendTransient, openInfo, returnToChat, runtimeForGoal, showGoalStatus]);

  const createGoal = useCallback(async (objective: string, tokenBudget?: number) => {
    if (!activeModel) {
      openInfo(uiText('m90cf943c0eb7'), uiText('m805ea5bb295f'), "error");
      return;
    }
    let sessionId = coordinator.sessionId;
    if (!sessionId) {
      const session = await dependencies.sessionStore.create({ title: fallbackSessionTitle(objective), titlePending: false, workspacePath, model: toSessionModel(activeModel, requestSettings) });
      sessionId = session.id;
      coordinator.attachSession(sessionId);
      sessionTitlePending.current = false;
      startTitleGeneration(sessionId, activeModel, objective);
    }
    const goal = await runtimeForGoal(sessionId).create({ objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) });
    setAgentMode("default");
    returnToChat(() => appendTransient("system", uiText('m74480ce93fc5')));
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
        confirm: () => void createGoal(command.objective, command.tokenBudget).catch((error: unknown) => openInfo(uiText('mbce4be22a138'), error instanceof Error ? error.message : String(error), "error")),
        cancel: returnToChat,
      });
    } catch (error) {
      openInfo(uiText('m1c531d38036c'), error instanceof Error ? error.message : String(error), "error");
    }
  }, [createGoal, enterCommandView, openInfo, pauseGoal, resumeGoal, returnToChat, showGoalStatus]);

  const showStatus = useCallback(() => {
    const auxiliaryUsage = dependencies.getAuxiliaryUsage?.();
    const metadata = activeModel
      ? resolveModelStatusMetadata(activeModel.base_url, activeModel.model_name)
      : undefined;
    const capabilities = activeModel
      ? resolveProviderCapabilities(activeModel.base_url, activeModel.model_name, activeModel.responses_profile)
      : undefined;
    enterCommandView({
      kind: "status",
      snapshot: {
        version: dependencies.version,
        model_name: activeModel?.model_name ?? null,
        provider: metadata?.provider ?? "N/A",
        base_url: activeModel?.base_url ?? null,
        workspace_path: workspacePath,
        session_id: coordinator.sessionId ?? null,
        context_window: metadata?.context_window ?? null,
        context_tokens: activeModel ? sessionUsage.context_tokens : null,
        input_tokens: sessionUsage.input_tokens,
        output_tokens: sessionUsage.output_tokens,
        protocol: capabilities?.protocol ?? "responses",
        ...(capabilities ? { compaction: capabilities.compaction } : {}),
        reasoning_effort: requestSettings.reasoningEffort,
        ...(capabilities ? { responses_profile: capabilities.responsesProfile ?? "generic", capability_source: capabilities.source, reasoning_sent: requestReasoningEffort(capabilities, requestSettings.reasoningEffort) ?? uiText('mcd5f943d5863') } : {}),
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
        configuration_status: activeModel ? uiText('mb747c510125e') : uiText('mb236c2397c15'),
        workflow_status: workflowRuntime.current?.state.result ?? uiText('mbfe1f62ec901'),
        ...(agent?.getTeamSnapshot?.() ? { team_state: agent.getTeamSnapshot!()!.state, team_tokens: agent.getTeamSnapshot!()!.usage.inputTokens + agent.getTeamSnapshot!()!.usage.outputTokens, team_usage_complete: agent.getTeamSnapshot!()!.usage.complete } : {}),
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

  const setResponsesProfile = useCallback(async (args: string) => {
    const profile = args.trim().toLowerCase();
    if (!isResponsesProfile(profile)) {
      openInfo(uiText('m745ebe40f3ee'), uiText('mcc6a3f6c1376'), "error");
      return;
    }
    if (coordinator.activeTask || directController.current) {
      openInfo(uiText('m78ac945f1362'), uiText('m71a66875fa9b'), "error");
      return;
    }
    if (!activeModel || !dependencies.registry.setResponsesProfile) {
      openInfo(uiText('m86c05fa99b2a'), uiText('mfc4d16ff076b'), "error");
      return;
    }
    const operation = startCommandLoad(uiText('m0f3721048c69'), uiText('m3490975ad746'));
    try {
      const sessionId = coordinator.sessionId;
      const loaded = sessionId ? await dependencies.sessionStore.load(sessionId) : undefined;
      const capabilities = resolveProviderCapabilities(activeModel.base_url, activeModel.model_name, profile);
      if (loaded && hasOpaqueProviderContext(loaded.context) && !capabilities.encryptedReasoning) {
        throw new Error(uiText('m190780410fca'));
      }
      if (!isCurrentCommandOperation(operation) || coordinator.activeTask) return;
      const saved = await dependencies.registry.setResponsesProfile(activeModel, profile);
      if (!isCurrentCommandOperation(operation)) return;
      // A profile changes the request protocol, so the previous Agent is disposed
      // and rebuilt from the same Session context by the normal model lifecycle.
      const nextModel = { ...activeModel, responses_profile: saved.responses_profile ?? profile };
      delete nextModel.request_settings;
      if (!isCurrentCommandOperation(operation) || coordinator.activeTask) return;
      if (sessionId) await dependencies.sessionStore.selectModel(sessionId, toSessionModel(nextModel, settingsForModel(nextModel)), true);
      if (!isCurrentCommandOperation(operation) || coordinator.activeTask) return;
      coordinator.invalidatePlan();
      setSessionContext(loaded?.context.map((item) => ({ ...item })) ?? []);
      setSessionUsage((current) => resetContextUsage(current, true));
      setActiveModel(nextModel);
      setRequestSettings(settingsForModel(nextModel));
      setSessionEpoch((epoch) => epoch + 1);
      replaceCommandView(infoView(uiText('m0f3721048c69'), uiText('mec6ea58d14de', {p0: profile})));
    } catch (error) {
      if (isCurrentCommandOperation(operation)) replaceCommandView(infoView(uiText('m5be10207f4c9'), error instanceof Error ? error.message : String(error), "error"));
    }
  }, [activeModel, dependencies.registry, dependencies.sessionStore, startCommandLoad, isCurrentCommandOperation, replaceCommandView, openInfo]);

  const setReasoning = useCallback((args: string) => {
    const effort = args.trim().toLowerCase();
    if (!isReasoningEffort(effort)) {
      openInfo(uiText('m1b3ee45108b1'), uiText('m8e4a1b1f3da9'), "error");
      return;
    }
    if (coordinator.activeTask || directController.current) {
      openInfo(uiText('md06db0a59f74'), uiText('mde800a4ee518'), "error");
      return;
    }
    if (!activeModel || !agent) {
      openInfo(uiText('m589b35213c11'), uiText('m7905157c2902'), "error");
      return;
    }
    if (!resolveProviderCapabilities(activeModel.base_url, activeModel.model_name, activeModel.responses_profile).reasoningEffort) {
      openInfo(uiText('me6f4fe4e98e0'), uiText('m709b87200ba3'), "error");
      return;
    }
    const next = { ...requestSettings, reasoningEffort: effort };
    agent.setRequestSettings?.(next);
    setRequestSettings(next);
    const sessionId = coordinator.sessionId;
    if (sessionId) {
      void dependencies.sessionStore.selectModel(sessionId, toSessionModel(activeModel, next), true)
        .catch((error: unknown) => appendTransient("error", uiText('ma8a058288481', {p0: error instanceof Error ? error.message : String(error)})));
    }
    openInfo(uiText('m566e19959205'), uiText('m190922f2b9d5', {p0: effort}));
  }, [activeModel, agent, appendTransient, dependencies.sessionStore, openInfo, requestSettings]);

  const runDoctor = useCallback((args: string) => {
    const normalized = args.trim().toLowerCase();
    if (normalized && normalized !== "--live") {
      openInfo(uiText('m766a5aa67c78'), uiText('m22682217d459'), "error");
      return;
    }
    if (!dependencies.doctor) {
      openInfo(uiText('m284c569e2319'), uiText('md56ae237d62f'), "error");
      return;
    }
    const execute = () => {
      const controller = new AbortController();
      const operation = startCommandLoad(
        uiText('m8c3f2a6c8801'),
      normalized === "--live" ? uiText('m78a17fd2cc64') : uiText('m972827cbfbcd'),
      true,
      normalized === "--live",
      () => {
        controller.abort();
        returnToChat();
      },
    );
      void dependencies.doctor!(activeModel, permissions.current, normalized === "--live", controller.signal)
      .then((result) => {
        if (!isCurrentCommandOperation(operation)) return;
        replaceCommandView(infoView(uiText('m8c3f2a6c8801'), result));
      })
      .catch((error: unknown) => {
        if (!isCurrentCommandOperation(operation) || controller.signal.aborted) return;
        replaceCommandView(infoView(uiText('meabc1e196ed0'), modelErrorGuidance(error), "error"));
      });
    };
    if (normalized === "--live") {
      if (!activeModel) { openInfo(uiText('mc64e9b985def'), uiText('mbd21cd1504ef'), "error"); return; }
      enterCommandView({ kind: "action-confirm", text: uiText('m44f7bf66b899', {p0: activeModel.model_name, p1: diagnosticEndpoint(activeModel)}), start: execute, cancel: returnToChat });
    } else execute();
  }, [activeModel, dependencies, enterCommandView, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, startCommandLoad]);

  const runCompact = useCallback((args: string) => {
    if (args.trim()) {
      openInfo(uiText('m6077c3782e44'), uiText('maee6205f363b'), "error");
      return;
    }
    if (coordinator.activeTask || directController.current) {
      openInfo(uiText('m6e18d9f31956'), uiText('mf12e6bcde17d'), "error");
      return;
    }
    if (!activeModel) {
      openInfo(uiText('m79a2bccd17fd'), uiText('m805ea5bb295f'), "error");
      return;
    }
    if (!coordinator.sessionId) {
      openInfo(uiText('mb3d1832586c8'), uiText('m700477b1d77e'), "error");
      return;
    }
    if (!agent?.compact) {
      openInfo(uiText('m767233e3c869'), uiText('m30bd58904532'), "error");
      return;
    }
    const controller = new AbortController();
    const operation = startCommandLoad(
      uiText('m47b06c6c10b9'),
      uiText('m67afcd229f27'),
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
        returnToChat(() => appendTransient("system", uiText('m60af6f33a617')));
      })
      .catch((error: unknown) => {
        if (!isCurrentCommandOperation(operation) || controller.signal.aborted) return;
        replaceCommandView(infoView(
          uiText('m4c5a0b05dff2'),
          error instanceof LoopStoppedError && error.reason === "usage_limited"
            ? uiText('m678d6621f843')
            : error instanceof LoopStoppedError && error.reason === "budget_limited"
              ? uiText('mea83419c4871')
              : error instanceof Error ? error.message : String(error),
          "error",
        ));
      });
  }, [activeModel, agent, appendTransient, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, startCommandLoad]);

  const reviewMcpIsolation = useCallback(async (name: string, mode: 'sandbox' | 'host') => {
    if (!dependencies.previewMcpIsolation || !dependencies.setMcpIsolation) return;
    const preview = await dependencies.previewMcpIsolation(name, mode);
    enterCommandView({ kind: 'action-confirm', text: preview.summary + '\n' + uiText('security.mcpModeHelp'), startLabel: uiText('security.mcpModeConfirm'), cancel: returnToChat,
      start: () => { void dependencies.setMcpIsolation!(name, mode).then(() => openInfo('/mcp', uiText('security.mcpModeSaved'))).catch(error => openInfo('/mcp', error instanceof Error ? error.message : String(error), 'error')); },
    });
  }, [dependencies, enterCommandView, returnToChat, openInfo]);

  const runChat = useCallback(
    async (
      text: string,
      timelineRecorded = false,
      mode: AgentMode = coordinator.mode,
      taskSource: WorkflowTaskSource = "user",
      attachments: readonly FileAttachment[] = [],
      executeApprovedPlan = false,
      inputHistoryText?: string,
    ) => {
      await permissionsReady.current;
      if (directController.current) return;
      if (dependencies.privacy && (await dependencies.privacy.settings.read()).configured === false) {
        const preview = await dependencies.privacy.preview(30, false);
        const result = await requestUserInput({ questions: [{ id: 'session_retention', header: uiText('privacy.retentionHeader'), question: uiText('privacy.retentionChoice', { p0: preview.candidates.length, p1: preview.excluded.length }), options: [
          { label: uiText('privacy.days30'), description: uiText('privacy.days30Help') },
          { label: uiText('privacy.days7'), description: uiText('privacy.days7Help') },
          { label: uiText('privacy.forever'), description: uiText('privacy.foreverHelp') },
        ] }] });
        if (result.__cancelled) return;
        const chosen = result.session_retention;
        const days = chosen === uiText('privacy.days30') ? 30 : chosen === uiText('privacy.days7') ? 7 : chosen === uiText('privacy.forever') ? null : Number(chosen);
        const selected = await dependencies.privacy.preview(days);
        const review = await requestUserInput({ questions: [{ id: 'retention_review', header: uiText('privacy.retentionHeader'), question: uiText('privacy.retentionReview', { p0: days ?? uiText('privacy.forever'), p1: selected.candidates.length, p2: selected.excluded.length }), options: [
          { label: uiText('privacy.savePolicy'), description: uiText('privacy.savePolicyHelp') },
          { label: uiText('security.reject'), description: uiText('privacy.keepExisting') },
        ] }] });
        if (review.__cancelled || review.retention_review !== uiText('privacy.savePolicy')) return;
        await dependencies.privacy.configure(selected.token);
      }
      if (!agent || !activeModel) {
        append("error", uiText('m805ea5bb295f'));
        return;
      }
      const admission = coordinator.beginTask(agent, mode, executeApprovedPlan);
      if (admission.status !== "started") {
        if (admission.status === "no_approved_plan") {
          appendTransient("system", uiText('ma0963593147f'));
        }
        return;
      }
      const task = admission.task;
      setWorkflowProjection(undefined);
      setLastTaskStartedAt(Date.now());setTaskFinishedAt(undefined);setTaskOutcome(undefined);setTaskFailure(undefined);
      if (admission.approvedPlan) {
        const approved = admission.approvedPlan;
        text = `Implement the following plan, which the user approved and explicitly started with /plan execute. Inspect current files and project rules before editing, respect current permissions, and verify the result.\n\nTitle: ${approved.title}\n\n${approved.plan}`;
        setAgentMode("default");
      }

      if (coordinator.sessionId === undefined) {
        setBusyLabel(uiText('m1739d06cf79b'));
        try {
          const session = await dependencies.sessionStore.create({
            title: fallbackSessionTitle(text),
            titlePending: false,
            workspacePath,
            model: toSessionModel(activeModel, requestSettings),
          });
          if (!coordinator.matchesTaskContext(task)) {
            coordinator.finishTask(task);
            setBusyLabel(undefined);
            returnQueuedGuidanceToDraft();
            return;
          }
          coordinator.attachSession(session.id);
          sessionTitlePending.current = false;
          startTitleGeneration(session.id, activeModel, text);
        } catch (error) {
          if (coordinator.matchesTaskContext(task)) {
            setTaskOutcome('failed');setTaskFinishedAt(Date.now());
            append("error", uiText('mfbae80eb57f5', {p0: error instanceof Error ? error.message : String(error)}));
            clearQueuedGuidance();
          }
          setBusyLabel(undefined);
          coordinator.finishTask(task);
          return;
        }
      } else if (sessionTitlePending.current) {
        setBusyLabel(uiText('mf0e757983637'));
        const sessionId = coordinator.sessionId;
        try {
          await dependencies.sessionStore.updateTitle(
            sessionId,
            fallbackSessionTitle(text),
          );
          if (!coordinator.matchesTaskContext(task)) {
            coordinator.finishTask(task);
            setBusyLabel(undefined);
            returnQueuedGuidanceToDraft();
            return;
          }
          sessionTitlePending.current = false;
          startTitleGeneration(sessionId, activeModel, text);
        } catch (error) {
          if (coordinator.matchesTaskContext(task)) {
            append("error", uiText('md6f9dfa004a3', {p0: error instanceof Error ? error.message : String(error)}));
            clearQueuedGuidance();
          }
          setBusyLabel(undefined);
          coordinator.finishTask(task);
          return;
        }
      }

      if (inputHistoryText !== undefined && coordinator.sessionId) {
        await dependencies.inputHistory?.append(inputHistoryText, { sessionId: coordinator.sessionId }).catch(() => appendTransient('error', uiText('m807d2bac6f8f')));
      }
      if (!timelineRecorded) append("user", text);
      const metadata = resolveModelStatusMetadata(activeModel.base_url, activeModel.model_name);
      const waitingTarget = metadata.provider === "OpenAI-compatible"
        ? activeModel.model_name
        : metadata.provider;
      setAgentPhase("sampling");
      setTurnStartedAt(Date.now());
      setBusyLabel(uiText('mba82609db10b', {p0: waitingTarget}));
      clearLiveAssistant();
      setLiveToolStatus(undefined);
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
              const sessionId = coordinator.sessionId;
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
          signal: task.signal,
          ...(attachments.length === 0 ? {} : { attachments }),
        });
        task.signal.throwIfAborted();
        if (!coordinator.matchesTaskContext(task)) return;
        setTaskFailure(result.agentResult.stopReason?'limit':undefined);
        setTaskOutcome(result.agentResult.stopReason?'failed':result.disposition==='plan_cancelled'?'cancelled':result.disposition==='plan_approved'||result.workflowResult?.state.result==='verified'||result.workflowResult?.state.result==='no_changes'?'success':'failed');
        const forkResumeSettled =
          mode === "default" &&
          forkResumePending.current &&
          result.disposition === "completed" &&
          (result.workflowResult?.state.result === "verified" ||
            result.workflowResult?.state.result === "no_changes");
        if (forkResumeSettled) {
          const sessionId = coordinator.sessionId;
          if (!sessionId || !dependencies.sessionStore.setForkPendingResume) {
            throw new Error(uiText('m407537777597'));
          }
          await dependencies.sessionStore.setForkPendingResume(sessionId, false);
          if (coordinator.sessionId === sessionId) forkResumePending.current = false;
        }
        if (result.disposition === "plan_approved") {
          if (!result.agentResult.approvedPlan || !result.agentResult.approvedPlanTitle) {
            throw new Error(uiText('m265de9ce82c6'));
          }
          if (coordinator.approvePlan(task, { title: result.agentResult.approvedPlanTitle, plan: result.agentResult.approvedPlan })) {
            setAgentMode("plan");
            appendTransient("system", uiText('m47862783953e'));
          }
        } else if (result.disposition === "plan_cancelled") {
          setAgentMode("default");
          appendTransient("system", uiText('mca789d6817de'));
        }
      } catch (error) {
        await agent.finalizePendingGoalCompletion?.(false).catch(() => undefined);
        await agent.finishMemoryTurn?.(task.signal.aborted ? "cancelled" : "failed").catch(() => undefined);
        // Cleanup debt belongs to the process owner, even after navigation has
        // invalidated the old task's permission to publish conversation output.
        if(error instanceof ResourceCleanupError){coordinator.markCleanupFailed(task);setCleanupFailed(true);setTaskOutcome('cleanup_failed');setBusyLabel(uiText('task.cleanupFailed'));if(coordinator.matchesTaskContext(task))append('error',uiText('task.cleanupFailed'));return;}
        if (!coordinator.matchesTaskContext(task)) return;
        if (task.signal.aborted) {
          setTaskOutcome('cancelled');
          const sessionId = coordinator.sessionId;
          if (mode === "default" && sessionId) {
            const goal = activeGoalProjection.current;
            if (goal?.status === "active") {
              const paused = { ...goal, status: "paused" as const, updated_at: new Date().toISOString() };
              await dependencies.sessionStore.setGoal(sessionId, paused).catch(() => undefined);
              activeGoalProjection.current = paused;
              setActiveGoal(paused);
            }
          }
          append("system", uiText('m4670e6f4fb99'));
        } else {
          setTaskOutcome('failed');setTaskFailure(error instanceof PersistenceError?'persistence':'runtime');
          append("error", uiText('m47d42e68fd0d', {p0: modelErrorGuidance(error)}));
        }
      } finally {
        const matchesContext = coordinator.matchesTaskContext(task);
        if(matchesContext)setTaskFinishedAt(Date.now());
        const ownsTask = coordinator.finishTask(task);
        // oxlint-disable-next-line no-unsafe-finally -- A task that lost ownership must not update the active conversation.
        if (!ownsTask) return;
        setBusyLabel(undefined);
        setAgentPhase(undefined);
        setTurnStartedAt(undefined);
        setReasoningStartedAt(undefined);
        clearLiveAssistant();
        setLiveToolStatus(undefined);
        if (task.signal.aborted && queuedGuidance.current.length === 0) {
          setQueuedGuidanceCount(0);
        }
        if (!matchesContext || mode === "plan") {
          returnQueuedGuidanceToDraft();
          // oxlint-disable-next-line no-unsafe-finally -- Guidance from a replaced context or a plan must not start another coding turn.
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
    },
    [activeModel, agent, agentMode, append, appendTransient, clearLiveAssistant, clearQueuedGuidance, dependencies, ensureWorkflow, executeVerification, requestSettings, returnQueuedGuidanceToDraft, startTitleGeneration, workspacePath],
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
      if (coordinator.activeTask || directController.current) return;
      if (!command) {
        append("error", uiText('mb707ac43cd2c'));
        return;
      }
directController.current = new AbortController();setLastTaskStartedAt(Date.now());setTaskFinishedAt(undefined);setTaskOutcome(undefined);setTaskFailure(undefined);
      setTerminalOutput(undefined);
      setTerminalBusy(true);
      let retainedCleanupDebt=false;
      try {
        const result=await executeTerminalCommand(command, setTerminalOutput);
        setTaskOutcome(result.cancelled||directController.current.signal.aborted?'cancelled':result.error||result.exitCode!==0?'failed':'success');
      } catch (error) {
        if(error instanceof ResourceCleanupError){retainedCleanupDebt=true;setCleanupFailed(true);setTaskOutcome('cleanup_failed');}else setTaskOutcome(directController.current?.signal.aborted?'cancelled':'failed');
        append("error", error instanceof Error ? error.message : String(error));
      } finally {
        setTaskFinishedAt(Date.now());
        if(!retainedCleanupDebt)directController.current = undefined;
        setTerminalOutput(undefined);
        setTerminalBusy(false);
      }
    },
    [append, executeTerminalCommand],
  );

  const queueGuidance = useCallback((text: string, attachments: readonly FileAttachment[] = []) => {
    const timelineRecorded = coordinator.sessionId !== undefined;
    if (timelineRecorded) append("user", text);
    if (confirmationRef.current) finishConfirmation(false);
    if (agentMode !== "plan" && agent?.requestSteering?.(text, attachments)) {
      setQueuedGuidanceCount((current) => current + 1);
      setLiveToolStatus(uiText('m3382f0c7f9bf'));
      return;
    }
    queuedGuidance.current.push({ text, timelineRecorded, attachments });
    setQueuedGuidanceCount(queuedGuidance.current.length);
  }, [agent, agentMode, append, finishConfirmation]);

  const showWorkspaceDiff = useCallback(async () => {
    const operation = startCommandLoad(uiText('m1f88c1f77c26'), uiText('m0e2e22ca18e8'));
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
        uiText('mc20ec6668165'),
        error instanceof Error ? error.message : String(error),
        "error",
      ));
    }
  }, [isCurrentCommandOperation, replaceCommandView, startCommandLoad, workspacePath]);

  const runManualVerification = useCallback(async (requested: string) => {
    await permissionsReady.current;
    if (coordinator.activeTask || directController.current) {
      openInfo(uiText('m611ee54e10ad'), uiText('m73804da3c881'), "error");
      return;
    }
    const controller = new AbortController();
    directController.current = controller;
    const cancel = () => {
      controller.abort();
      if (directController.current === controller) directController.current = undefined;
      returnToChat();
    };
    const operation = startCommandLoad(uiText('m7736fef88d36'), uiText('m388d25d7c04d'), true, true, cancel);
    try {
      if (requested.trim().startsWith('--package')) {
        const relative = requested.trim().slice('--package'.length).trim();
        if (!relative) throw new Error(uiText('reliability.packageUsage'));
        const revision = permissionPolicyRevision(permissions.current);
        const result = await ensureWorkflow().runPackageVerification(relative, async (command, cwd, signal, timeoutMs) => {
          if (permissionPolicyRevision(permissions.current) !== revision || commandPermission(command, permissions.current) === 'deny') throw new Error(uiText('m0fbbd0957e31'));
          const result = await dependencies.runBash(command, permissions.current, signal, undefined, timeoutMs, cwd);
          if (permissionPolicyRevision(permissions.current) !== revision) throw new Error(uiText('m0fbbd0957e31'));
          return result;
        }, controller.signal);
        if (isCurrentCommandOperation(operation)) replaceCommandView(infoView(uiText('m9765081cd0f3'), JSON.stringify(result, null, 2), result.status === 'passed' ? 'default' : 'error'));
        return;
      }
      const commands = await discoverVerificationCommands(workspacePath);
      controller.signal.throwIfAborted();
      if (!isCurrentCommandOperation(operation)) return;
      const supplemental = requested.trim().length > 0;
      const selected = supplemental
        ? [{ id: "manual", label: uiText('mb1b737731381'), command: requested.trim(), tier: "full" as const, timeoutMs: 120_000 }]
        : selectVerificationCommands(commands, "full");
      if (selected.length === 0) {
        replaceCommandView(infoView(uiText('m3c00ab2235c2'), uiText('mf866a9e5696a')));
        return;
      }
      replaceCommandView({ kind: "loading", title: uiText('m4a2a26c52759'), label: selected.map((command) => command.command).join(" · "), cancellable: true, onCancel: cancel });
      const verificationPermissionRevision = permissionPolicyRevision(permissions.current);
      const result = await ensureWorkflow().runManualVerification(
        selected,
        async (value, signal, timeoutMs) => {
          if (permissionPolicyRevision(permissions.current) !== verificationPermissionRevision) {
            return { stdout: "", stderr: "", exitCode: null, signal: null, error: uiText('m0fbbd0957e31') };
          }
          const executed = await executeVerification(value, signal, timeoutMs, true);
          return permissionPolicyRevision(permissions.current) === verificationPermissionRevision
            ? executed
            : { ...executed, exitCode: null, error: uiText('m0fbbd0957e31') };
        },
        { supplemental, signal: controller.signal },
      );
      if (isCurrentCommandOperation(operation)) {
        const note = supplemental ? uiText('m25a96f873082') : "";
        replaceCommandView(infoView(uiText('m9765081cd0f3'), `${JSON.stringify(result, null, 2)}${note}`, result.status === "passed" ? "default" : "error"));
      }
    } catch (error) {
      if (!controller.signal.aborted && isCurrentCommandOperation(operation)) replaceCommandView(infoView(uiText('mf8e281a207d6'), error instanceof Error ? error.message : String(error), "error"));
    } finally {
      if (directController.current === controller) directController.current = undefined;
    }
  }, [executeVerification, ensureWorkflow, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, startCommandLoad, workspacePath]);

  const undoWorkflow = useCallback(async () => {
    if (coordinator.activeTask || directController.current) {
      appendTransient("system", uiText('md275364bd803'));
      return;
    }
    const result = await ensureWorkflow().undo();
    appendTransient("system", result.status === "undone"
      ? uiText('m2a7df3f8adb8', {p0: result.restored.join(", ") || "none"})
      : result.status === "conflict"
        ? uiText('m029548ed6950', {p0: result.conflicts.join(", ")})
        : result.status === "empty"
          ? uiText('m99f3c84c264d')
          : uiText('m5a15583ebb95'));
  }, [appendTransient, ensureWorkflow]);

  const runPrivacy = useCallback(async (args: string) => {
    const privacy = dependencies.privacy;
    if (!privacy) { openInfo(uiText('m02c093d511ba'), uiText('m455206f15f1e'), "error"); return; }
    if (coordinator.activeTask || directController.current) { openInfo(uiText('m7ed5f4885f81'), uiText('m73804da3c881')); return; }
    const operation = startCommandLoad(uiText('m4d871c057078'), uiText('m9ae6f80c1dd1'), true, false);
    try {
      const [action, ...rest] = args.trim().split(/\s+/u);
      const current = () => isCurrentCommandOperation(operation);
      const confirm = (text: string, work: () => Promise<unknown>) => {
        if (!current()) return;
        enterCommandView({ kind: "action-confirm", text, startLabel: uiText('md4d8b7dcb91d'), cancel: returnToChat, start: () => {
          const pending = startCommandLoad(uiText('mda72440a5095'), uiText('mdea9dad0fb18'), true, false);
          void work().then((result) => { if (isCurrentCommandOperation(pending)) replaceCommandView(infoView(uiText('m86b31a7fd46f'), typeof result === "string" ? result : JSON.stringify(result ?? { saved: true }))); }).catch(() => { if (isCurrentCommandOperation(pending)) replaceCommandView(infoView(uiText('m1d7c1e9d18d7'), uiText('m33cefab96588'), "error")); });
        } });
      };
      if (action === "retention") {
        const days = rest[0] === "forever" ? null : Number(rest[0]);
        const preview = await privacy.preview(days);
        confirm(uiText('mdb23ca779c32', {p0: days === null ? "forever" : days + uiText('mb1c503166f16'), p1: preview.candidates.length, p2: preview.candidates.reduce((n, c) => n + c.bytes, 0), p3: preview.excluded.length, p4: preview.invalidRecords, p5: [...new Set(preview.excluded.map((e) => e.reason))].join(", ")}), () => privacy.configure(preview.token));
      } else if (action === "cleanup") {
        const settings = await privacy.settings.read(); const preview = await privacy.preview(settings.retentionDays);
        confirm(uiText('ma2ccf99bc129', {p0: preview.candidates.length, p1: preview.excluded.length, p2: preview.invalidRecords}), () => privacy.cleanup(preview.token));
      } else if (action === "scan") {
        if (!coordinator.sessionId) throw new Error(uiText('mdbaeb8bee86e'));
        const report = await privacy.scan(coordinator.sessionId); if (current()) replaceCommandView(infoView(uiText('m4dc5cb068fcd'), JSON.stringify(report, null, 2) + uiText('m06f2ef137f56')));
      } else if (action === "export" || action === "export-conversation") {
        const sessionId = coordinator.sessionId; if (!sessionId || !rest.length) throw new Error(uiText('m4a69d7e35eee'));
        const target = rest.join(" ");
        const scan = await privacy.scan(sessionId);
        const conversation = action === "export-conversation" ? await privacy.previewExport(sessionId) : undefined;
        const preview = conversation?.text ?? uiText('mbe1fdad321db');
        const { redactSecretsPreservingLayout } = await import("../../util/redact-secrets.js");
        confirm(uiText('m32c1f2a64f2b', {p0: action === "export" ? uiText('m104d9a10da6e') : uiText('mb0466dcf5e30'), p1: scan.findings, p2: redactSecretsPreservingLayout(preview)}), () => privacy.export(sessionId, target, action === "export-conversation", conversation?.fingerprint));
      } else {
        const text = localizeHostReport(await privacy.describe()); if (current()) replaceCommandView(infoView(uiText('m4d871c057078'), text + uiText('m12dd24867346')));
      }
    } catch { if (isCurrentCommandOperation(operation)) replaceCommandView(infoView(uiText('m1d7c1e9d18d7'), uiText('mfb94068f0874'), "error")); }
  }, [dependencies, enterCommandView, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, startCommandLoad]);

  const runMemoryReview = useCallback(async (args: string) => {
    if (coordinator.activeTask || directController.current) { openInfo(uiText('m95a62c02a35f'), uiText('m73804da3c881')); return; }
    const operation = startCommandLoad(uiText('m608fe03ea871'), uiText('mb24d46af2ef5'), true, false);
    try {
      const [action, scope, id, ...rest] = args.split(/\s+/u);
      const status = await dependencies.getMemoryStatus?.(workspacePath); const entries = status?.entries ?? status?.recent ?? [];
      const { memoryEntryRevision, memoryEntryExpired } = await import("../../memory/learned-memory.js");
      if (!isCurrentCommandOperation(operation)) return;
      if (action === "list") { replaceCommandView(infoView(uiText('m97d5b7cda343'), entries.map((e) => `${e.scope}#${e.id} · ${e.status}${memoryEntryExpired(e) ? uiText('me2c18e1ca315') : ""}\n${e.lesson}`).join("\n\n") || uiText('mfeed98ce586a'))); return; }
      const entry = entries.find((e) => e.scope === scope && e.id === id); if (!entry) throw new Error(uiText('mf36668ddf224'));
      const revision = memoryEntryRevision(entry);
      const sources = await Promise.all((entry.sourceSessionIds ?? (entry.sourceSessionId ? [entry.sourceSessionId] : [])).map(async (source) => {
        try { await dependencies.sessionStore.load(source); return uiText('ma8d2e9b6f76d', {p0: source}); } catch { return uiText('me2cff71a5b6c', {p0: source}); }
      }));
      if (!isCurrentCommandOperation(operation)) return;
      const detail = uiText('mcd36c152b3a5', {p0: entry.scope, p1: entry.id, p2: entry.lesson, p3: entry.applyWhen, p4: entry.confidence, p5: entry.createdAt, p6: entry.expiresAt ?? uiText('m1d5a0712256b'), p7: entry.status, p8: memoryEntryExpired(entry) ? uiText('mc66bcf3ff4f9') : "", p9: sources.join(", ") || "unknown", p10: revision});
      if (action === "inspect") { replaceCommandView(infoView(uiText('md7e68f3c0338'), detail + uiText('m30bba58c7424'))); return; }
      if (!["renew", "disable", "delete", "correct"].includes(action!) || !dependencies.reviewMemory) throw new Error(uiText('mbeeb7fd0a49e'));
      const reviewAction = action as "renew" | "disable" | "delete" | "correct";
      let correction: { lesson: string; applyWhen: string } | undefined;
      if (action === "correct") { const value: unknown = JSON.parse(rest.join(" ")); if (!value || typeof value !== "object" || !("lesson" in value) || !("applyWhen" in value) || typeof value.lesson !== "string" || typeof value.applyWhen !== "string") throw new Error(uiText('m38289a9f594a')); correction = { lesson: value.lesson, applyWhen: value.applyWhen }; }
      enterCommandView({ kind: "action-confirm", text: uiText('mce5ea24c50bf', {p0: detail, p1: action, p2: correction ? "\n" + JSON.stringify(correction) : ""}), startLabel: uiText('mb804c4e8f298'), cancel: returnToChat, start: () => {
        const pending = startCommandLoad(uiText('m695198e89c8a'), uiText('mf9f89c8e9e48'), true, false);
        void dependencies.reviewMemory!(entry.scope, workspacePath, entry.id, revision, reviewAction, correction).then(() => { if (isCurrentCommandOperation(pending)) replaceCommandView(infoView(uiText('mf5b5cf06a801'), uiText('m8bac2573dd14'))); }).catch(() => { if (isCurrentCommandOperation(pending)) replaceCommandView(infoView(uiText('me67da28946d9'), uiText('mb453ac09a92c'), "error")); });
      } });
    } catch { if (isCurrentCommandOperation(operation)) replaceCommandView(infoView(uiText('ma53f17ee7d93'), uiText('mb4472347ff79'), "error")); }
  }, [dependencies, enterCommandView, isCurrentCommandOperation, openInfo, replaceCommandView, returnToChat, startCommandLoad, workspacePath]);

  const handleSubmit = useCallback(
    (input: string): boolean | Promise<boolean> => {
      const parsed = parseTuiInput(input);
      if (parsed.kind === "empty") return false;
      const sensitivePayload = parsed.kind === 'chat' ? parsed.text : parsed.kind === 'slash' && parsed.command === '/plan' ? parsed.args ?? '' : '';
      if (sensitiveText(sensitivePayload) && !sensitiveInputGrants.current.has(sensitiveDigest(sensitivePayload))) {
        return (async () => {
          const revision = permissionPolicyRevision(permissions.current);
          const result = await requestUserInput({ questions: [{ id: 'sensitive_input', header: uiText('security.sensitive'), question: uiText('security.originalHelp'), options: [uiText('security.mask'), uiText('security.original'), uiText('security.reject')].map(label => ({ label, description: label })) }] });
          if (revision !== permissionPolicyRevision(permissions.current) || result.__cancelled || result.sensitive_input === uiText('security.reject')) return false;
          if (result.sensitive_input === uiText('security.original')) sensitiveInputGrants.current.set(sensitiveDigest(sensitivePayload), revision);
          else { const { redactSecretsPreservingLayout } = await import('../../util/redact-secrets.js'); input = redactSecretsPreservingLayout(input); }
          skipInputHistory.current = true;
          return handleSubmit(input);
        })();
      }
      if (parsed.kind === 'slash' && parsed.command === '/history' && parsed.args === 'no-save') {
        skipInputHistory.current = true; appendTransient('system', uiText('privacy.noHistory')); return true;
      }
      if (parsed.kind === 'slash' && parsed.command === '/history' && parsed.args === 'clear') {
        return (async () => { await dependencies.inputHistory?.clear(); setInputHistory([]); setResumedInputHistory([]); return true; })();
      }
      const submitResolved = (attachments: readonly FileAttachment[]): boolean => {
        const saveHistory = !skipInputHistory.current && !sensitiveText(input);
        const historyInTask = parsed.kind === 'chat' && !coordinator.activeTask || parsed.kind === 'slash' && parsed.command === '/plan' && !!parsed.args && !['execute', 'exit'].includes(parsed.args);
        if (saveHistory) {
        setInputHistory((current) => current.at(-1) === input ? current : [...current, input].slice(-1000));
        setResumedInputHistory((current) => current === undefined ? undefined : current.at(-1) === input ? current : [...current, input].slice(-1000));
        if (!historyInTask) void dependencies.inputHistory?.append(input, coordinator.sessionId ? { sessionId: coordinator.sessionId } : {}).catch(() => appendTransient("error", uiText('m807d2bac6f8f')));
        }
        skipInputHistory.current = false;

        if (parsed.kind === "chat") {
          if (coordinator.activeTask) queueGuidance(parsed.text, attachments);
          else void runChat(parsed.text, false, agentMode, "user", attachments, false, saveHistory ? input : undefined);
          return true;
        }
        if (parsed.kind === "bash") {
          if (coordinator.activeTask) {
            appendTransient("system", uiText('mf1062f8e6fcd'));
            return true;
          }
          void runDirectBash(parsed.command);
          return true;
        }
        if (parsed.kind === "unknown") {
          openInfo(
            uiText('m31f6c687be1d'),
            uiText('mb3497210f20d', {p0: parsed.command}),
            "error",
          );
          return true;
        }

        if(parsed.command==='/language'){
          if(!isLanguagePreference(parsed.args)){openInfo(uiText('language.title'),uiText('language.help',{p0:currentLanguage()}));}
          else{void changeLanguage(parsed.args).then(language=>{openInfo(uiText('language.title'),uiText('language.saved',{p0:language}));}).catch(()=>openInfo(uiText('language.title'),uiText('language.failed'),'error'));}
          return true;
        }
        if (parsed.command === "/login") enterCommandView({ kind: "login" });
        if (parsed.command === "/model") {
          if (parsed.args?.toLowerCase().startsWith("profile ")) void setResponsesProfile(parsed.args.slice(8));
          else void openModelPicker();
        }
        if (parsed.command === "/models") void showModels();
        if (parsed.command === "/status") showStatus();
        if (parsed.command === "/privacy") void runPrivacy(parsed.args ?? "");
        if (parsed.command === "/perf") {
          const operation = startCommandLoad(uiText('mec45e9585c56'), uiText('m81c7b3e2d9e8'), true, false);
          void import("../../performance/task-report.js").then(async ({ formatTaskPerformance }) => {
            const sessionId = coordinator.sessionId;
            const report = sessionId ? (await dependencies.sessionStore.load(sessionId)).performanceReport : undefined;
            if (isCurrentCommandOperation(operation)) replaceCommandView(infoView(uiText('mec45e9585c56'), localizeHostReport(formatTaskPerformance(report))));
          }).catch(() => { if (isCurrentCommandOperation(operation)) replaceCommandView(infoView(uiText('m270e3f4df929'), uiText('m2376480c3776'), "error")); });
        }
        if (parsed.command === "/context") enterCommandView({ kind: "context" });
        if (parsed.command === "/team") void showTeam(parsed.args ?? "");
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
        if (parsed.command === "/web") enterCommandView({ kind: "web" });
        if (parsed.command === "/cost") enterCommandView({ kind: "cost" });
        if (parsed.command === "/permissions") enterCommandView({ kind: "permissions" });
        if (parsed.command === "/mcp") {
          const args = parsed.args?.trim() ?? "";
          if (args.startsWith('mode ')) {
            const [, name, mode] = args.split(/\s+/u);
            if (coordinator.activeTask || directController.current) appendTransient('system', uiText('mfbddd6f152ac'));
            else if (name && (mode === 'sandbox' || mode === 'host')) void reviewMcpIsolation(name, mode).catch(error => openInfo('/mcp', error instanceof Error ? error.message : String(error), 'error'));
            else openInfo('/mcp', uiText('security.mcpModeUsage'), 'error');
          } else if (args.startsWith("trust ")) {
            if (coordinator.activeTask || directController.current) appendTransient("system", uiText('mfbddd6f152ac'));
            else void reviewMcpTrust(args.slice(6).trim());
          } else if (args.startsWith("revoke ")) {
            coordinator.cancelTask();
            void dependencies.revokeMcpTrust?.(args.slice(7).trim()).then(showMcp).catch(() => openInfo(uiText('mb808e6a384cf'), uiText('md3ba2cf24f28'), "error"));
          } else if (args === "reconnect") {
            if (coordinator.activeTask || directController.current) appendTransient("system", uiText('m79a7deafd318'));
            else void dependencies.reconnectMcp?.().then(showMcp).catch(() => openInfo(uiText('m6f392ee21284'), uiText('maa50009ccf83'), "error"));
          } else void showMcp();
        }
        if (parsed.command === "/skills") enterCommandView({ kind: "skills" });
        if (parsed.command === "/memory") {
          const args = parsed.args?.trim() ?? "";
          if (args.toLowerCase().startsWith("remember ")) rememberMemory(args.slice("remember ".length).trim());
          else if (args.toLowerCase() === "pause") toggleMemory(false);
          else if (args.toLowerCase() === "resume") toggleMemory(true);
          else if (args.toLowerCase() === "view") void showMemoryPrompt();
          else if (/^(?:list|inspect|renew|disable|delete|correct)(?:\s|$)/u.test(args)) void runMemoryReview(args);
          else void showMemory();
        }
        if (parsed.command === "/plan") {
          const args = parsed.args?.trim() ?? "";
          const action = args.toLowerCase();
          if (coordinator.activeTask || directController.current) {
            appendTransient("system", uiText('m8a1974abf54f'));
          } else if (action === "execute") {
            void runChat("", false, "default", "user", [], true);
          } else if (action === "show") {
            const approved = coordinator.approvedPlan();
            if (approved) {
              enterCommandView({ kind: "approved-plan", submitted: approved });
            } else {
              appendTransient("system", uiText('ma0963593147f'));
            }
          } else if (action === "exit") {
            setAgentMode("default");
            appendTransient("system", uiText('maa24aa1a6109'));
          } else if (!args) {
            setAgentMode("plan");
            appendTransient("system", uiText('mdcfb041122d5'));
          } else {
            setAgentMode("plan");
            void runChat(args, false, "plan", "user", [], false, saveHistory ? input : undefined);
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
        if (parsed.command === "/help") openInfo(uiText('m60535e64ce89'), getTuiHelp());
        if (parsed.command === "/exit") exit(0);
        return true;
      };

      if (parsed.kind !== "chat" || (parseFileReferences(parsed.text).length === 0 && !parsed.text.includes('@"'))) {
        return submitResolved([]);
      }
      return (async () => {
        const controller = new AbortController();
        attachmentController.current?.abort(new Error(uiText('m973166832978')));
        attachmentController.current = controller;
        const capturedSessionId = coordinator.sessionId;
        const capturedWorkspace = workspacePath;
        try {
          const attachments = await resolveFileAttachments(parsed.text, capturedWorkspace, controller.signal);
          if (coordinator.sessionId !== capturedSessionId || workspacePath !== capturedWorkspace) {
            appendTransient("error", uiText('md53f2692d757'));
            return false;
          }
          return submitResolved(attachments);
        } catch (error) {
          if (!controller.signal.aborted) {
            appendTransient("error", uiText('m20e5e33000b3', {p0: error instanceof Error ? error.message : String(error)}));
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
      agent,
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
      showTeam,
      showStatus,
      runCompact,
      setReasoning,
      setResponsesProfile,
      runDoctor,
      runPrivacy,
      runMemoryReview,
      workspacePath,
    ],
  );

  const finishLogout = useCallback(
    (removedIds: string[]) => {
      const message = uiText('mb85a781f1870', {p0: removedIds.length, p1: removedIds.length === 1 ? "" : "s"});
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
        uiText('m64cf305db8b5'),
        uiText('ma50bd04957cd'),
        false,
        false,
      );
      void dependencies.registry
        .resolveAll()
        .then((resolved) => {
          if (!isCurrentCommandOperation(operation)) return;
          if (resolved.available.length === 1) {
            activateModel(resolved.available[0]!, uiText('m72bca6c1071f', {p0: resolved.available[0]!.model_name}));
          } else if (resolved.available.length > 1) {
            replaceCommandView({
              kind: "model-picker",
              title: uiText('md08a0cc79f6d'),
              models: resolved.available,
            });
          } else {
            returnToChat(() => {
              appendTransient("system", uiText('md41f04a008d1'));
            });
          }
        })
        .catch((error: unknown) => {
          if (!isCurrentCommandOperation(operation)) return;
          replaceCommandView(infoView(
            uiText('m455174ae62f0'),
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
      if (key.ctrl && input === "c" && view.kind === "mcp-trust") {
        view.cancel();
        return;
      }
      if (key.ctrl && input === "c" && view.kind === "loading" && view.onCancel) {
        view.onCancel();
        return;
      }
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
      if (coordinator.activeTask) {
        coordinator.cancelTask();
        setActiveCommand((current) => current ? { ...current, cancelling: true } : current);
        if (confirmationRef.current) finishConfirmation(false);
        return;
      }
      if (confirmationRef.current) {
        finishConfirmation(false);
        return;
      }
    },
    { isActive: view.kind === "chat" || view.kind === "context" || view.kind === "plan-questions" || view.kind === "mcp-trust" || confirmation !== undefined || (view.kind === "loading" && (directController.current !== undefined || view.onCancel !== undefined)) },
  );

  useEffect(
    () => () => {
      coordinator.cancelTask();
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
      if (redrawTimer !== undefined) clearTimeout(redrawTimer);
      // Command surfaces contain no Static transcript to replay. Ink already
      // resizes them; clearing again can leave its unchanged frame blank until
      // the next input. Keep the mounted surface and its draft intact.
      if (view.kind !== "chat") return;
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
  }, [onReplayOutput, stdout, view.kind]);

  const displayedToolStatus = reasoningStartedAt !== undefined
    ? `${translateHostText('Thinking')} · ${formatElapsed(reasoningElapsedSeconds)}`
    : liveToolStatus;

  const isDirectTask=directController.current!==undefined;
  const isTaskActive=coordinator.activeTask!==undefined||isDirectTask;
  const taskReport=isTaskActive?agent?.getLivePerformanceReport?.():agent?.getPerformanceReport?.();
  const requestBudget=!isTaskActive||taskReport!==undefined?agent?.getRequestBudgetSnapshot?.():undefined;
  const team=agent?.getTeamSnapshot?.();
  const taskUsed=taskReport?Object.values(taskReport.usage).reduce((sum,usage)=>sum+(usage?.inputTokens??0)+(usage?.outputTokens??0),0):null;
  const taskStatus=projectTaskStatus({active:isTaskActive,...(coordinator.sessionId?{sessionId:coordinator.sessionId}:{}),...(workflowProjection?.task_id?{taskId:workflowProjection.task_id}:{}),cancelled:coordinator.activeTask?.signal.aborted===true||directController.current?.signal.aborted===true,cleanupFailed:cleanupFailed||coordinator.cleanupBlocked,approval:confirmation!==undefined,question:view.kind==='plan-questions',mode:isDirectTask?'default':agentMode,...(isDirectTask?{loopPhase:'tools'}:agentPhase?{loopPhase:agentPhase}:{}),...(!isDirectTask&&workflowProjection?{workflow:workflowProjection}:{}),...(lastTaskStartedAt?{startedAt:lastTaskStartedAt}:{}),stageStartedAt:taskStageStartedAt,...(taskFinishedAt?{finishedAt:taskFinishedAt}:{}),...(taskOutcome?{outcome:taskOutcome}:{}),...(taskFailure?{failure:taskFailure}:{}),...(isDirectTask?{operation:uiText('task.directShell')} :busyLabel?{operation:translateHostText(busyLabel)}:{}),budgets:isDirectTask?[]:[...(requestBudget?[{scope:'request' as const,...requestBudget}]:[]),{scope:'task',limit:team?.options.tokenBudget??null,used:team?team.usage.inputTokens+team.usage.outputTokens:taskUsed,complete:team?team.usage.complete:taskReport!==undefined&&Object.values(taskReport.usage).every(usage=>usage?.unknown===0),inFlight:agentPhase==='sampling'||(team?.openRequests??0)>0},...(activeGoal?[{scope:'goal' as const,limit:activeGoal.token_budget,used:activeGoal.tokens_used,complete:activeGoal.usage_complete,inFlight:agentPhase==='sampling'||(team?.openRequests??0)>0}]:[])]});
  useEffect(()=>{setTaskStageStartedAt(Date.now());},[taskStatus.stage,taskStatus.taskId]);

  if (view.kind !== "chat") {
    return (
      // Keep the chat's host container mounted. Removing its ancestor would
      // free Ink's Static Yoga node before Ink clears the retained reference.
      <Box width="100%" paddingRight={1} flexDirection="column">
      <CommandScreen>
        {view.kind === "outputs" ? (
          <TextBrowser title="/outputs" entries={timeline.filter((entry) => entry.kind === "output").map((entry) => ({ label: entry.kind === "output" ? entry.command?.command ?? entry.text.split("\n")[0] ?? uiText('mb2439bcb8dee') : "", text: entry.kind === "output" ? entry.text : "", ...(entry.kind === "output" && entry.command ? { command: entry.command } : {}) })).reverse()} onBack={returnToChat} />
        ) : view.kind === "input-history" ? (
          <TextBrowser title="/history" entries={[...inputHistory].reverse().map((text) => ({ label: text, text }))} onBack={returnToChat} onClear={async () => { await dependencies.inputHistory?.clear(); setInputHistory([]); }} />
        ) : view.kind === "terminal-setup" ? (
          <TerminalSetup onBack={returnToChat} />
        ) : view.kind === "permissions" ? (
          <PermissionsPicker
            plan={agentMode === "plan"}
            policy={permissions.current}
            workspace={workspacePath}
            onChange={(policy) => {
              void (async () => {
                try {
                  coordinator.cancelTask(new Error(uiText('m71bcaf700a0c')));
                  await dependencies.savePermissions?.(workspacePath, policy);
                  permissions.current = dependencies.loadPermissions
                    ? await dependencies.loadPermissions(workspacePath)
                    : policy;
                } catch (error) {
                  if (dependencies.loadPermissions) permissions.current = await dependencies.loadPermissions(workspacePath);
                  if (error instanceof ProcessCleanupError) await ensureWorkflow().recordCleanupFailure(error);
                  // Persistence errors preserve the current effective stored policy.
                } finally {
                  returnToChat();
                }
              })();
            }}
            onSaveProject={(policy) => {
              void (async () => {
                try {
                  coordinator.cancelTask(new Error(uiText('m71bcaf700a0c')));
                  await dependencies.savePermissions?.(workspacePath, policy, "project");
                  if (dependencies.loadPermissions) permissions.current = await dependencies.loadPermissions(workspacePath);
                } catch (error) {
                  if (dependencies.loadPermissions) permissions.current = await dependencies.loadPermissions(workspacePath);
                  if (error instanceof ProcessCleanupError) await ensureWorkflow().recordCleanupFailure(error);
                  // Persistence errors preserve the current effective stored policy.
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
          <PlanReviewSurface submitted={view.submitted} onDecision={view.decide} onCancelTask={view.cancelTask} />
        ) : view.kind === "approved-plan" ? (
          <ApprovedPlanSurface submitted={view.submitted} onBack={returnToChat} />
        ) : view.kind === "goal-confirm" ? (
          <GoalConfirmationSurface
            objective={view.objective}
            {...(view.tokenBudget === undefined ? {} : { tokenBudget: view.tokenBudget })}
            onConfirm={view.confirm}
            onCancel={view.cancel}
          />
        ) : view.kind === "action-confirm" ? (
          <ActionConfirmation text={translateHostText(view.text)} start={view.start} cancel={view.cancel} {...(view.startLabel ? { startLabel: view.startLabel } : {})} />
        ) : view.kind === "web" ? (
          <WebSurface configure={dependencies.configureWeb} onBack={returnToChat} />
        ) : view.kind === "cost" ? (
          <CostSurface modelId={activeModel?.id} configure={dependencies.configureCost} status={dependencies.getCostStatus} onBack={returnToChat} />
        ) : view.kind === "mcp-trust" ? (
          <McpTrustSurface preview={view.preview} onApprove={view.approve} onCancel={view.cancel} />
        ) : view.kind === "goal-status" ? (
          <GoalStatusSurface {...(view.goal ? { goal: view.goal } : {})} {...(dependencies.getInFlightRequests?.() === undefined ? {} : { inFlightRequests: dependencies.getInFlightRequests!()! })} onPause={pauseGoal} onResume={resumeGoal} onBack={returnToChat} />
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
        ) : view.kind === "team" ? (
          <TeamSurface
            config={teamConfig} models={view.models}
            getSnapshot={() => { const current = agent?.getTeamSnapshot?.(); return view.snapshot && current?.teamId !== view.snapshot.teamId ? view.snapshot : current ?? view.snapshot; }}
            busy={coordinator.activeTask !== undefined} onConfigure={configureTeam}
            onAction={async (action, id) => {
              if (action === "continue") {
                await configureTeam({ ...teamConfig, enabled: true, resumeTeamId: id });
                returnToChat(() => appendTransient("system", uiText('m37e6aeaa8f91')));
              } else {
                await dependencies.manageTeam?.(action, id, coordinator.sessionId, view.snapshot?.teamId);
                if (coordinator.sessionId) {
                  const snapshot = await dependencies.inspectTeam?.(coordinator.sessionId, view.snapshot?.teamId);
                  if (snapshot) enterCommandView({ ...view, snapshot });
                }
              }
            }} onBack={returnToChat}
          />
        ) : view.kind === "tasks" ? (
          <TaskProgressSurface progress={view.progress} workflow={view.workflow} onBack={returnToChat} />
        ) : view.kind === "login" ? (
          <LoginWizard
            dependencies={dependencies}
            onComplete={(model) => activateModel(model, uiText('m757f3a884b51', {p0: model.model_name}))}
            onCancel={returnToChat}
          />
        ) : view.kind === "model-picker" ? (
          <ModelPicker
            title={translateHostText(view.title)}
            models={view.models}
            onSelect={(model) => {
              if (!view.resumeSession) {
                activateModel(model);
                return;
              }
              const loaded = view.resumeSession;
              const operation = startCommandLoad(
                uiText('mfe2ee5028847'),
                uiText('mfe958bef9fde'),
                false,
                false,
              );
              void completeResume(loaded, model, true)
                .catch((error: unknown) => {
                  if (!isCurrentCommandOperation(operation)) return;
                  replaceCommandView(infoView(
                    uiText('m8d94f4cf7cd3'),
                    uiText('m3905310128fc', {p0: error instanceof Error ? error.message : String(error)}),
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
            taskStatus={taskStatus} maxOutputTokens={requestSettings.maxOutputTokens}
            onBack={returnToChat}
          />
        )}
      </CommandScreen>
      </Box>
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

      <TaskStatus snapshot={taskStatus}/>
      {confirmation ? (
        <Box flexDirection="column">
          <ApprovalConfirmation
            inputHandledByPrompt
            kind={confirmation.kind}
            request={confirmation.request}
            onConfirm={() => finishConfirmation(true)}
            onCancel={() => finishConfirmation(false)}
          />
          {turnStartedAt !== undefined ? <Text dimColor>{uiText('m55f1cec9a608')}{formatElapsed(elapsedSeconds)}</Text> : null}
          {liveAssistant ? <Box marginLeft={2}><RichOutput text={liveAssistant} /></Box> : null}
          {displayedToolStatus ? <Text color={TUI_COLORS.secondary}>• {displayedToolStatus}</Text> : null}
          <Prompt
            key={`prompt-${inputKey}`}
            activeModelName={activeModel?.model_name}
            placeholder={uiText('m8ee119dfd26a')}
            onApprovalChoice={finishConfirmation}
            history={resumedInputHistory ?? inputHistory}
            editorRef={editorRef}
            historyNavigationRef={historyNavigationRef}
            getFileSuggestions={getFileSuggestions}
            onEmptyInterrupt={() => coordinator.cancelTask()}
            onSubmit={handleSubmit}
          />
        </Box>
      ) : terminalBusy ? (
        <Box flexDirection="column">
          <Text bold color={activeCommand?.cancelling ? TUI_COLORS.warning : TUI_COLORS.status} wrap="truncate-end">
            • {activeCommand?.cancelling ? uiText('m20d55e8c3373') : uiText('mf4ccae29e1bb')} <Text color={TUI_COLORS.secondary}>{activeCommand?.shell}</Text>{turnStartedAt === undefined ? "" : ` (${formatElapsed(elapsedSeconds)})`}
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
              {queuedGuidanceCount > 0 ? <Text dimColor>{queuedGuidanceCount}{uiText('m17b21415b2d8')}{queuedGuidanceCount === 1 ? "" : "s"}{uiText('mf9ad5e1de7d0')}</Text> : null}
              <Prompt
                key={`prompt-${inputKey}`}
                activeModelName={activeModel?.model_name}
                placeholder={uiText('m4fb81cb2da45')}
                history={resumedInputHistory ?? inputHistory}
                editorRef={editorRef}
                historyNavigationRef={historyNavigationRef}
                getFileSuggestions={getFileSuggestions}
                onEmptyInterrupt={() => coordinator.cancelTask()}
                onSubmit={handleSubmit}
              />
            </>
          ) : null}
        </Box>
      ) : busyLabel ? (
        <Box flexDirection="column">
          <Spinner label={`${agentPhase === "tools" ? uiText('ma92f0449a9f7') : agentPhase === "sampling" ? uiText('mcb5cb11b8e5f', {p0: busyLabel}) : busyLabel}${turnStartedAt === undefined ? "" : uiText('m1ee447087e68', {p0: formatElapsed(elapsedSeconds)})}`} />
          {liveAssistant ? <Box marginLeft={2}><RichOutput text={liveAssistant} /></Box> : null}
          {displayedToolStatus ? <Text color={TUI_COLORS.secondary}>• {displayedToolStatus}</Text> : null}
          {queuedGuidanceCount > 0 ? <Text dimColor>{queuedGuidanceCount}{uiText('m17b21415b2d8')}{queuedGuidanceCount === 1 ? "" : "s"}{uiText('mf9ad5e1de7d0')}</Text> : null}
          <Prompt
            key={`prompt-${inputKey}`}
            activeModelName={activeModel?.model_name}
            placeholder={uiText('m4fb81cb2da45')}
            history={resumedInputHistory ?? inputHistory}
            editorRef={editorRef}
            historyNavigationRef={historyNavigationRef}
            getFileSuggestions={getFileSuggestions}
            onEmptyInterrupt={() => coordinator.cancelTask()}
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
