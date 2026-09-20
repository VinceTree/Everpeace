import { Select, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { PlanRequest, PlanReviewDecision, SubmittedPlan } from "../../../plan/runtime.js";
import { RichOutput } from "../../rendering/rich-text.js";
import { CommandSurface } from "./command-surface.js";

export function PlanQuestionsSurface({ request, onComplete, onCancel }: {
  request: PlanRequest;
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
    <CommandSurface title={`/plan · ${question.header}`}>
      <Text bold>{question.question}</Text>
      <Text dimColor>Question {index + 1} of {request.questions.length}</Text>
      {other ? (
        <Box marginTop={1}><Text color="#4EC9B0">Other ❯ </Text><TextInput placeholder="Enter your answer" onSubmit={(value) => { if (value.trim()) choose(value.trim()); }} /></Box>
      ) : (
        <Select options={[
          ...question.options.map((option) => ({ label: `${option.label} - ${option.description}`, value: option.label })),
          { label: "Other", value: "__other__" },
        ]} onChange={(value) => value === "__other__" ? setOther(true) : choose(value)} />
      )}
      <Text dimColor>Esc to cancel planning</Text>
    </CommandSurface>
  );
}

export function PlanReviewSurface({ submitted, onDecision }: {
  submitted: SubmittedPlan;
  onDecision(decision: PlanReviewDecision): void;
}) {
  useInput((_input, key) => { if (key.escape) onDecision("cancel"); });
  return (
    <CommandSurface title={`/plan · ${submitted.title}`}>
      <RichOutput text={submitted.plan} />
      <Box marginTop={1} flexDirection="column">
        <Select options={[
          { label: "Approve and execute", value: "approve" },
          { label: "Keep planning", value: "continue" },
          { label: "Cancel plan", value: "cancel" },
        ]} onChange={(value) => onDecision(value as PlanReviewDecision)} />
      </Box>
    </CommandSurface>
  );
}
