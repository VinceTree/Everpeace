import React, { useState, useRef, useEffect } from "react";
import { Box, Text, useInput } from "ink";
import { Select, PasswordInput, Spinner } from "@inkjs/ui";

export function WebSurface({ configure, onBack }: { configure?: ((provider: "html" | "brave", key?: string) => Promise<void>) | undefined; onBack(): void }) {
  const [step, setStep] = useState<"select" | "key" | "confirm" | "saving">("select");
  const [provider, setProvider] = useState<"html" | "brave">("html");
  const [error, setError] = useState<string>();
  const secret = useRef(""); const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; secret.current = ""; }, []);
  useInput((_input, key) => { if (key.escape && step !== "saving") { secret.current = ""; onBack(); } });
  async function save() {
    if (!configure) { setError("Web configuration is unavailable in this host."); return; }
    setStep("saving");
    try { await configure(provider, secret.current || undefined); secret.current = ""; if (mounted.current) onBack(); }
    catch { secret.current = ""; if (mounted.current) { setError("Web settings could not be saved. Check credential storage and try again."); setStep("select"); } }
  }
  return <Box flexDirection="column"><Text bold>Web search provider</Text>
    <Text>HTML search is the default. Brave uses your LLM Context API subscription and may incur charges.</Text>
    <Text>Keys are stored in the system credential store. No test request is sent when configuring.</Text>
    {error && <Text color="red">{error}</Text>}
    {step === "select" && <Select options={[{ label: "HTML search", value: "html" }, { label: "Brave LLM Context", value: "brave" }]} onChange={(value) => { setProvider(value === "brave" ? "brave" : "html"); setStep(value === "brave" ? "key" : "confirm"); }} />}
    {step === "key" && <PasswordInput placeholder="Brave API key" onSubmit={(value) => { if (!value.trim()) { setError("A Brave API key is required."); return; } secret.current = value; setError(undefined); setStep("confirm"); }} />}
    {step === "confirm" && <Select options={[{ label: `Save ${provider} provider`, value: "save" }, { label: "Cancel", value: "cancel" }]} onChange={(value) => { if (value === "save") void save(); else { secret.current = ""; onBack(); } }} />}
    {step === "saving" && <Spinner label="Saving web settings" />}
    <Text dimColor>Esc: return to the same session</Text>
  </Box>;
}
