import {uiText} from '../../../localization/messages.js';
import { Select, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { AgentMode, PlanRequest, PlanReviewResult, SubmittedPlan } from "../../../plan/runtime.js";
import { RichOutput } from "../../rendering/rich-text.js";
import { CommandSurface } from "./command-surface.js";

export function PlanQuestionsSurface({ request, mode = "plan", onComplete, onCancel }: {
  request: PlanRequest;
  mode?: AgentMode;
  onComplete(answers: Record<string, string>): void;
  onCancel(): void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState(false);
  const question = request.questions[index]!;
  useInput((_input, key) => { if (key.escape) onCancel(); });
  const choose = (answer: string) => {
    const next = { ...answers, [question.id]: answer };
    if (index + 1 === request.questions.length) onComplete(next);
    else { setAnswers(next); setIndex(index + 1); setOther(false); }
  };
  return (
    <CommandSurface title={`${mode === "plan" ? "/plan" : "/question"} · ${question.header}`}>
      <Text bold>{question.question}</Text>
      <Text dimColor>{uiText('m39821a754d34')}{index + 1}{uiText('ma4282e4b2298')}{request.questions.length}</Text>
      {other ? (
        <Box marginTop={1}><Text color="#4EC9B0">{uiText('m21319351b6db')}</Text><TextInput placeholder={uiText('me89a1919d78b')} onSubmit={(value) => { if (value.trim()) choose(value.trim()); }} /></Box>
      ) : (
        <Select options={[
          ...question.options.map((option) => ({ label: `${option.label} - ${option.description}`, value: option.label })),
          { label: uiText('mf97e9da0e3b8'), value: "__other__" },
        ]} onChange={(value) => value === "__other__" ? setOther(true) : choose(value)} />
      )}
      <Text dimColor>{mode === "plan" ? uiText('md281ae3d2d4a') : uiText('mcfb77cea36b1')}</Text>
    </CommandSurface>
  );
}

export function PlanReviewSurface({ submitted, onDecision, onCancelTask }: {
  submitted: SubmittedPlan;
  onDecision(decision: PlanReviewResult): void;
  onCancelTask(): void;
}) {
  const [revising, setRevising] = useState(false);
  useInput((input, key) => {
    if (key.ctrl && input === "c") onCancelTask();
    else if (key.escape) {
      if (revising) setRevising(false);
      else onDecision("cancel");
    }
  });
  return (
    <CommandSurface title={uiText('m40dcf2be77fc', {p0: submitted.title})}>
      <RichOutput text={submitted.plan} />
      <Box marginTop={1} flexDirection="column">
        {revising ? (
          <TextInput placeholder={uiText('m01fd6d1b5a68')} onSubmit={(value) => {
            const feedback = value.trim();
            if (feedback) onDecision({ decision: "continue", feedback });
          }} />
        ) : (
          <Select options={[
            { label: uiText('m3cb71b35ce24'), value: "approve" },
            { label: uiText('m0bdb3346296f'), value: "continue" },
            { label: uiText('m2e5d129831b6'), value: "cancel" },
          ]} onChange={(value) => value === "continue" ? setRevising(true) : onDecision(value as "approve" | "cancel")} />
        )}
      </Box>
      <Text dimColor>{revising ? uiText('m0ce752530520') : uiText('md281ae3d2d4a')}{uiText('md3fa31f013d6')}</Text>
    </CommandSurface>
  );
}

export function ApprovedPlanSurface({ submitted, onBack }: { submitted: SubmittedPlan; onBack(): void }) {
  return (
    <CommandSurface title={uiText('mccf60ab79239', {p0: submitted.title})} onBack={onBack}>
      <RichOutput text={submitted.plan} />
      <Text dimColor>{uiText('md62684a89e5d')}</Text>
    </CommandSurface>
  );
}
