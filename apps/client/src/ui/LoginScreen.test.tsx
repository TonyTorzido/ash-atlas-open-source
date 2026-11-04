// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LoginScreen } from "./LoginScreen.js";

describe("LoginScreen development profiles", () => {
  it("keeps legal links on the website when rendered in the native client", () => {
    const html = renderToStaticMarkup(
      <LoginScreen
        googleClientId=""
        nativeLoginEnabled
        nativeWebsiteBase="https://playashatlas.com"
        developmentAuthEnabled={false}
        busy={false}
        message={null}
        onGoogleCredential={vi.fn()}
        onNativeLogin={vi.fn()}
        onDeveloperLogin={vi.fn()}
      />
    );
    expect(html).toContain('href="https://playashatlas.com/privacy"');
    expect(html).toContain('href="https://playashatlas.com/terms"');
  });

  it("keeps sign-in in the original auth card rather than Miscellaneous", () => {
    const html = renderToStaticMarkup(
      <LoginScreen
        googleClientId="google-client"
        developmentAuthEnabled={false}
        busy={false}
        message={null}
        onGoogleCredential={vi.fn()}
        onDeveloperLogin={vi.fn()}
      />
    );
    expect(html).toContain('class="auth-copy"');
    expect(html).toContain('class="google-button-slot"');
    expect(html).not.toContain("Miscellaneous");
    expect(html).not.toContain("Sign out");
  });

  it("renders an accessible, equally prominent white Apple web provider button", () => {
    const html = renderToStaticMarkup(
      <LoginScreen
        googleClientId="google-client"
        appleSignInEnabled
        developmentAuthEnabled={false}
        busy={false}
        message={null}
        onGoogleCredential={vi.fn()}
        onAppleLogin={vi.fn()}
        onDeveloperLogin={vi.fn()}
      />
    );
    expect(html).toContain('class="auth-provider-options"');
    expect(html).toContain('class="auth-provider-button apple-provider-button"');
    expect(html).toContain('aria-label="Continue with Apple"');
    expect(html).toContain('src="/brand/sign-in-with-apple-continue-white@3x.png"');
    expect(html).toContain('width="320"');
    expect(html).toContain('height="44"');
    expect(html).toContain('alt=""');
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("");
  });

  it("keeps the native handoff neutral when Apple is available", () => {
    const html = renderToStaticMarkup(
      <LoginScreen
        googleClientId="google-client"
        appleSignInEnabled
        nativeLoginEnabled
        nativeWebsiteBase="https://playashatlas.com"
        developmentAuthEnabled={false}
        busy={false}
        message={null}
        onGoogleCredential={vi.fn()}
        onNativeLogin={vi.fn()}
        onAppleLogin={vi.fn()}
        onDeveloperLogin={vi.fn()}
      />
    );
    expect(html).toContain(">Continue with Google or Apple</button>");
    expect(html).not.toContain("apple-provider-button");
    expect(html).not.toContain(">Continue with Apple</button>");
  });

  it("shows all four local account choices only when server capability is enabled", () => {
    const enabled = renderToStaticMarkup(
      <LoginScreen
        googleClientId=""
        developmentAuthEnabled
        busy={false}
        message={null}
        onGoogleCredential={vi.fn()}
        onDeveloperLogin={vi.fn()}
      />
    );
    for (const label of ["Default Dev", "Dev Player 2", "Dev Player 3", "Dev Player 4"]) {
      expect(enabled).toContain(label);
    }

    const disabled = renderToStaticMarkup(
      <LoginScreen
        googleClientId=""
        developmentAuthEnabled={false}
        busy={false}
        message={null}
        onGoogleCredential={vi.fn()}
        onDeveloperLogin={vi.fn()}
      />
    );
    expect(disabled).not.toContain("Default Dev");
    expect(disabled).not.toContain("Dev Player 2");
  });
});

describe("LoginScreen email sign-in", () => {
  afterEach(cleanup);

  const baseProps = {
    googleClientId: "",
    developmentAuthEnabled: false,
    busy: false,
    message: null,
    onGoogleCredential: vi.fn(),
    onDeveloperLogin: vi.fn()
  };

  it("renders the email option only when the server enables it", () => {
    const off = renderToStaticMarkup(
      <LoginScreen {...baseProps} onEmailStart={vi.fn()} onEmailVerify={vi.fn()} />
    );
    expect(off).not.toContain("Continue with email");

    const on = renderToStaticMarkup(
      <LoginScreen {...baseProps} emailSignInEnabled onEmailStart={vi.fn()} onEmailVerify={vi.fn()} />
    );
    expect(on).toContain("Continue with email");
  });

  it("leaves email to the web login page when rendered in the native client", () => {
    const html = renderToStaticMarkup(
      <LoginScreen
        {...baseProps}
        emailSignInEnabled
        nativeLoginEnabled
        onNativeLogin={vi.fn()}
        onEmailStart={vi.fn()}
        onEmailVerify={vi.fn()}
      />
    );
    expect(html).not.toContain("Continue with email");
  });

  it("walks email, code, resend timer, and back with inline friendly errors", async () => {
    const onEmailStart = vi.fn(async () => ({
      ok: true as const,
      resendAvailableAt: Date.now() + 60_000,
      codeTtlSeconds: 600
    }));
    const { AuthApiError } = await import("../auth/authClient.js");
    const onEmailVerify = vi
      .fn<(email: string, code: string) => Promise<void>>()
      .mockRejectedValueOnce(new AuthApiError("EMAIL_CODE_INVALID", "raw", 400))
      .mockResolvedValue(undefined);

    render(<LoginScreen {...baseProps} emailSignInEnabled onEmailStart={onEmailStart} onEmailVerify={onEmailVerify} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with email" }));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: " Player@Example.com " } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));

    await screen.findByLabelText("6-digit code");
    expect(onEmailStart).toHaveBeenCalledWith("Player@Example.com");
    expect(screen.getByRole("button", { name: /Resend in \d+s/ })).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "12ab34-56" } });
    expect((screen.getByLabelText("6-digit code") as HTMLInputElement).value).toBe("123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((await screen.findByRole("alert")).textContent).toBe("That code is invalid or has expired.");
    expect((screen.getByLabelText("6-digit code") as HTMLInputElement).value).toBe("");

    fireEvent.change(screen.getByLabelText("6-digit code"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(onEmailVerify).toHaveBeenLastCalledWith("Player@Example.com", "654321"));

    fireEvent.click(screen.getByRole("button", { name: "Use a different email" }));
    expect(screen.getByLabelText("Email address")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Continue with email" })).toBeTruthy();
  });

  it("shows a friendly inline message when the email domain is rejected", async () => {
    const { AuthApiError } = await import("../auth/authClient.js");
    const onEmailStart = vi.fn().mockRejectedValue(new AuthApiError("EMAIL_DOMAIN_NOT_ALLOWED", "raw", 400));
    render(<LoginScreen {...baseProps} emailSignInEnabled onEmailStart={onEmailStart} onEmailVerify={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue with email" }));
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "x@mailinator.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Email sign-in supports Gmail, Outlook/Hotmail, Yahoo, iCloud, AOL and GMX. You can also continue with Google or Apple."
    );
  });
});
