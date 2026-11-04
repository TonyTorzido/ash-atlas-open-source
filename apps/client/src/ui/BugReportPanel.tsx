import type {
  BugReportCategory,
  BugReportClientState,
  BugReportReproducibility,
  BugReportSubmitMessage,
  BugReportSubmitResultMessage
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import { bugReportDiagnostics } from "../diagnostics/bugReportDiagnostics.js";
import { PhoneMenuDestinationShell } from "./PhoneMenuDestinationShell.js";

type Props = {
  open: boolean;
  result: BugReportSubmitResultMessage | null;
  synchronizedNow(): number;
  connectionGeneration(): number;
  captureClientState(): BugReportClientState;
  submit(message: ReturnType<typeof bugReportDiagnostics.buildSubmission>["message"]): boolean;
  onBack(): void;
  onReturnToGame(): void;
};

const CATEGORIES: ReadonlyArray<{ value: BugReportCategory; label: string }> = [
  { value: "gameplay", label: "Gameplay" },
  { value: "movement_travel", label: "Movement / Travel" },
  { value: "combat", label: "Combat" },
  { value: "inventory_items", label: "Inventory / Items" },
  { value: "territory_building", label: "Territory / Building" },
  { value: "ui", label: "UI" },
  { value: "connection_performance", label: "Connection / Performance" },
  { value: "other", label: "Other" }
];

const REPRODUCIBILITY: ReadonlyArray<{
  value: BugReportReproducibility;
  label: string;
}> = [
  { value: "once", label: "Once" },
  { value: "sometimes", label: "Sometimes" },
  { value: "every_time", label: "Every time" },
  { value: "not_sure", label: "Not sure" }
];

export function BugReportPanel({
  open,
  result,
  synchronizedNow,
  connectionGeneration,
  captureClientState,
  submit,
  onBack,
  onReturnToGame
}: Props): React.JSX.Element {
  const [draftId, setDraftId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<BugReportCategory>("gameplay");
  const [description, setDescription] = useState("");
  const [expectedBehavior, setExpectedBehavior] = useState("");
  const [reproducibility, setReproducibility] =
    useState<BugReportReproducibility>("not_sure");
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportCode, setReportCode] = useState<string | null>(null);
  const [retrySubmission, setRetrySubmission] = useState<BugReportSubmitMessage | null>(null);
  const openedRef = useRef(false);
  const handledResultRef = useRef<BugReportSubmitResultMessage | null>(null);
  const draftConnectionGenerationRef = useRef<number | null>(null);

  useEffect(() => {
    if (open && !openedRef.current && draftId === null && reportCode === null) {
      const draft = bugReportDiagnostics.startDraft(synchronizedNow());
      setDraftId(draft.draftId);
      draftConnectionGenerationRef.current = connectionGeneration();
    }
    openedRef.current = open;
  }, [connectionGeneration, draftId, open, reportCode, synchronizedNow]);

  useEffect(() => {
    if (
      !result ||
      result === handledResultRef.current ||
      result.requestId !== pendingRequestId
    ) return;
    handledResultRef.current = result;
    setPendingRequestId(null);
    if (result.success) {
      setReportCode(result.reportCode);
      setRetrySubmission(null);
      setError(null);
      if (draftId) bugReportDiagnostics.discardDraft(draftId);
      setDraftId(null);
      return;
    }
    setError(result.message);
  }, [draftId, pendingRequestId, result]);

  const reset = (): void => {
    if (draftId) bugReportDiagnostics.discardDraft(draftId);
    setDraftId(null);
    setTitle("");
    setCategory("gameplay");
    setDescription("");
    setExpectedBehavior("");
    setReproducibility("not_sure");
    setPendingRequestId(null);
    setError(null);
    setReportCode(null);
    setRetrySubmission(null);
    draftConnectionGenerationRef.current = null;
  };

  const cancel = (): void => {
    if (pendingRequestId) {
      onReturnToGame();
      return;
    }
    reset();
    onBack();
  };

  const submitReport = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (pendingRequestId || reportCode) return;
    if (!title.trim() || !description.trim()) {
      setError("Add a title and describe what happened.");
      return;
    }
    if (!draftId) {
      setError("The diagnostic snapshot is unavailable. Reopen Report a Bug.");
      return;
    }
    try {
      const message = retrySubmission &&
        retrySubmission.title === title &&
        retrySubmission.category === category &&
        retrySubmission.description === description &&
        retrySubmission.expectedBehavior === expectedBehavior &&
        retrySubmission.reproducibility === reproducibility &&
        retrySubmission.connectionGeneration === connectionGeneration()
        ? retrySubmission
        : bugReportDiagnostics.buildSubmission(
          draftId,
          draftConnectionGenerationRef.current ?? connectionGeneration(),
          {
            title,
            category,
            description,
            expectedBehavior,
            reproducibility
          },
          captureClientState()
        ).message;
      if (!submit(message)) {
        setError("The game connection is not ready. Please retry.");
        return;
      }
      setRetrySubmission(message);
      setPendingRequestId(message.requestId);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The report could not be prepared.");
    }
  };

  return (
    <PhoneMenuDestinationShell
      open={open}
      title="Report a Bug"
      {...(reportCode ? {} : { subtitle: "Recent diagnostics were frozen when this app opened." })}
      bodyClassName="bug-report-body"
      onBack={cancel}
      onReturnToGame={onReturnToGame}
    >
      {reportCode ? (
        <section className="bug-report-success" role="status">
          <span aria-hidden="true">✓</span>
          <h2>Bug report submitted</h2>
          <code>{reportCode}</code>
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(reportCode)}
          >
            Copy Report ID
          </button>
          <p>Keep this ID if you want to refer to the report later.</p>
        </section>
      ) : (
        <form className="bug-report-form" onSubmit={submitReport}>
          <label>
            <span>Title <b>{title.length}/80</b></span>
            <input
              required
              maxLength={80}
              value={title}
              placeholder="Tree disappeared after harvesting."
              onChange={(event) => setTitle(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>Category</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.currentTarget.value as BugReportCategory)}
            >
              {CATEGORIES.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>What happened? <b>{description.length}/2000</b></span>
            <textarea
              required
              maxLength={2000}
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
          <label>
            <span>What should have happened? <b>{expectedBehavior.length}/1000</b></span>
            <textarea
              maxLength={1000}
              rows={3}
              value={expectedBehavior}
              onChange={(event) => setExpectedBehavior(event.currentTarget.value)}
            />
          </label>
          <fieldset>
            <legend>How often does it happen?</legend>
            <div>
              {REPRODUCIBILITY.map((option) => (
                <label key={option.value}>
                  <input
                    type="radio"
                    name="bug-report-reproducibility"
                    value={option.value}
                    checked={reproducibility === option.value}
                    onChange={() => setReproducibility(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="bug-report-privacy">
            This report attaches up to five minutes of recent game diagnostics. It does not
            include chat or private messages, Google credentials, or device GPS.
          </p>
          {error ? <p className="bug-report-error" role="alert">{error}</p> : null}
          <button
            className="bug-report-submit"
            type="submit"
            disabled={pendingRequestId !== null}
          >
            {pendingRequestId ? "Submitting…" : "Submit Bug"}
          </button>
        </form>
      )}
    </PhoneMenuDestinationShell>
  );
}
