// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { GameManifest } from "@next-round/contracts";
import type { AdminGameSummary, MatchCard } from "./api.js";

export function HistoryMatches({ finished, games, loading, error }: {
  finished: MatchCard[];
  games: GameManifest[];
  loading: boolean;
  error: string;
}) {
  return <>
    {error && <p className="error-message" role="alert">{error}</p>}
    {loading && <p role="status">Loading your history…</p>}
    <section className="section" aria-labelledby="history-matches-heading">
      <h2 id="history-matches-heading" className="section-heading">Finished matches</h2>
      <div className="card-grid">
        {finished.map((match) => <article className="card" key={match.id}>
          <h3>{games.find((game) => game.id === match.moduleId)?.name ?? "Game"}</h3>
          <p className="card-meta">{match.mode} game · Finished</p>
          <Link className="button button-primary" to={`/matches/${encodeURIComponent(match.id)}`}>View result</Link>
        </article>)}
        {!loading && finished.length === 0 && <p className="status-message">No finished matches yet.</p>}
      </div>
    </section>
  </>;
}

export function AdminAccess({ isAdmin, children }: { isAdmin: boolean; children: ReactNode }) {
  return isAdmin ? <>{children}</> : <main className="app-main">
    <h1 className="page-title">Admin</h1>
    <p className="status-message">Administrator access is required.</p>
  </main>;
}

export function AdminModule({ game, busy, onDefault, onToggle }: {
  game: AdminGameSummary;
  busy: boolean;
  onDefault: (game: AdminGameSummary, version: string) => void;
  onToggle: (game: AdminGameSummary) => void;
}) {
  return <article className="card">
    <h3>{game.id}</h3>
    <p className="card-meta">
      {game.enabled ? "Enabled" : "Disabled"} · {game.referenceCounts.total} matches (
      {game.referenceCounts.lobby} waiting, {game.referenceCounts.active} in progress,{" "}
      {game.referenceCounts.finished} finished)
    </p>
    <div className="field">
      <label htmlFor={`default-${game.id}`}>Default version</label>
      <select id={`default-${game.id}`} value={game.defaultVersion} disabled={busy}
        onChange={(event) => onDefault(game, event.target.value)}>
        {game.versions.map((version) => <option key={version.version} value={version.version}>
          {version.version}{version.hasClientAssets ? "" : " (client missing)"}
        </option>)}
      </select>
    </div>
    <div className="inline-actions">
      <button className="button" type="button" disabled={busy} onClick={() => onToggle(game)}>
        {game.enabled ? "Disable module" : "Enable module"}
      </button>
    </div>
  </article>;
}
