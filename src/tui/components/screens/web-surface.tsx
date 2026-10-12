import {uiText} from '../../../localization/messages.js';
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
    if (!configure) { setError(uiText('mde61249b55a7')); return; }
    setStep("saving");
    try { await configure(provider, secret.current || undefined); secret.current = ""; if (mounted.current) onBack(); }
    catch { secret.current = ""; if (mounted.current) { setError(uiText('m97c3e3ee4986')); setStep("select"); } }
  }
  return <Box flexDirection="column"><Text bold>{uiText('m04e17fbb1be8')}</Text>
    <Text>{uiText('m84d4b07d475f')}</Text>
    <Text>{uiText('m95ec04d9d1a8')}</Text>
    {error && <Text color="red">{error}</Text>}
    {step === "select" && <Select options={[{ label: uiText('mf1dd45c96f33'), value: "html" }, { label: uiText('m62b8047f4b86'), value: "brave" }]} onChange={(value) => { setProvider(value === "brave" ? "brave" : "html"); setStep(value === "brave" ? "key" : "confirm"); }} />}
    {step === "key" && <PasswordInput placeholder={uiText('m837697bf04e4')} onSubmit={(value) => { if (!value.trim()) { setError(uiText('m8d07df2d9ffa')); return; } secret.current = value; setError(undefined); setStep("confirm"); }} />}
    {step === "confirm" && <Select options={[{ label: uiText('m869eda20f445', {p0: provider}), value: "save" }, { label: uiText('m19766ed6ccb2'), value: "cancel" }]} onChange={(value) => { if (value === "save") void save(); else { secret.current = ""; onBack(); } }} />}
    {step === "saving" && <Spinner label={uiText('mffe892644d3e')} />}
    <Text dimColor>{uiText('m6651831681e1')}</Text>
  </Box>;
}
