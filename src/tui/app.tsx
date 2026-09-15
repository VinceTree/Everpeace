import { Spinner } from "@inkjs/ui";
import { Box, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentIO } from "../agent/react-agent.js";
import type {
  RegisteredModel,
  RegisteredModelStatus,
  ResolvedModels,
} from "../storage/model-registry.js";
import type { BashResult } from "../tools/bash.js";
import { parseTuiInput, TUI_HELP } from "./commands.js";
import { BashConfirmation } from "./components/bash-confirmation.js";
import { History } from "./components/history.js";
import { LoginWizard } from "./components/login-wizard.js";
import { LogoutWizard } from "./components/logout-wizard.js";
import { ModelPicker } from "./components/model-picker.js";
import { Prompt } from "./components/prompt.js";
import { StatusBar } from "./components/status-bar.js";
import type {
  HistoryKind,
  TimelineEntry,
  TuiDependencies,
} from "./types.js";

type View =
  | { kind: "chat" }
  | { kind: "login" }
  | { kind: "model-picker"; title: string; models: RegisteredModel[] }
  | { kind: "logout"; models: RegisteredModelStatus[] };

interface PendingConfirmation {
  command: string;
  resolve(accepted: boolean): void;
}

export interface EverpeaceAppProps {
  dependencies: TuiDependencies;
  initialModels: ResolvedModels;
  onClearOutput(): void;
}

function initialActiveModel(models: RegisteredModel[]): RegisteredModel | undefined {
  return models.length === 1 ? models[0] : undefined;
}

function initialView(models: RegisteredModel[]): View {
  return models.length > 1
    ? { kind: "model-picker", title: "选择本次会话模型", models }
    : { kind: "chat" };
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

export function EverpeaceApp({
  dependencies,
  initialModels,
  onClearOutput,
}: EverpeaceAppProps) {
  const { exit, suspendTerminal } = useApp();
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
  const confirmationRef = useRef<PendingConfirmation | undefined>(undefined);
  const [timeline, setTimeline] = useState(initialTimeline);
  const [timelineEpoch, setTimelineEpoch] = useState(0);
  const [inputKey, setInputKey] = useState(0);
  const [sessionEpoch, setSessionEpoch] = useState(0);
  const [activeModel, setActiveModel] = useState(firstActiveModel);
  const [view, setView] = useState<View>(() => initialView(initialModels.available));
  const [busyLabel, setBusyLabel] = useState<string>();
  const [confirmation, setConfirmation] = useState<PendingConfirmation>();

  const append = useCallback((kind: HistoryKind, text: string) => {
    setTimeline((current) => [
      ...current,
      { id: nextId.current++, kind, text },
    ]);
  }, []);

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
      const status = bashStatus(result);
      append(status.kind, status.text);
      return result;
    },
    [append, dependencies, suspendTerminal],
  );

  const executeTerminalCommand = useCallback(
    async (command: string): Promise<BashResult> => {
      let result: BashResult | undefined;
      await suspendTerminal(async () => {
        result = await dependencies.runTerminalCommand(command);
      });
      if (result === undefined) throw new Error("Terminal command did not return a result");
      const status = terminalStatus(result);
      append(status.kind, status.text);
      return result;
    },
    [append, dependencies, suspendTerminal],
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
        : dependencies.createAgent(activeModel, agentIo),
    [activeModel, agentIo, dependencies, sessionEpoch],
  );

  const activateModel = useCallback(
    (model: RegisteredModel, message = `已启用模型 ${model.model_name}`) => {
      abortController.current?.abort();
      setActiveModel(model);
      setSessionEpoch((current) => current + 1);
      setView({ kind: "chat" });
      append("system", `${message}；对话上下文已重置。`);
    },
    [append],
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

  const clearConversation = useCallback(() => {
    abortController.current?.abort();
    const banner: TimelineEntry = {
      id: nextId.current++,
      kind: "banner",
      ...(activeModel === undefined ? {} : { modelName: activeModel.model_name }),
    };
    onClearOutput();
    setTimeline([banner]);
    setTimelineEpoch((current) => current + 1);
    setSessionEpoch((current) => current + 1);
  }, [activeModel, onClearOutput]);

  const runChat = useCallback(
    async (text: string) => {
      if (!agent) {
        append("error", "尚未启用模型，请先使用 /login 或 /model。");
        return;
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
    [activeModel?.model_name, agent, append],
  );

  const runDirectBash = useCallback(
    async (command: string) => {
      if (!command) {
        append("error", "Usage: !<command>");
        return;
      }
      append("tool", `! ${command}`);
      setBusyLabel("正在执行终端命令");
      try {
        await executeTerminalCommand(command);
      } catch (error) {
        append("error", error instanceof Error ? error.message : String(error));
      } finally {
        setBusyLabel(undefined);
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
      if (parsed.command === "/logout") void openLogout();
      if (parsed.command === "/clear") clearConversation();
      if (parsed.command === "/help") append("system", TUI_HELP);
      if (parsed.command === "/exit") exit(0);
    },
    [
      append,
      clearConversation,
      exit,
      openLogout,
      openModelPicker,
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
      confirmationRef.current?.resolve(false);
      confirmationRef.current = undefined;
    },
    [],
  );

  return (
    <Box width="100%" paddingRight={1} flexDirection="column">
      <History
        key={timelineEpoch}
        entries={timeline}
        version={dependencies.version}
        workspacePath={dependencies.workspacePath}
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
          onSelect={(model) => activateModel(model)}
          onCancel={() => setView({ kind: "chat" })}
        />
      ) : view.kind === "logout" ? (
        <LogoutWizard
          dependencies={dependencies}
          models={view.models}
          onComplete={finishLogout}
          onCancel={() => setView({ kind: "chat" })}
        />
      ) : busyLabel ? (
        <Spinner label={busyLabel} />
      ) : (
        <Prompt
          inputKey={inputKey}
          activeModelName={activeModel?.model_name}
          onSubmit={handleSubmit}
        />
      )}

      <StatusBar
        modelName={activeModel?.model_name}
        workspacePath={dependencies.workspacePath}
      />
    </Box>
  );
}
