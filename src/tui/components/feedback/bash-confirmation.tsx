import {uiText} from '../../../localization/messages.js';
import { ConfirmInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import React from "react";
import { HighlightedCommand } from "../../rendering/rich-text.js";

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
      <Text color="yellow">{uiText('m243a4acff95c')}</Text>
      <HighlightedCommand command={command} shell="Bash" />
      <Box>
        <Text>{uiText('m29c33691ecb3')}</Text>
        <ConfirmInput defaultChoice="cancel" onConfirm={onConfirm} onCancel={onCancel} />
      </Box>
    </Box>
  );
}
