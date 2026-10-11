import { appendFileSync } from "node:fs";

export default async function* reporter(source) {
  const file = process.env.EVERPEACE_NATIVE_EVENTS;
  if (!file) throw new Error("Native evidence file is required");
  for await (const event of source) {
    if (["test:pass", "test:fail", "test:summary"].includes(event.type)) {
      const { name, skip, todo, testNumber, details } = event.data;
      appendFileSync(file, JSON.stringify({ type: event.type, data: { name, skip, todo, testNumber, duration_ms: details?.duration_ms } }) + "\n");
    }
    if (event.type === "test:fail") yield `FAIL ${event.data.name}\n`;
    if (event.type === "test:pass") yield `${event.data.skip ? "SKIP" : "PASS"} ${event.data.name}\n`;
  }
}
