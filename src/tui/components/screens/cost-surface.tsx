import {uiText,translateHostText} from '../../../localization/messages.js';
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Select, TextInput, Spinner } from "@inkjs/ui";
import { isModelPrice, type ModelPrice } from "../../../status/cost.js";


export function CostSurface({ modelId, status, configure, onBack }: { modelId?: string | undefined; status?: ((modelId: string) => Promise<string>) | undefined; configure?: ((modelId: string, price: ModelPrice) => Promise<void>) | undefined; onBack(): void }) {
const fields = [uiText('mdc81ac88642e'), uiText('m609d936f95b4'), uiText('m5e89de8fba0e'), uiText('m6b13ed4649b0'), uiText('ma7a76b0dc102')];
  const [report, setReport] = useState(uiText('m9935f68a74f8'));
  const [step, setStep] = useState(-1); const [values, setValues] = useState<string[]>([]); const [error, setError] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; void (modelId && status ? status(modelId) : Promise.resolve(uiText('m58562fba1db1'))).then((text) => { if (mounted.current) setReport(text); }, () => { if (mounted.current) setReport(uiText('m86ff90cb912e')); }); return () => { mounted.current = false; }; }, [modelId, status]);
  useInput((_input, key) => { if (key.escape && step !== 6) onBack(); });
  const price: ModelPrice = { currency: (values[0] ?? "").toUpperCase(), input: Number(values[1]), cachedInput: Number(values[2]), output: Number(values[3]), ...(values[4]?.trim() ? { warningThreshold: Number(values[4]) } : {}) };
  async function save() {
    if (!modelId || !configure || !isModelPrice(price) || values.slice(0, 4).some((value) => !value.trim())) { setError(uiText('m97135f12f2c3')); setStep(0); setValues([]); return; }
    setStep(6);
    try { await configure(modelId, price); if (mounted.current) onBack(); }
    catch { if (mounted.current) { setError(uiText('m0ecc345b4384')); setStep(-1); } }
  }
  return <Box flexDirection="column"><Text bold>{uiText('m9ccba222f889')}</Text><Text>{translateHostText(report)}</Text>
    <Text>{uiText('mebe910a5621c')}</Text>
    <Text>{uiText('ma468a12d706e')}</Text>
    {error && <Text color="red">{translateHostText(error)}</Text>}
    {step === -1 && <Select options={[{ label: uiText('m76900f1bfd16'), value: "back" }, { label: uiText('m18d3979fcd8b'), value: "configure" }]} onChange={(value) => { if (value === "back") onBack(); else { setValues([]); setStep(0); } }} />}
    {step >= 0 && step < 5 && <Box flexDirection="column"><Text>{fields[step]}</Text><TextInput key={step} onSubmit={(value) => { setValues((current) => [...current, value]); setStep(step + 1); }} /></Box>}
    {step === 5 && <Box flexDirection="column"><Text>{JSON.stringify(price)}{uiText('m16df46779a62')}</Text><Select options={[{ label: uiText('m19766ed6ccb2'), value: "cancel" }, { label: uiText('m59e96cb1b0bd'), value: "save" }]} onChange={(value) => { if (value === "save") void save(); else onBack(); }} /></Box>}
    {step === 6 && <Spinner label={uiText('m21a0ad2e6ca4')} />}
    <Text dimColor>{uiText('mcca786d78717')}</Text>
  </Box>;
}
