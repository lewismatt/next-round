// SPDX-License-Identifier: Apache-2.0
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SignOutButton, SignOutContext, SignOutError, submitSignOut } from "./sign-out.js";

function presentation(busy: boolean, error: string, guestConfirmation = false) {
  return renderToStaticMarkup(createElement(SignOutContext.Provider, {
    value: { busy, error },
    children: [
      createElement(SignOutButton, { key: "button", onClick: () => {}, guestConfirmation }),
      createElement(SignOutError, { key: "error" }),
    ],
  }));
}

describe("Shared sign-out presentation", () => {
  it("disables ordinary and guest-confirmation controls while pending", () => {
    for (const guest of [false, true]) {
      const html = presentation(true, "", guest);
      expect(html).toMatch(/<button[^>]*disabled=""/);
      expect(html).toContain("Signing out…");
      expect(html).not.toContain('role="alert"');
    }
  });
  it("shows escaped failure text with an enabled retry control", () => {
    for (const guest of [false, true]) {
      const html = presentation(false, "<script>failure</script>", guest);
      expect(html).toContain('role="alert"');
      expect(html).toContain("&lt;script&gt;failure&lt;/script&gt;");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain('disabled=""');
      expect(html).toContain(guest ? "Sign out and clear guest session" : "Sign out");
    }
  });
});

describe("Production sign-out submission", () => {
  it("locks concurrent submissions, retains the session after failure and clears errors before a successful retry", async () => {
    let busy = false;
    let error = "stale failure";
    let session: object | null = { player: "existing player" };
    const originalSession = session;
    let rejectRequest!: (cause: unknown) => void;
    let resolveRequest!: () => void;
    const request = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectRequest = reject; }))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { resolveRequest = resolve; }));
    const onSuccess = vi.fn(() => { session = null; });
    const options = {
      lock: { current: false },
      request,
      onSuccess,
      setBusy: (next: boolean) => { busy = next; },
      setError: (next: string) => { error = next; },
    };

    const first = submitSignOut(options);
    expect(busy).toBe(true);
    expect(error).toBe("");
    expect(presentation(busy, error)).toContain("Signing out…");
    await submitSignOut(options);
    expect(request).toHaveBeenCalledTimes(1);
    rejectRequest(new Error("Unable to sign out"));
    await first;
    expect(session).toBe(originalSession);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(options.lock.current).toBe(false);
    expect(busy).toBe(false);
    expect(error).toBe("Unable to sign out");
    expect(presentation(busy, error)).toContain('role="alert"');

    const retry = submitSignOut(options);
    expect(error).toBe("");
    expect(busy).toBe(true);
    expect(presentation(busy, error)).not.toContain('role="alert"');
    expect(request).toHaveBeenCalledTimes(2);
    resolveRequest();
    await retry;
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(session).toBeNull();
    expect(busy).toBe(false);
    expect(options.lock.current).toBe(false);
    expect(error).toBe("");
  });
});
