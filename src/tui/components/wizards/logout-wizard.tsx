import {uiText} from '../../../localization/messages.js';
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
      setError(uiText('m41fd5ed68cdb'));
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
        {uiText('m64cf305db8b5')}</Text>
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
          <Text dimColor>{uiText('mcca2fd47f7b6')}</Text>
        </>
      ) : null}

      {step === "confirm" ? (
        <Box flexDirection="column">
          <Text>{uiText('m5948954e3b49')}{selectedIds.length}{uiText('ma791e1e893ea')}{selectedIds.length === 1 ? "" : "s"}{uiText('m1f829fc4890d')}</Text>
          <ConfirmInput defaultChoice="cancel" onConfirm={remove} onCancel={onCancel} />
          <Text dimColor>{uiText('m30c2566270e3')}</Text>
        </Box>
      ) : null}

      {step === "deleting" ? <Spinner label={uiText('ma126919a7a56')} /> : null}
    </Box>
  );
}
