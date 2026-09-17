/** Close interrupted tool batches before subsequent messages, without rerunning tools. */
export function repairToolContext(items: readonly Record<string, unknown>[]): Array<Record<string, unknown>> {
  const repaired: Array<Record<string, unknown>> = [];
  const pending = new Set<string>();
  const completed = new Set<string>();
  const closePending = () => {
    for (const callId of pending) {
      repaired.push({ type: "function_call_output", call_id: callId, output: JSON.stringify({ status: "interrupted", error: "No tool result was recorded. Execution outcome is unknown; do not assume success." }) });
      completed.add(callId);
    }
    pending.clear();
  };
  for (const item of items) {
    if (item.type === "function_call_output" && typeof item.call_id === "string") {
      if (!pending.has(item.call_id) || completed.has(item.call_id)) continue;
      pending.delete(item.call_id);
      completed.add(item.call_id);
    } else if (item.type === "function_call" && typeof item.call_id === "string") {
      pending.add(item.call_id);
    } else if (item.role === "user") {
      closePending();
    }
    repaired.push({ ...item });
  }
  closePending();
  return repaired;
}
