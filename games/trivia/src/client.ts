// SPDX-License-Identifier: Apache-2.0
import {
  defineGameClient,
  type GameBridge,
  type GameMountResult,
} from "@next-round/game-client";
import type { TriviaView } from "./types.js";

type Intent = {
  roundIndex: number;
  choice: number;
  commandId: string;
  expectedRevision: number;
  stale: boolean;
};

export function mount(
  element: HTMLElement,
  bridge: GameBridge<TriviaView>,
): GameMountResult {
  const root = document.createElement("section");
  root.className = "card next-round-trivia-game";
  root.setAttribute("aria-label", "Trivia game");
  element.append(root);
  let snapshot = bridge.getSnapshot();
  let chosen: number | null = null;
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
    if (snapshot.game.suspended)
      countdown.textContent = "Paused — waiting for an enabled player";
    else if (!snapshot.game.dueAt) countdown.textContent = "";
    else {
      const seconds = Math.max(
        0,
        Math.ceil(
          (Date.parse(snapshot.game.dueAt) -
            clockServer -
            (performance.now() - clockReceived)) /
            1000,
        ),
      );
      countdown.textContent = seconds
        ? `${seconds}s remaining`
        : "Waiting for the round reveal…";
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

  async function send(intent: Intent) {
    if (
      acting ||
      !mounted ||
      snapshot.game.roundIndex !== intent.roundIndex ||
      !snapshot.game.canSubmit
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
    message = "Submitting your private answer…";
    isError = false;
    render();
    try {
      await bridge.act({
        type: "submit",
        payload: { roundIndex: intent.roundIndex, choice: intent.choice },
        commandId: intent.commandId,
        expectedRevision: intent.expectedRevision,
      });
      if (!mounted) return;
      snapshot = bridge.getSnapshot();
      if (snapshot.game.roundIndex === intent.roundIndex)
        message =
          "Your answer is recorded. It will be revealed at the deadline.";
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
      if (
        snapshot.game.roundIndex !== intent.roundIndex ||
        snapshot.game.myChoice !== null
      ) {
        pending = null;
        message =
          snapshot.game.myChoice !== null
            ? "Your answer is recorded."
            : "The round changed; the old answer was not replayed.";
        isError = false;
      } else if (code === "STALE_REVISION") {
        pending = { ...intent, stale: true };
        message =
          "The match changed. Review the refreshed question, then explicitly retry your answer.";
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
          "The result is unknown. Retry explicitly to check the same command; your answer will not be replaced.";
        isError = true;
      } else {
        pending = null;
        message =
          error instanceof Error
            ? error.message
            : "Your answer could not be submitted.";
        isError = true;
      }
    } finally {
      acting = false;
      if (mounted) render();
    }
  }

  function render() {
    if (!mounted) return;
    const focusedChoice =
      document.activeElement instanceof HTMLInputElement &&
      root.contains(document.activeElement)
        ? document.activeElement.value
        : null;
    const focusAction =
      document.activeElement instanceof HTMLElement &&
      root.contains(document.activeElement)
        ? document.activeElement.dataset.action
        : undefined;
    root.replaceChildren();
    const game = snapshot.game;
    add(root, "h2", "Trivia");
    add(
      root,
      "p",
      game.phase === "lobby"
        ? "Waiting for the host to start"
        : game.phase === "finished"
          ? "Finished"
          : `Round ${game.roundIndex + 1} of ${game.totalRounds}`,
    );
    countdown = add(root, "p");
    countdown.className = "hint";
    tick();
    if (game.question) {
      add(root, "h3", game.question.prompt);
      const fields = add(root, "fieldset");
      add(fields, "legend", "Choose your private answer");
      game.question.choices.forEach((text, choice) => {
        const label = add(fields, "label");
        label.className = "checkbox-row";
        const input = add(label, "input");
        input.type = "radio";
        input.name = "trivia-choice";
        input.value = String(choice);
        input.checked = (game.myChoice ?? chosen) === choice;
        input.disabled = acting || !game.canSubmit;
        input.addEventListener("change", () => {
          chosen = choice;
          pending = null;
          message = "";
          render();
        });
        add(label, "span", text);
      });
      if (game.myChoice !== null)
        add(root, "p", "Your answer is recorded. Waiting for the deadline.");
      else if (!game.canSubmit && !game.suspended)
        add(root, "p", "You can answer starting with the next eligible round.");
      const actions = add(root, "div");
      actions.className = "inline-actions";
      const submit = button(
        actions,
        "Submit answer",
        () => {
          if (chosen === null) return;
          void send({
            roundIndex: game.roundIndex,
            choice: chosen,
            commandId: crypto.randomUUID(),
            expectedRevision: snapshot.revision,
            stale: false,
          });
        },
        acting || !game.canSubmit || chosen === null || pending !== null,
      );
      submit.dataset.action = "submit";
      if (pending && pending.roundIndex === game.roundIndex && game.canSubmit) {
        const retry = button(
          actions,
          "Retry your answer",
          () => {
            if (pending) void send(pending);
          },
          acting,
        );
        retry.dataset.action = "retry";
      }
    }
    if (message) {
      const status = add(root, "p", message);
      status.className = isError ? "error-message" : "status-message";
      status.setAttribute("role", isError ? "alert" : "status");
    }
    if (game.phase !== "finished") {
      add(root, "h3", "Scores");
      const standings = add(root, "ul");
      for (const m of [...snapshot.members].sort(
        (a, b) => (game.scores[b.id] ?? 0) - (game.scores[a.id] ?? 0),
      )) {
        add(standings, "li", `${m.displayName}: ${game.scores[m.id] ?? 0}`);
      }
    }
    if (game.reveals.length) {
      add(root, "h3", "Round results");
      for (const reveal of game.reveals) {
        const details = add(root, "details");
        details.open = true;
        add(
          details,
          "summary",
          `Round ${reveal.roundIndex + 1}: ${reveal.prompt}`,
        );
        add(
          details,
          "p",
          `Correct answer: ${reveal.choices[reveal.correctChoice]}`,
        );
        add(details, "p", reveal.explanation);
        const answers = add(details, "ul");
        for (const [id, choice] of Object.entries(reveal.answers)) {
          const name =
            snapshot.members.find((m) => m.id === id)?.displayName ??
            "Former player";
          add(answers, "li", `${name}: ${reveal.choices[choice]}`);
        }
      }
    }
    if (game.attribution) add(root, "p", game.attribution).className = "hint";
    const controls = add(root, "div");
    controls.className = "inline-actions";
    button(controls, "Open match chat", () => bridge.openPanel("chat"));
    button(controls, "Open participants", () =>
      bridge.openPanel("participants"),
    );
    if (focusedChoice !== null)
      root
        .querySelector<HTMLInputElement>(`input[value="${focusedChoice}"]`)
        ?.focus();
    else if (focusAction)
      root
        .querySelector<HTMLButtonElement>(
          `button[data-action="${focusAction}"]`,
        )
        ?.focus();
  }

  const unsubscribe = bridge.subscribe((next) => {
    if (
      next.game.roundIndex !== snapshot.game.roundIndex ||
      next.phase !== snapshot.phase
    ) {
      chosen = null;
      pending = null;
      message = "";
    }
    snapshot = next;
    if (next.game.myChoice !== null) {
      chosen = next.game.myChoice;
      pending = null;
    }
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

export const client = defineGameClient<TriviaView>({ mount });
