export interface ComposerState {
  value: string;
  /** Cursor offset measured in Unicode code points. */
  cursor: number;
  killBuffer: string;
  preferredColumn: number | null;
}

export function createComposerState(value = ""): ComposerState {
  return {
    value,
    cursor: Array.from(value).length,
    killBuffer: "",
    preferredColumn: null,
  };
}

function characters(value: string): string[] {
  return Array.from(value);
}

function withCharacters(
  state: ComposerState,
  next: string[],
  cursor: number,
  changes?: Partial<Pick<ComposerState, "killBuffer" | "preferredColumn">>,
): ComposerState {
  return {
    value: next.join(""),
    cursor: Math.max(0, Math.min(cursor, next.length)),
    killBuffer: changes?.killBuffer ?? state.killBuffer,
    preferredColumn: changes?.preferredColumn ?? null,
  };
}

function lineStartAt(items: string[], cursor: number): number {
  let index = Math.min(cursor, items.length);
  while (index > 0 && items[index - 1] !== "\n") index -= 1;
  return index;
}

function lineEndAt(items: string[], cursor: number): number {
  let index = Math.min(cursor, items.length);
  while (index < items.length && items[index] !== "\n") index += 1;
  return index;
}

function wordClass(character: string): "space" | "word" | "punctuation" {
  if (/\s/u.test(character)) return "space";
  if (/[\p{L}\p{N}_]/u.test(character)) return "word";
  return "punctuation";
}

function backwardWordStart(items: string[], cursor: number): number {
  let index = cursor;
  while (index > 0 && wordClass(items[index - 1]!) === "space") index -= 1;
  if (index === 0) return index;

  const category = wordClass(items[index - 1]!);
  while (index > 0 && wordClass(items[index - 1]!) === category) index -= 1;
  return index;
}

function forwardWordEnd(items: string[], cursor: number): number {
  let index = cursor;
  while (index < items.length && wordClass(items[index]!) === "space") index += 1;
  if (index === items.length) return index;

  const category = wordClass(items[index]!);
  while (index < items.length && wordClass(items[index]!) === category) index += 1;
  return index;
}

export function insertComposerText(state: ComposerState, text: string): ComposerState {
  const inserted = characters(text.replace(/\r\n?/gu, "\n"));
  if (inserted.length === 0) return state;
  const items = characters(state.value);
  items.splice(state.cursor, 0, ...inserted);
  return withCharacters(state, items, state.cursor + inserted.length);
}

export function moveComposerLeft(state: ComposerState): ComposerState {
  return { ...state, cursor: Math.max(0, state.cursor - 1), preferredColumn: null };
}

export function moveComposerRight(state: ComposerState): ComposerState {
  const length = characters(state.value).length;
  return { ...state, cursor: Math.min(length, state.cursor + 1), preferredColumn: null };
}

export function moveComposerLineStart(state: ComposerState): ComposerState {
  const items = characters(state.value);
  return { ...state, cursor: lineStartAt(items, state.cursor), preferredColumn: null };
}

export function moveComposerLineEnd(state: ComposerState): ComposerState {
  const items = characters(state.value);
  return { ...state, cursor: lineEndAt(items, state.cursor), preferredColumn: null };
}

export function moveComposerWordLeft(state: ComposerState): ComposerState {
  const items = characters(state.value);
  return { ...state, cursor: backwardWordStart(items, state.cursor), preferredColumn: null };
}

export function moveComposerWordRight(state: ComposerState): ComposerState {
  const items = characters(state.value);
  return { ...state, cursor: forwardWordEnd(items, state.cursor), preferredColumn: null };
}

export function moveComposerVertically(
  state: ComposerState,
  direction: -1 | 1,
): ComposerState {
  const items = characters(state.value);
  const currentStart = lineStartAt(items, state.cursor);
  const currentEnd = lineEndAt(items, state.cursor);
  const column = state.preferredColumn ?? state.cursor - currentStart;

  if (direction < 0) {
    if (currentStart === 0) return state;
    const previousEnd = currentStart - 1;
    const previousStart = lineStartAt(items, previousEnd);
    return {
      ...state,
      cursor: Math.min(previousStart + column, previousEnd),
      preferredColumn: column,
    };
  }

  if (currentEnd === items.length) return state;
  const nextStart = currentEnd + 1;
  const nextEnd = lineEndAt(items, nextStart);
  return {
    ...state,
    cursor: Math.min(nextStart + column, nextEnd),
    preferredColumn: column,
  };
}

export function deleteComposerBackward(state: ComposerState): ComposerState {
  if (state.cursor === 0) return state;
  const items = characters(state.value);
  items.splice(state.cursor - 1, 1);
  return withCharacters(state, items, state.cursor - 1);
}

export function deleteComposerForward(state: ComposerState): ComposerState {
  const items = characters(state.value);
  if (state.cursor >= items.length) return state;
  items.splice(state.cursor, 1);
  return withCharacters(state, items, state.cursor);
}

export function deleteComposerWordBackward(state: ComposerState): ComposerState {
  const items = characters(state.value);
  const start = backwardWordStart(items, state.cursor);
  if (start === state.cursor) return state;
  const removed = items.splice(start, state.cursor - start).join("");
  return withCharacters(state, items, start, { killBuffer: removed });
}

export function deleteComposerWordForward(state: ComposerState): ComposerState {
  const items = characters(state.value);
  const end = forwardWordEnd(items, state.cursor);
  if (end === state.cursor) return state;
  const removed = items.splice(state.cursor, end - state.cursor).join("");
  return withCharacters(state, items, state.cursor, { killBuffer: removed });
}

/** Codex Ctrl+U semantics: kill from the cursor to the current line start. */
export function killComposerToLineStart(state: ComposerState): ComposerState {
  const items = characters(state.value);
  let start = lineStartAt(items, state.cursor);
  if (start === state.cursor && start > 0) start -= 1;
  if (start === state.cursor) return state;
  const removed = items.splice(start, state.cursor - start).join("");
  return withCharacters(state, items, start, { killBuffer: removed });
}

/** Codex Ctrl+K semantics: kill from the cursor to the current line end. */
export function killComposerToLineEnd(state: ComposerState): ComposerState {
  const items = characters(state.value);
  let end = lineEndAt(items, state.cursor);
  if (end === state.cursor && end < items.length) end += 1;
  if (end === state.cursor) return state;
  const removed = items.splice(state.cursor, end - state.cursor).join("");
  return withCharacters(state, items, state.cursor, { killBuffer: removed });
}

export function yankComposer(state: ComposerState): ComposerState {
  return insertComposerText(state, state.killBuffer);
}
