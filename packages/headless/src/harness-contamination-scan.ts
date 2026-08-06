/**
 * Whether a graded cell's trajectory shows the arm looking the answer up.
 *
 * In the #1970 run an arm read the benchmark's pinned revision out of its
 * mount, fetched the task's reference solution from the public repository at
 * that exact revision, and recorded a pass that measured retrieval. The mounts
 * have since been narrowed so that identity is not reachable, but a narrowed
 * mount is a claim about one path; this is the check that the claim held, made
 * after the fact against what the arm actually did.
 *
 * The identity itself never appears here. A graded arm executes this package's
 * build output, so a benchmark's revision, upstream URL or task list compiled
 * into `dist` is readable from inside the container being scored — the very
 * leak this exists to detect. The caller loads `harbor/benchmark-identity.json`
 * on the host and passes it in, exactly as `assertFrozenTaskSet` takes its
 * expected set rather than holding one.
 */

/** The benchmark facts a container must not be able to see. */
export interface ContaminationBenchmarkIdentity {
  upstreamRepositoryUrl: string;
  revision: string;
  taskTreeFingerprint: string;
  taskIds: readonly string[];
}

export type ContaminationSignalKind =
  | 'upstream_repository'
  | 'pinned_revision'
  | 'task_tree_fingerprint'
  | 'foreign_task_id';

export interface ContaminationSignal {
  kind: ContaminationSignalKind;
  /** The trajectory step the evidence is in, so a reviewer can go read it. */
  stepId: number | null;
  /** What matched, verbatim. */
  match: string;
  /** Surrounding text, bounded, so the match can be judged without the file. */
  excerpt: string;
}

export interface CellContaminationReport {
  taskId: string;
  /**
   * False when the trajectory cannot answer the question. A degraded export
   * carries no steps to search, and reporting "no signals" for it would read as
   * evidence of cleanliness — which is how an entire run can be pronounced
   * clean on nothing at all.
   */
  analyzable: boolean;
  notAnalyzableReason?: string;
  stepCount: number;
  signals: ContaminationSignal[];
}

export interface ContaminationScanReport {
  schemaVersion: 'maka.harness_contamination.report.v1';
  cells: CellContaminationReport[];
  /** Cells whose trajectory could not be searched. Never folded into `clean`. */
  notAnalyzable: number;
  flagged: number;
  clean: number;
}

/**
 * How much of a commit hash has to appear before a match means anything.
 *
 * A full hash is unambiguous; a short prefix is not, and hex runs occur in
 * ordinary output. Twelve is what git itself treats as unambiguous at this repo
 * scale, and short enough to still catch an arm that abbreviated the revision
 * it found.
 */
const MIN_REVISION_PREFIX = 12;

const EXCERPT_RADIUS = 80;

function excerptAround(haystack: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(haystack.length, index + length + EXCERPT_RADIUS);
  return `${start > 0 ? '…' : ''}${haystack.slice(start, end)}${end < haystack.length ? '…' : ''}`;
}

/**
 * Every string a trajectory step carries, flattened.
 *
 * Which field a leak lands in is not something to predict: an arm may name the
 * upstream in a shell command, in its own reasoning, or in a tool result it
 * read back. Walking the step whole costs nothing and cannot be outflanked by
 * an exporter adding a field.
 */
function stepText(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stepText(item, out);
  else if (value && typeof value === 'object') {
    for (const nested of Object.values(value as Record<string, unknown>)) stepText(nested, out);
  }
  return out;
}

function stepId(step: Record<string, unknown>): number | null {
  return typeof step.step_id === 'number' ? step.step_id : null;
}

