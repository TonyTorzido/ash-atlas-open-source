export function ClientUpdateHelpScreen({
  onTryAgain,
  presentation = "full"
}: {
  onTryAgain(): void;
  presentation?: "full" | "embedded";
}): React.JSX.Element {
  return (
    <main className={`client-update-help${presentation === "embedded" ? " client-update-help--embedded" : ""}`}>
      <section className="client-update-help__card" aria-labelledby="client-update-help-title">
        <p className="client-update-help__eyebrow">Ash Atlas</p>
        <h1 id="client-update-help-title">Clear cache to continue</h1>
        <p>The game files could not refresh automatically. Clear this site’s saved files, then open Ash Atlas again.</p>
        <p>Clearing site data can sign you out. If that happens, sign in again with the same account; player progress is saved to your account.</p>
        <details>
          <summary>iPhone Safari</summary>
          <p>Open Settings → Apps → Safari → Advanced → Website Data. Search for <strong>playashatlas.com</strong> and delete its data.</p>
        </details>
        <details>
          <summary>Installed web app</summary>
          <p>Remove Ash Atlas from your Home Screen. Open <strong>playashatlas.com/play</strong> in Safari, then add it to the Home Screen again.</p>
        </details>
        <details>
          <summary>Android Chrome</summary>
          <p>Open Chrome → Settings → Site settings → All sites → <strong>playashatlas.com</strong> → Clear &amp; reset.</p>
        </details>
        <button type="button" className="auth-primary" onClick={onTryAgain}>Try loading again</button>
      </section>
    </main>
  );
}
