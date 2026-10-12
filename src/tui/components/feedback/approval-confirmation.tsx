import {uiText} from '../../../localization/messages.js';
import { ConfirmInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import React from "react";
import { HighlightedCommand, RichOutput } from "../../rendering/rich-text.js";

export interface ApprovalConfirmationProps {
  kind: "bash" | "patch" | "web" | "mcp" | "goal";
  request: string;
  onConfirm(): void;
  onCancel(): void;
  inputHandledByPrompt?: boolean;
}

export function ApprovalConfirmation({
  kind,
  request,
  onConfirm,
  onCancel,
  inputHandledByPrompt = false,
}: ApprovalConfirmationProps) {
  const isBash = kind === "bash";
  const isPatch = kind === "patch";
  const isMcp = kind === "mcp";
  const isGoal = kind === "goal";
  const shell = process.platform === "win32" ? "PowerShell" : "Bash";
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">
        {isBash ? uiText('medfbff3286cb', {p0: shell}) : isPatch ? uiText('m8b4018da6a61') : isMcp ? uiText('m35ad3d7a6630') : isGoal ? uiText('maae9dc7063da') : uiText('ma51d760b6e4f')}
      </Text>
      {isBash ? <HighlightedCommand command={request} shell={shell} /> : isPatch ? <RichOutput text={request} /> : <Text wrap="truncate-end">{request}</Text>}
      <Box>
        <Text>{isBash ? uiText('m29c33691ecb3') : isPatch ? uiText('m42219adcf198') : isMcp ? uiText('m2a0af6a0010c') : isGoal ? uiText('m0af9f38d3ebc') : uiText('mdab1a62e2569')}</Text>
        {inputHandledByPrompt ? <Text>{uiText('me7bb53e4fecb')}</Text> : <ConfirmInput defaultChoice="cancel" onConfirm={onConfirm} onCancel={onCancel} />}
      </Box>
      {inputHandledByPrompt ? <Text dimColor>{uiText('m28f01d0dca4a')}</Text> : null}
    </Box>
  );
}
