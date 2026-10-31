import type { BenchmarkCampaignResult } from "./campaign.js";

/** Resample tasks, retaining all repetitions within each selected task. */
export function pairedSuccessInterval(campaign: BenchmarkCampaignResult, baseline: string, candidate: string) {
  const tasks = [...new Set(campaign.planned.filter(item => item.harness === baseline).map(item => item.taskId))].sort();
  const clusters = tasks.map(taskId => {
    const pairs = campaign.planned.filter(item => item.harness === baseline && item.taskId === taskId);
    const differences = pairs.map(pair => {
      const a = campaign.results.find(run => run.adapter === baseline && run.taskId === taskId && run.repetition === pair.repetition);
      const b = campaign.results.find(run => run.adapter === candidate && run.taskId === taskId && run.repetition === pair.repetition);
      return a && b ? Number(b.status === "passed") - Number(a.status === "passed") : null;
    });
    return differences.some(value => value === null) ? null : differences.reduce<number>((sum, value) => sum + value!, 0) / differences.length;
  });
  if (tasks.length < 2 || clusters.some(value => value === null) || !campaign.statisticsComplete) return { method: "task-cluster-bootstrap", taskClusters: tasks.length, pairedDifference: null, interval95: null };
  let state = campaign.seed >>> 0 || 1;
  const draws: number[] = [];
  for (let iteration = 0; iteration < 2000; iteration++) {
    let total = 0;
    for (let index = 0; index < clusters.length; index++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      total += clusters[Math.floor(state / 4294967296 * clusters.length)]!;
    }
    draws.push(total / clusters.length);
  }
  draws.sort((a, b) => a - b);
  return { method: "task-cluster-bootstrap", taskClusters: tasks.length, pairedDifference: clusters.reduce<number>((sum, value) => sum + value!, 0) / clusters.length, interval95: [draws[49]!, draws[1949]!] as [number, number] };
}
