import { Spinner } from "@inkjs/ui";
import { Box, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentIO } from "../agent/react-agent.js";
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
import type { BashResult } from "../tools/bash.js";
import { parseTuiInput, TUI_HELP } from "./commands.js";
import { BashConfirmation } from "./components/bash-confirmation.js";
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
  | { kind: "chat" }
  | { kind: "login" }
  | {
      kind: "model-picker";
      title: string;
      models: RegisteredModel[];
      resumeSession?: LoadedSession;
    }
  | { kind: "session-picker"; sessions: SessionSummary[] }
  | { kind: "logout"; models: RegisteredModelStatus[] };

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
  if (result.error) return { kind: "error", text: `Bash error: ${result.error}` };
  if (result.signal) return { kind: "error", text: `Bash stopped by ${result.signal}` };
  if (result.exitCode !== 0) {
    return { kind: "error", text: `Bash exited with code ${result.exitCode}` };
  }
  return { kind: "system", text: "Bash completed successfully" };
}

function terminalStatus(result: BashResult): { kind: HistoryKind; text: string } {
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
  const maximumOutputLines = Math.max(1, Math.min(12, rows - 4));
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
  const { exit, suspendTerminal } = useApp();
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
  const terminalCommandRunning = useRef(false);
  const activeSessionId = useRef<string | undefined>(undefined);
  const sessionTitlePending = useRef(false);
  const [timeline, setTimeline] = useState(initialTimeline);
  const [timelineEpoch, setTimelineEpoch] = useState(0);
  const [inputKey, setInputKey] = useState(0);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [sessionContext, setSessionContext] = useState<
    Array<Record<string, unknown>>
  >([]);
  const [activeModel, setActiveModel] = useState(firstActiveModel);
  const [workspacePath, setWorkspacePath] = useState(dependencies.workspacePath);
  const [view, setView] = useState<View>(() => initialView(initialModels.available));
  const [busyLabel, setBusyLabel] = useState<string>();
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalOutput, setTerminalOutput] = useState<string>();
  const [confirmation, setConfirmation] = useState<PendingConfirmation>();

  const append = useCallback((kind: HistoryKind, text: string): number => {
    const id = nextId.current++;
    setTimeline((current) => [
      ...current,
      { id, kind, text },
    ]);
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
    async (command: string): Promise<BashResult> => {
      let result: BashResult | undefined;
      await suspendTerminal(async () => {
        result = await dependencies.runBash(command);
      });
      if (result === undefined) throw new Error("Bash did not return a result");
      const output = commandOutput(result);
      if (output) append("output", output);
      const status = bashStatus(result);
      append(status.kind, status.text);
      return result;
    },
    [append, dependencies, suspendTerminal],
  );

  const executeTerminalCommand = useCallback(
    async (
      command: string,
      onOutput?: (output: string) => void,
    ): Promise<BashResult> => {
      terminalCommandRunning.current = true;
      let result: BashResult;
      try {
        result = await dependencies.runTerminalCommand(command, onOutput);
      } finally {
        terminalCommandRunning.current = false;
      }
      const output = commandOutput(result);
      if (output) append("output", output);
      const status = terminalStatus(result);
      append(status.kind, status.text);
      return result;
    },
    [append, dependencies],
  );

  const agentIo = useMemo<AgentIO>(
    () => ({
      confirmBash: requestBashConfirmation,
      runBash: executeBash,
      writeAssistant(text) {
        append("assistant", text);
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
            append("error", `Session save failed: ${error instanceof Error ? error.message : String(error)}`);
          });
      }
      setActiveModel(model);
      setSessionContext([]);
      setSessionEpoch((current) => current + 1);
      setView({ kind: "chat" });
      append("system", `${message}；对话上下文已重置。`);
    },
    [append, dependencies.sessionStore],
  );

  const showModels = useCallback(async () => {
    setBusyLabel("正在读取模型注册表");
    try {
      const models = await dependencies.registry.listStatuses();
      if (models.length === 0) {
        append("system", "尚未注册模型，请使用 /login。");
        return;
      }
      append(
        "system",
        models
          .map(
            (model) =>
              `${activeModel?.id === model.id ? "●" : "○"} ${model.model_name} [${model.credential_status}]`,
          )
          .join("\n"),
      );
    } catch (error) {
      append("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusyLabel(undefined);
    }
  }, [activeModel?.id, append, dependencies.registry]);

  const openModelPicker = useCallback(async () => {
    setBusyLabel("正在读取可用模型");
    try {
      const resolved = await dependencies.registry.resolveAll();
      if (resolved.available.length === 0) {
        append("system", "没有可用模型，请先使用 /login。");
        return;
      }
      setView({ kind: "model-picker", title: "切换当前模型", models: resolved.available });
    } catch (error) {
      append("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusyLabel(undefined);
    }
  }, [append, dependencies.registry]);

  const openLogout = useCallback(async () => {
    setBusyLabel("正在读取模型注册表");
    try {
      const models = await dependencies.registry.listStatuses();
      if (models.length === 0) {
        append("system", "尚未注册模型。");
        return;
      }
      setView({ kind: "logout", models });
    } catch (error) {
      append("error", error instanceof Error ? error.message : String(error));
    } finally {
      setBusyLabel(undefined);
    }
  }, [append, dependencies.registry]);

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
          ...loaded.timeline.map((entry, index) => ({
            id: index + 1,
            kind: entry.kind,
            text: entry.text,
          })),
        ];

        abortController.current?.abort();
        activeSessionId.current = loaded.summary.id;
        sessionTitlePending.current = loaded.summary.title_pending;
        nextId.current = restoredTimeline.length;
        onReplayOutput(() => {
          setTimeline(restoredTimeline);
          setTimelineEpoch((current) => current + 1);
          setSessionContext(loaded.context.map((item) => ({ ...item })));
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
      setView({ kind: "chat" });
      setBusyLabel("正在恢复 Session");
      try {
        const [loaded, resolved] = await Promise.all([
          dependencies.sessionStore.load(summary.id),
          dependencies.registry.resolveAll(),
        ]);
        const originalModel = resolved.available.find(
          (candidate) =>
            candidate.id === loaded.summary.model.id ||
            (candidate.model_name === loaded.summary.model.model_name &&
              candidate.base_url === loaded.summary.model.base_url),
        );

        if (originalModel) {
          await completeResume(loaded, originalModel, false);
        } else if (resolved.available.length > 0) {
          setView({
            kind: "model-picker",
            title: `原模型 ${loaded.summary.model.model_name} 不可用，请选择替代模型`,
            models: resolved.available,
            resumeSession: loaded,
          });
        } else {
          append("error", "原 Session 模型不可用；请先使用 /login 注册模型。");
        }
      } catch (error) {
        append("error", `Session restore failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setBusyLabel(undefined);
      }
    },
    [append, completeResume, dependencies.registry, dependencies.sessionStore],
  );

  const openResume = useCallback(async () => {
    setBusyLabel("正在读取 Session");
    try {
      const result = await dependencies.sessionStore.list();
      if (result.skipped > 0) {
        append("error", `已跳过 ${result.skipped} 个损坏的 Session 文件。`);
      }
      if (result.sessions.length === 0) {
        append("system", "没有可恢复的 Session。");
        return;
      }
      setView({ kind: "session-picker", sessions: result.sessions });
    } catch (error) {
      append("error", `Session list failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyLabel(undefined);
    }
  }, [append, dependencies.sessionStore]);

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
      append("error", "尚未启用模型，请先使用 /login 或 /model。");
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
      await dependencies.sessionStore.appendTimeline(session.id, {
        kind: "system",
        text: message,
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
        setSessionEpoch((current) => current + 1);
        setInputKey((current) => current + 1);
        setView({ kind: "chat" });
      });
    } catch (error) {
      append("error", `Session creation failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyLabel(undefined);
    }
  }, [activeModel, append, dependencies.sessionStore, onReplayOutput, workspacePath]);

  const clearConversation = useCallback(() => {
    abortController.current?.abort();
    activeSessionId.current = undefined;
    sessionTitlePending.current = false;
    setSessionContext([]);
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

  const runChat = useCallback(
    async (text: string) => {
      if (!agent || !activeModel) {
        append("error", "尚未启用模型，请先使用 /login 或 /model。");
        return;
      }

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
          return;
        }
      }

      append("user", text);
      const controller = new AbortController();
      abortController.current = controller;
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
      if (!command) {
        append("error", "Usage: !<command>");
        return;
      }
      append("tool", `! ${command}`);
      setTerminalOutput(undefined);
      setTerminalBusy(true);
      try {
        await executeTerminalCommand(command, setTerminalOutput);
      } catch (error) {
        append("error", error instanceof Error ? error.message : String(error));
      } finally {
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
        append("error", `未知命令：${parsed.command}。输入 /help 查看可用命令。`);
        return;
      }

      if (parsed.command === "/login") setView({ kind: "login" });
      if (parsed.command === "/model") void openModelPicker();
      if (parsed.command === "/models") void showModels();
      if (parsed.command === "/new") void createNewSession();
      if (parsed.command === "/resume") void openResume();
      if (parsed.command === "/logout") void openLogout();
      if (parsed.command === "/clear") clearConversation();
      if (parsed.command === "/help") append("system", TUI_HELP);
      if (parsed.command === "/exit") exit(0);
    },
    [
      append,
      clearConversation,
      createNewSession,
      exit,
      openLogout,
      openModelPicker,
      openResume,
      runChat,
      runDirectBash,
      showModels,
    ],
  );

  const finishLogout = useCallback(
    (removedIds: string[]) => {
      append("system", `已删除 ${removedIds.length} 个模型及对应系统凭据。`);
      if (!activeModel || !removedIds.includes(activeModel.id)) {
        setView({ kind: "chat" });
        return;
      }

      setActiveModel(undefined);
      setSessionContext([]);
      setSessionEpoch((current) => current + 1);
      setBusyLabel("正在刷新可用模型");
      setView({ kind: "chat" });
      void dependencies.registry
        .resolveAll()
        .then((resolved) => {
          if (resolved.available.length === 1) {
            activateModel(resolved.available[0]!, `已自动切换到 ${resolved.available[0]!.model_name}`);
          } else if (resolved.available.length > 1) {
            setView({
              kind: "model-picker",
              title: "当前模型已注销，请选择新模型",
              models: resolved.available,
            });
          } else {
            append("system", "当前没有可用模型，请使用 /login。");
          }
        })
        .catch((error: unknown) => {
          append("error", error instanceof Error ? error.message : String(error));
        })
        .finally(() => setBusyLabel(undefined));
    },
    [activeModel, activateModel, append, dependencies.registry],
  );

  useInput(
    (input, key) => {
      if (!key.ctrl || input !== "c") return;
      if (terminalCommandRunning.current) return;
      if (abortController.current) {
        abortController.current.abort();
        return;
      }
      if (confirmationRef.current) {
        finishConfirmation(false);
        return;
      }
      exit(0);
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
      ) : view.kind === "login" ? (
        <LoginWizard
          dependencies={dependencies}
          onComplete={(model) => activateModel(model, `已登录并启用 ${model.model_name}`)}
          onCancel={() => setView({ kind: "chat" })}
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
            setView({ kind: "chat" });
            setBusyLabel("正在恢复 Session");
            void completeResume(loaded, model, true)
              .catch((error: unknown) => {
                append("error", `Session restore failed: ${error instanceof Error ? error.message : String(error)}`);
              })
              .finally(() => setBusyLabel(undefined));
          }}
          onCancel={() => setView({ kind: "chat" })}
        />
      ) : view.kind === "session-picker" ? (
        <SessionPicker
          sessions={view.sessions}
          onSelect={(session) => void chooseSession(session)}
          onCancel={() => setView({ kind: "chat" })}
        />
      ) : view.kind === "logout" ? (
        <LogoutWizard
          dependencies={dependencies}
          models={view.models}
          onComplete={finishLogout}
          onCancel={() => setView({ kind: "chat" })}
        />
      ) : terminalBusy ? (
        <TerminalActivity output={terminalOutput} />
      ) : busyLabel ? (
        <Spinner label={busyLabel} />
      ) : (
        <Prompt
          key={`prompt-${inputKey}`}
          activeModelName={activeModel?.model_name}
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
