import { ConfirmInput, MultiSelect, Spinner } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { RegisteredModelStatus } from "../../storage/model-registry.js";
import type { TuiDependencies } from "../types.js";

type LogoutStep = "select" | "confirm" | "deleting";

export interface LogoutWizardProps {
  dependencies: TuiDependencies;
  models: RegisteredModelStatus[];
  onComplete(removedIds: string[]): void;
  onCancel(): void;
}

export function LogoutWizard({
  dependencies,
  models,
  onComplete,
  onCancel,
}: LogoutWizardProps) {
  const [step, setStep] = useState<LogoutStep>("select");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  useInput((input, key) => {
    const wantsToCancel = key.escape || (key.ctrl && input === "c");
    if (wantsToCancel && step !== "deleting") onCancel();
  });

  const submitSelection = (ids: string[]) => {
    if (ids.length === 0) {
      setError("至少选择一个模型");
      return;
    }
    setSelectedIds(ids);
    setError(undefined);
    setStep("confirm");
  };

  const remove = () => {
    setStep("deleting");
    void dependencies.registry
      .removeMany(selectedIds)
      .then(() => onComplete(selectedIds))
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
        setStep("select");
      });
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#D4AF37" paddingX={1}>
      <Text bold color="#D4AF37">
        /logout · 注销模型
      </Text>
      {error ? <Text color="red">{error}</Text> : null}

      {step === "select" ? (
        <>
          <MultiSelect
            options={models.map((model) => ({
              label: `${model.model_name} [${model.credential_status}]`,
              value: model.id,
            }))}
            visibleOptionCount={Math.min(8, models.length)}
            onSubmit={submitSelection}
          />
          <Text dimColor>↑↓ 移动 · Space 勾选 · Enter 继续 · Esc 返回 Session</Text>
        </>
      ) : null}

      {step === "confirm" ? (
        <Box flexDirection="column">
          <Text>删除 {selectedIds.length} 个模型及对应系统凭据？</Text>
          <ConfirmInput defaultChoice="cancel" onConfirm={remove} onCancel={onCancel} />
          <Text dimColor>Esc 返回 Session</Text>
        </Box>
      ) : null}

      {step === "deleting" ? <Spinner label="正在删除模型与凭据" /> : null}
    </Box>
  );
}
