import { ConfirmInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import React from "react";
import { HighlightedCommand } from "../../rendering/rich-text.js";

export interface ApprovalConfirmationProps {
  kind: "bash" | "web" | "mcp" | "goal";
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
  const isMcp = kind === "mcp";
  const isGoal = kind === "goal";
  const shell = process.platform === "win32" ? "PowerShell" : "Bash";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">
        {isBash ? `The model wants to run ${shell}:` : isMcp ? "The model wants to call an MCP tool:" : isGoal ? "The model wants to change the session goal:" : "The model wants to access the web:"}
      </Text>
      {isBash ? <HighlightedCommand command={request} shell={shell} /> : <Text wrap="truncate-end">{request}</Text>}
      <Box>
        <Text>{isBash ? "Run this command? " : isMcp ? "Allow this MCP tool call? " : isGoal ? "Allow this goal change? " : "Allow this web request? "}</Text>
        <ConfirmInput defaultChoice="cancel" onConfirm={onConfirm} onCancel={onCancel} />
      </Box>
    </Box>
  );
}
