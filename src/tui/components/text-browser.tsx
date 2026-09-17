import { Select, ConfirmInput } from "@inkjs/ui";
import { Text, useInput, useWindowSize } from "ink";
import React, { useEffect, useMemo, useState } from "react";
import { CommandSurface } from "./command-surface.js";
import { textWidth } from "../text-width.js";

export function TextBrowser({ title, entries, onBack, onClear }: {
  title: string;
  entries: Array<{ label: string; text: string }>;
  onBack(): void;
  onClear?: () => Promise<void>;
}) {
  const [selected, setSelected] = useState<number>();
  const [offset, setOffset] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const { rows, columns } = useWindowSize();
  const page = Math.max(1, rows - 10);
  const width = Math.max(1, Math.min(80, columns - 2) - 4);
  const selectedText = selected === undefined ? "" : entries[selected]?.text ?? "";
  const lines = useMemo(() => selectedText.split("\n").flatMap((line) => {
    const wrapped: string[] = [];
    let current = "";
    for (const character of line) {
      if (current && textWidth(current + character) > width) { wrapped.push(current); current = ""; }
      current += character;
    }
    wrapped.push(current);
    return wrapped;
  }), [selectedText, width]);
  useEffect(() => setOffset((current) => Math.min(current, Math.max(0, lines.length - page))), [lines.length, page]);
  useInput((_input, key) => {
    if (selected === undefined) return;
    if (key.upArrow) setOffset((n) => Math.max(0, n - 1));
    if (key.downArrow) setOffset((n) => Math.min(Math.max(0, lines.length - page), n + 1));
    if (key.pageUp) setOffset((n) => Math.max(0, n - page));
    if (key.pageDown) setOffset((n) => Math.min(Math.max(0, lines.length - page), n + page));
    if (key.home) setOffset(0);
    if (key.end) setOffset(Math.max(0, lines.length - page));
  });
  return <CommandSurface title={title} onBack={() => {
    if (clearing) setClearing(false);
    else if (selected !== undefined) setSelected(undefined);
    else onBack();
  }}>
    {error ? <Text color="red">{error}</Text> : null}
    {clearing ? <><Text>Clear all global input history? Session records will remain.</Text><ConfirmInput defaultChoice="cancel" onCancel={() => setClearing(false)} onConfirm={() => {
      void onClear?.().then(onBack).catch((e: unknown) => { setError(String(e)); setClearing(false); });
    }} /></> : selected !== undefined ? <>
      <Text>{`${offset + 1}-${Math.min(lines.length, offset + page)} / ${lines.length}`}</Text>
      {lines.slice(offset, offset + page).map((line, index) => <Text key={index} wrap="wrap">{line || " "}</Text>)}
    </> : entries.length || onClear ? <Select visibleOptionCount={Math.min(8, page)} options={[
      ...entries.map((entry, index) => ({ label: entry.label.replace(/\s+/g, " ").slice(0, Math.max(1, Math.floor((width - 3) / 2))), value: String(index) })),
      ...(onClear ? [{ label: "Clear history...", value: "clear" }] : []),
    ]} onChange={(value) => {
      if (value === "clear") setClearing(true);
      else { setSelected(Number(value)); setOffset(0); }
    }} /> : <Text>No entries</Text>}
  </CommandSurface>;
}
