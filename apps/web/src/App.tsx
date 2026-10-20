// SPDX-License-Identifier: Apache-2.0
import { useEffect, useId, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  Link,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import type { GameManifest, Json } from "@next-round/contracts";
import type {
  GameBridge,
  GameClient,
  MatchSnapshot,
} from "@next-round/game-client";
import {
  acceptInvitation,
  act,
  ApiError,
  createGuestInvite,
  createMatch,
  createMatchLink,
  getAdminGames,
  getChat,
  getGameManifest,
  getGameResources,
  getGames,
  getIncomingInvitations,
  getLeaderboard,
  getMatch,
  getMatchResult,
  getMatches,
  getSession,
  importGameResource,
  joinMatch,
  login,
  logout,
  matchLifecycle,
  patchAdminGame,
  redeemGuest,
  redeemResetToken,
  redeemSignInToken,
  register,
  resolveMatchLink,
  sendChat,
  setCsrfToken,
} from "./api.js";
import type {
  AdminGameSummary,
  ChatMessage,
  GameResourceEntry,
  InvitationPreview,
  LeaderboardEntry,
  MatchCard,
  PendingInvitation,
  SessionInfo,
} from "./api.js";
import {
  buildCrosswordSettings,
  catalogSummary,
  EMPTY_CUSTOM_INPUT,
} from "./crossword-setup.js";
import type { CrosswordCustomInput } from "./crossword-setup.js";
import { LiveClient } from "./live.js";
import type { LiveBinding } from "./live.js";

const TOKEN_PATHS: Record<string, true> = {
  "/invite": true,
  "/guest": true,
  "/register": true,
  "/sign-in": true,
  "/reset-password": true,
};
const GUEST_MARKER = "next-round:guest-present";
const STARTED_NOTICE = "Game started.";
const ENDED_NOTICE = "Game ended. The result is ready.";
const GUEST_ENTRY_COPY =
  "Keep using this browser to return to this game. If you clear its saved data, switch browsers or your guest access expires, you’ll need a new invitation. Your earlier points will stay with your original player and won’t move to your new player.";
const LOST_GUEST_COPY =
  "We can’t restore your previous guest player in this browser. Ask the person who invited you for a new invitation. If the game still accepts players, you can join as a new player; your earlier points stay with your previous player.";

export type TokenFlow =
  | { kind: "unresolved-invite"; token: string }
  | { kind: "match-link"; token: string; preview: InvitationPreview }
  | { kind: "guest-invite"; token: string }
  | { kind: "registration"; token: string }
  | { kind: "sign-in"; token: string }
  | { kind: "password-reset"; token: string }
  | { kind: "invalid-invite"; message: string };

function captureInitialTokenFlow(): TokenFlow | null {
  const token = window.location.hash.slice(1);
  if (!token) return null;
  const path = window.location.pathname;
  if (!Object.hasOwn(TOKEN_PATHS, path)) return null;
  window.history.replaceState(
    window.history.state,
    "",
    `${path}${window.location.search}`,
  );
  if (path === "/register") return { kind: "registration", token };
  if (path === "/sign-in") return { kind: "sign-in", token };
  if (path === "/reset-password") return { kind: "password-reset", token };
  return { kind: "unresolved-invite", token };
}

const INITIAL_TOKEN_FLOW = captureInitialTokenFlow();

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

function isStale(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "STALE_REVISION";
}

function Header({
  session,
  onSignOut,
}: {
  session: SessionInfo;
  onSignOut: () => void;
}) {
  return (
    <header className="site-header">
      <Link className="brand" to="/" aria-label="Next Round home">
        Next Round
      </Link>
      <nav className="shell-nav" aria-label="Main navigation">
        <Link to="/">Home</Link>
        <Link to="/history">History</Link>
        {session.permissions.isAdmin && <Link to="/admin">Admin</Link>}
      </nav>
      <div className="header-actions">
        <span className="header-identity">
          Signed in as {session.principal.displayName}
        </span>
        {session.principal.kind === "guest" && (
          <Link className="button button-plain" to="/login">
            Sign in
          </Link>
        )}
        <button className="button" type="button" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </header>
  );
}

function MobileNav({ isAdmin }: { isAdmin: boolean }) {
  return (
    <nav className="mobile-nav" aria-label="Main navigation">
      <Link to="/">Home</Link>
      <Link to="/#games">Games</Link>
      <Link to="/history">History</Link>
      {isAdmin && <Link to="/admin">Admin</Link>}
      <Link to="/login">Account</Link>
    </nav>
  );
}

function Shell({
  session,
  onSignOut,
  children,
}: {
  session: SessionInfo;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <Header session={session} onSignOut={onSignOut} />
      {children}
      <MobileNav isAdmin={session.permissions.isAdmin} />
    </div>
  );
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog?.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialogRef}
      className="dialog-panel"
      aria-labelledby={dialogId}
      onCancel={onClose}
    >
      <div className="dialog-heading">
        <h2 id={dialogId}>{title}</h2>
        <button
          className="button button-plain"
          type="button"
          onClick={onClose}
          aria-label={`Close ${title}`}
        >
          Close
        </button>
      </div>
      {children}
    </dialog>
  );
}

function phaseLabel(phase: string): string {
  if (phase === "lobby") return "Waiting to start";
  if (phase === "active") return "In progress";
  if (phase === "finished") return "Finished";
  return "Unavailable";
}
function modeLabel(mode: string): string {
  if (mode === "solo") return "Solo game";
  if (mode === "group") return "Group game";
  return `${mode.charAt(0).toUpperCase()}${mode.slice(1)} game`;
}
function invitationTitle(preview: InvitationPreview): string {
  if (preview.moduleId === "test-counter") return "Test Counter";
  return preview.title === preview.moduleId ? "Game" : preview.title;
}

function MatchCardView({
  match,
  title,
  action,
  actionLabel,
  actionDisabled = false,
}: {
  match: MatchCard;
  title: string;
  action?: () => void;
  actionLabel?: string;
  actionDisabled?: boolean;
}) {
  const currentPhaseLabel = phaseLabel(match.phase);
  return (
    <article className="card">
      <h3>{title}</h3>
      <p className="card-meta">
        {modeLabel(match.mode)} · {currentPhaseLabel}
      </p>
      {action && actionLabel && (
        <div className="inline-actions">
          <button
            className="button button-primary"
            type="button"
            disabled={actionDisabled}
            onClick={action}
          >
            {actionLabel}
          </button>
        </div>
      )}
    </article>
  );
}

