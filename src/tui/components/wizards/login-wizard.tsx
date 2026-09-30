import { PasswordInput, Select, Spinner, TextInput } from "@inkjs/ui";
import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import {
  getProviderDefinition,
  normalizeBaseUrl,
} from "../../../providers/openai-compatible.js";
import type { RegisteredModel } from "../../../storage/model-registry.js";
import type { TuiDependencies } from "../../app/types.js";
import { providerKind } from "../../../providers/capabilities.js";

type LoginStep = "provider" | "base-url" | "api-key" | "loading" | "model" | "saving";

export interface LoginWizardProps {
  dependencies: TuiDependencies;
  onComplete(model: RegisteredModel): void;
  onCancel(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function LoginWizard({
  dependencies,
  onComplete,
  onCancel,
}: LoginWizardProps) {
  const [step, setStep] = useState<LoginStep>("provider");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const requestController = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      requestController.current?.abort();
    },
    [],
  );

  const cancel = () => {
    requestController.current?.abort();
    setApiKey("");
    onCancel();
  };

  useInput((_input, key) => {
    const wantsToCancel = key.escape || (key.ctrl && _input === "c");
    if (wantsToCancel && step !== "saving") cancel();
  });

  const selectProvider = (provider: string) => {
    setError(undefined);
    if (provider === "custom") {
      setBaseUrl("");
      setStep("base-url");
      return;
    }

    if (provider === "deepseek" || provider === "openai") {
      setBaseUrl(getProviderDefinition(provider).baseURL);
      setStep("api-key");
    }
  };

  const submitBaseUrl = (value: string) => {
    try {
      setBaseUrl(normalizeBaseUrl(value));
      setError(undefined);
      setStep("api-key");
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const loadModels = (value: string) => {
    const normalizedKey = value.trim();
    if (!normalizedKey) {
      setError("API Key cannot be empty");
      return;
    }

    const controller = new AbortController();
    requestController.current = controller;
    setApiKey(normalizedKey);
    setError(undefined);
    setStep("loading");

    void dependencies
      .listModels(baseUrl, normalizedKey, controller.signal)
      .then((availableModels) => {
        if (controller.signal.aborted || !mounted.current) return;
        if (availableModels.length === 0) {
          throw new Error("The endpoint returned no models");
        }
        const ordered = providerKind(baseUrl) === "deepseek" && availableModels.includes("deepseek-flash")
          ? ["deepseek-flash", ...availableModels.filter((model) => model !== "deepseek-flash")]
          : availableModels;
        setModels(ordered);
        setStep("model");
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted || !mounted.current) return;
        setApiKey("");
        setError(errorMessage(caught));
        setStep("api-key");
      });
  };

  const selectModel = (modelName: string) => {
    setError(undefined);
    setStep("saving");

    void dependencies.registry
      .registerMany(baseUrl, [modelName], apiKey)
      .then(() => dependencies.registry.resolveAll())
      .then((resolved) => {
        if (!mounted.current) return;
        const model = resolved.available.find(
          (candidate) =>
            candidate.base_url === baseUrl && candidate.model_name === modelName,
        );
        if (!model) throw new Error("Saved model credential could not be loaded");
        setApiKey("");
        onComplete(model);
      })
      .catch((caught: unknown) => {
        if (!mounted.current) return;
        setApiKey("");
        setError(errorMessage(caught));
        setStep("api-key");
      });
  };

  const deepseek = getProviderDefinition("deepseek");
  const openai = getProviderDefinition("openai");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="#D4AF37" paddingX={1}>
      <Text bold color="#D4AF37">
        /login · Model sign-in
      </Text>

      {error ? <Text color="red">{error}</Text> : null}

      {step === "provider" ? (
        <Select
          options={[
            {
              label: deepseek.displayName,
              value: "deepseek",
            },
            {
              label: openai.displayName,
              value: "openai",
            },
            { label: "Custom OpenAI-compatible endpoint", value: "custom" },
          ]}
          onChange={selectProvider}
        />
      ) : null}

      {step === "base-url" ? (
        <Box>
          <Text color="#4EC9B0">Base URL ❯ </Text>
          <TextInput placeholder="https://api.example.com/v1" onSubmit={submitBaseUrl} />
        </Box>
      ) : null}

      {step === "api-key" ? (
        <Box>
          <Text color="#4EC9B0">API Key ❯ </Text>
          <PasswordInput
            placeholder="Input is hidden"
            onChange={setApiKey}
            onSubmit={loadModels}
          />
        </Box>
      ) : null}

      {step === "loading" ? <Spinner label="Loading model list" /> : null}

      {step === "model" ? (
        <Box flexDirection="column">
          <Text dimColor>Choose a model. Names retain the server's original IDs:</Text>
          <Select
            options={models.map((model) => ({ label: model, value: model }))}
            visibleOptionCount={Math.min(8, models.length)}
            onChange={selectModel}
          />
        </Box>
      ) : null}

      {step === "saving" ? <Spinner label="Securely saving credentials and enabling model" /> : null}

      {step !== "saving" ? (
        <Text dimColor>Enter confirm · Esc to return to session</Text>
      ) : null}
    </Box>
  );
}
