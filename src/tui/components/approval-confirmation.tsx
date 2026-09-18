import { ConfirmInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import React from "react";
import { HighlightedCommand } from "./rich-text.js";

export interface ApprovalConfirmationProps {
  kind: "bash" | "web";
  request: string;
  onConfirm(): void;
  onCancel(): void;
}

export function ApprovalConfirmation({
  kind,
  request,
  onConfirm,
  onCancel,
}: ApprovalConfirmationProps) {
  const isBash = kind === "bash";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">
        {isBash ? "The model wants to run Bash:" : "The model wants to access the web:"}
      </Text>
      {isBash ? <HighlightedCommand command={request} shell="Bash" /> : <Text wrap="truncate-end">{request}</Text>}
      <Box>
        <Text>{isBash ? "Run this command? " : "Allow this web request? "}</Text>
        <ConfirmInput defaultChoice="cancel" onConfirm={onConfirm} onCancel={onCancel} />
      </Box>
    </Box>
  );
}
