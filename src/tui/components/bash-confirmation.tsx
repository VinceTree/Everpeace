import { ConfirmInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import React from "react";

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
      <Text color="yellow">模型请求执行 Bash：</Text>
      <Text>{command}</Text>
      <Box>
        <Text>是否执行？ </Text>
        <ConfirmInput defaultChoice="cancel" onConfirm={onConfirm} onCancel={onCancel} />
      </Box>
    </Box>
  );
}
