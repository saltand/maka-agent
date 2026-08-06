#!/usr/bin/env node
/**
 * Scan a finished run's trajectories for signs an arm looked the answer up.
 *
 * Host-only, like everything else in this directory that touches benchmark
 * identity: the scan needs the upstream URL, pinned revision and task list to
 * search for, and those are exactly what must not be reachable from inside a
 * graded container. The scanner itself holds none of them — it takes them as an
 * argument, and this is where they are loaded.
 *
 * Usage:
 *   node run-contamination-scan.mjs --jobs-dir <dir> [--benchmark terminal-bench-2.1|deep-swe]
 *                                   [--json <path>] [--markdown <path>]
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildContaminationScanReport,
  renderContaminationScanReportMarkdown,
  scanCellTrajectory,
} from '#harness-contamination-scan';
import { BENCHMARK_IDENTITY } from './benchmark-identity.mjs';

/** Where Harbor's agent leaves its ATIF trajectory inside a trial directory. */
const TRIAL_TRAJECTORY = 'agent/trajectory.json';

function identityFor(benchmark) {
  if (benchmark === 'deep-swe') {
    const { upstreamRepositoryUrl, revision, full113 } = BENCHMARK_IDENTITY.deepSwe;
    return {
      upstreamRepositoryUrl,
      revision,
      taskTreeFingerprint: full113.taskTreeFingerprint,
      taskIds: full113.taskIds,
    };
  }
  return BENCHMARK_IDENTITY.terminalBench21;
}

/**
 * Every trial directory under a run, with the task it was graded on.
 *
 * Harbor lays a job out as `<jobs-dir>/<job>/<trial>/`, and a trial directory
 * is named for its task, optionally with a `__`-separated attempt suffix —
 * `findTrialDir` in `harbor-task-runner.ts` matches on exactly that shape.
 * Reading the tree rather than a manifest lets a partially finished run, or one
 * whose manifest was never written, still be scanned.
 */
async function discoverTrials(jobsDir) {
  const trials = [];
  for (const job of await readdir(jobsDir, { withFileTypes: true })) {
    if (!job.isDirectory()) continue;
    const jobPath = join(jobsDir, job.name);
    for (const trial of await readdir(jobPath, { withFileTypes: true })) {
      if (!trial.isDirectory()) continue;
      trials.push({
        taskId: trial.name.split('__')[0],
        path: join(jobPath, trial.name),
      });
    }
  }
  return trials;
}

export async function scanRun({ jobsDir, benchmark }) {
  const identity = identityFor(benchmark);
  const cells = [];
  for (const trial of await discoverTrials(jobsDir)) {
    const trajectoryPath = join(trial.path, TRIAL_TRAJECTORY);
    let trajectory;
    try {
      trajectory = JSON.parse(await readFile(trajectoryPath, 'utf8'));
    } catch (error) {
      // A trial with no readable trajectory is not a clean trial. Say which it
      // is and let the report count it as unanswerable.
      cells.push({
        taskId: trial.taskId,
        analyzable: false,
        notAnalyzableReason: `could not read ${TRIAL_TRAJECTORY}: ${error.message}`,
        stepCount: 0,
        signals: [],
      });
      continue;
    }
    cells.push(scanCellTrajectory({ taskId: trial.taskId, identity, trajectory }));
  }
  return buildContaminationScanReport(cells);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) continue;
    args[flag.slice(2)] = argv[index + 1];
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args['jobs-dir']) throw new Error('--jobs-dir is required');
  const report = await scanRun({
    jobsDir: args['jobs-dir'],
    benchmark: args.benchmark ?? 'terminal-bench-2.1',
  });
  if (args.json) await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderContaminationScanReportMarkdown(report);
  if (args.markdown) await writeFile(args.markdown, markdown);
  else process.stdout.write(markdown);
  // Flagged cells need a human to look; unanswerable ones need the export
  // fixed before the question can even be asked. Neither is a clean run, and
  // neither should be swallowed by a zero exit in a script.
  return report.flagged > 0 || report.notAnalyzable > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exit(2);
    },
  );
}
