import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import React from "react";
import { SLASH_COMMANDS } from "../commands.js";

export interface PromptProps {
  inputKey: number;
  activeModelName: string | undefined;
  disabled?: boolean;
  onSubmit(value: string): void;
}

export function Prompt({
  inputKey,
  activeModelName,
  disabled = false,
  onSubmit,
}: PromptProps) {
  return (
    <Box
      width="100%"
      height={3}
      minHeight={3}
      maxHeight={3}
      flexDirection="column"
      borderStyle="round"
      borderColor="#4EC9B0"
      backgroundColor="#1F2937"
      paddingX={1}
      overflow="hidden"
    >
      <Box height={1} flexWrap="nowrap" overflow="hidden">
        <Box flexShrink={0}>
          <Text bold color="#D4AF37">
            everpeace
          </Text>
          <Text color="#4EC9B0"> ❯ </Text>
        </Box>
        <Box height={1} minWidth={0} flexGrow={1} overflow="hidden">
          <TextInput
            key={inputKey}
            isDisabled={disabled}
            placeholder={activeModelName ? "Ask Everpeace to do anything" : "输入 /login 开始"}
            suggestions={[...SLASH_COMMANDS]}
            onSubmit={onSubmit}
          />
        </Box>
      </Box>
    </Box>
  );
}
