import { Select } from "@inkjs/ui";
import { Text } from "ink";
import React from "react";
import type { McpTrustPreview } from "../../../mcp/trust.js";
import { CommandSurface } from "./command-surface.js";

export function McpTrustSurface({ preview, onApprove, onCancel }: { preview: McpTrustPreview; onApprove(): void; onCancel(): void }) {
  return <CommandSurface title="/mcp · Startup trust" onBack={onCancel}>
    <Text>{preview.summary}</Text>
    <Text>Approval is saved for this workspace and exact configuration.</Text>
    <Select options={[{ label: "Cancel", value: "cancel" }, { label: "Approve startup", value: "approve" }]} onChange={(value) => value === "approve" ? onApprove() : onCancel()} />
  </CommandSurface>;
}
