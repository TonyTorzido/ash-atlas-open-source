export function consumeAppleCallbackMessage(): string | null {
  const url = new URL(window.location.href);
  const outcome = url.searchParams.get("apple_auth");
  if (outcome !== "cancelled" && outcome !== "provider_error") return null;
  url.searchParams.delete("apple_auth");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return outcome === "cancelled"
    ? "Apple sign-in was canceled. Please try again when you're ready."
    : "Apple sign-in could not be completed. Please try again.";
}
