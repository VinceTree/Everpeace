import type { WebEvent } from "../protocol.js";

export function workbenchToken(): string | null {
  const fragment = location.hash.slice(1);
  if (/^[A-Za-z0-9_-]{43}$/u.test(fragment)) {
    sessionStorage.setItem("everpeace-workbench", fragment);
    history.replaceState(null, "", "/");
  }
  return sessionStorage.getItem("everpeace-workbench");
}

export async function action(token: string, name: string, body: object): Promise<void> {
  const response = await fetch(`/api/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json() as { error?: string };
    throw new Error(error.error ?? response.statusText);
  }
}

/** Return false on expired credentials and reconnect on interrupted streams. */
export async function connect(token: string, signal: AbortSignal, receive: (event: WebEvent) => void): Promise<boolean> {
  const response = await fetch("/api/events", { headers: { Authorization: `Bearer ${token}` }, signal });
  if (response.status === 401) return false;
  if (!response.ok || !response.body) throw new Error(response.statusText);
  for await (const event of eventFrames(response.body)) receive(event as WebEvent);
  return true;
}

export async function* eventFrames(body: NonNullable<Response["body"]>): AsyncGenerator<unknown> {
  let buffer = "";
  const stream = body.pipeThrough(new TextDecoderStream());
  for await (const part of stream) {
    buffer += part;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as unknown;
    }
  }
}
