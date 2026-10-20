// SPDX-License-Identifier: Apache-2.0
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AdminAccess, AdminModule, HistoryMatches } from "./page-views.js";
import type { AdminGameSummary } from "./api.js";

function history(error: string, loading = false) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(HistoryMatches, {
        finished: [
          {
            id: "saved/result?one",
            moduleId: "retired-module",
            moduleVersion: "1",
            mode: "solo",
            phase: "finished",
            revision: 4,
            createdAt: "2026-10-20",
          },
        ],
        games: [],
        loading,
        error,
      }),
    ),
  );
}

describe("History loaded presentation", () => {
  it("targets the entitled result record even when its module is no longer listed", () => {
    const html = history("");
    expect(html).toContain('href="/matches/saved%2Fresult%3Fone"');
    expect(html).not.toContain("retired-module");
  });
  it("keeps the retained result reachable during refresh errors and escapes error data", () => {
    const html = history("<script>refresh failed</script>");
    expect(html).toContain('role="alert"');
    expect(html).toContain("&lt;script&gt;refresh failed&lt;/script&gt;");
    expect(html).toContain('href="/matches/saved%2Fresult%3Fone"');
    expect(html).not.toContain("<script>");
  });
});

describe("Admin loaded module controls", () => {
  const counts = { lobby: 1, active: 2, finished: 3, total: 6 };
  const game: AdminGameSummary = {
    id: "installed-module",
    enabled: true,
    defaultVersion: "2",
    createdAt: "",
    updatedAt: "",
    referenceCounts: counts,
    versions: ["1", "2"].map((version) => ({
      version,
      installedAt: "",
      hasServer: true,
      hasClientAssets: version === "2",
      referenceCounts: counts,
    })),
  };
  function render(isAdmin: boolean, busy: boolean, enabled = true) {
    return renderToStaticMarkup(
      createElement(AdminAccess, {
        isAdmin,
        children: createElement(AdminModule, {
          game: { ...game, enabled },
          busy,
          onDefault: () => {},
          onToggle: () => {},
        }),
      }),
    );
  }
  it("omits actual loaded module data and controls for nonadministrators", () => {
    const html = render(false, false);
    expect(html).not.toContain(game.id);
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<button");
  });
  it("selects the installed default and offers the inverse enabled action", () => {
    const html = render(true, false);
    expect(html).toContain('<option value="2" selected="">');
    expect(html).toContain('value="1"');
    expect(html).toContain("Disable module");
    expect(render(true, false, false)).toContain("Enable module");
    expect(html).not.toContain('disabled=""');
  });
  it("locks both actual mutation controls while their module mutation is pending", () => {
    const html = render(true, true);
    expect(html).toMatch(/<select[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*disabled=""/);
  });
});
