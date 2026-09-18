import { ConfirmInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import React from "react";
import { HighlightedCommand } from "./rich-text.js";

export interface BashConfirmationProps {
  command: string;
  onConfirm(): void;
  onCancel(): void;
}

export function BashConfirmation({
  command,
  onConfirm,
  onCancel,
}: BashConfirmationProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">The model wants to run Bash:</Text>
      <HighlightedCommand command={command} shell="Bash" />
      <Box>
        <Text>Run this command? </Text>
        <ConfirmInput defaultChoice="cancel" onConfirm={onConfirm} onCancel={onCancel} />
      </Box>
    </Box>
  );
}