/** The repository's identity in a URL, without the scheme or a `.git` suffix. */
function repositoryNeedle(upstreamRepositoryUrl: string): string {
  return upstreamRepositoryUrl
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

function revisionNeedles(revision: string): RegExp | null {
  if (revision.length < MIN_REVISION_PREFIX) return null;
  return new RegExp(revision.slice(0, MIN_REVISION_PREFIX), 'gi');
}

function pushMatches(
  signals: ContaminationSignal[],
  kind: ContaminationSignalKind,
  id: number | null,
  text: string,
  pattern: RegExp,
): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    signals.push({
      kind,
      stepId: id,
      match: match[0],
      excerpt: excerptAround(text, index, match[0].length),
    });
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The reason this trajectory cannot be searched, or undefined if it can.
 *
 * `maka_artifact_kind: summary` is the exporter saying it could not build a
 * trajectory — the whole of a 89-cell run once exported that way, and a scan
 * that called those cells clean would have been reporting on nothing.
 */
function notAnalyzableReason(
  trajectory: Record<string, unknown>,
  steps: unknown[],
): string | undefined {
  const extra = trajectory.extra;
  if (extra && typeof extra === 'object') {
    const kind = (extra as Record<string, unknown>).maka_artifact_kind;
    if (kind === 'summary') {
      const reason = (extra as Record<string, unknown>).maka_summary_reason;
      return `trajectory degraded to a summary${typeof reason === 'string' ? `: ${reason}` : ''}`;
    }
  }
  if (steps.length === 0) return 'trajectory carries no steps';
  return undefined;
}

/** Scan one cell's ATIF trajectory against the benchmark it was graded under. */
export function scanCellTrajectory(input: {
  taskId: string;
  identity: ContaminationBenchmarkIdentity;
  trajectory: unknown;
}): CellContaminationReport {
  const trajectory =
    input.trajectory && typeof input.trajectory === 'object'
      ? (input.trajectory as Record<string, unknown>)
      : {};
  const steps = Array.isArray(trajectory.steps) ? trajectory.steps : [];
  const reason = notAnalyzableReason(trajectory, steps);
  if (reason !== undefined) {
    return {
      taskId: input.taskId,
      analyzable: false,
      notAnalyzableReason: reason,
      stepCount: steps.length,
      signals: [],
    };
  }

  const repository = repositoryNeedle(input.identity.upstreamRepositoryUrl);
  const repositoryPattern = new RegExp(escapeRegExp(repository), 'gi');
  const revisionPattern = revisionNeedles(input.identity.revision);
  const fingerprintPattern = new RegExp(escapeRegExp(input.identity.taskTreeFingerprint), 'gi');
  // The cell's own task id is the task it was told to solve; every other id in
  // the set is one it had no legitimate way to learn.
  const foreignTaskIds = input.identity.taskIds.filter((taskId) => taskId !== input.taskId);

  const signals: ContaminationSignal[] = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    const id = stepId(step as Record<string, unknown>);
    for (const text of stepText(step)) {
      pushMatches(signals, 'upstream_repository', id, text, repositoryPattern);
      if (revisionPattern) pushMatches(signals, 'pinned_revision', id, text, revisionPattern);
      pushMatches(signals, 'task_tree_fingerprint', id, text, fingerprintPattern);
      for (const foreign of foreignTaskIds) {
        if (!text.includes(foreign)) continue;
        pushMatches(signals, 'foreign_task_id', id, text, new RegExp(escapeRegExp(foreign), 'g'));
      }
    }
  }

  return { taskId: input.taskId, analyzable: true, stepCount: steps.length, signals };
}

export function buildContaminationScanReport(
  cells: readonly CellContaminationReport[],
): ContaminationScanReport {
  const notAnalyzable = cells.filter((cell) => !cell.analyzable).length;
  const flagged = cells.filter((cell) => cell.analyzable && cell.signals.length > 0).length;
  return {
    schemaVersion: 'maka.harness_contamination.report.v1',
    cells: [...cells],
    notAnalyzable,
    flagged,
    clean: cells.length - notAnalyzable - flagged,
  };
}

export function renderContaminationScanReportMarkdown(report: ContaminationScanReport): string {
  const lines = [
    '# Contamination scan',
    '',
    `- Cells scanned: ${report.cells.length}`,
    `- Flagged: ${report.flagged}`,
    `- Clean: ${report.clean}`,
    // Stated on its own line and never added to `clean`: a cell nothing could
    // be read from is not a cell that was found to be clean.
    `- Not analyzable: ${report.notAnalyzable}`,
    '',
  ];
  for (const cell of report.cells) {
    if (!cell.analyzable) {
      lines.push(`## ${cell.taskId} — not analyzable`, '', `${cell.notAnalyzableReason}`, '');
      continue;
    }
    if (cell.signals.length === 0) continue;
    lines.push(`## ${cell.taskId} — ${cell.signals.length} signal(s)`, '');
    for (const signal of cell.signals) {
      lines.push(
        `- \`${signal.kind}\` at step ${signal.stepId ?? '?'}: matched \`${signal.match}\``,
        '',
        '  ```',
        ...signal.excerpt.split('\n').map((line) => `  ${line}`),
        '  ```',
        '',
      );
    }
  }
  return lines.join('\n');
}
