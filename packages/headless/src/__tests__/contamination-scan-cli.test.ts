import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execFileAsync = promisify(execFile);

const SCRIPT = new URL('../../harbor/run-contamination-scan.mjs', import.meta.url).pathname;

async function writeTrial(
  jobsDir: string,
  job: string,
  trial: string,
  trajectory: unknown,
): Promise<void> {
  const agentDir = join(jobsDir, job, trial, 'agent');
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, 'trajectory.json'), JSON.stringify(trajectory));
}

/**
 * The run tree the scanner walks, built here rather than described: the
 * `<jobs-dir>/<job>/<trial>/agent/trajectory.json` layout is Harbor's, not
 * ours, and a scanner pointed at the wrong depth reports a clean run because it
 * found no trials at all.
 *
 * No benchmark identity appears here. A scan that matched would have to name a
 * real revision or task id in a file that compiles into the container's mount,
 * which is the leak this whole path exists to detect — so the trials below
 * exercise the tree, the degraded-export gate, and the exit code instead.
 */
test('the contamination scan walks a run tree and refuses to call a degraded cell clean', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maka-contamination-cli-'));
  try {
    const jobsDir = join(dir, 'jobs');
    await writeTrial(jobsDir, 'ab-maka-r0', 'task-ordinary', {
      steps: [{ step_id: 1, source: 'agent', message: 'read the failing test' }],
    });
    // The attempt suffix Harbor appends when a task is retried; the task id is
    // what precedes it.
    await writeTrial(jobsDir, 'ab-maka-r0', 'task-degraded__2', {
      steps: [{ step_id: 1, source: 'system', message: 'Maka trajectory summary' }],
      extra: { maka_artifact_kind: 'summary', maka_summary_reason: 'runtime_event_schema_invalid' },
    });

    const jsonPath = join(dir, 'report.json');
    const error = await execFileAsync(process.execPath, [
      SCRIPT,
      '--jobs-dir',
      jobsDir,
      '--json',
      jsonPath,
    ]).then(
      () => null,
      (thrown: { code?: number; stdout?: string }) => thrown,
    );
    // A run with an unreadable cell exits non-zero: the question could not be
    // answered for it, and a zero exit in a script reads as "no contamination".
    assert.equal(error?.code, 1, 'an unanswerable cell must not exit clean');

    const report = JSON.parse(
      await import('node:fs/promises').then((fs) => fs.readFile(jsonPath, 'utf8')),
    ) as {
      cells: Array<{ taskId: string; analyzable: boolean }>;
      clean: number;
      notAnalyzable: number;
    };
    assert.equal(report.clean, 1);
    assert.equal(report.notAnalyzable, 1);
    assert.deepEqual(report.cells.map((cell) => [cell.taskId, cell.analyzable]).sort(), [
      ['task-degraded', false],
      ['task-ordinary', true],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
