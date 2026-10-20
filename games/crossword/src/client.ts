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
import type { CrosswordClueView, CrosswordView } from "./types.js";

/**
 * Master Spec §9 C2/C3 — crossword browser client.
 *
 * The client is deliberately server-free: it imports only the platform bridge
 * and the type-only view types. It never imports `./server.js` or
 * `./content.js`, so `node:crypto` never reaches the browser bundle.
 *
 * Two rules shape the whole implementation:
 *
 * 1. Individual cells are never guesses. The only way to send letters to the
 *    server is the explicit `submit_word` action, and it carries one whole
 *    word answer. Typed letters stay in a local draft map.
 * 2. Every user intent produces exactly one command id, reused for any
 *    network retry of that same intent, and carries the revision the client
 *    was looking at when the intent was formed.
 */

type CrosswordSnapshot = MatchSnapshot<CrosswordView>;

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function directionLabel(direction: CrosswordClueView["direction"]): string {
  return direction === "across" ? "Across" : "Down";
}

export function mount(
  element: HTMLElement,
  bridge: GameBridge<CrosswordView>,
): GameMountResult {
  const root = document.createElement("div");
  root.className = "next-round-crossword-game";
  element.appendChild(root);

  let currentSnapshot: CrosswordSnapshot = bridge.getSnapshot();
  let isActing = false;
  let statusMessage = "";
  let statusIsError = false;
  let selectedWordId: string | null = null;
  let selectedCell: { row: number; col: number } | null = null;
  /** Local-only typed letters, per word id, keyed by grid cell. */
  const drafts = new Map<string, Map<string, string>>();

  const view = (): CrosswordView => currentSnapshot.game;

  const clueList = (): CrosswordClueView[] => view().clues ?? [];

  const findClue = (wordId: string | null): CrosswordClueView | null =>
    wordId === null
      ? null
      : (clueList().find((clue) => clue.id === wordId) ?? null);

  const boardLetter = (row: number, col: number): string | null => {
    const game = view();
    if (game.rows === null || game.cols === null) return null;
    const index = row * game.cols + col;
    return game.board?.[index] ?? null;
  };

  const isBlocked = (row: number, col: number): boolean => {
    const game = view();
    if (game.rows === null || game.cols === null) return true;
    const index = row * game.cols + col;
    return game.blocked?.[index] ?? true;
  };

  const draftMap = (wordId: string): Map<string, string> => {
    let map = drafts.get(wordId);
    if (!map) {
      map = new Map<string, string>();
      drafts.set(wordId, map);
    }
    return map;
  };

  /** Cell indexes of a word that the server has not solved yet. */
  const unsolvedIndexes = (clue: CrosswordClueView): number[] =>
    clue.cells
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => boardLetter(cell.row, cell.col) === null)
      .map(({ index }) => index);

  /** The typed letters of a word, in the order of its unsolved cells. */
  const draftText = (clue: CrosswordClueView): string => {
    const map = drafts.get(clue.id);
    if (!map) return "";
    return unsolvedIndexes(clue)
      .map((index) => {
        const cell = clue.cells[index];
        return map.get(cellKey(cell.row, cell.col)) ?? "";
      })
      .join("");
  };

  /** Solved letters plus local draft letters, in cell order. */
  const composedAnswer = (clue: CrosswordClueView): string => {
    const map = drafts.get(clue.id);
    return clue.cells
      .map((cell) => {
        const solved = boardLetter(cell.row, cell.col);
        if (solved) return solved;
        return map?.get(cellKey(cell.row, cell.col)) ?? ".";
      })
      .join("");
  };

  const memberName = (memberId: string | null): string => {
    if (!memberId) return "Unknown";
    const member: Member | undefined = currentSnapshot.members.find(
      (candidate) => candidate.id === memberId,
    );
    return member ? member.displayName : memberId;
  };

  const send = async (
    type: string,
    payload: Json,
    commandId: string,
    busyMessage: string,
  ): Promise<void> => {
    if (isActing) return;
    isActing = true;
    statusMessage = busyMessage;
    statusIsError = false;
    render();
    try {
      await bridge.act({
        type,
        payload,
        commandId,
        expectedRevision: currentSnapshot.revision,
      });
      statusMessage = "";
      statusIsError = false;
    } catch (cause: unknown) {
      statusMessage =
        cause instanceof Error
          ? cause.message
          : "The action could not be completed.";
      statusIsError = true;
    } finally {
      isActing = false;
      render();
    }
  };

  const selectWord = (
    wordId: string,
    cell: { row: number; col: number } | null,
  ): void => {
    selectedWordId = wordId;
    selectedCell = cell;
    const clue = findClue(wordId);
    if (clue && !cell) {
      const positions = unsolvedIndexes(clue);
      const target =
        positions.length > 0 ? clue.cells[positions[0]] : clue.cells[0];
      selectedCell = { row: target.row, col: target.col };
    }
    render();
  };

  const render = () => {
    const game = view();
    const snapshot = currentSnapshot;
    const active = document.activeElement as HTMLInputElement | null;
    const restoreId =
      active && root.contains(active) && active.id ? active.id : null;
    const restoreStart = restoreId ? active?.selectionStart ?? null : null;
    const restoreEnd = restoreId ? active?.selectionEnd ?? null : null;

    const rows = game.rows ?? 0;
    const cols = game.cols ?? 0;
    const selectedClue = findClue(selectedWordId);
    const completed = new Set(game.completedWordIds);
    const assisted = new Set(game.assistedWordIds);

    const wordsByCell = new Map<string, CrosswordClueView[]>();
    for (const clue of clueList()) {
      for (const cell of clue.cells) {
        const key = cellKey(cell.row, cell.col);
        const list = wordsByCell.get(key) ?? [];
        list.push(clue);
        wordsByCell.set(key, list);
      }
    }

    const draftFor = selectedClue ? drafts.get(selectedClue.id) : undefined;

    const cellHtml: string[] = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const index = row * cols + col;
        if (isBlocked(row, col)) {
          cellHtml.push(
            `<div class="crossword-cell crossword-cell-blocked" role="gridcell" aria-hidden="true"></div>`,
          );
          continue;
        }
        const number = game.numbers?.[index] ?? null;
        const letter = boardLetter(row, col);
        const owning = wordsByCell.get(cellKey(row, col)) ?? [];
        const isSelected = owning.some((clue) => clue.id === selectedWordId);
        const isCompleted = owning.some((clue) => completed.has(clue.id));
        const isAssisted = owning.some((clue) => assisted.has(clue.id));
        const draftLetter = draftFor?.get(cellKey(row, col)) ?? "";
        const shown = letter ?? (isSelected ? draftLetter : "");
        const classes = ["crossword-cell"];
        if (isSelected) classes.push("selected");
        if (isCompleted) classes.push("completed");
        if (isAssisted) classes.push("assisted");
        if (draftLetter && !letter) classes.push("draft");
        const marker = isCompleted
          ? `<span class="crossword-cell-marker" aria-hidden="true">✓</span>`
          : isAssisted
            ? `<span class="crossword-cell-marker" aria-hidden="true">▲</span>`
            : "";
        const label = [
          number === null ? null : `Number ${number}`,
          letter ? `letter ${letter}` : draftLetter ? `draft ${draftLetter}` : "empty",
          owning.length > 0
            ? `word${owning.length > 1 ? "s" : ""} ${owning
                .map((clue) => `${clue.number} ${directionLabel(clue.direction)}`)
                .join(", ")}`
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(", ");
        cellHtml.push(
          `<button type="button" class="${classes.join(" ")}" role="gridcell" data-row="${row}" data-col="${col}" aria-label="${escapeText(label)}">
            <span class="crossword-cell-number">${number === null ? "" : number}</span>
            <span class="crossword-cell-letter">${escapeText(shown)}</span>
            ${marker}
          </button>`,
        );
      }
    }

    const clueItem = (clue: CrosswordClueView): string => {
      const isSelected = clue.id === selectedWordId;
      const isCompleted = completed.has(clue.id);
      const isAssisted = assisted.has(clue.id);
      const marker = isCompleted
        ? `<span class="crossword-clue-flag crossword-clue-flag-completed" aria-label="Completed">✓</span>`
        : isAssisted
          ? `<span class="crossword-clue-flag crossword-clue-flag-assisted" aria-label="Revealed, no points">▲</span>`
          : "";
      return `<li class="crossword-clue-item">
        <button type="button" class="crossword-clue${isSelected ? " selected" : ""}" data-word-id="${escapeText(clue.id)}" aria-pressed="${isSelected ? "true" : "false"}" aria-label="${escapeText(`${directionLabel(clue.direction)} ${clue.number}, ${clue.length} letters`)}">
          <span class="crossword-clue-label">${clue.number}. ${escapeText(clue.text)}</span>
          <span class="crossword-clue-length">(${clue.length})</span>
          ${marker}
        </button>
      </li>`;
    };

    const acrossClues = clueList().filter(
      (clue) => clue.direction === "across",
    );
    const downClues = clueList().filter((clue) => clue.direction === "down");

    const answer = selectedClue ? composedAnswer(selectedClue) : "";
    const answerText = selectedClue
      ? `${selectedClue.number} ${directionLabel(selectedClue.direction)} (${selectedClue.length} letters)`
      : "No word selected";
    const answerComplete =
      selectedClue !== null &&
      answer.length === selectedClue.length &&
      !answer.includes(".");
    const draftValue = selectedClue ? draftText(selectedClue) : "";

    const canSubmit =
      game.canSubmitWord &&
      game.phase === "active" &&
      selectedClue !== null &&
      answerComplete &&
      !completed.has(selectedClue.id) &&
      !isActing;
    const canPass = game.canPass && game.phase === "active" && !isActing;
    const canContinue = game.soloAwaitingContinue && !isActing;
    const canRevealLetter =
      game.canReveal &&
      selectedCell !== null &&
      !isBlocked(selectedCell.row, selectedCell.col) &&
      boardLetter(selectedCell.row, selectedCell.col) === null &&
      !isActing;
    const canRevealWord =
      game.canReveal && selectedClue !== null && !isActing;
    const canRevealPuzzle = game.canReveal && !isActing;
    const canDeclare = game.canDeclareExposure && !isActing;

    const feedback = game.privateFeedback;
    const feedbackHtml = feedback
      ? `<p class="crossword-feedback-line">Last wrong guess: <strong>${escapeText(feedback.lastWrongGuess ?? "None")}</strong></p>
         <p class="crossword-feedback-line">Wrong guesses left this turn: <strong>${feedback.remainingWrong === null ? "Unlimited" : feedback.remainingWrong}</strong></p>`
      : `<p class="crossword-feedback-line">No private feedback yet.</p>`;

    let deadlineHtml = `<p class="crossword-feedback-line">Turn deadline: <strong>No timer</strong></p>`;
    if (game.turnDueAt) {
      const due = new Date(game.turnDueAt);
      const dueLabel = Number.isNaN(due.getTime())
        ? game.turnDueAt
        : due.toLocaleTimeString();
      const nowMs = Date.parse(snapshot.serverNow);
      const dueMs = due.getTime();
      let remaining = "";
      if (!Number.isNaN(nowMs) && !Number.isNaN(dueMs)) {
        const total = Math.max(0, Math.floor((dueMs - nowMs) / 1000));
        const minutes = Math.floor(total / 60);
        const seconds = total % 60;
        remaining = ` · ${minutes}:${seconds.toString().padStart(2, "0")} left`;
      }
      deadlineHtml = `<p class="crossword-feedback-line">Turn deadline: <strong>${escapeText(dueLabel)}</strong>${remaining}</p>`;
    }

    const suspendedHtml = game.suspended
      ? `<p class="crossword-notice crossword-notice-suspended" role="status">This match is suspended until a member is reactivated.</p>`
      : "";

    const continueHtml = game.soloAwaitingContinue
      ? `<div class="crossword-continue">
          <p class="crossword-notice">The turn ended. Continue when you are ready for the next one.</p>
          <button id="nr-crossword-continue-btn" class="button button-primary" type="button" ${canContinue ? "" : "disabled"}>Continue</button>
        </div>`
      : "";

    const exclusionItems = game.exclusionReasons
      .map((reason) => `<li>${escapeText(reason)}</li>`)
      .join("");
    const exclusionHtml = game.exclusionReasons.length
      ? `<section class="crossword-exclusions" aria-labelledby="nr-crossword-exclusions-heading">
          <h3 id="nr-crossword-exclusions-heading">Match notice</h3>
          <ul class="crossword-exclusion-list">${exclusionItems}</ul>
        </section>`
      : "";

    const scoreRows = snapshot.members
      .map((member) => {
        const score = game.scores[member.id] ?? 0;
        const isActor = member.id === game.currentMemberId;
        const isViewer = member.id === game.myMemberId;
        const tags = [
          isActor ? "current turn" : null,
          isViewer ? "you" : null,
        ].filter((tag): tag is string => tag !== null);
        return `<li class="crossword-score-item${isActor ? " actor" : ""}">
          <span>${escapeText(member.displayName)}${tags.length ? ` · ${escapeText(tags.join(" · "))}` : ""}</span>
          <strong>${score}</strong>
        </li>`;
      })
      .join("");

    const actingHostHtml =
      game.actingHostMemberId &&
      game.actingHostMemberId !== snapshot.hostMemberId
        ? `<span class="badge crossword-badge-acting-host">Acting host: ${escapeText(memberName(game.actingHostMemberId))}</span>`
        : "";

    const statusHtml = statusMessage
      ? `<p class="${statusIsError ? "crossword-error" : "crossword-status"}" role="${statusIsError ? "alert" : "status"}" aria-live="polite">${escapeText(statusMessage)}</p>`
      : "";

    const gridHtml =
      rows > 0 && cols > 0
        ? `<div class="crossword-grid" role="grid" aria-label="Crossword grid" style="--crossword-cols: ${cols}">${cellHtml.join("")}</div>`
        : `<p class="crossword-hint">The grid appears once the match starts.</p>`;

    root.innerHTML = `
      <div class="crossword-panel">
        <header class="crossword-header">
          <div class="crossword-heading">
            <h2>${escapeText(game.title ?? "Crossword")}</h2>
            <div class="crossword-details" aria-label="Match status">
              <span>Mode: <strong>${escapeText(game.mode)}</strong></span>
              <span>Preset: <strong>${escapeText(game.preset === "solo_casual" ? "Solo casual" : game.preset === "quick" ? "Quick" : "Custom")}</strong></span>
              <span>Phase: <strong>${escapeText(game.phase === "lobby" ? "Waiting to start" : game.phase === "finished" ? "Finished" : "In progress")}</strong></span>
              ${game.difficulty ? `<span>Difficulty: <strong>${escapeText(game.difficulty)}</strong></span>` : ""}
              ${game.author ? `<span>Author: <strong>${escapeText(game.author)}</strong></span>` : ""}
            </div>
          </div>
          <div class="crossword-badges">
            <span class="badge">Current turn: ${escapeText(memberName(game.currentMemberId))}${game.currentMemberId && game.currentMemberId === game.myMemberId ? " (you)" : ""}</span>
            ${actingHostHtml}
          </div>
        </header>

        ${exclusionHtml}
        ${suspendedHtml}

        <div class="crossword-layout">
          <section class="crossword-board" aria-label="Crossword board">
            ${gridHtml}
            <div class="crossword-answer">
              <label class="crossword-answer-label" for="nr-crossword-answer-input">Answer for ${escapeText(answerText)}</label>
              <div class="crossword-answer-row">
                <input id="nr-crossword-answer-input" class="crossword-answer-input" type="text" inputmode="text" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" maxlength="${selectedClue ? Math.max(0, unsolvedIndexes(selectedClue).length) : 0}" placeholder="${selectedClue ? "Type the letters" : "Select a clue"}" value="${escapeText(draftValue)}" ${selectedClue ? "" : "disabled"} />
                <button id="nr-crossword-submit-btn" class="button button-primary" type="button" ${canSubmit ? "" : "disabled"}>Submit word</button>
              </div>
              <p class="crossword-answer-preview" id="nr-crossword-answer-preview" role="status" aria-live="polite">${escapeText(selectedClue ? answer : "Select a clue to enter an answer.")}</p>
              <p class="crossword-hint">Letters stay local until you press Submit word. Enter never submits by itself.</p>
            </div>
          </section>

          <aside class="crossword-clues" aria-label="Clues">
            <section class="crossword-clue-section" aria-labelledby="nr-crossword-across-heading">
              <h3 id="nr-crossword-across-heading">Across</h3>
              <ul class="crossword-clue-list">${acrossClues.map(clueItem).join("") || "<li class=\"crossword-hint\">No across clues yet.</li>"}</ul>
            </section>
            <section class="crossword-clue-section" aria-labelledby="nr-crossword-down-heading">
              <h3 id="nr-crossword-down-heading">Down</h3>
              <ul class="crossword-clue-list">${downClues.map(clueItem).join("") || "<li class=\"crossword-hint\">No down clues yet.</li>"}</ul>
            </section>
          </aside>
        </div>

        <section class="crossword-status-panel" aria-label="Your private feedback">
          <h3>Your private feedback</h3>
          ${feedbackHtml}
          ${deadlineHtml}
          ${continueHtml}
          ${statusHtml}
        </section>

        <section class="crossword-controls" aria-label="Crossword actions">
          <button id="nr-crossword-pass-btn" class="button" type="button" ${canPass ? "" : "disabled"}>Pass</button>
          <button id="nr-crossword-reveal-letter-btn" class="button" type="button" ${canRevealLetter ? "" : "disabled"}>Reveal letter</button>
          <button id="nr-crossword-reveal-word-btn" class="button" type="button" ${canRevealWord ? "" : "disabled"}>Reveal word</button>
          <button id="nr-crossword-reveal-puzzle-btn" class="button" type="button" ${canRevealPuzzle ? "" : "disabled"}>Reveal puzzle</button>
          <button id="nr-crossword-declare-btn" class="button" type="button" ${canDeclare ? "" : "disabled"}>Declare outside knowledge</button>
        </section>

        <section class="crossword-section" aria-labelledby="nr-crossword-scores-heading">
          <h3 id="nr-crossword-scores-heading">Scores</h3>
          <ul class="crossword-scores">${scoreRows || "<li class=\"crossword-hint\">No scores yet.</li>"}</ul>
        </section>

        <footer class="crossword-footer">
          <button id="nr-crossword-chat-btn" class="button" type="button">Open match chat</button>
          <button id="nr-crossword-participants-btn" class="button" type="button">Open participants</button>
        </footer>
      </div>
    `;

    const clueButtons = root.querySelectorAll<HTMLButtonElement>(
      ".crossword-clue[data-word-id]",
    );
    clueButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const wordId = button.dataset.wordId ?? null;
        if (!wordId) return;
        selectWord(wordId, null);
        root
          .querySelector<HTMLInputElement>("#nr-crossword-answer-input")
          ?.focus();
      });
    });

    const cellButtons = root.querySelectorAll<HTMLButtonElement>(
      ".crossword-cell[data-row]",
    );
    cellButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const row = Number(button.dataset.row);
        const col = Number(button.dataset.col);
        if (!Number.isFinite(row) || !Number.isFinite(col)) return;
        const owning = wordsByCell.get(cellKey(row, col)) ?? [];
        const preferred =
          owning.find((clue) => clue.direction === "across") ??
          owning[0] ??
          null;
        selectedCell = { row, col };
        selectedWordId = preferred ? preferred.id : selectedWordId;
        render();
        const input = root.querySelector<HTMLInputElement>(
          "#nr-crossword-answer-input",
        );
        input?.focus();
      });
    });

    const grid = root.querySelector<HTMLElement>(".crossword-grid");
    grid?.addEventListener("keydown", (event) => {
      const key = event.key.toUpperCase();
      if (!/^[A-Z]$/.test(key)) return;
      const clue = findClue(selectedWordId);
      if (!clue) return;
      event.preventDefault();
      const positions = unsolvedIndexes(clue);
      const map = draftMap(clue.id);
      const firstEmpty = positions.find((index) => {
        const cell = clue.cells[index];
        return !map.has(cellKey(cell.row, cell.col));
      });
      if (firstEmpty === undefined) return;
      const cell = clue.cells[firstEmpty];
      map.set(cellKey(cell.row, cell.col), key);
      updateDraftDom(clue, true);
    });

    const answerInput = root.querySelector<HTMLInputElement>(
      "#nr-crossword-answer-input",
    );
    answerInput?.addEventListener("input", () => {
      const input = answerInput;
      if (!input) return;
      const clue = findClue(selectedWordId);
      if (!clue) return;
      const positions = unsolvedIndexes(clue);
      const letters = input.value
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
        .slice(0, positions.length);
      const map = draftMap(clue.id);
      positions.forEach((index, offset) => {
        const cell = clue.cells[index];
        const key = cellKey(cell.row, cell.col);
        if (offset < letters.length) map.set(key, letters[offset]);
        else map.delete(key);
      });
      if (input.value !== letters) {
        input.value = letters;
        try {
          input.setSelectionRange(letters.length, letters.length);
        } catch {
          /* selection is best effort */
        }
      }
      updateDraftDom(clue, false);
    });

    root
      .querySelector<HTMLButtonElement>("#nr-crossword-submit-btn")
      ?.addEventListener("click", () => {
        const clue = findClue(selectedWordId);
        if (!clue) return;
        const value = composedAnswer(clue);
        if (value.includes(".") || value.length !== clue.length) {
          statusMessage =
            "Fill every letter of the selected word before submitting.";
          statusIsError = true;
          render();
          return;
        }
        void send(
          "submit_word",
          { wordId: clue.id, answer: value },
          crypto.randomUUID(),
          "Submitting your word…",
        );
      });

    root
      .querySelector<HTMLButtonElement>("#nr-crossword-pass-btn")
      ?.addEventListener("click", () => {
        void send("pass", {}, crypto.randomUUID(), "Passing your turn…");
      });

    root
      .querySelector<HTMLButtonElement>("#nr-crossword-continue-btn")
      ?.addEventListener("click", () => {
        void send(
          "continue",
          {},
          crypto.randomUUID(),
          "Starting the next turn…",
        );
      });

    root
      .querySelector<HTMLButtonElement>("#nr-crossword-reveal-letter-btn")
      ?.addEventListener("click", () => {
        if (!selectedCell) return;
        void send(
          "reveal_letter",
          { row: selectedCell.row, col: selectedCell.col },
          crypto.randomUUID(),
          "Revealing the letter…",
        );
      });

    root
      .querySelector<HTMLButtonElement>("#nr-crossword-reveal-word-btn")
      ?.addEventListener("click", () => {
        const clue = findClue(selectedWordId);
        if (!clue) return;
        void send(
          "reveal_word",
          { wordId: clue.id },
          crypto.randomUUID(),
          "Revealing the word…",
        );
      });

    root
      .querySelector<HTMLButtonElement>("#nr-crossword-reveal-puzzle-btn")
      ?.addEventListener("click", () => {
        void send(
          "reveal_puzzle",
          {},
          crypto.randomUUID(),
          "Revealing the puzzle…",
        );
      });

    root
      .querySelector<HTMLButtonElement>("#nr-crossword-declare-btn")
      ?.addEventListener("click", () => {
        void send(
          "declare_exposure",
          {},
          crypto.randomUUID(),
          "Recording your declaration…",
        );
      });

    root
      .querySelector<HTMLButtonElement>("#nr-crossword-chat-btn")
      ?.addEventListener("click", () => bridge.openPanel("chat"));
    root
      .querySelector<HTMLButtonElement>("#nr-crossword-participants-btn")
      ?.addEventListener("click", () => bridge.openPanel("participants"));

    if (restoreId) {
      const restored = root.querySelector<HTMLElement>(`#${restoreId}`);
      if (restored instanceof HTMLInputElement) {
        restored.focus();
        const start = Math.min(
          restoreStart ?? restored.value.length,
          restored.value.length,
        );
        const end = Math.min(restoreEnd ?? start, restored.value.length);
        try {
          restored.setSelectionRange(start, end);
        } catch {
          /* selection is best effort */
        }
      } else {
        restored?.focus();
      }
    }
  };

  /**
   * Patches only the parts of the DOM that the local draft changes, so the
   * answer input keeps focus and caret position while typing.
   */
  const updateDraftDom = (
    clue: CrosswordClueView,
    syncInput: boolean,
  ): void => {
    const preview = root.querySelector("#nr-crossword-answer-preview");
    if (preview) preview.textContent = composedAnswer(clue);
    if (syncInput) {
      const input = root.querySelector<HTMLInputElement>(
        "#nr-crossword-answer-input",
      );
      if (input) {
        const text = draftText(clue);
        if (input.value !== text) {
          input.value = text;
          try {
            input.setSelectionRange(text.length, text.length);
          } catch {
            /* selection is best effort */
          }
        }
      }
    }
    const map = drafts.get(clue.id);
    for (const cell of clue.cells) {
      const button = root.querySelector<HTMLButtonElement>(
        `.crossword-cell[data-row="${cell.row}"][data-col="${cell.col}"]`,
      );
      if (!button) continue;
      const letter = boardLetter(cell.row, cell.col);
      const draftLetter = map?.get(cellKey(cell.row, cell.col)) ?? "";
      const span = button.querySelector<HTMLElement>(".crossword-cell-letter");
      if (span) span.textContent = letter ?? draftLetter;
      button.classList.toggle("draft", !letter && draftLetter !== "");
    }
    const submitButton = root.querySelector<HTMLButtonElement>(
      "#nr-crossword-submit-btn",
    );
    if (submitButton) {
      const answer = composedAnswer(clue);
      const complete = answer.length === clue.length && !answer.includes(".");
      submitButton.disabled = !(
        view().canSubmitWord &&
        view().phase === "active" &&
        complete &&
        !view().completedWordIds.includes(clue.id) &&
        !isActing
      );
    }
  };

  const unsubscribe = bridge.subscribe((snapshot: CrosswordSnapshot) => {
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

/**
 * The exported client is typed against `Json` because `CrosswordView` (and the
 * nested view interfaces it uses) is an interface without an index signature
 * and therefore cannot satisfy the `Json` constraint of `GameClient`. The view
 * is read through `CrosswordView` inside `mount`, which is the type the
 * crossword server publishes.
 */
export const client: GameClient<CrosswordView> =
  defineGameClient<CrosswordView>({ mount });
