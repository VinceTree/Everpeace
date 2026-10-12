import type { Prompter } from "./terminal.js";

export function parseNumberSelection(
  input: string,
  itemCount: number,
  multiple: boolean,
): number[] | undefined {
  const normalized = input.trim().toLowerCase();
  if (normalized === "q") return undefined;
  if (!normalized) return [];

  const parts = multiple ? normalized.split(",") : [normalized];
  if (parts.some((part) => !/^\d+$/.test(part.trim()))) return [];

  const indexes = [...new Set(parts.map((part) => Number(part.trim()) - 1))];
  if (indexes.some((index) => index < 0 || index >= itemCount)) return [];
  return indexes;
}

export async function selectOne<T>(
  title: string,
  items: readonly T[],
  label: (item: T) => string,
  prompter: Prompter,
): Promise<T | undefined> {
  prompter.write(`\n${title}:\n`);
  items.forEach((item, index) => prompter.write(`  ${index + 1}. ${label(item)}\n`));
  prompter.write("  q. Cancel\n");

  while (true) {
    const selected = parseNumberSelection(
      await prompter.ask("\nSelect: "),
      items.length,
      false,
    );
    if (selected === undefined) return undefined;
    const item = items[selected[0] ?? -1];
    if (item !== undefined) return item;
    prompter.write("Invalid selection. Enter a listed number or q.\n");
  }
}

export async function selectMany<T>(
  title: string,
  items: readonly T[],
  label: (item: T) => string,
  prompter: Prompter,
): Promise<T[] | undefined> {
  prompter.write(`\n${title}:\n`);
  items.forEach((item, index) => prompter.write(`  ${index + 1}. ${label(item)}\n`));
  prompter.write("  q. Cancel\n");

  while (true) {
    const selected = parseNumberSelection(
      await prompter.ask("\nSelect one or more numbers (comma-separated): "),
      items.length,
      true,
    );
    if (selected === undefined) return undefined;
    if (selected.length > 0) return selected.map((index) => items[index]!);
    prompter.write("Invalid selection. Use listed numbers separated by commas, or q.\n");
  }
}
