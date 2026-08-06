import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  buildContaminationScanReport,
  renderContaminationScanReportMarkdown,
  scanCellTrajectory,
  type ContaminationBenchmarkIdentity,
} from '../harness-contamination-scan.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Not the real benchmark's identity, deliberately. This file compiles into the
 * build output a graded arm mounts, so a real revision or task id written here
 * is the leak the scanner exists to find.
 */
const IDENTITY: ContaminationBenchmarkIdentity = {
  upstreamRepositoryUrl: 'https://example.invalid/acme/fixture-bench',
  revision: '0123456789abcdef0123456789abcdef01234567',
  taskTreeFingerprint: 'sha256:fixture-tree-fingerprint',
  taskIds: ['fixture-task-a', 'fixture-task-b', 'fixture-task-c'],
};

function trajectory(steps: unknown[], extra?: Record<string, unknown>): Record<string, unknown> {
  return { steps, ...(extra ? { extra } : {}) };
}

function agentStep(id: number, fields: Record<string, unknown>): Record<string, unknown> {
  return { step_id: id, source: 'agent', ...fields };
}

describe('harness contamination scan', () => {
  test('finds the upstream repository wherever in a step it was named', () => {
    // Which field carries the leak is not predictable: a shell command, the
    // model's own reasoning, and a tool result it read back are all places the
    // #1970 retrieval could have surfaced. Each is a separate step here so a
    // regression that stops walking one of them cannot hide behind the others.
    const report = scanCellTrajectory({
      taskId: 'fixture-task-a',
      identity: IDENTITY,
      trajectory: trajectory([
        agentStep(1, {
          tool_calls: [
            {
              name: 'shell',
              arguments: { command: 'git clone https://example.invalid/acme/fixture-bench' },
            },
          ],
        }),
        agentStep(2, { reasoning_content: 'the tasks live at example.invalid/acme/fixture-bench' }),
        agentStep(3, {
          observation: {
            results: [{ output: 'Cloning into example.invalid/acme/fixture-bench...' }],
          },
        }),
      ]),
    });
    assert.equal(report.analyzable, true);
    assert.deepEqual(
      report.signals.map((signal) => signal.stepId),
      [1, 2, 3],
    );
    assert.ok(report.signals.every((signal) => signal.kind === 'upstream_repository'));
    assert.ok(report.signals[0].excerpt.includes('git clone'), 'excerpt must carry the context');
  });

  test('reports a degraded trajectory as unanswerable, not as clean', () => {
    // The whole point. A 89-cell run once exported every cell as a one-line
    // summary; a scanner that returned "no signals" for those would have
    // pronounced the run clean on the strength of nothing at all.
    const report = scanCellTrajectory({
      taskId: 'fixture-task-a',
      identity: IDENTITY,
      trajectory: trajectory(
        [
          {
            step_id: 1,
            source: 'system',
            message: 'Maka trajectory summary: invocation completed',
          },
        ],
        { maka_artifact_kind: 'summary', maka_summary_reason: 'runtime_event_schema_invalid' },
      ),
    });
    assert.equal(report.analyzable, false);
    assert.match(report.notAnalyzableReason ?? '', /runtime_event_schema_invalid/);
    assert.deepEqual(report.signals, []);

    const rollup = buildContaminationScanReport([report]);
    assert.equal(rollup.notAnalyzable, 1);
    assert.equal(rollup.clean, 0, 'an unreadable cell must never count as a clean one');
  });

  test('matches an abbreviated revision but not a short hex run', () => {
    const abbreviated = scanCellTrajectory({
      taskId: 'fixture-task-a',
      identity: IDENTITY,
      trajectory: trajectory([agentStep(1, { message: 'checked out 0123456789ab' })]),
    });
    assert.deepEqual(
      abbreviated.signals.map((signal) => signal.kind),
      ['pinned_revision'],
    );

    const tooShort = scanCellTrajectory({
      taskId: 'fixture-task-a',
      identity: IDENTITY,
      trajectory: trajectory([agentStep(1, { message: 'sha 0123456789a is unrelated' })]),
    });
    assert.deepEqual(tooShort.signals, []);
  });

  test('flags a task id the cell had no way to learn, and not its own', () => {
    const report = scanCellTrajectory({
      taskId: 'fixture-task-a',
      identity: IDENTITY,
      trajectory: trajectory([
        agentStep(1, { message: 'solving fixture-task-a' }),
        agentStep(2, { message: 'the suite also has fixture-task-c' }),
      ]),
    });
    assert.deepEqual(
      report.signals.map((signal) => [signal.kind, signal.stepId, signal.match]),
      [['foreign_task_id', 2, 'fixture-task-c']],
    );
  });

  test('finds the task tree fingerprint', () => {
    const report = scanCellTrajectory({
      taskId: 'fixture-task-a',
      identity: IDENTITY,
      trajectory: trajectory([
        agentStep(1, { message: 'manifest says sha256:fixture-tree-fingerprint' }),
      ]),
    });
    assert.deepEqual(
      report.signals.map((signal) => signal.kind),
      ['task_tree_fingerprint'],
    );
  });

  test('leaves an ordinary trajectory alone', () => {
    const report = scanCellTrajectory({
      taskId: 'fixture-task-a',
      identity: IDENTITY,
      trajectory: trajectory([
        agentStep(1, { message: 'reading the failing test', tool_calls: [{ name: 'read' }] }),
        agentStep(2, {
          observation: { results: [{ output: 'FAIL tests/test_solver.py::test_rejects' }] },
        }),
      ]),
    });
    assert.equal(report.analyzable, true);
    assert.deepEqual(report.signals, []);
    assert.equal(buildContaminationScanReport([report]).clean, 1);
  });

  test('the rendered report separates unanswerable cells from clean ones', () => {
    const markdown = renderContaminationScanReportMarkdown(
      buildContaminationScanReport([
        scanCellTrajectory({
          taskId: 'fixture-task-a',
          identity: IDENTITY,
          trajectory: trajectory([agentStep(1, { message: 'ordinary work' })]),
        }),
        scanCellTrajectory({
          taskId: 'fixture-task-b',
          identity: IDENTITY,
          trajectory: trajectory([], { maka_artifact_kind: 'summary' }),
        }),
        scanCellTrajectory({
          taskId: 'fixture-task-c',
          identity: IDENTITY,
          trajectory: trajectory([
            agentStep(1, { message: 'https://example.invalid/acme/fixture-bench' }),
          ]),
        }),
      ]),
    );
    assert.match(markdown, /- Clean: 1/);
    assert.match(markdown, /- Not analyzable: 1/);
    assert.match(markdown, /- Flagged: 1/);
    assert.match(markdown, /## fixture-task-b — not analyzable/);
    assert.match(markdown, /## fixture-task-c — 1 signal/);
    assert.ok(!markdown.includes('## fixture-task-a'), 'a clean cell needs no section');
  });

  test('holds no benchmark identity of its own', () => {
    // The scanner runs on the host, but it ships in the build output a graded
    // arm mounts. A real revision, upstream URL or task id written into either
    // file — including as a test fixture — is the leak it exists to find.
    // `harness-ab-manifest.test.ts` holds the same line for the rest of dist.
    const identity = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/headless/harbor/benchmark-identity.json'), 'utf8'),
    ) as {
      terminalBench21: { revision: string; upstreamRepositoryUrl: string; taskIds: string[] };
      deepSwe: { revision: string; upstreamRepositoryUrl: string; full113: { taskIds: string[] } };
    };
    const needles = [
      identity.terminalBench21.revision,
      identity.terminalBench21.upstreamRepositoryUrl,
      identity.deepSwe.revision,
      identity.deepSwe.upstreamRepositoryUrl,
      ...identity.terminalBench21.taskIds,
      ...identity.deepSwe.full113.taskIds,
    ];
    for (const file of [
      'packages/headless/src/harness-contamination-scan.ts',
      'packages/headless/src/__tests__/harness-contamination-scan.test.ts',
    ]) {
      const source = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const needle of needles) {
        assert.ok(!source.includes(needle), `${file} names the benchmark identity ${needle}`);
      }
    }
  });
});
