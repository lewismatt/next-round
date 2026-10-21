// SPDX-License-Identifier: Apache-2.0
import { createContext, useContext } from "react";

export const SignOutContext = createContext({ busy: false, error: "" });

export function SignOutButton({
  onClick,
  guestConfirmation = false,
}: {
  onClick: () => void;
  guestConfirmation?: boolean;
}) {
  const { busy } = useContext(SignOutContext);
  return (
    <button
      className={guestConfirmation ? "button button-danger" : "button"}
      type="button"
      disabled={busy}
      onClick={onClick}
    >
      {busy ? "Signing out…" : guestConfirmation ? "Sign out and clear guest session" : "Sign out"}
    </button>
  );
}

export function SignOutError() {
  const { error } = useContext(SignOutContext);
  return error ? <p className="error-message" role="alert">{error}</p> : null;
}

/** Keep the lock synchronous: two clicks can arrive before React renders busy. */
export async function submitSignOut({
  lock,
  request,
  onSuccess,
  setBusy,
  setError,
}: {
  lock: { current: boolean };
  request: () => Promise<void>;
  onSuccess: () => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string) => void;
}): Promise<void> {
  if (lock.current) return;
  lock.current = true;
  setError("");
  setBusy(true);
  try {
    await request();
    onSuccess();
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : "The request could not be completed.");
  } finally {
    lock.current = false;
    setBusy(false);
  }
}