function CreateMatchDialog({
  games,
  initialGameId,
  onClose,
  onCreated,
}: {
  games: GameManifest[];
  initialGameId: string;
  onClose: () => void;
  onCreated: (matchId: string) => void;
}) {
  const [gameId, setGameId] = useState(initialGameId || games[0]?.id || "");
  const selectedGame = games.find((game) => game.id === gameId) ?? games[0];
  const firstMode =
    selectedGame?.modes.find((mode) => mode.id === "group") ??
    selectedGame?.modes[0];
  const [mode, setMode] = useState(firstMode?.id ?? "group");
  const [target, setTarget] = useState("10");
  const [turnSeconds, setTurnSeconds] = useState("none");
  const [visibility, setVisibility] = useState<"instance" | "invite">(
    "instance",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resources, setResources] = useState<GameResourceEntry[]>([]);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [resourceId, setResourceId] = useState("");
  const [custom, setCustom] = useState<CrosswordCustomInput>(
    EMPTY_CUSTOM_INPUT,
  );
  const needsResource = Boolean(selectedGame?.capabilities.resources);

  useEffect(() => {
    const first = games.find((game) => game.id === gameId) ?? games[0];
    const modeOption =
      first?.modes.find((candidate) => candidate.id === "group") ??
      first?.modes[0];
    setMode(modeOption?.id ?? "group");
  }, [gameId, games]);

  useEffect(() => {
    if (!selectedGame?.capabilities.resources) {
      setResources([]);
      setResourceId("");
      return;
    }
    let cancelled = false;
    setResourcesLoading(true);
    getGameResources(selectedGame.id)
      .then((entries) => {
        if (cancelled) return;
        setResources(entries);
        setResourceId(entries[0]?.resourceId ?? "");
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      })
      .finally(() => {
        if (!cancelled) setResourcesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedGame?.id, selectedGame?.capabilities.resources]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedGame) return;
    setBusy(true);
    setError("");
    let settings: Json = {};
    if (selectedGame.id === "test-counter") {
      const targetValue = Number(target);
      const seconds = turnSeconds === "none" ? null : Number(turnSeconds);
      if (
        !Number.isInteger(targetValue) ||
        targetValue < 1 ||
        targetValue > 20 ||
        (seconds !== null &&
          (!Number.isInteger(seconds) || seconds < 1 || seconds > 60))
      ) {
        setError(
          "Choose a target from 1 to 20 and a turn limit from 1 to 60 seconds, or no timer.",
        );
        setBusy(false);
        return;
      }
      settings = { target: targetValue, turnSeconds: seconds };
    }
    let selectedResourceId: string | undefined;
    if (needsResource) {
      if (!resourceId) {
        setError(
          "Choose a puzzle first. If none are listed, an administrator needs to import one before a match can be created.",
        );
        setBusy(false);
        return;
      }
      const built = buildCrosswordSettings(mode, custom);
      if (!built.ok) {
        setError(built.error);
        setBusy(false);
        return;
      }
      settings = { ...built.settings };
      selectedResourceId = resourceId;
    }
    try {
      const created = await createMatch({
        moduleId: selectedGame.id,
        mode,
        settings,
        ...(selectedResourceId ? { resourceId: selectedResourceId } : {}),
        visibility,
      });
      onCreated(created.matchId);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title="Start a game" onClose={onClose}>
      {games.length === 0 ? (
        <p>No enabled games are available to start.</p>
      ) : (
        <form onSubmit={(event) => void submit(event)}>
          <div className="field">
            <label htmlFor="create-game">Game</label>
            <select
              id="create-game"
              value={gameId}
              onChange={(event) => setGameId(event.target.value)}
            >
              {games.map((game) => (
                <option key={`${game.id}-${game.version}`} value={game.id}>
                  {game.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="create-mode">Mode</label>
            <select
              id="create-mode"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              {(selectedGame?.modes ?? []).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} · {option.minPlayersToStart}–
                  {option.maxPlayers} players
                </option>
              ))}
            </select>
          </div>
          {selectedGame?.id === "test-counter" && (
            <>
              <div className="field">
                <label htmlFor="counter-target">Target count</label>
                <input
                  id="counter-target"
                  type="number"
                  min="1"
                  max="20"
                  step="1"
                  value={target}
                  onChange={(event) => setTarget(event.target.value)}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="counter-turn-limit">Turn timer</label>
                <select
                  id="counter-turn-limit"
                  value={turnSeconds}
                  onChange={(event) => setTurnSeconds(event.target.value)}
                >
                  <option value="none">No timer</option>
                  {Array.from({ length: 60 }, (_, index) => index + 1).map(
                    (seconds) => (
                      <option key={seconds} value={seconds}>
                        {seconds} seconds
                      </option>
                    ),
                  )}
                </select>
              </div>
            </>
          )}
          {needsResource && (
            <>
              <div className="field">
                <label htmlFor="create-resource">Puzzle</label>
                <select
                  id="create-resource"
                  value={resourceId}
                  onChange={(event) => setResourceId(event.target.value)}
                  disabled={resourcesLoading || resources.length === 0}
                >
                  {resources.map((entry) => (
                    <option key={entry.resourceId} value={entry.resourceId}>
                      {entry.metadata.title} — {catalogSummary(entry.metadata)}
                    </option>
                  ))}
                </select>
                {resourcesLoading && (
                  <p className="hint">Loading the puzzle library…</p>
                )}
                {!resourcesLoading && resources.length === 0 && (
                  <p className="hint">
                    No puzzles are in the library yet. An administrator can
                    import one from the Admin page.
                  </p>
                )}
                {resources.length > 0 &&
                  (() => {
                    const selected = resources.find(
                      (entry) => entry.resourceId === resourceId,
                    );
                    return selected ? (
                      <p className="hint">
                        Attribution: {selected.metadata.rights.attribution}
                      </p>
                    ) : null;
                  })()}
              </div>
              {mode === "quick" && (
                <p className="hint">
                  Quick rules: 3 wrong guesses and 1 correct word per turn, no
                  timer. Settings lock when the match starts.
                </p>
              )}
              {mode === "solo" && (
                <p className="hint">
                  Casual solo: no guess limits and no timer.
                </p>
              )}
              {mode === "custom" && (
                <>
                  <div className="field">
                    <label htmlFor="custom-wrong">Wrong guesses per turn</label>
                    <input
                      id="custom-wrong"
                      type="number"
                      min="1"
                      max="100"
                      step="1"
                      placeholder="No limit"
                      value={custom.wrongGuessesPerTurn}
                      onChange={(event) =>
                        setCustom((current) => ({
                          ...current,
                          wrongGuessesPerTurn: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="custom-correct">
                      Correct words per turn
                    </label>
                    <input
                      id="custom-correct"
                      type="number"
                      min="1"
                      max="100"
                      step="1"
                      placeholder="No limit"
                      value={custom.correctWordsPerTurn}
                      onChange={(event) =>
                        setCustom((current) => ({
                          ...current,
                          correctWordsPerTurn: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="custom-timer">Turn timer (seconds)</label>
                    <input
                      id="custom-timer"
                      type="number"
                      min="10"
                      max="86400"
                      step="1"
                      placeholder="No timer"
                      value={custom.turnSeconds}
                      onChange={(event) =>
                        setCustom((current) => ({
                          ...current,
                          turnSeconds: event.target.value,
                        }))
                      }
                    />
                  </div>
                  <p className="hint">
                    Leave a field empty for no limit. Custom rules matches do
                    not count toward career stats.
                  </p>
                </>
              )}
            </>
          )}
          <div className="field">
            <label htmlFor="match-visibility">Who can find this game?</label>
            <select
              id="match-visibility"
              value={visibility}
              onChange={(event) =>
                setVisibility(event.target.value as "instance" | "invite")
              }
            >
              <option value="instance">Instance members</option>
              <option value="invite">Invite only</option>
            </select>
          </div>
          {error && (
            <p className="error-message" role="alert">
              {error}
            </p>
          )}
          <div className="inline-actions">
            <button
              className="button button-primary"
              type="submit"
              disabled={busy}
            >
              {busy ? "Creating…" : "Create match"}
            </button>
            <button className="button" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

interface HomeData {
  mine: MatchCard[];
  open: MatchCard[];
  games: GameManifest[];
  invitations: PendingInvitation[];
}

function HomePage({
  session,
  onSignOut,
  onSessionExpired,
  notice,
}: {
  session: SessionInfo;
  onSignOut: () => void;
  onSessionExpired: () => void;
  notice: string;
}) {
  const navigate = useNavigate();
  const [home, setHome] = useState<HomeData>({
    mine: [],
    open: [],
    games: [],
    invitations: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [createGameId, setCreateGameId] = useState("");
  const [busyMatch, setBusyMatch] = useState<string | null>(null);
  const [refreshNotice, setRefreshNotice] = useState("");
  const loadRef = useRef<() => Promise<void>>(async () => {});
  const expiredRef = useRef(onSessionExpired);
  expiredRef.current = onSessionExpired;

  loadRef.current = async () => {
    setLoading(true);
    setError("");
    try {
      const mine = await getMatches("mine");
      if (session.principal.kind === "guest") {
        setHome({ mine, open: [], games: [], invitations: [] });
      } else {
        const [open, games, invitations] = await Promise.all([
          getMatches("open"),
          getGames(),
          getIncomingInvitations(),
        ]);
        setHome({ mine, open, games, invitations });
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401)
        expiredRef.current();
      else setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRef.current();
    const live = new LiveClient(
      [
        {
          scope: { kind: "home" },
          onRefresh: () => void loadRef.current(),
        },
      ],
      () => expiredRef.current(),
    );
    return () => live.close();
  }, [session.principal.id]);

  async function joinOpenMatch(match: MatchCard) {
    setBusyMatch(match.id);
    setRefreshNotice("");
    try {
      await joinMatch(match.id, match.revision);
      navigate(`/matches/${encodeURIComponent(match.id)}`);
    } catch (cause) {
      if (isStale(cause)) {
        await loadRef.current();
        setRefreshNotice(
          "This match changed. The latest authorized match list is loaded; review it before joining again.",
        );
      } else if (cause instanceof ApiError && cause.status === 401) {
        expiredRef.current();
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setBusyMatch(null);
    }
  }

  async function acceptPending(invitation: PendingInvitation) {
    setBusyMatch(invitation.id);
    setError("");
    try {
      await acceptInvitation(invitation.id, invitation.matchRevision);
      navigate(`/matches/${encodeURIComponent(invitation.matchId)}`);
    } catch (cause) {
      if (isStale(cause)) {
        await loadRef.current();
        setRefreshNotice(
          "The match changed. Its current invitation details are refreshed; review and accept it again.",
        );
      } else if (cause instanceof ApiError && cause.status === 401) {
        expiredRef.current();
      } else {
        setError(errorMessage(cause));
      }
    } finally {
      setBusyMatch(null);
    }
  }

  function gameTitle(moduleId: string): string {
    if (moduleId === "test-counter") return "Test Counter";
    return home.games.find((game) => game.id === moduleId)?.name ?? "Game";
  }

  return (
    <Shell session={session} onSignOut={onSignOut}>
      <main className="app-main">
        <h1 className="page-title">Your Home</h1>
        <p className="page-intro">
          Resume a game or start a new one. Opening a game here never leaves it;
          use its explicit Leave match control only when you want to give up
          your seat.
        </p>
        {notice && (
          <p className="status-message" role="status">
            {notice}
          </p>
        )}
        {refreshNotice && (
          <p className="status-message" role="status">
            {refreshNotice}
          </p>
        )}
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {loading && <p role="status">Loading your authorized games…</p>}

        {session.principal.kind === "guest" ? (
          <>
            <section className="section" aria-labelledby="guest-match-heading">
              <h2 id="guest-match-heading" className="section-heading">
                Your invited game
              </h2>
              <p className="hint">
                Guest access is limited to the game that invited you. Keep using
                this browser to return to the same player.
              </p>
              <div className="card-grid">
                {home.mine.map((match) => (
                  <MatchCardView
                    key={match.id}
                    match={match}
                    title={gameTitle(match.moduleId)}
                    action={() =>
                      navigate(`/matches/${encodeURIComponent(match.id)}`)
                    }
                    actionLabel={
                      match.phase === "finished" ? "View result" : "Resume game"
                    }
                  />
                ))}
                {!loading && home.mine.length === 0 && (
                  <p className="status-message">
                    No game is currently available in this guest session.
                  </p>
                )}
              </div>
            </section>
          </>
        ) : (
          <>
            <div className="inline-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={home.games.length === 0}
                onClick={() => {
                  setCreateGameId(home.games[0]?.id ?? "");
                  setCreateOpen(true);
                }}
              >
                Start a game
              </button>
            </div>
            <section
              className="section"
              aria-labelledby="current-matches-heading"
            >
              <h2 id="current-matches-heading" className="section-heading">
                Your matches
              </h2>
              <div className="card-grid">
                {home.mine.map((match) => (
                  <MatchCardView
                    key={match.id}
                    match={match}
                    title={gameTitle(match.moduleId)}
                    action={() =>
                      navigate(`/matches/${encodeURIComponent(match.id)}`)
                    }
                    actionLabel={
                      match.phase === "finished" ? "View result" : "Resume game"
                    }
                  />
                ))}
                {!loading && home.mine.length === 0 && (
                  <p className="status-message">
                    No matches yet. Start a game or join an open match.
                  </p>
                )}
              </div>
            </section>
            {home.invitations.length > 0 && (
              <section
                className="section"
                aria-labelledby="pending-invitations-heading"
              >
                <h2
                  id="pending-invitations-heading"
                  className="section-heading"
                >
                  Pending invitations
                </h2>
                <div className="card-grid">
                  {home.invitations.map((invitation) => (
                    <article className="card" key={invitation.id}>
                      <h3>Invitation to a match</h3>
                      <p className="card-meta">
                        Expires{" "}
                        {new Date(invitation.expiresAt).toLocaleString()}
                      </p>
                      <div className="inline-actions">
                        <button
                          className="button button-primary"
                          type="button"
                          disabled={busyMatch === invitation.id}
                          onClick={() => void acceptPending(invitation)}
                        >
                          {busyMatch === invitation.id
                            ? "Accepting…"
                            : "Accept invitation"}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            )}
            <section
              className="section"
              id="games"
              aria-labelledby="open-games-heading"
            >
              <h2 id="open-games-heading" className="section-heading">
                Open matches
              </h2>
              <div className="card-grid">
                {home.open.map((match) => (
                  <MatchCardView
                    key={match.id}
                    match={match}
                    title={gameTitle(match.moduleId)}
                    action={() => void joinOpenMatch(match)}
                    actionLabel={
                      busyMatch === match.id ? "Joining…" : "Join match"
                    }
                    actionDisabled={busyMatch === match.id}
                  />
                ))}
                {!loading && home.open.length === 0 && (
                  <p className="status-message">
                    No open matches are available right now.
                  </p>
                )}
              </div>
            </section>
            <section className="section" aria-labelledby="game-catalog-heading">
              <h2 id="game-catalog-heading" className="section-heading">
                Games
              </h2>
              <div className="card-grid">
                {home.games.map((game) => (
                  <article className="card" key={`${game.id}-${game.version}`}>
                    <h3>{game.name}</h3>
                    <p>{game.description}</p>
                    <p className="card-meta">
                      Available modes:{" "}
                      {game.modes.map((mode) => mode.label).join(", ")}
                    </p>
                    <div className="inline-actions">
                      <button
                        className="button"
                        type="button"
                        onClick={() => {
                          setCreateGameId(game.id);
                          setCreateOpen(true);
                        }}
                      >
                        Create {game.name} match
                      </button>
                    </div>
                  </article>
                ))}
                {!loading && home.games.length === 0 && (
                  <p className="status-message">
                    No games are available to start right now.
                  </p>
                )}
              </div>
            </section>
          </>
        )}
      </main>
      {createOpen && (
        <CreateMatchDialog
          games={home.games}
          initialGameId={createGameId}
          onClose={() => setCreateOpen(false)}
          onCreated={(matchId) =>
            navigate(`/matches/${encodeURIComponent(matchId)}`)
          }
        />
      )}
    </Shell>
  );
}

function HistoryPage({
  session,
  onSignOut,
  onSessionExpired,
}: {
  session: SessionInfo;
  onSignOut: () => void;
  onSessionExpired: () => void;
}) {
  const navigate = useNavigate();
  const [finished, setFinished] = useState<MatchCard[]>([]);
  const [games, setGames] = useState<GameManifest[]>([]);
  const [boards, setBoards] = useState<Record<string, LeaderboardEntry[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const expiredRef = useRef(onSessionExpired);
  expiredRef.current = onSessionExpired;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const [mine, gameList] = await Promise.all([
          getMatches("mine", "finished"),
          session.principal.kind === "registered"
            ? getGames()
            : Promise.resolve([] as GameManifest[]),
        ]);
        if (cancelled) return;
        setFinished(mine);
        setGames(gameList);
        const careerGames = gameList.filter(
          (game) => game.capabilities.careerStats,
        );
        const loaded = await Promise.all(
          careerGames.map(async (game) => {
            try {
              return [game.id, await getLeaderboard(game.id)] as const;
            } catch {
              return [game.id, [] as LeaderboardEntry[]] as const;
            }
          }),
        );
        if (!cancelled) setBoards(Object.fromEntries(loaded));
      } catch (cause) {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 401)
          expiredRef.current();
        else setError(errorMessage(cause));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session.principal.id, session.principal.kind]);

  function gameTitle(moduleId: string): string {
    return games.find((game) => game.id === moduleId)?.name ?? "Game";
  }

  return (
    <Shell session={session} onSignOut={onSignOut}>
      <main className="app-main">
        <h1 className="page-title">History</h1>
        <p className="page-intro">
          Your finished matches and the career standings they produced. Raw
          per-match points stay with each result; standings count only
          career-eligible play.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {loading && <p role="status">Loading your history…</p>}
        <section className="section" aria-labelledby="history-matches-heading">
          <h2 id="history-matches-heading" className="section-heading">
            Finished matches
          </h2>
          <div className="card-grid">
            {finished.map((match) => (
              <MatchCardView
                key={match.id}
                match={match}
                title={gameTitle(match.moduleId)}
                action={() =>
                  navigate(`/matches/${encodeURIComponent(match.id)}`)
                }
                actionLabel="View result"
              />
            ))}
            {!loading && finished.length === 0 && (
              <p className="status-message">No finished matches yet.</p>
            )}
          </div>
        </section>
        {games
          .filter((game) => game.capabilities.careerStats)
          .map((game) => (
            <section
              className="section"
              key={game.id}
              aria-labelledby={`leaderboard-${game.id}`}
            >
              <h2 id={`leaderboard-${game.id}`} className="section-heading">
                {game.name} standings
              </h2>
              {(boards[game.id] ?? []).length === 0 ? (
                <p className="status-message">
                  No career-eligible results yet.
                </p>
              ) : (
                <table className="result-score-table">
                  <thead>
                    <tr>
                      <th scope="col">Rank</th>
                      <th scope="col">Player</th>
                      <th scope="col">Points</th>
                      <th scope="col">Played</th>
                      <th scope="col">Wins</th>
                      <th scope="col">Avg / game</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(boards[game.id] ?? []).map((entry) => (
                      <tr key={entry.principalId}>
                        <td>{entry.rank}</td>
                        <td>{entry.displayName}</td>
                        <td>{entry.points}</td>
                        <td>{entry.gamesPlayed}</td>
                        <td>{entry.wins}</td>
                        <td>
                          {entry.averagePointsPerGame === null
                            ? "—"
                            : entry.averagePointsPerGame.toFixed(2)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
      </main>
    </Shell>
  );
}

function AdminPage({
  session,
  onSignOut,
  onSessionExpired,
}: {
  session: SessionInfo;
  onSignOut: () => void;
  onSessionExpired: () => void;
}) {
  const [adminGames, setAdminGames] = useState<AdminGameSummary[]>([]);
  const [manifests, setManifests] = useState<GameManifest[]>([]);
  const [catalogs, setCatalogs] = useState<
    Record<string, GameResourceEntry[]>
  >({});
  const [importText, setImportText] = useState<Record<string, string>>({});
  const [importMessage, setImportMessage] = useState<Record<string, string>>(
    {},
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const expiredRef = useRef(onSessionExpired);
  expiredRef.current = onSessionExpired;
  const loadRef = useRef<() => Promise<void>>(async () => {});
  loadRef.current = async () => {
    setLoading(true);
    setError("");
    try {
      const [games, manifestList] = await Promise.all([
        getAdminGames(),
        getGames(),
      ]);
      setAdminGames(games);
      setManifests(manifestList);
      const importable = manifestList.filter(
        (game) => game.resourceSchemas?.import,
      );
      const loaded = await Promise.all(
        importable.map(async (game) => {
          try {
            return [game.id, await getGameResources(game.id)] as const;
          } catch {
            return [game.id, [] as GameResourceEntry[]] as const;
          }
        }),
      );
      setCatalogs(Object.fromEntries(loaded));
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401)
        expiredRef.current();
      else setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (session.permissions.isAdmin) void loadRef.current();
    else setLoading(false);
  }, [session.permissions.isAdmin]);

  async function toggleEnabled(game: AdminGameSummary) {
    setBusy(game.id);
    setError("");
    try {
      await patchAdminGame(game.id, { enabled: !game.enabled });
      await loadRef.current();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  async function changeDefault(game: AdminGameSummary, version: string) {
    setBusy(game.id);
    setError("");
    try {
      await patchAdminGame(game.id, { defaultVersion: version });
      await loadRef.current();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }

  async function submitImport(gameId: string) {
    const raw = (importText[gameId] ?? "").trim();
    if (!raw) {
      setImportMessage((current) => ({
        ...current,
        [gameId]: "Paste a puzzle document (JSON) first.",
      }));
      return;
    }
    let document: Json;
    try {
      document = JSON.parse(raw) as Json;
    } catch {
      setImportMessage((current) => ({
        ...current,
        [gameId]: "That is not valid JSON.",
      }));
      return;
    }
    setBusy(gameId);
    try {
      const receipt = await importGameResource(gameId, document);
      setImportMessage((current) => ({
        ...current,
        [gameId]: receipt.duplicate
          ? `Already in the library (version ${receipt.version}); the import still records you as exposed to this puzzle.`
          : `Imported as version ${receipt.version}. Importing records you as exposed to this puzzle.`,
      }));
      setImportText((current) => ({ ...current, [gameId]: "" }));
      await loadRef.current();
    } catch (cause) {
      setImportMessage((current) => ({
        ...current,
        [gameId]: errorMessage(cause),
      }));
    } finally {
      setBusy("");
    }
  }

  if (!session.permissions.isAdmin) {
    return (
      <Shell session={session} onSignOut={onSignOut}>
        <main className="app-main">
          <h1 className="page-title">Admin</h1>
          <p className="status-message">Administrator access is required.</p>
        </main>
      </Shell>
    );
  }

  return (
    <Shell session={session} onSignOut={onSignOut}>
      <main className="app-main">
        <h1 className="page-title">Admin</h1>
        <p className="page-intro">
          Manage installed game modules and the content library. Disabling a
          module blocks new matches; matches already running keep their
          pinned version and finish normally.
        </p>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {loading && <p role="status">Loading administration…</p>}
        <section className="section" aria-labelledby="admin-games-heading">
          <h2 id="admin-games-heading" className="section-heading">
            Game modules
          </h2>
          <div className="card-grid">
            {adminGames.map((game) => (
              <article className="card" key={game.id}>
                <h3>{game.id}</h3>
                <p className="card-meta">
                  {game.enabled ? "Enabled" : "Disabled"} ·{" "}
                  {game.referenceCounts.total} matches ({" "}
                  {game.referenceCounts.lobby} waiting,{" "}
                  {game.referenceCounts.active} in progress,{" "}
                  {game.referenceCounts.finished} finished)
                </p>
                <div className="field">
                  <label htmlFor={`default-${game.id}`}>Default version</label>
                  <select
                    id={`default-${game.id}`}
                    value={game.defaultVersion}
                    disabled={busy === game.id}
                    onChange={(event) =>
                      void changeDefault(game, event.target.value)
                    }
                  >
                    {game.versions.map((version) => (
                      <option key={version.version} value={version.version}>
                        {version.version}
                        {version.hasClientAssets ? "" : " (client missing)"}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="inline-actions">
                  <button
                    className="button"
                    type="button"
                    disabled={busy === game.id}
                    onClick={() => void toggleEnabled(game)}
                  >
                    {game.enabled ? "Disable module" : "Enable module"}
                  </button>
                </div>
              </article>
            ))}
            {!loading && adminGames.length === 0 && (
              <p className="status-message">No game modules are installed.</p>
            )}
          </div>
        </section>
        {manifests
          .filter((game) => game.resourceSchemas?.import)
          .map((game) => (
            <section
              className="section"
              key={game.id}
              aria-labelledby={`admin-import-${game.id}`}
            >
              <h2
                id={`admin-import-${game.id}`}
                className="section-heading"
              >
                {game.name} library
              </h2>
              <div className="card-grid">
                {(catalogs[game.id] ?? []).map((entry) => (
                  <article className="card" key={entry.resourceId}>
                    <h3>{entry.metadata.title}</h3>
                    <p className="card-meta">
                      {catalogSummary(entry.metadata)} · version{" "}
                      {entry.version}
                    </p>
                    <p className="card-meta">
                      Attribution: {entry.metadata.rights.attribution}
                    </p>
                  </article>
                ))}
                {(catalogs[game.id] ?? []).length === 0 && (
                  <p className="status-message">
                    No content has been imported yet.
                  </p>
                )}
              </div>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitImport(game.id);
                }}
              >
                <div className="field">
                  <label htmlFor={`import-${game.id}`}>
                    Import a {game.name} document (JSON)
                  </label>
                  <textarea
                    id={`import-${game.id}`}
                    rows={10}
                    value={importText[game.id] ?? ""}
                    onChange={(event) =>
                      setImportText((current) => ({
                        ...current,
                        [game.id]: event.target.value,
                      }))
                    }
                    placeholder='{"format": "next-round.crossword/1", ...}'
                  />
                </div>
                <p className="hint">
                  Only import content with a reviewed license (CC0-1.0,
                  CC-BY-4.0, CC-BY-SA-4.0 or documented permission). Importing
                  records you as exposed to the puzzle.
                </p>
                {importMessage[game.id] && (
                  <p className="status-message" role="status">
                    {importMessage[game.id]}
                  </p>
                )}
                <div className="inline-actions">
                  <button
                    className="button button-primary"
                    type="submit"
                    disabled={busy === game.id}
                  >
                    {busy === game.id ? "Importing…" : "Import document"}
                  </button>
                </div>
              </form>
            </section>
          ))}
      </main>
    </Shell>
  );
}

function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="center-page">
      <section className="card auth-card">
        <h1 className="page-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

function GuestReplacementWarning({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <>
      <div className="consent-copy" role="note">
        <p>{GUEST_ENTRY_COPY}</p>
        <p>
          Continuing will replace the current sign-in saved in this browser. If
          you cannot keep using the same guest session, ask the inviter for a
          new invitation; your earlier points will not move to another player.
        </p>
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        I understand this may replace my current guest access and will not
        transfer its points.
      </label>
    </>
  );
}

function LoginPage({
  currentGuest,
  busy,
  onSubmit,
  message,
}: {
  currentGuest: boolean;
  busy: boolean;
  onSubmit: (username: string, password: string) => Promise<void>;
  message?: string;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [replacementAccepted, setReplacementAccepted] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (currentGuest && !replacementAccepted) {
      setError(
        "Confirm the guest-session replacement warning before signing in.",
      );
      return;
    }
    setError("");
    try {
      await onSubmit(username, password);
      setPassword("");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <AuthCard title="Sign in">
      {currentGuest && (
        <GuestReplacementWarning
          checked={replacementAccepted}
          onChange={setReplacementAccepted}
        />
      )}
      <p className="hint">
        Sign in with your registered account. Your guest player and points are
        separate and will not be recovered or merged by signing in.
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="status-message" role="status">
            {message}
          </p>
        )}
        <div className="inline-actions">
          <button
            className="button button-primary"
            type="submit"
            disabled={busy}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
        <p className="hint">
          <Link to="/guest-access-lost">Lost guest access?</Link>
        </p>
      </form>
    </AuthCard>
  );
}

function RegistrationPage({
  token,
  currentGuest,
  onComplete,
}: {
  token: string | null;
  currentGuest: boolean;
  onComplete: (input: {
    token: string;
    username: string;
    password: string;
    displayName: string;
  }) => Promise<void>;
}) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    if (currentGuest && !accepted) {
      setError(
        "Confirm the guest-session replacement warning before creating an account.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onComplete({ token, username, password, displayName });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthCard title="Create your account">
      {!token && (
        <p className="error-message" role="alert">
          This page needs a registration invitation. Open the complete link from
          your inviter.
        </p>
      )}
      {currentGuest && (
        <GuestReplacementWarning checked={accepted} onChange={setAccepted} />
      )}
      <form onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor="registration-name">Display name</label>
          <input
            id="registration-name"
            autoComplete="nickname"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={80}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="registration-username">Username</label>
          <input
            id="registration-username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            minLength={3}
            maxLength={32}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="registration-password">Password</label>
          <input
            id="registration-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            minLength={12}
            maxLength={128}
            required
          />
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="inline-actions">
          <button
            className="button button-primary"
            type="submit"
            disabled={!token || busy}
          >
            {busy ? "Creating account…" : "Create account"}
          </button>
          <Link className="button" to="/login">
            Sign in instead
          </Link>
        </div>
      </form>
    </AuthCard>
  );
}

function SignInTokenPage({
  token,
  currentGuest,
  onRedeem,
}: {
  token: string | null;
  currentGuest: boolean;
  onRedeem: (token: string) => Promise<void>;
}) {
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function redeem() {
    if (!token) return;
    if (currentGuest && !accepted) {
      setError(
        "Confirm the guest-session replacement warning before signing in.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onRedeem(token);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthCard title="Use sign-in link">
      {!token && (
        <p className="error-message" role="alert">
          This sign-in link has no token. Open the complete link from your
          administrator.
        </p>
      )}
      {currentGuest && (
        <GuestReplacementWarning checked={accepted} onChange={setAccepted} />
      )}
      <p className="hint">
        This one-use link signs in the registered account it was issued for. It
        does not recover or merge guest points.
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div className="inline-actions">
        <button
          className="button button-primary"
          type="button"
          disabled={!token || busy}
          onClick={() => void redeem()}
        >
          {busy ? "Signing in…" : "Continue with sign-in link"}
        </button>
        <Link className="button" to="/login">
          Use password instead
        </Link>
      </div>
    </AuthCard>
  );
}

function PasswordResetPage({
  token,
  onRedeem,
}: {
  token: string | null;
  onRedeem: (token: string, password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError("");
    try {
      await onRedeem(token, password);
      setPassword("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthCard title="Reset password">
      {!token && (
        <p className="error-message" role="alert">
          This reset link has no token. Open the complete link from your
          administrator.
        </p>
      )}
      <form onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor="reset-password">New password</label>
          <input
            id="reset-password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </div>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="inline-actions">
          <button
            className="button button-primary"
            type="submit"
            disabled={!token || busy}
          >
            {busy ? "Resetting…" : "Reset password"}
          </button>
          <Link className="button" to="/login">
            Back to sign in
          </Link>
        </div>
      </form>
    </AuthCard>
  );
}

function GuestInvitePage({
  token,
  session,
  onRedeem,
}: {
  token: string;
  session: SessionInfo | null;
  onRedeem: (token: string, displayName: string) => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [replacementAccepted, setReplacementAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accepted || (session !== null && !replacementAccepted)) {
      setError(
        "Confirm the guest entry and current-session replacement information before entering.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onRedeem(token, displayName);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "TOKEN_INVALID")
        setError(
          "This guest invitation has expired or is no longer valid. Ask the inviter for a new invitation.",
        );
      else if (cause instanceof ApiError && cause.code === "CAPACITY_REACHED")
        setError(
          "This game is full. Ask the inviter whether it can accept another player.",
        );
      else if (cause instanceof ApiError && cause.code === "MATCH_CLOSED")
        setError("This game is closed and cannot accept a new guest.");
      else setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthCard title="Join as a guest">
      <p className="consent-copy">{GUEST_ENTRY_COPY}</p>
      {session && (
        <p className="status-message" role="note">
          Continuing will replace the session currently saved in this browser.
          If it is a guest session you need, keep using that session or ask its
          inviter for a new invitation before continuing.
        </p>
      )}
      <form onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor="guest-display-name">Display name</label>
          <input
            id="guest-display-name"
            autoComplete="nickname"
            maxLength={80}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            required
          />
        </div>
        {session && (
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={replacementAccepted}
              onChange={(event) => setReplacementAccepted(event.target.checked)}
            />
            I understand this guest entry replaces the session in this browser
            and may make its guest access unavailable.
          </label>
        )}
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.target.checked)}
          />
          I understand this guest player is tied to this browser and its points
          will not move to a different player.
        </label>
        {error && (
          <p className="error-message" role="alert">
            {error}
          </p>
        )}
        <div className="inline-actions">
          <button
            className="button button-primary"
            type="submit"
            disabled={
              busy || !accepted || (session !== null && !replacementAccepted)
            }
          >
            {busy ? "Joining…" : "Continue as guest"}
          </button>
          {session?.principal.kind === "registered" && (
            <Link className="button" to="/">
              Cancel
            </Link>
          )}
        </div>
      </form>
    </AuthCard>
  );
}

function InvitePage({
  flow,
  session,
  busy,
  onJoin,
  onRedeemGuest,
  onSignOut,
  notice,
}: {
  flow: TokenFlow | null;
  session: SessionInfo | null;
  busy: boolean;
  onJoin: (token: string, preview: InvitationPreview) => Promise<void>;
  onRedeemGuest: (token: string, displayName: string) => Promise<void>;
  onSignOut: () => void;
  notice: string;
}) {
  const navigate = useNavigate();
  if (!flow)
    return (
      <AuthCard title="Invitation">
        <p>Open the complete invitation link to continue.</p>
        <Link className="button" to="/login">
          Sign in
        </Link>
      </AuthCard>
    );
  if (flow.kind === "unresolved-invite")
    return (
      <AuthCard title="Checking invitation">
        <p role="status">Checking the invitation with the platform…</p>
      </AuthCard>
    );
  if (flow.kind === "invalid-invite")
    return (
      <AuthCard title="Invitation unavailable">
        <p className="error-message" role="alert">
          {flow.message}
        </p>
        <Link className="button" to="/login">
          Sign in
        </Link>
      </AuthCard>
    );
  if (flow.kind === "guest-invite")
    return (
      <GuestInvitePage
        token={flow.token}
        session={session}
        onRedeem={onRedeemGuest}
      />
    );
  if (flow.kind !== "match-link")
    return (
      <AuthCard title="Invitation">
        <p>
          This token is for a different sign-in flow. Open its matching link
          route.
        </p>
      </AuthCard>
    );

  const inviteTitle = invitationTitle(flow.preview);
  if (session?.principal.kind === "registered")
    return (
      <Shell session={session} onSignOut={onSignOut}>
        <main className="app-main">
          <h1 className="page-title">Join {inviteTitle}</h1>
          <p className="page-intro">
            This link can admit a registered player if the game still accepts
            players. Joining will not create a guest account.
          </p>
          {notice && (
            <p className="status-message" role="status">
              {notice}
            </p>
          )}
          <article className="card">
            <p>
              <strong>Game:</strong> {inviteTitle}
            </p>
            <p>
              <strong>Status:</strong> {phaseLabel(flow.preview.phase)}
            </p>
            {busy && <p role="status">Joining…</p>}
            <div className="inline-actions">
              <button
                className="button button-primary"
                type="button"
                disabled={busy || flow.preview.phase === "finished"}
                onClick={() => void onJoin(flow.token, flow.preview)}
              >
                Join match
              </button>
              <Link className="button" to="/">
                Home
              </Link>
            </div>
          </article>
        </main>
      </Shell>
    );
  return (
    <AuthCard title={`Join ${inviteTitle}`}>
      <p className="page-intro">
        This match link is for registered players. Sign in to continue; guests
        need a separate guest invitation.
      </p>
      <p>
        <strong>Status:</strong> {phaseLabel(flow.preview.phase)}
      </p>
      {notice && (
        <p className="status-message" role="status">
          {notice}
        </p>
      )}
      {session?.principal.kind === "guest" && (
        <p className="status-message">
          Signing in replaces the guest session in this browser. The warning and
          confirmation appear before the sign-in request.
        </p>
      )}
      <div className="inline-actions">
        <button
          className="button button-primary"
          type="button"
          onClick={() => navigate("/login")}
        >
          Sign in to join
        </button>
      </div>
    </AuthCard>
  );
}

function GameRenderer({
  snapshot,
  onRefresh,
  onOpenPanel,
  onSessionExpired,
}: {
  snapshot: MatchSnapshot;
  onRefresh: () => Promise<MatchSnapshot | null>;
  onOpenPanel: (panel: "chat" | "participants") => void;
  onSessionExpired: () => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const snapshotRef = useRef(snapshot);
  const listenersRef = useRef(new Set<(next: MatchSnapshot) => void>());
  const refreshRef = useRef(onRefresh);
  const expiredRef = useRef(onSessionExpired);
  const openPanelRef = useRef(onOpenPanel);
  const [status, setStatus] = useState("Loading the pinned game version…");
  const [error, setError] = useState("");
  snapshotRef.current = snapshot;
  refreshRef.current = onRefresh;
  expiredRef.current = onSessionExpired;
  openPanelRef.current = onOpenPanel;

  useEffect(() => {
    for (const listener of listenersRef.current) listener(snapshot);
  }, [snapshot]);

  useEffect(() => {
    let active = true;
    let mountedClient: { unmount(): void } | null = null;
    let loadedStyles: HTMLLinkElement[] = [];
    const mount = async () => {
      try {
        const manifest = await getGameManifest(
          snapshot.moduleId,
          snapshot.moduleVersion,
        );
        if (!active) return;
        const base = `/games/${encodeURIComponent(snapshot.moduleId)}/${encodeURIComponent(snapshot.moduleVersion)}/`;
        loadedStyles = manifest.client.css.map((asset) => {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href =
            base +
            asset
              .replace(/^\.\//, "")
              .split("/")
              .map(encodeURIComponent)
              .join("/");
          document.head.appendChild(link);
          return link;
        });
        const entry = manifest.client.entry
          .replace(/^\.\//, "")
          .split("/")
          .map(encodeURIComponent)
          .join("/");
        const moduleUrl = base + entry;
        const gameModule = (await import(/* @vite-ignore */ moduleUrl)) as {
          client?: GameClient;
        };
        if (!active || !elementRef.current) return;
        if (!gameModule.client || typeof gameModule.client.mount !== "function")
          throw new Error("The pinned game client is unavailable.");
        const bridge: GameBridge = {
          getSnapshot: () => snapshotRef.current,
          subscribe(listener) {
            listenersRef.current.add(listener);
            return () => listenersRef.current.delete(listener);
          },
          async act(input) {
            try {
              const receipt = await act(snapshotRef.current.id, input);
              await refreshRef.current();
              return receipt;
            } catch (cause) {
              if (cause instanceof ApiError && cause.status === 401)
                expiredRef.current();
              if (isStale(cause)) {
                await refreshRef.current();
                throw new Error(
                  "The match changed. The latest state is loaded; review it before acting again.",
                );
              }
              throw cause;
            }
          },
          async refresh() {
            const current = await refreshRef.current();
            if (!current) throw new Error("The match is no longer available.");
            return current;
          },
          openPanel(panel) {
            openPanelRef.current(panel);
          },
        };
        mountedClient = gameModule.client.mount(elementRef.current, bridge);
        setStatus("");
        setError("");
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401)
          expiredRef.current();
        setError(errorMessage(cause));
        setStatus("");
      }
    };
    void mount();
    return () => {
      active = false;
      mountedClient?.unmount();
      for (const link of loadedStyles) link.remove();
      listenersRef.current.clear();
    };
  }, [snapshot.id, snapshot.moduleId, snapshot.moduleVersion]);

  return (
    <section className="game-frame" aria-label="Game play area">
      <div ref={elementRef} />
      {status && <p role="status">{status}</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

type CounterResultView = {
  outcome: string;
  data: { count?: number; target?: number; winners?: string[] };
  participants: Array<{ memberId: string; score: number; win: boolean }>;
};

function ResultView({
  result,
  members,
}: {
  result: Json;
  members: MatchSnapshot["members"];
}) {
  const projection = result as CounterResultView;
  const names = new Map(
    members.map((member) => [member.id, member.displayName]),
  );
  const participants = Array.isArray(projection.participants)
    ? projection.participants
    : [];
  return (
    <section className="card" aria-labelledby="result-heading">
      <h2 id="result-heading" className="section-heading">
        Game result
      </h2>
      <p>
        <strong>Outcome:</strong> {projection.outcome ?? "complete"}
      </p>
      {typeof projection.data?.count === "number" &&
        typeof projection.data.target === "number" && (
          <p>
            <strong>Final count:</strong> {projection.data.count} /{" "}
            {projection.data.target}
          </p>
        )}
      <h3>Scores</h3>
      <table className="result-score-table">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Score</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {participants.map((participant, index) => (
            <tr key={participant.memberId}>
              <th scope="row">
                {names.get(participant.memberId) ?? `Participant ${index + 1}`}
              </th>
              <td>{participant.score}</td>
              <td>{participant.win ? "Winner" : "Played"}</td>
            </tr>
          ))}
          {participants.length === 0 && (
            <tr>
              <td colSpan={3}>The saved result is available.</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function ChatDialog({
  messages,
  loading,
  error,
  onClose,
  onSend,
}: {
  messages: ChatMessage[];
  loading: boolean;
  error: string;
  onClose: () => void;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (text.length < 1 || text.length > 2000) return;
    setBusy(true);
    try {
      if (await onSend(text)) setText("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Match chat" onClose={onClose}>
      <p className="hint">
        Messages are visible only to members with current chat access.
      </p>
      {loading && <p role="status">Loading chat…</p>}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <div
        className="chat-messages"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {messages.map((message) => (
          <article className="chat-message" key={message.id}>
            <strong>{message.displayName}</strong>
            <p>{message.text}</p>
            <time dateTime={message.createdAt}>
              {new Date(message.createdAt).toLocaleString()}
            </time>
          </article>
        ))}
        {!loading && messages.length === 0 && (
          <p className="hint">No messages yet.</p>
        )}
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <div className="field">
          <label htmlFor="chat-message">Message</label>
          <textarea
            id="chat-message"
            value={text}
            maxLength={2000}
            onChange={(event) => setText(event.target.value)}
            required
          />
        </div>
        <div className="inline-actions">
          <button
            className="button button-primary"
            type="submit"
            disabled={busy || text.length === 0}
          >
            {busy ? "Sending…" : "Send message"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function ParticipantsDialog({
  snapshot,
  onClose,
}: {
  snapshot: MatchSnapshot;
  onClose: () => void;
}) {
  let currentActorMemberId: string | null = null;
  if (
    typeof snapshot.game === "object" &&
    snapshot.game !== null &&
    !Array.isArray(snapshot.game) &&
    "currentActorMemberId" in snapshot.game &&
    typeof snapshot.game.currentActorMemberId === "string"
  ) {
    currentActorMemberId = snapshot.game.currentActorMemberId;
  }
  return (
    <Dialog title="Participants" onClose={onClose}>
      <ul className="member-list">
        {snapshot.members.map((member) => (
          <li className="member-row" key={member.id}>
            <span>
              {member.displayName}
              {member.id === currentActorMemberId ? " · current turn" : ""}
            </span>
            <span className="badge">
              {member.kind === "guest" ? "Guest" : "Registered"} ·{" "}
              {member.status}
            </span>
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function InviteLinkControls({
  snapshot,
  session,
}: {
  snapshot: MatchSnapshot;
  session: SessionInfo;
}) {
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<"member" | "guest">("member");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function create() {
    setBusy(true);
    setMessage("");
    try {
      const invite =
        kind === "guest"
          ? await createGuestInvite(snapshot.id)
          : await createMatchLink(snapshot.id);
      setUrl(invite.url);
      setMessage(
        "expiresAt" in invite && typeof invite.expiresAt === "string"
          ? `Guest invitation expires ${new Date(invite.expiresAt).toLocaleString()}.`
          : "Registered-player join link created.",
      );
    } catch (cause) {
      setMessage(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("Invitation link copied.");
    } catch {
      setMessage(
        "Copy is unavailable. Select and copy the invitation link below.",
      );
    }
  }
  const canInvite =
    snapshot.capabilities.canInvite && session.principal.kind === "registered";
  const canInviteGuest = canInvite && session.permissions.canInviteGuests;
  if (!canInvite) return null;
  return (
    <section className="card" aria-labelledby="invite-heading">
      <h2 id="invite-heading" className="section-heading">
        Invite players
      </h2>
      <div className="field">
        <label htmlFor="invite-kind">Invitation type</label>
        <select
          id="invite-kind"
          value={kind}
          onChange={(event) =>
            setKind(event.target.value as "member" | "guest")
          }
        >
          <option value="member">Registered player link</option>
          {canInviteGuest && <option value="guest">Guest invitation</option>}
        </select>
      </div>
      <div className="inline-actions">
        <button
          className="button"
          type="button"
          disabled={busy || (kind === "guest" && !canInviteGuest)}
          onClick={() => void create()}
        >
          {busy
            ? "Creating link…"
            : kind === "guest"
              ? "Create guest invitation"
              : "Create registered join link"}
        </button>
      </div>
      {url && (
        <div className="field">
          <label htmlFor="invite-url">Invitation link</label>
          <input
            id="invite-url"
            className="text-input"
            type="url"
            value={url}
            readOnly
            onFocus={(event) => event.currentTarget.select()}
          />
          <button className="button" type="button" onClick={() => void copy()}>
            Copy link
          </button>
        </div>
      )}
      {message && (
        <p className="status-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

function MatchPage({
  session,
  onSignOut,
  onSessionExpired,
  onAccessRevoked,
}: {
  session: SessionInfo;
  onSignOut: () => void;
  onSessionExpired: () => void;
  onAccessRevoked: () => void;
}) {
  const { matchId = "" } = useParams();
  const navigate = useNavigate();
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState("");
  const [pageError, setPageError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  const [result, setResult] = useState<Json | null>(null);
  const [selectedPanel, setSelectedPanel] = useState<
    "chat" | "participants" | null
  >(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const [confirmAction, setConfirmAction] = useState<"leave" | "finish" | null>(
    null,
  );
  const [busyAction, setBusyAction] = useState(false);
  const snapshotRef = useRef<MatchSnapshot | null>(snapshot);
  const loadRef = useRef<() => Promise<MatchSnapshot | null>>(async () => null);
  const loadChatRef = useRef<() => Promise<void>>(async () => {});
  const expiredRef = useRef(onSessionExpired);
  const revokedRef = useRef(onAccessRevoked);
  snapshotRef.current = snapshot;
  expiredRef.current = onSessionExpired;
  revokedRef.current = onAccessRevoked;

  loadRef.current = async () => {
    setSnapshotError("");
    try {
      const next = await getMatch(matchId);
      if (
        !snapshotRef.current ||
        next.revision >= snapshotRef.current.revision
      ) {
        snapshotRef.current = next;
        setSnapshot(next);
      }
      if (next.phase === "finished") {
        const savedResult = await getMatchResult(matchId);
        setResult(savedResult);
      }
      return snapshotRef.current;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        snapshotRef.current = null;
        setSnapshot(null);
        expiredRef.current();
        return null;
      }
      if (
        cause instanceof ApiError &&
        (cause.code === "MODULE_UNAVAILABLE" ||
          cause.status === 403 ||
          cause.status === 404)
      ) {
        try {
          const savedResult = await getMatchResult(matchId);
          setSnapshot(null);
          snapshotRef.current = null;
          setResult(savedResult);
          return null;
        } catch (resultError) {
          setSnapshotError(errorMessage(resultError));
          setSnapshot(null);
          snapshotRef.current = null;
          setChatMessages([]);
          return null;
        }
      }
      setSnapshotError(errorMessage(cause));
      return null;
    }
  };

  loadChatRef.current = async () => {
    setChatLoading(true);
    setChatError("");
    try {
      const page = await getChat(matchId);
      setChatMessages(page.data);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401)
        expiredRef.current();
      setChatError(errorMessage(cause));
    } finally {
      setChatLoading(false);
    }
  };

  useEffect(() => {
    void loadRef.current();
    const snapshotGetter = () => snapshotRef.current?.revision;
    const liveBindings: LiveBinding[] = [
      {
        scope: { kind: "match", id: matchId },
        knownRevision: snapshotGetter,
        onRefresh: (reason, revision) => {
          const known = snapshotRef.current?.revision;
          if (
            reason === "subscribed" ||
            revision === undefined ||
            known === undefined ||
            revision > known
          )
            void loadRef.current();
        },
        onRevoked: () => {
          snapshotRef.current = null;
          setSnapshot(null);
          setChatMessages([]);
          revokedRef.current();
        },
      },
      {
        scope: { kind: "chat", id: matchId },
        onRefresh: () => void loadChatRef.current(),
        onRevoked: () => {
          setChatMessages([]);
          setSelectedPanel(null);
        },
      },
    ];
    const live = new LiveClient(liveBindings, () => expiredRef.current());
    return () => live.close();
  }, [matchId, session.principal.id]);

  // BL-025: once the authoritative phase is finished, an earlier lifecycle
  // notice (above all "Game started.") is obsolete and must not linger over
  // the final projection. The explicit ended-game confirmation set by the
  // finish action itself is preserved.
  useEffect(() => {
    if (snapshot?.phase !== "finished") return;
    setActionMessage((current) => (current === STARTED_NOTICE ? "" : current));
  }, [snapshot?.phase]);

  async function refreshSnapshot(): Promise<MatchSnapshot | null> {
    return loadRef.current();
  }

  async function runLifecycle(action: "start" | "leave" | "finish") {
    if (!snapshot) return;
    setBusyAction(true);
    setPageError("");
    setActionMessage("");
    try {
      await matchLifecycle(matchId, action, snapshot.revision);
      if (action === "leave") {
        snapshotRef.current = null;
        setSnapshot(null);
        setChatMessages([]);
        setSelectedPanel(null);
        setConfirmAction(null);
        navigate("/");
        return;
      }
      await refreshSnapshot();
      setActionMessage(
        action === "start" ? STARTED_NOTICE : ENDED_NOTICE,
      );
      setConfirmAction(null);
    } catch (cause) {
      if (isStale(cause)) {
        await refreshSnapshot();
        setActionMessage(
          "The match changed. Review the refreshed state before trying again.",
        );
      } else if (cause instanceof ApiError && cause.status === 401) {
        expiredRef.current();
      } else {
        setPageError(errorMessage(cause));
      }
    } finally {
      setBusyAction(false);
    }
  }

  async function sendMessage(text: string): Promise<boolean> {
    try {
      await sendChat(matchId, text);
      await loadChatRef.current();
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401)
        expiredRef.current();
      setChatError(errorMessage(cause));
      return false;
    }
  }

  const title = snapshot?.moduleId === "test-counter" ? "Test Counter" : "Game";
  if (snapshotError && !snapshot && !result)
    return (
      <Shell session={session} onSignOut={onSignOut}>
        <main className="app-main">
          <h1 className="page-title">Game unavailable</h1>
          <p className="error-message" role="alert">
            {snapshotError}
          </p>
          <Link className="button" to="/">
            Return Home
          </Link>
        </main>
      </Shell>
    );

  return (
    <Shell session={session} onSignOut={onSignOut}>
      <main className="app-main">
        <div className="match-toolbar">
          <Link
            className="button"
            to="/"
            aria-label="Return Home without leaving the match"
          >
            Home
          </Link>
          <span className="badge">
            {snapshot ? phaseLabel(snapshot.phase) : "Loading game"}
          </span>
          <span className="spacer" />
          {snapshot?.capabilities.canStart && (
            <button
              className="button button-primary"
              type="button"
              disabled={busyAction}
              onClick={() => void runLifecycle("start")}
            >
              Start game
            </button>
          )}
          {snapshot?.capabilities.canFinish &&
            snapshot.phase !== "finished" && (
              <button
                className="button button-danger"
                type="button"
                disabled={busyAction}
                onClick={() => setConfirmAction("finish")}
              >
                End game
              </button>
            )}
          {snapshot?.capabilities.canLeave && snapshot.phase !== "finished" && (
            <button
              className="button button-danger"
              type="button"
              disabled={busyAction}
              onClick={() => setConfirmAction("leave")}
            >
              Leave match
            </button>
          )}
        </div>
        <h1 className="page-title">{title}</h1>
        {snapshot && (
          <p className="page-intro">
            {snapshot.mode === "group" ? "Group game" : "Solo game"}
          </p>
        )}
        {actionMessage && (
          <p className="status-message" role="status">
            {actionMessage}
          </p>
        )}
        {pageError && (
          <p className="error-message" role="alert">
            {pageError}
          </p>
        )}
        {!snapshot && !result && <p role="status">Loading game…</p>}

        {snapshot && snapshot.phase === "finished" && result && (
          <ResultView result={result} members={snapshot.members} />
        )}
        {!snapshot && result && <ResultView result={result} members={[]} />}

        {snapshot && snapshot.phase !== "finished" && (
          <div className="match-layout">
            <div>
              <GameRenderer
                snapshot={snapshot}
                onRefresh={refreshSnapshot}
                onOpenPanel={setSelectedPanel}
                onSessionExpired={onSessionExpired}
              />
              <div className="match-toolbar">
                {snapshot.capabilities.canChat && (
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      setSelectedPanel("chat");
                      void loadChatRef.current();
                    }}
                  >
                    Open chat
                  </button>
                )}
                <button
                  className="button"
                  type="button"
                  onClick={() => setSelectedPanel("participants")}
                >
                  Open participants
                </button>
              </div>
            </div>
            <aside className="match-sidebar" aria-label="Shared game panels">
              <section className="card">
                <h2 className="section-heading">Participants</h2>
                <ul className="member-list">
                  {snapshot.members.map((member) => (
                    <li className="member-row" key={member.id}>
                      <span>{member.displayName}</span>
                      <span className="badge">{member.status}</span>
                    </li>
                  ))}
                </ul>
                <button
                  className="button"
                  type="button"
                  onClick={() => setSelectedPanel("participants")}
                >
                  View participant details
                </button>
              </section>
              {snapshot.capabilities.canChat && (
                <section className="card">
                  <h2 className="section-heading">Chat</h2>
                  <p className="hint">Open the shared match conversation.</p>
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      setSelectedPanel("chat");
                      void loadChatRef.current();
                    }}
                  >
                    Open chat
                  </button>
                </section>
              )}
              <InviteLinkControls snapshot={snapshot} session={session} />
            </aside>
          </div>
        )}
        {snapshot &&
          snapshot.phase === "finished" &&
          snapshot.capabilities.canChat && (
            <div className="inline-actions">
              <button
                className="button"
                type="button"
                onClick={() => {
                  setSelectedPanel("chat");
                  void loadChatRef.current();
                }}
              >
                Open chat
              </button>
              <button
                className="button"
                type="button"
                onClick={() => setSelectedPanel("participants")}
              >
                Open participants
              </button>
            </div>
          )}
      </main>

      {selectedPanel === "participants" && snapshot && (
        <ParticipantsDialog
          snapshot={snapshot}
          onClose={() => setSelectedPanel(null)}
        />
      )}
      {selectedPanel === "chat" &&
        snapshot &&
        snapshot.capabilities.canChat && (
          <ChatDialog
            messages={chatMessages}
            loading={chatLoading}
            error={chatError}
            onClose={() => setSelectedPanel(null)}
            onSend={sendMessage}
          />
        )}
      {confirmAction && (
        <Dialog
          title={
            confirmAction === "leave" ? "Leave this match?" : "End this game?"
          }
          onClose={() => setConfirmAction(null)}
        >
          <p>
            {confirmAction === "leave"
              ? "Leaving revokes your active match and chat access. Your result entitlement may remain; returning Home alone never leaves."
              : "Ending now records the game's final result for everyone. This cannot be undone."}
          </p>
          {pageError && (
            <p className="error-message" role="alert">
              {pageError}
            </p>
          )}
          <div className="inline-actions">
            <button
              className="button button-danger"
              type="button"
              disabled={busyAction}
              onClick={() => void runLifecycle(confirmAction)}
            >
              {busyAction
                ? "Working…"
                : confirmAction === "leave"
                  ? "Confirm leave"
                  : "Confirm end game"}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => setConfirmAction(null)}
            >
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </Shell>
  );
}

function GuestRecoveryPage({ onSignIn }: { onSignIn: () => void }) {
  return (
    <AuthCard title="Guest access unavailable">
      <p className="consent-copy">{LOST_GUEST_COPY}</p>
      <p className="hint">
        Signing in with a registered account uses the ordinary account flow and
        will not recover or merge guest points.
      </p>
      <div className="inline-actions">
        <button
          className="button button-primary"
          type="button"
          onClick={onSignIn}
        >
          Sign in with a registered account
        </button>
      </div>
    </AuthCard>
  );
}

export function App() {
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [lostGuest, setLostGuest] = useState(false);
  const [tokenFlow, setTokenFlow] = useState<TokenFlow | null>(
    INITIAL_TOKEN_FLOW,
  );
  const [authBusy, setAuthBusy] = useState(false);
  const [logoutPrompt, setLogoutPrompt] = useState(false);
  const [notice, setNotice] = useState("");
  const [globalError, setGlobalError] = useState("");

  async function refreshSession(): Promise<SessionInfo | null> {
    try {
      const next = await getSession();
      setCsrfToken(next.csrfToken);
      setSession(next);
      setLostGuest(false);
      if (next.principal.kind === "guest")
        window.localStorage.setItem(GUEST_MARKER, "present");
      else window.localStorage.removeItem(GUEST_MARKER);
      setInitializing(false);
      setGlobalError("");
      return next;
    } catch (cause) {
      setCsrfToken(null);
      setSession(null);
      if (cause instanceof ApiError && cause.status === 401) {
        setLostGuest(window.localStorage.getItem(GUEST_MARKER) === "present");
        setGlobalError("");
      } else {
        setGlobalError(errorMessage(cause));
      }
      setInitializing(false);
      return null;
    }
  }

  useEffect(() => {
    void refreshSession();
  }, []);

  useEffect(() => {
    if (tokenFlow?.kind !== "unresolved-invite") return;
    let cancelled = false;
    void resolveMatchLink(tokenFlow.token)
      .then((preview) => {
        if (!cancelled)
          setTokenFlow({ kind: "match-link", token: tokenFlow.token, preview });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        if (
          cause instanceof ApiError &&
          ["TOKEN_INVALID", "NOT_FOUND"].includes(cause.code)
        ) {
          setTokenFlow({ kind: "guest-invite", token: tokenFlow.token });
        } else {
          setTokenFlow({
            kind: "invalid-invite",
            message: errorMessage(cause),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tokenFlow]);

  async function authenticate(response: {
    csrfToken: string;
  }): Promise<SessionInfo | null> {
    setCsrfToken(response.csrfToken);
    return refreshSession();
  }

  async function completeLogin(
    username: string,
    password: string,
    returnMatchId?: string,
  ) {
    setAuthBusy(true);
    setGlobalError("");
    try {
      const result = await login(username, password);
      const current = await authenticate(result);
      if (!current) return;
      if (returnMatchId) {
        navigate(`/matches/${encodeURIComponent(returnMatchId)}`);
        return;
      }
      if (
        tokenFlow?.kind === "match-link" &&
        current.principal.kind === "registered"
      ) {
        try {
          await joinMatch(
            tokenFlow.preview.matchId,
            tokenFlow.preview.revision,
            tokenFlow.token,
          );
          navigate(`/matches/${encodeURIComponent(tokenFlow.preview.matchId)}`);
          return;
        } catch (cause) {
          if (isStale(cause)) {
            const refreshed = await resolveMatchLink(tokenFlow.token);
            setTokenFlow({
              kind: "match-link",
              token: tokenFlow.token,
              preview: refreshed,
            });
            setNotice(
              "The match changed while you signed in. Review the refreshed invitation and choose Join match again.",
            );
          } else {
            setNotice(errorMessage(cause));
          }
          navigate("/invite");
          return;
        }
      }
      navigate("/");
    } finally {
      setAuthBusy(false);
    }
  }

  async function completeRegistration(input: {
    token: string;
    username: string;
    password: string;
    displayName: string;
  }) {
    setAuthBusy(true);
    setGlobalError("");
    try {
      const result = await register(input);
      const current = await authenticate(result);
      if (!current) return;
      if (result.destination) {
        const pending = await getIncomingInvitations();
        const invitation = pending.find(
          (item) => item.id === result.destination?.invitationId,
        );
        if (invitation) {
          try {
            await acceptInvitation(invitation.id, invitation.matchRevision);
            navigate(
              `/matches/${encodeURIComponent(result.destination.matchId)}`,
            );
            return;
          } catch (cause) {
            if (isStale(cause)) {
              setNotice(
                "Your account is ready. The match changed during invitation acceptance; review the refreshed invitation on Home before accepting it.",
              );
            } else {
              setNotice(
                `Your account is ready, but the match invitation could not be accepted: ${errorMessage(cause)}`,
              );
            }
          }
        } else {
          setNotice(
            "Your account is ready. The linked match invitation is available from Home.",
          );
        }
      }
      navigate("/");
    } finally {
      setAuthBusy(false);
    }
  }

  async function redeemSignIn(token: string) {
    setAuthBusy(true);
    setGlobalError("");
    try {
      const result = await redeemSignInToken(token);
      await authenticate(result);
      navigate("/");
    } finally {
      setAuthBusy(false);
    }
  }

  async function redeemPasswordReset(token: string, password: string) {
    setAuthBusy(true);
    setGlobalError("");
    try {
      await redeemResetToken(token, password);
      setNotice("Password reset complete. Sign in with your new password.");
      navigate("/login");
    } finally {
      setAuthBusy(false);
    }
  }

  async function redeemGuestInvite(token: string, displayName: string) {
    setAuthBusy(true);
    setGlobalError("");
    try {
      const result = await redeemGuest(token, displayName);
      if (result.csrfToken) setCsrfToken(result.csrfToken);
      window.localStorage.setItem(GUEST_MARKER, "present");
      const current = await refreshSession();
      if (current) navigate(`/matches/${encodeURIComponent(result.matchId)}`);
    } finally {
      setAuthBusy(false);
    }
  }

  async function joinFromMatchLink(token: string, preview: InvitationPreview) {
    try {
      await joinMatch(preview.matchId, preview.revision, token);
      navigate(`/matches/${encodeURIComponent(preview.matchId)}`);
    } catch (cause) {
      if (isStale(cause)) {
        const latest = await resolveMatchLink(token);
        setTokenFlow({ kind: "match-link", token, preview: latest });
        setNotice(
          "The match changed. Current invitation details are refreshed; review them and choose Join match again.",
        );
      } else {
        setNotice(errorMessage(cause));
      }
    }
  }

  async function performLogout() {
    if (!session) return;
    setAuthBusy(true);
    try {
      await logout();
      setCsrfToken(null);
      if (session.principal.kind === "guest") {
        window.localStorage.setItem(GUEST_MARKER, "present");
        setLostGuest(true);
      } else {
        window.localStorage.removeItem(GUEST_MARKER);
        setLostGuest(false);
      }
      setSession(null);
      setLogoutPrompt(false);
      setNotice("");
      navigate("/");
    } catch (cause) {
      setGlobalError(errorMessage(cause));
    } finally {
      setAuthBusy(false);
    }
  }

  function requestLogout() {
    if (session?.principal.kind === "guest") setLogoutPrompt(true);
    else void performLogout();
  }

  function sessionExpired() {
    void refreshSession();
  }

  function accessRevoked() {
    setNotice(
      "Access to that match was removed. Ask the inviter for a new invitation if you should rejoin.",
    );
    navigate("/");
  }

  function handleInviteFlow(
    flow: TokenFlow | null,
    currentSession: SessionInfo | null,
  ) {
    if (flow?.kind === "match-link" && !currentSession) {
      return (
        <AuthCard title={`Join ${invitationTitle(flow.preview)}`}>
          <p>
            This registered-player invitation needs sign-in. Your destination
            stays inside this app.
          </p>
          <Link className="button button-primary" to="/login">
            Sign in to continue
          </Link>
        </AuthCard>
      );
    }
    return (
      <InvitePage
        flow={flow}
        session={currentSession}
        busy={authBusy}
        onJoin={joinFromMatchLink}
        onRedeemGuest={redeemGuestInvite}
        onSignOut={requestLogout}
        notice={notice}
      />
    );
  }

  function loginScreen(returnMatchId?: string) {
    return (
      <LoginPage
        currentGuest={session?.principal.kind === "guest"}
        busy={authBusy}
        message={globalError || notice}
        onSubmit={(username, password) =>
          completeLogin(username, password, returnMatchId)
        }
      />
    );
  }

  return (
    <div className="app-shell">
      {initializing ? (
        <div className="center-page">
          <p role="status">Checking your session…</p>
        </div>
      ) : (
        <Routes>
          <Route
            path="/"
            element={
              session ? (
                <HomePage
                  session={session}
                  onSignOut={requestLogout}
                  onSessionExpired={sessionExpired}
                  notice={notice}
                />
              ) : lostGuest ? (
                <GuestRecoveryPage onSignIn={() => navigate("/login")} />
              ) : (
                <AuthCard title="Next Round">
                  <p className="page-intro">
                    Sign in to continue to your games. If you have an
                    invitation, open its complete link.
                  </p>
                  {globalError && (
                    <p className="error-message" role="alert">
                      {globalError}
                    </p>
                  )}
                  <div className="inline-actions">
                    <Link className="button button-primary" to="/login">
                      Sign in
                    </Link>
                    <Link className="button" to="/invite">
                      Open invitation
                    </Link>
                  </div>
                  <p className="hint">
                    <Link to="/guest-access-lost">Lost guest access?</Link>
                  </p>
                </AuthCard>
              )
            }
          />
          <Route
            path="/history"
            element={
              session ? (
                <HistoryPage
                  session={session}
                  onSignOut={requestLogout}
                  onSessionExpired={sessionExpired}
                />
              ) : lostGuest ? (
                <GuestRecoveryPage onSignIn={() => navigate("/login")} />
              ) : (
                <AuthCard title="Next Round">
                  <p className="page-intro">
                    Sign in to see your finished matches and standings.
                  </p>
                  <div className="inline-actions">
                    <Link className="button button-primary" to="/login">
                      Sign in
                    </Link>
                  </div>
                </AuthCard>
              )
            }
          />
          <Route
            path="/admin"
            element={
              session ? (
                <AdminPage
                  session={session}
                  onSignOut={requestLogout}
                  onSessionExpired={sessionExpired}
                />
              ) : lostGuest ? (
                <GuestRecoveryPage onSignIn={() => navigate("/login")} />
              ) : (
                <AuthCard title="Next Round">
                  <p className="page-intro">
                    Sign in with an administrator account to manage games.
                  </p>
                  <div className="inline-actions">
                    <Link className="button button-primary" to="/login">
                      Sign in
                    </Link>
                  </div>
                </AuthCard>
              )
            }
          />
          <Route
            path="/matches/:matchId"
            element={
              session ? (
                <MatchPage
                  key={`${session.principal.id}:${pathname}`}
                  session={session}
                  onSignOut={requestLogout}
                  onSessionExpired={sessionExpired}
                  onAccessRevoked={accessRevoked}
                />
              ) : lostGuest ? (
                <GuestRecoveryPage onSignIn={() => navigate("/login")} />
              ) : (
                <MatchLoginRoute
                  onSubmit={(username, password, matchId) =>
                    completeLogin(username, password, matchId)
                  }
                  busy={authBusy}
                  error={globalError || notice}
                />
              )
            }
          />
          <Route
            path="/login"
            element={
              session?.principal.kind === "registered" ? (
                <Shell session={session} onSignOut={requestLogout}>
                  <main className="app-main">
                    <p className="status-message">You are already signed in.</p>
                    <Link className="button" to="/">
                      Return Home
                    </Link>
                  </main>
                </Shell>
              ) : (
                loginScreen()
              )
            }
          />
          <Route
            path="/register"
            element={
              <RegistrationPage
                token={
                  tokenFlow?.kind === "registration" ? tokenFlow.token : null
                }
                currentGuest={session?.principal.kind === "guest"}
                onComplete={completeRegistration}
              />
            }
          />
          <Route
            path="/sign-in"
            element={
              <SignInTokenPage
                token={tokenFlow?.kind === "sign-in" ? tokenFlow.token : null}
                currentGuest={session?.principal.kind === "guest"}
                onRedeem={redeemSignIn}
              />
            }
          />
          <Route
            path="/reset-password"
            element={
              <PasswordResetPage
                token={
                  tokenFlow?.kind === "password-reset" ? tokenFlow.token : null
                }
                onRedeem={redeemPasswordReset}
              />
            }
          />
          <Route
            path="/invite"
            element={handleInviteFlow(tokenFlow, session)}
          />
          <Route path="/guest" element={handleInviteFlow(tokenFlow, session)} />
          <Route
            path="/guest-access-lost"
            element={<GuestRecoveryPage onSignIn={() => navigate("/login")} />}
          />
          <Route
            path="*"
            element={
              session ? (
                <HomePage
                  session={session}
                  onSignOut={requestLogout}
                  onSessionExpired={sessionExpired}
                  notice={notice}
                />
              ) : (
                <AuthCard title="Next Round">
                  <p>This page is unavailable. Sign in to return Home.</p>
                  <Link className="button button-primary" to="/login">
                    Sign in
                  </Link>
                </AuthCard>
              )
            }
          />
        </Routes>
      )}
      {logoutPrompt && session?.principal.kind === "guest" && (
        <Dialog
          title="Sign out of guest access?"
          onClose={() => setLogoutPrompt(false)}
        >
          <p className="consent-copy">{GUEST_ENTRY_COPY}</p>
          <p>
            Signing out clears this browser’s guest session. If that saved
            access is lost or expires, the previous guest player cannot be
            restored by name; ask the inviter for a new invitation. Points
            remain with the original player.
          </p>
          {globalError && (
            <p className="error-message" role="alert">
              {globalError}
            </p>
          )}
          <div className="inline-actions">
            <button
              className="button button-danger"
              type="button"
              disabled={authBusy}
              onClick={() => void performLogout()}
            >
              {authBusy ? "Signing out…" : "Sign out and clear guest session"}
            </button>
            <button
              className="button"
              type="button"
              onClick={() => setLogoutPrompt(false)}
            >
              Keep using this browser
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function MatchLoginRoute({
  onSubmit,
  busy,
  error,
}: {
  onSubmit: (
    username: string,
    password: string,
    returnMatchId?: string,
  ) => Promise<void>;
  busy: boolean;
  error: string;
}) {
  const { matchId = "" } = useParams();
  return (
    <LoginPage
      currentGuest={false}
      busy={busy}
      message={error}
      onSubmit={(username, password) => onSubmit(username, password, matchId)}
    />
  );
}
