import {uiText} from '../../../localization/messages.js';
import React from "react";
import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
export function ActionConfirmation({ text, start, cancel, startLabel = uiText('m2755c914e39f') }: { text: string; start(): void; cancel(): void; startLabel?: string }) {
  useInput((_input, key) => { if (key.escape) cancel(); });
  return <Box flexDirection="column"><Text>{text}</Text><Select options={[{ label: uiText('m19766ed6ccb2'), value: "cancel" }, { label: startLabel, value: "start" }]} onChange={(value) => value === "start" ? start() : cancel()} /></Box>;
}
