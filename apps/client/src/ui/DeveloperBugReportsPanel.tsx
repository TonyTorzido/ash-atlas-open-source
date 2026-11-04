import { useEffect, useState } from "react";

type DeveloperBugReport = Readonly<{
  reportCode: string;
  submittedAt: string;
  title: string;
  category: string;
  description: string;
  expectedBehavior: string;
  reproducibility: string;
  status: string;
  releaseGeneration: string | null;
  exportStatus: string;
}>;

type Props = Readonly<{
  serverHttpBase?: string | undefined;
}>;

export function DeveloperBugReportsPanel({ serverHttpBase }: Props): React.JSX.Element {
  const [reports, setReports] = useState<readonly DeveloperBugReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!serverHttpBase) {
      setReports([]);
      setError("Bug reports are unavailable without a game server.");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const url = new URL("/api/dev/bug-reports", serverHttpBase);
    url.searchParams.set("limit", "100");
    void fetch(url, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Bug report list failed (${response.status})`);
        return response.json() as Promise<{ reports: DeveloperBugReport[] }>;
      })
      .then((result) => setReports(result.reports))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Bug reports are unavailable");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, serverHttpBase]);

  return (
    <section className="developer-bug-reports" aria-label="Player bug reports">
      <div className="dev-quick-actions">
        <div>
          <span className="eyebrow">Player support</span>
          <h3>Bug Reports</h3>
        </div>
        <button type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          Refresh
        </button>
      </div>
      <p className="muted">Durable reports submitted through Report a Bug. Only developer-authorized accounts can view this list.</p>
      {loading ? <p role="status">Loading bug reports…</p> : null}
      {error ? <p role="alert" className="dev-feedback">{error}</p> : null}
      {!loading && !error && reports.length === 0 ? <p className="muted">No player bug reports have been submitted.</p> : null}
      <div className="developer-bug-reports-list">
        {reports.map((report) => (
          <article className="developer-bug-report-entry" key={report.reportCode}>
            <header>
              <div>
                <strong>{report.title}</strong>
                <small>{report.reportCode} · {formatLabel(report.category)}</small>
              </div>
              <span className="developer-bug-report-status">{formatLabel(report.status)}</span>
            </header>
            <p>{report.description}</p>
            {report.expectedBehavior ? <p><strong>Expected:</strong> {report.expectedBehavior}</p> : null}
            <footer>
              <small>
                <time dateTime={report.submittedAt}>{formatSubmittedAt(report.submittedAt)}</time>
                {" · "}{formatLabel(report.reproducibility)}
                {" · export: "}{formatLabel(report.exportStatus)}
                {report.releaseGeneration ? ` · ${report.releaseGeneration}` : ""}
              </small>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

function formatLabel(value: string): string {
  return value
    .split(/[_-]/u)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatSubmittedAt(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}
