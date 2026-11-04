import { useState } from "react";

import {
  COMMUNITY_REPORT_CATEGORIES,
  type CommunityReportCategory
} from "../community/communitySafetyClient.js";
import { GameActionPrompt } from "./GameActionPrompt.js";

const REPORT_CATEGORY_LABELS: Readonly<Record<CommunityReportCategory, string>> = {
  harassment: "Harassment or bullying",
  hate: "Hate or identity attack",
  sexual: "Sexual content or exploitation",
  threat: "Threat or encouragement of harm",
  illegal: "Illegal or dangerous content",
  spam: "Spam or scam",
  cheating: "Cheating or exploit abuse",
  other: "Other concern"
};

export function CommunityReportPrompt({
  targetLabel,
  onSubmit,
  onCancel
}: Readonly<{
  targetLabel: string;
  onSubmit(category: CommunityReportCategory, explanation: string | null): void | Promise<void>;
  onCancel(): void;
}>): React.JSX.Element {
  const [category, setCategory] = useState<CommunityReportCategory>("other");
  const [explanation, setExplanation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(category, explanation.trim() || null);
      onCancel();
    } catch (nextError) {
      setBusy(false);
      setError(nextError instanceof Error ? nextError.message : "The report could not be submitted.");
    }
  };

  return <GameActionPrompt
    modal
    movable={false}
    elevated
    title={`Report ${targetLabel}`}
    category="COMMUNITY SAFETY"
    detail="Choose the closest reason. Add context only if it helps a reviewer understand what happened."
    message={error ? { text: error, tone: "error" } : null}
    content={<div className="community-report-fields">
      <fieldset className="community-report-reasons" disabled={busy}>
        <legend>Reason</legend>
        <div role="radiogroup" aria-label="Report reason">
          {COMMUNITY_REPORT_CATEGORIES.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={category === value}
              onClick={() => setCategory(value)}
            >
              {REPORT_CATEGORY_LABELS[value]}
            </button>
          ))}
        </div>
      </fieldset>
      <label>
        <span>Additional details (optional)</span>
        <textarea
          aria-label="Report details"
          value={explanation}
          maxLength={1_000}
          rows={3}
          disabled={busy}
          onChange={(event) => setExplanation(event.currentTarget.value)}
        />
      </label>
    </div>}
    actions={[{
      key: "submit-report",
      label: busy ? "Submitting…" : "Submit Report",
      busy,
      onSelect: () => void submit()
    }]}
    onCancel={() => {
      if (!busy) onCancel();
    }}
  />;
}
