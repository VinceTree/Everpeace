import type { TestContext } from 'node:test';
import { ChildProcess } from 'node:child_process';
import { nativeProcessBackend, type ProcessReceipt } from '../../src/tools/owned-process.js';
import { randomUUID } from 'node:crypto';

export function mockProcessOwner(context: TestContext, child: ChildProcess, killers: ChildProcess[], onStop: () => void = () => {}, applies: (command: string) => boolean = () => true) {
  const launch = nativeProcessBackend.launch;
  context.mock.method(nativeProcessBackend, 'launch', (command: string, args: readonly string[], options: Parameters<typeof launch>[2]) => {
    if (!applies(command)) return launch(command, args, options);
    return { command, args: [...args], attach() {
      let resolve!: (receipt: ProcessReceipt) => void, stopping = false;
      const receipt = new Promise<ProcessReceipt>(accept => { resolve = accept; });
      child.once('close', (exitCode: number | null) => { if (!stopping) resolve({ status: 'confirmed_exited', exitCode }); });
      return { ownerId: randomUUID(), receipt, stop() {
        if (stopping) return; stopping = true; onStop();
        const killer = new ChildProcess(); killers.push(killer);
        killer.once('close', (code: number) => resolve({ status: code === 0 ? 'confirmed_exited' : 'unknown', exitCode: null }));
      } };
    } };
  });
}
