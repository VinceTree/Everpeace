import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select, TextInput, Spinner } from "@inkjs/ui";
import { isModelPrice, type ModelPrice } from "../../../status/cost.js";

const fields = ["Currency (three letters, e.g. USD)", "Input price per million tokens", "Cached input price per million tokens", "Output price per million tokens", "Task warning threshold (blank disables)"];
export function CostSurface({ modelId, status, configure, onBack }: { modelId?: string | undefined; status?: ((modelId: string) => Promise<string>) | undefined; configure?: ((modelId: string, price: ModelPrice) => Promise<void>) | undefined; onBack(): void }) {
  const [report, setReport] = useState("Loading estimates...");
  const [step, setStep] = useState(-1); const [values, setValues] = useState<string[]>([]); const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; void (modelId && status ? status(modelId) : Promise.resolve("No active model or cost accounting unavailable.")).then((text) => { if (mounted.current) setReport(text); }, () => { if (mounted.current) setReport("Cost settings or session estimates could not be read."); }); return () => { mounted.current = false; }; }, [modelId, status]);
  useInput((_input, key) => { if (key.escape && step !== 6) onBack(); });
  const price: ModelPrice = { currency: (values[0] ?? "").toUpperCase(), input: Number(values[1]), cachedInput: Number(values[2]), output: Number(values[3]), ...(values[4]?.trim() ? { warningThreshold: Number(values[4]) } : {}) };
  async function save() {
    if (!modelId || !configure || !isModelPrice(price) || values.slice(0, 4).some((value) => !value.trim())) { setError("Enter a currency and finite nonnegative prices; the warning threshold must be positive."); setStep(0); setValues([]); return; }
    setStep(6);
    try { await configure(modelId, price); if (mounted.current) onBack(); }
    catch { if (mounted.current) { setError("Cost settings could not be saved."); setStep(-1); } }
  }
  return <Box flexDirection="column"><Text bold>Estimated cost</Text><Text>{report}</Text>
    <Text>Request token budget controls request admission. It is not a hard spending limit; in-flight billing may exceed it.</Text>
    <Text>Prices are user supplied. Unknown usage or missing prices remain unknown/partial. No currency conversion is performed.</Text>
    {error && <Text color="red">{error}</Text>}
    {step === -1 && <Select options={[{ label: "Back", value: "back" }, { label: "Configure active model prices", value: "configure" }]} onChange={(value) => { if (value === "back") onBack(); else { setValues([]); setStep(0); } }} />}
    {step >= 0 && step < 5 && <Box flexDirection="column"><Text>{fields[step]}</Text><TextInput key={step} onSubmit={(value) => { setValues((current) => [...current, value]); setStep(step + 1); }} /></Box>}
    {step === 5 && <Box flexDirection="column"><Text>{JSON.stringify(price)} · per million tokens</Text><Select options={[{ label: "Cancel", value: "cancel" }, { label: "Save prices and task warning threshold", value: "save" }]} onChange={(value) => { if (value === "save") void save(); else onBack(); }} /></Box>}
    {step === 6 && <Spinner label="Saving prices" />}
    <Text dimColor>Esc: return to the same session. Changing prices does not rewrite past request estimates.</Text>
  </Box>;
}
