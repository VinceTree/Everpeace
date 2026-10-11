import React from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
export function ActionConfirmation({ text, start, cancel }: { text: string; start(): void; cancel(): void }) {
  useInput((_input, key) => { if (key.escape) cancel(); });
  return <Box flexDirection="column"><Text>{text}</Text><Select options={[{ label: "Cancel", value: "cancel" }, { label: "Start diagnostic requests", value: "start" }]} onChange={(value) => value === "start" ? start() : cancel()} /></Box>;
}
