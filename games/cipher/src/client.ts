// SPDX-License-Identifier: Apache-2.0
import {
  defineGameClient,
  type GameBridge,
  type GameMountResult,
} from "@next-round/game-client";
import type { CipherView, GuessRecord } from "./types.js";

const PALETTE = [
  "#b3392e",
  "#d97b24",
  "#c9a227",
  "#3e7d3a",
  "#2563a8",
  "#5b3ea8",
  "#a83272",
  "#4a4a4a",
];

type Intent = {
  boardLength: number;
  guess: number[];
  commandId: string;
  expectedRevision: number;
  stale: boolean;
};

export function mount(
  element: HTMLElement,
  bridge: GameBridge<CipherView>,
): GameMountResult {
  const root = document.createElement("section");
  root.className = "card next-round-cipher-game";
  root.setAttribute("aria-label", "Cipher game");
  element.append(root);
  let snapshot = bridge.getSnapshot();
  let draft: number[] = [];
  let pending: Intent | null = null;
  let acting = false;
  let mounted = true;
  let message = "";
  let isError = false;
  let clockReceived = performance.now();
  let clockServer = Date.parse(snapshot.serverNow);
  let countdown: HTMLElement | null = null;

  function add<K extends keyof HTMLElementTagNameMap>(
    parent: HTMLElement,
    tag: K,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  }
  function tick() {
    if (!countdown) return;
    const game = snapshot.game;
    if (game.suspended)
      countdown.textContent = "Paused — waiting for an enabled player";
    else if (!game.dueAt) countdown.textContent = "";
    else {
      const seconds = Math.max(
        0,
        Math.ceil(
          (Date.parse(game.dueAt) -
            clockServer -
            (performance.now() - clockReceived)) /
            1000,
        ),
      );
      countdown.textContent = seconds
        ? `Turn ends in ${seconds}s`
        : "Waiting for the turn to pass…";
    }
  }
  function button(
    parent: HTMLElement,
    text: string,
    action: () => void,
    disabled = false,
  ) {
    const node = add(parent, "button", text);
    node.type = "button";
    node.className = "button";
    node.disabled = disabled;
    node.addEventListener("click", action);
    return node;
  }
  function chips(parent: HTMLElement, symbols: number[]) {
    const row = add(parent, "span");
    for (const symbol of symbols) {
      const chip = add(row, "span", String(symbol + 1));
      chip.style.display = "inline-block";
      chip.style.minWidth = "1.8em";
      chip.style.textAlign = "center";
      chip.style.marginRight = "0.25em";
      chip.style.padding = "0.15em 0";
      chip.style.borderRadius = "0.4em";
      chip.style.color = "#fff";
      chip.style.background = PALETTE[symbol] ?? "#333";
    }
    return row;
  }
  function boardRow(parent: HTMLElement, record: GuessRecord) {
    const item = add(parent, "li");
    chips(item, record.guess);
    add(
      item,
      "span",
      ` — ${record.exact} exact, ${record.misplaced} misplaced`,
    );
  }

  async function send(intent: Intent) {
    if (
      acting ||
      !mounted ||
      !snapshot.game.canGuess ||
      snapshot.game.myBoard.length !== intent.boardLength
    )
      return;
    if (intent.stale) {
      intent = {
        ...intent,
        stale: false,
        commandId: crypto.randomUUID(),
        expectedRevision: snapshot.revision,
      };
    }
    pending = intent;
    acting = true;
    message = "Submitting your guess…";
    isError = false;
    render();
    try {
      await bridge.act({
        type: "guess",
        payload: { guess: intent.guess },
        commandId: intent.commandId,
        expectedRevision: intent.expectedRevision,
      });
      if (!mounted) return;
      snapshot = bridge.getSnapshot();
      if (snapshot.game.myBoard.length > intent.boardLength) {
        message = "Your guess is recorded.";
        draft = [];
      }
      if (pending?.commandId === intent.commandId) pending = null;
    } catch (error: unknown) {
      if (!mounted) return;
      const code =
        error && typeof error === "object" && "code" in error
          ? error.code
          : null;
      try {
        snapshot = await bridge.refresh();
      } catch {
        /* Keep intent for explicit transport retry. */
      }
      if (!mounted) return;
      if (snapshot.game.myBoard.length > intent.boardLength) {
        pending = null;
        message = "Your guess is recorded.";
        draft = [];
        isError = false;
      } else if (!snapshot.game.canGuess) {
        pending = null;
        message = "The turn moved on; your guess was not replayed.";
        isError = false;
      } else if (code === "STALE_REVISION") {
        pending = { ...intent, stale: true };
        message =
          "The match changed. Review the board, then explicitly retry your guess.";
        isError = true;
      } else if (
        code === "NETWORK_ERROR" ||
        code === null ||
        (typeof error === "object" &&
          error !== null &&
          "status" in error &&
          Number(error.status) >= 500)
      ) {
        pending = intent;
        message =
          "The result is unknown. Retry explicitly to check the same command; your guess will not be replaced.";
        isError = true;
      } else {
        pending = null;
        message =
          error instanceof Error
            ? error.message
            : "Your guess could not be submitted.";
        isError = true;
      }
    } finally {
      acting = false;
      if (mounted) render();
    }
  }

  function render() {
    if (!mounted) return;
    root.replaceChildren();
    const game = snapshot.game;
    add(root, "h2", "Cipher");
    const presetLabel =
      game.preset[0].toUpperCase() + game.preset.slice(1);
    add(
      root,
      "p",
      game.phase === "lobby"
        ? "Waiting for the host to start"
        : game.phase === "finished"
          ? "Finished"
          : `${presetLabel} · crack the ${game.codeLength}-symbol code in ${game.guessCap} guesses`,
    );
    countdown = add(root, "p");
    countdown.className = "hint";
    tick();

    if (game.phase === "active") {
      const turnName =
        snapshot.members.find((m) => m.id === game.currentMemberId)
          ?.displayName ?? "Another player";
      add(
        root,
        "p",
        game.canGuess
          ? "Your turn — build your guess."
          : `Waiting for ${turnName} to guess.`,
      );
      if (game.canGuess) {
        const builder = add(root, "div");
        add(builder, "h3", "Your guess");
        const draftRow = add(builder, "p");
        if (draft.length) chips(draftRow, draft);
        else add(draftRow, "span", "Pick symbols below.");
        const palette = add(builder, "div");
        palette.className = "inline-actions";
        for (let symbol = 0; symbol < game.alphabetSize; symbol++) {
          const used = !game.repeats && draft.includes(symbol);
          const pick = button(
            palette,
            String(symbol + 1),
            () => {
              if (draft.length < game.codeLength) {
                draft = [...draft, symbol];
                message = "";
                render();
              }
            },
            acting || used || draft.length >= game.codeLength,
          );
          pick.style.background = PALETTE[symbol];
          pick.style.color = "#fff";
        }
        const actions = add(builder, "div");
        actions.className = "inline-actions";
        button(
          actions,
          "Undo",
          () => {
            draft = draft.slice(0, -1);
            render();
          },
          acting || draft.length === 0,
        );
        button(
          actions,
          "Clear",
          () => {
            draft = [];
            render();
          },
          acting || draft.length === 0,
        );
        button(
          actions,
          "Submit guess",
          () => {
            void send({
              boardLength: game.myBoard.length,
              guess: [...draft],
              commandId: crypto.randomUUID(),
              expectedRevision: snapshot.revision,
              stale: false,
            });
          },
          acting || draft.length !== game.codeLength || pending !== null,
        );
        if (pending && game.canGuess) {
          button(
            actions,
            "Retry your guess",
            () => {
              if (pending) void send(pending);
            },
            acting,
          );
        }
      }
      add(root, "h3", "Your board");
      if (game.myBoard.length) {
        const list = add(root, "ol");
        for (const record of game.myBoard) boardRow(list, record);
      } else {
        add(root, "p", "No guesses yet. Your guesses stay private until the match ends.");
      }
      add(root, "h3", "Race");
      const race = add(root, "ul");
      for (const player of game.players) {
        const name =
          snapshot.members.find((m) => m.id === player.memberId)
            ?.displayName ?? "Former player";
        const state = player.cracked
          ? "cracked it"
          : player.done
            ? "out of guesses"
            : game.currentMemberId === player.memberId
              ? "guessing now"
              : "waiting";
        add(
          race,
          "li",
          `${name}: ${player.guessesUsed}/${game.guessCap} guesses · ${state}`,
        );
      }
    }

    if (message) {
      const status = add(root, "p", message);
      status.className = isError ? "error-message" : "status-message";
      status.setAttribute("role", isError ? "alert" : "status");
    }

    if (game.phase === "finished" && game.reveal) {
      add(root, "h3", "The code");
      const codeRow = add(root, "p");
      chips(codeRow, game.reveal.code);
      add(root, "h3", "Every board");
      for (const player of game.players) {
        const name =
          snapshot.members.find((m) => m.id === player.memberId)
            ?.displayName ?? "Former player";
        add(root, "h4", name);
        const board = game.reveal.boards[player.memberId] ?? [];
        if (board.length) {
          const list = add(root, "ol");
          for (const record of board) boardRow(list, record);
        } else {
          add(root, "p", "No guesses.");
        }
      }
    }

    const controls = add(root, "div");
    controls.className = "inline-actions";
    button(controls, "Open match chat", () => bridge.openPanel("chat"));
    button(controls, "Open participants", () =>
      bridge.openPanel("participants"),
    );
  }

  const unsubscribe = bridge.subscribe((next) => {
    if (
      next.game.currentMemberId !== snapshot.game.currentMemberId ||
      next.phase !== snapshot.phase
    ) {
      pending = null;
      message = "";
    }
    snapshot = next;
    clockServer = Date.parse(next.serverNow);
    clockReceived = performance.now();
    render();
  });
  const timer = window.setInterval(tick, 250);
  render();
  return {
    unmount() {
      mounted = false;
      unsubscribe();
      window.clearInterval(timer);
      root.remove();
    },
  };
}

export const client = defineGameClient<CipherView>({ mount });
