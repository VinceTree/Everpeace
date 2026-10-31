import {uiText} from '../../../localization/messages.js';
import { Select } from "@inkjs/ui";
import { Text } from "ink";
import React from "react";
import type { McpTrustPreview } from "../../../mcp/trust.js";
import { CommandSurface } from "./command-surface.js";

export function McpTrustSurface({ preview, onApprove, onCancel }: { preview: McpTrustPreview; onApprove(): void; onCancel(): void }) {
  return <CommandSurface title={uiText('m741279c7487a')} onBack={onCancel}>
    <Text>{preview.summary}</Text>
    <Text>{uiText('m817cfe6c84fe')}</Text>
    <Select options={[{ label: uiText('m19766ed6ccb2'), value: "cancel" }, { label: uiText('m8b05806d9d4a'), value: "approve" }]} onChange={(value) => value === "approve" ? onApprove() : onCancel()} />
  </CommandSurface>;
}
