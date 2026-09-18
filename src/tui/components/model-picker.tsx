import { Select } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import React from "react";
import type { RegisteredModel } from "../../storage/model-registry.js";

export interface ModelPickerProps {
  title: string;
  models: RegisteredModel[];
  onSelect(model: RegisteredModel): void;
  onCancel(): void;
}

export function ModelPicker({ title, models, onSelect, onCancel }: ModelPickerProps) {
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === "c")) onCancel();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#D4AF37" paddingX={1}>
      <Text bold color="#D4AF37">
        {title}
      </Text>
      <Select
        options={models.map((model) => ({
          label: model.model_name,
          value: model.id,
        }))}
        visibleOptionCount={Math.min(8, models.length)}
        onChange={(id) => {
          const model = models.find((candidate) => candidate.id === id);
          if (model) onSelect(model);
        }}
      />
      <Text dimColor>↑↓ select · Enter confirm · Esc to return to session</Text>
    </Box>
  );
}
