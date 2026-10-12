import {uiText} from '../localization/messages.js';
import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";

class MuteableOutput extends Writable {
  muted = false;
  readonly #target: NodeJS.WriteStream;

  constructor(target: NodeJS.WriteStream) {
    super();
    this.#target = target;
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.muted) {
      callback();
      return;
    }
    this.#target.write(chunk, encoding, callback);
  }
}

export interface Prompter {
  ask(prompt: string): Promise<string>;
  askSecret(prompt: string): Promise<string>;
  write(text: string): void;
  writeError(text: string): void;
  pause(): void;
  resume(): void;
  close(): void;
}

export class TerminalPrompter implements Prompter {
  readonly #output = new MuteableOutput(stdout);
  readonly #readline: Interface;

  constructor() {
    this.#readline = createInterface({
      input: stdin,
      output: this.#output,
      terminal: Boolean(stdin.isTTY && stdout.isTTY),
    });
  }

  ask(prompt: string): Promise<string> {
    if (!stdin.isTTY || !stdout.isTTY) return Promise.reject(new Error(uiText('accessible.nonTTY')));
    return this.#readline.question(prompt);
  }

  async askSecret(prompt: string): Promise<string> {
    if (!stdin.isTTY || !stdout.isTTY) {
      throw new Error(uiText('m8fe829639f07'));
    }

    stdout.write(prompt);
    this.#output.muted = true;
    try {
      return await this.#readline.question("");
    } finally {
      this.#output.muted = false;
      stdout.write("\n");
    }
  }

  write(text: string): void {
    stdout.write(text);
  }

  writeError(text: string): void {
    process.stderr.write(text);
  }

  pause(): void {
    this.#readline.pause();
  }

  resume(): void {
    this.#readline.resume();
  }

  close(): void {
    this.#readline.close();
  }
}
