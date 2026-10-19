// SPDX-License-Identifier: Apache-2.0
import type {
  CommandReceipt,
  GameBridge,
  GameClient,
  GameMountResult,
  MatchSnapshot,
  Member,
} from "@next-round/game-client";
import { defineGameClient } from "@next-round/game-client";
import type { CounterView } from "./server.js";

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
  bridge: GameBridge<CounterView>
): GameMountResult {
  const root = document.createElement("div");
  root.className = "next-round-counter-game";
  element.appendChild(root);

  let currentSnapshot: MatchSnapshot<CounterView> = bridge.getSnapshot();
  let isActing = false;
  let statusMessage = "";

  const render = () => {
    const { phase, revision, mode, game, capabilities, members } = currentSnapshot;
    const isCurrentActor = game.currentActorMemberId !== null;
    const canClickAdd = phase === "active" && capabilities.canAct && !isActing;

    const scoresListHtml = Object.entries(game.scores)
      .map(([memberId, score]) => {
        const member = members.find((m: Member) => m.id === memberId);
        const name = member ? member.displayName : memberId;
        const isActor = memberId === game.currentActorMemberId;
        return `<li class="counter-score-item${isActor ? " actor" : ""}">
          <span>${escapeText(name)}${isActor ? " (turn)" : ""}:</span>
          <strong>${score}</strong>
        </li>`;
      })
      .join("");

    root.innerHTML = `
      <div class="counter-panel" style="padding: 1rem; font-family: system-ui, sans-serif;">
        <header style="margin-bottom: 1rem; border-bottom: 1px solid #ddd; padding-bottom: 0.5rem;">
          <h2 style="margin: 0 0 0.5rem 0;">Test Counter</h2>
          <div style="font-size: 0.875rem; color: #555;">
            <span>Mode: <strong>${escapeText(mode)}</strong></span> |
            <span>Phase: <strong>${escapeText(phase)}</strong></span> |
            <span>Revision: <strong>${revision}</strong></span>
          </div>
        </header>

        <section style="margin-bottom: 1.5rem; text-align: center;">
          <div style="font-size: 3rem; font-weight: bold; margin: 0.5rem 0;">
            ${game.count} / ${game.target}
          </div>
          <div style="font-size: 0.9rem; color: #666;">
            Target count to complete
          </div>
          <div style="margin-top: 1rem;">
            <button
              id="nr-counter-add-btn"
              style="padding: 0.75rem 2rem; font-size: 1.25rem; cursor: ${canClickAdd ? "pointer" : "not-allowed"};"
              ${canClickAdd ? "" : "disabled"}
            >
              +1 Add
            </button>
          </div>
          ${
            statusMessage
              ? `<p style="color: #c00; font-size: 0.875rem; margin-top: 0.5rem;">${escapeText(statusMessage)}</p>`
              : ""
          }
        </section>

        <section style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1rem;">
          <div style="border: 1px solid #eee; padding: 0.75rem; border-radius: 4px;">
            <h4 style="margin: 0 0 0.5rem 0;">Scores</h4>
            <ul style="list-style: none; padding: 0; margin: 0;">
              ${scoresListHtml || "<li>No scores yet</li>"}
            </ul>
          </div>

          <div style="border: 1px solid #eee; padding: 0.75rem; border-radius: 4px;">
            <h4 style="margin: 0 0 0.5rem 0;">Your Private State</h4>
            <p style="margin: 0.25rem 0; font-size: 0.875rem;">Marker: <strong>${escapeText(game.myMarker ?? "None")}</strong></p>
            <p style="margin: 0.25rem 0; font-size: 0.875rem;">Score: <strong>${game.myScore ?? 0}</strong></p>
            <div style="margin-top: 0.5rem;">
              <label for="nr-counter-note-input" style="font-size: 0.75rem; display: block; margin-bottom: 0.25rem;">Private Note (max 80 chars):</label>
              <div style="display: flex; gap: 0.25rem;">
                <input
                  id="nr-counter-note-input"
                  type="text"
                  maxlength="80"
                  value="${escapeText(game.myNote ?? "")}"
                  style="flex: 1; padding: 0.25rem 0.5rem; font-size: 0.875rem;"
                />
                <button id="nr-counter-note-btn" style="padding: 0.25rem 0.5rem; font-size: 0.875rem; cursor: pointer;">
                  Save
                </button>
              </div>
            </div>
          </div>
        </section>

        <footer style="display: flex; gap: 0.5rem; justify-content: flex-end; border-top: 1px solid #eee; padding-top: 0.5rem;">
          <button id="nr-counter-chat-btn" style="padding: 0.25rem 0.75rem; font-size: 0.875rem;">Chat</button>
          <button id="nr-counter-participants-btn" style="padding: 0.25rem 0.75rem; font-size: 0.875rem;">Participants</button>
        </footer>
      </div>
    `;

    // Wire action button
    const addBtn = root.querySelector("#nr-counter-add-btn");
    if (addBtn) {
      addBtn.addEventListener("click", async () => {
        if (!canClickAdd || isActing) return;
        isActing = true;
        statusMessage = "";
        render();

        try {
          const commandId = crypto.randomUUID();
          await bridge.act({
            type: "add",
            payload: { amount: 1 },
            commandId,
            expectedRevision: currentSnapshot.revision,
          });
        } catch (err: unknown) {
          statusMessage = err instanceof Error ? err.message : "Failed to add count.";
        } finally {
          isActing = false;
          render();
        }
      });
    }

    // Wire note button
    const noteBtn = root.querySelector("#nr-counter-note-btn");
    const noteInput = root.querySelector("#nr-counter-note-input") as HTMLInputElement | null;
    if (noteBtn && noteInput) {
      noteBtn.addEventListener("click", async () => {
        const text = noteInput.value.slice(0, 80);
        try {
          const commandId = crypto.randomUUID();
          await bridge.act({
            type: "note",
            payload: { text },
            commandId,
            expectedRevision: currentSnapshot.revision,
          });
        } catch (err: unknown) {
          statusMessage = err instanceof Error ? err.message : "Failed to save note.";
          render();
        }
      });
    }

    // Wire panels
    const chatBtn = root.querySelector("#nr-counter-chat-btn");
    if (chatBtn) {
      chatBtn.addEventListener("click", () => bridge.openPanel("chat"));
    }

    const participantsBtn = root.querySelector("#nr-counter-participants-btn");
    if (participantsBtn) {
      participantsBtn.addEventListener("click", () => bridge.openPanel("participants"));
    }
  };

  const unsubscribe = bridge.subscribe((snapshot: MatchSnapshot<CounterView>) => {
    currentSnapshot = snapshot;
    render();
  });

  render();

  return {
    unmount() {
      unsubscribe();
      if (root.parentElement) {
        root.parentElement.removeChild(root);
      }
    },
  };
}

export const client: GameClient<CounterView> = defineGameClient<CounterView>({
  mount,
});
