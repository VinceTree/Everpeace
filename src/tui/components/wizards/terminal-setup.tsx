import { ConfirmInput } from "@inkjs/ui";
import { Text } from "ink";
import React, { useEffect, useState } from "react";
import { promises as fs } from "node:fs";
import { applyTerminalSettings, prepareTerminalSettings, terminalSettingsPath } from "../../terminal/settings.js";
import { CommandSurface } from "../screens/command-surface.js";

export function TerminalSetup({ onBack }: { onBack(): void }) {
  const [preview, setPreview] = useState<{ file: string; before: string; after: string }>();
  const [message, setMessage] = useState("Loading settings...");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const file = terminalSettingsPath();
      const before = await fs.readFile(file, "utf8");
      const after = prepareTerminalSettings(before);
      if (active) { setPreview({ file, before, after }); setMessage(""); }
    })().catch((e: unknown) => { if (active) setMessage(String(e)); });
    return () => { active = false; };
  }, []);
  return <CommandSurface title="/terminal-setup" {...(!busy ? { onBack } : {})}>
    <Text>{message}</Text>
    {preview && !busy ? <>
      <Text wrap="truncate-middle">{preview.file}</Text>
      <Text>+ Shift+Enter: sendInput "\n"</Text>
      <Text color="yellow">Applies to other programs in Windows Terminal too. Existing settings will be backed up. Apply?</Text>
      <ConfirmInput defaultChoice="cancel" onCancel={onBack} onConfirm={() => {
        setBusy(true);
        void applyTerminalSettings(preview.file, preview.before, preview.after)
          .then((backup) => { setPreview(undefined); setMessage(`Applied. Backup: ${backup}`); })
          .catch((e: unknown) => { setPreview(undefined); setMessage(String(e)); })
          .finally(() => setBusy(false));
      }} />
    </> : null}
  </CommandSurface>;
}
