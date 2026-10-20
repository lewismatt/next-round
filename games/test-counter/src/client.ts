// SPDX-License-Identifier: Apache-2.0
import type {
  GameBridge,
  GameClient,
  GameMountResult,
  Json,
  MatchSnapshot,
  Member,
} from "@next-round/game-client";
import { defineGameClient } from "@next-round/game-client";

interface CounterView {
  count: number;
  target: number;
  turnSeconds: number | null;
  scores: Record<string, number>;
  turnOrder: string[];
  currentActorMemberId: string | null;
  myMarker: string | null;
  myNote: string | null;
  myScore: number | null;
  [key: string]: Json;
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function mount(
  element: HTMLElement,
  bridge: GameBridge<CounterView>,
): GameMountResult {
  const root = document.createElement("div");
  root.className = "next-round-counter-game";
  element.appendChild(root);

  let currentSnapshot: MatchSnapshot<CounterView> = bridge.getSnapshot();
  let isActing = false;
  let statusMessage = "";
  let statusIsError = false;

  const render = () => {
    const { phase, mode, game, capabilities, members } = currentSnapshot;
    const canAdd = phase === "active" && capabilities.canAct && !isActing;
    const scoreRows = members.map((member: Member) => {
      const isActor = member.id === game.currentActorMemberId;
      const score = game.scores[member.id] ?? 0;
      return `<li class="counter-score-item${isActor ? " actor" : ""}">
        <span>${escapeText(member.displayName)}${isActor ? " · current turn" : ""}</span>
        <strong>${score}</strong>
      </li>`;
    }).join("");
    const currentActor = members.find((member) => member.id === game.currentActorMemberId);
    const actorText = currentActor ? `Current turn: ${escapeText(currentActor.displayName)}` : "No current turn";
    const phaseText = phase === "lobby" ? "Waiting to start" : phase === "active" ? "In progress" : "Finished";
    const modeText = mode === "group" ? "Group" : "Solo";
    const messageClass = statusIsError ? "counter-error" : "status-message";
    const statusHtml = statusMessage
      ? `<p class="${messageClass}" role="${statusIsError ? "alert" : "status"}" aria-live="polite">${escapeText(statusMessage)}</p>`
      : "";

    root.innerHTML = `
      <div class="counter-panel">
        <header class="counter-header">
          <div>
            <h2>Test Counter</h2>
            <div class="counter-details" aria-label="Game status">
              <span>Mode: <strong>${modeText}</strong></span>
              <span>Phase: <strong>${phaseText}</strong></span>
            </div>
          </div>
          <span class="badge">${actorText}</span>
        </header>

        <section class="counter-count" aria-label="Shared count">
          <div class="counter-number" aria-live="polite">${game.count} / ${game.target}</div>
          <p class="counter-hint">Count to the target together.</p>
          <button id="nr-counter-add-btn" class="button button-primary counter-primary-action" type="button" aria-label="Add one to the shared count" ${canAdd ? "" : "disabled"}>
            Add one
          </button>
        </section>
        ${statusHtml}

        <div class="counter-columns">
          <section class="counter-section" aria-labelledby="nr-counter-scores-heading">
            <h3 id="nr-counter-scores-heading">Scores</h3>
            <ul class="counter-scores">${scoreRows || "<li>No scores yet</li>"}</ul>
          </section>
          <section class="counter-section" aria-labelledby="nr-counter-private-heading">
            <h3 id="nr-counter-private-heading">Your private state</h3>
            <p>Marker: <strong>${escapeText(game.myMarker ?? "None")}</strong></p>
            <p>Your score: <strong>${game.myScore ?? 0}</strong></p>
            <form id="nr-counter-note-form">
              <div class="field">
                <label for="nr-counter-note-input">Private note (up to 80 characters)</label>
                <input id="nr-counter-note-input" type="text" maxlength="80" value="${escapeText(game.myNote ?? "")}" autocomplete="off" />
              </div>
              <button id="nr-counter-note-btn" class="button" type="submit" ${isActing || phase !== "active" ? "disabled" : ""}>Save private note</button>
            </form>
          </section>
        </div>

        <footer class="counter-footer">
          <button id="nr-counter-chat-btn" class="button" type="button">Open match chat</button>
          <button id="nr-counter-participants-btn" class="button" type="button">Open participants</button>
        </footer>
      </div>
    `;

    const addButton = root.querySelector<HTMLButtonElement>("#nr-counter-add-btn");
    addButton?.addEventListener("click", async () => {
      if (!canAdd || isActing) return;
      isActing = true;
      statusMessage = "Updating the shared count…";
      statusIsError = false;
      render();
      try {
        await bridge.act({
          type: "add",
          payload: { amount: 1 },
          commandId: crypto.randomUUID(),
          expectedRevision: currentSnapshot.revision,
        });
        statusMessage = "Count updated.";
      } catch (cause: unknown) {
        statusMessage = cause instanceof Error ? cause.message : "The count could not be updated.";
        statusIsError = true;
      } finally {
        isActing = false;
        render();
      }
    });

    const noteForm = root.querySelector<HTMLFormElement>("#nr-counter-note-form");
    const noteInput = root.querySelector<HTMLInputElement>("#nr-counter-note-input");
    noteForm?.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!noteInput || isActing || currentSnapshot.phase !== "active") return;
      const text = noteInput.value.slice(0, 80);
      isActing = true;
      statusMessage = "Saving your private note…";
      statusIsError = false;
      render();
      try {
        await bridge.act({
          type: "note",
          payload: { text },
          commandId: crypto.randomUUID(),
          expectedRevision: currentSnapshot.revision,
        });
        statusMessage = "Private note saved.";
      } catch (cause: unknown) {
        statusMessage = cause instanceof Error ? cause.message : "The note could not be saved.";
        statusIsError = true;
      } finally {
        isActing = false;
        render();
      }
    });

    root.querySelector<HTMLButtonElement>("#nr-counter-chat-btn")?.addEventListener("click", () => bridge.openPanel("chat"));
    root.querySelector<HTMLButtonElement>("#nr-counter-participants-btn")?.addEventListener("click", () => bridge.openPanel("participants"));
  };

  const unsubscribe = bridge.subscribe((snapshot: MatchSnapshot<CounterView>) => {
    currentSnapshot = snapshot;
    render();
  });

  render();

  return {
    unmount() {
      unsubscribe();
      root.remove();
    },
  };
}

export const client: GameClient<CounterView> = defineGameClient<CounterView>({ mount });
