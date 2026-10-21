// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useNavigate } from "react-router";
import { getSetupStatus, setupInstance } from "./api.js";

export function SetupGate({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError("");
    void getSetupStatus().then((status) => {
      if (!cancelled) setConfigured(status.configured);
    }).catch(() => {
      if (!cancelled) setError("Could not check instance setup. Try again.");
    });
    return () => { cancelled = true; };
  }, [attempt]);
  if (configured === true) return children;
  return (
    <main className="center-page">
      <section className="card auth-card">
        {configured === false ? <SetupForm onComplete={() => {
          navigate("/login", { replace: true });
          setConfigured(true);
        }} /> : <>
          <h1 className="page-title">Next Round</h1>
          {error ? <><p role="alert" className="error-message">{error}</p>
            <button className="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button></>
            : <p role="status">Checking instance setup…</p>}
        </>}
      </section>
    </main>
  );
}

export function SetupForm({ onComplete }: { onComplete: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const text = (name: string) => String(data.get(name) ?? "");
    if (text("password") !== text("confirmation")) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await setupInstance({ setupToken: text("setupToken"), instanceName: text("instanceName"),
        username: text("username"), displayName: text("displayName"), password: text("password") });
      form.reset();
      onComplete();
    } catch (cause) {
      // Never display submitted values or retain credentials in browser storage.
      setError(cause instanceof Error ? cause.message : "Setup could not be completed.");
    } finally {
      setBusy(false);
    }
  }
  return <>
    <h1 className="page-title">Set up Next Round</h1>
    <p className="page-intro">Create this instance and its first administrator. You will sign in after setup.</p>
    <form onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="field"><label htmlFor="setup-token">Setup token</label>
          <input id="setup-token" name="setupToken" type="password" autoComplete="off" required maxLength={1024} />
          <p className="hint">Use the SETUP_TOKEN from your server configuration.</p></div>
        <div className="field"><label htmlFor="setup-instance">Instance name</label>
          <input id="setup-instance" name="instanceName" required maxLength={100} defaultValue="Next Round" /></div>
        <div className="field"><label htmlFor="setup-username">Admin username</label>
          <input id="setup-username" name="username" autoComplete="username" required minLength={3} maxLength={32} /></div>
        <div className="field"><label htmlFor="setup-display">Display name</label>
          <input id="setup-display" name="displayName" required maxLength={80} /></div>
        <div className="field"><label htmlFor="setup-password">Password</label>
          <input id="setup-password" name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={256} /></div>
        <div className="field"><label htmlFor="setup-confirm">Confirm password</label>
          <input id="setup-confirm" name="confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={256} /></div>
        <p className="hint">Match history is visible to participants. Eligible multiplayer statistics are visible to instance members. Rejoining players can read earlier chat. Match records and notifications are retained until removed.</p>
        {error && <p className="error-message" role="alert">{error}</p>}
        <button className="button button-primary" type="submit">{busy ? "Creating administrator…" : "Create instance and admin"}</button>
      </fieldset>
    </form>
  </>;
}
