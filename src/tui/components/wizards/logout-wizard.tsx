import { ConfirmInput, MultiSelect, Spinner } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { RegisteredModelStatus } from "../../../storage/model-registry.js";
import type { TuiDependencies } from "../../app/types.js";

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
      setError("Select at least one model");
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
        /logout · Remove models
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
          <Text dimColor>↑↓ move · Space select · Enter continue · Esc to return to session</Text>
        </>
      ) : null}

      {step === "confirm" ? (
        <Box flexDirection="column">
          <Text>Remove {selectedIds.length} model{selectedIds.length === 1 ? "" : "s"} and associated system credentials?</Text>
          <ConfirmInput defaultChoice="cancel" onConfirm={remove} onCancel={onCancel} />
          <Text dimColor>Esc to return to session</Text>
        </Box>
      ) : null}

      {step === "deleting" ? <Spinner label="Removing models and credentials" /> : null}
    </Box>
  );
}
