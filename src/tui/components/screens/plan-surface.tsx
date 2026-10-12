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
      <Text dimColor>Question {index + 1} of {request.questions.length}</Text>
      {other ? (
        <Box marginTop={1}><Text color="#4EC9B0">Other ❯ </Text><TextInput placeholder="Enter your answer" onSubmit={(value) => { if (value.trim()) choose(value.trim()); }} /></Box>
      ) : (
        <Select options={[
          ...question.options.map((option) => ({ label: `${option.label} - ${option.description}`, value: option.label })),
          { label: "Other", value: "__other__" },
        ]} onChange={(value) => value === "__other__" ? setOther(true) : choose(value)} />
      )}
      <Text dimColor>{mode === "plan" ? "Esc to cancel planning" : "Esc to cancel the active task"}</Text>
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
    <CommandSurface title={`/plan · ${submitted.title}`}>
      <RichOutput text={submitted.plan} />
      <Box marginTop={1} flexDirection="column">
        {revising ? (
          <TextInput placeholder="Describe the changes to this plan" onSubmit={(value) => {
            const feedback = value.trim();
            if (feedback) onDecision({ decision: "continue", feedback });
          }} />
        ) : (
          <Select options={[
            { label: "Approve plan", value: "approve" },
            { label: "Revise plan", value: "continue" },
            { label: "Cancel plan", value: "cancel" },
          ]} onChange={(value) => value === "continue" ? setRevising(true) : onDecision(value as "approve" | "cancel")} />
        )}
      </Box>
      <Text dimColor>{revising ? "Esc to return to review" : "Esc to cancel planning"} · Ctrl+C to cancel the active task</Text>
    </CommandSurface>
  );
}

export function ApprovedPlanSurface({ submitted, onBack }: { submitted: SubmittedPlan; onBack(): void }) {
  return (
    <CommandSurface title={`/plan show · ${submitted.title}`} onBack={onBack}>
      <RichOutput text={submitted.plan} />
      <Text dimColor>Approved for this session. Run /plan execute to start.</Text>
    </CommandSurface>
  );
}
