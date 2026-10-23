import { terminateProcessTree } from './process-completion.js';

/** Request process-tree termination and wait for the platform kill request to settle. */
export function stopProcessTree(pid: number): Promise<void> {
  return terminateProcessTree(pid);
}
