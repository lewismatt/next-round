#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Real Chromium proof against the compiled HTTPS stack. No route mocks.
//
// setupThroughBrowser({ origin, setupToken, credentials, instanceName, artifactDir })
//   → { ok: true, screenshots: string[], observations: string[] }
// exerciseBrowser({ origin, credentials, matches, artifactDir })
//   → { ok: true, screenshots, observations, violations }
// Failure throws after writing private screenshots. Certificate exceptions
// stay on the single BrowserContext (ignoreHTTPSErrors).
/* global window, document, localStorage, HTMLInputElement, getComputedStyle, CSSFontFaceRule, location, performance, Image, HTMLImageElement, WebSocket */

import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { chromium } from "@playwright/test";

const SURFACE_TIMEOUT_MS = 30_000;
const LIVE_TIMEOUT_MS = 30_000;
const NEGATIVE_ORIGIN = "https://example.invalid";
const NEGATIVE_PATH = "/next-round-csp-negative-control";
const CIPHER_PALETTE = [
  "#b3392e",
  "#d97b24",
  "#c9a227",
  "#3e7d3a",
  "#2563a8",
  "#5b3ea8",
  "#a83272",
  "#4a4a4a",
];
const LOCAL_FONTS = ["Instrument Sans Variable", "Geist Mono Variable"];

export async function setupThroughBrowser(input) {
  const origin = requireOrigin(input?.origin);
  const setupToken = requireString(input?.setupToken, "setupToken");
  const credentials = requireCredentials(input?.credentials);
  const instanceName = requireString(input?.instanceName, "instanceName");
  const artifactDir = requireString(input?.artifactDir, "artifactDir");
  const secrets = [setupToken, credentials.password, credentials.username];
  const screenshots = [];
  const observations = [];
  await mkdir(artifactDir, { recursive: true });
  try {
    await withBrowser(async ({ context, page }) => {
      const bridge = await installObservers(context, page, origin);
      await openApp(page, origin);
      const heading = page.getByRole("heading", { name: "Set up Next Round" });
      await heading.waitFor();
      const fields = page.locator("fieldset.setup-fields");
      await fields.waitFor();
      if (await fields.getAttribute("style")) {
        throw new Error("setup fieldset rendered an inline style attribute");
      }
      await page.getByLabel("Setup token").waitFor();
      await page.getByLabel("Instance name").waitFor();
      await page.getByLabel("Admin username").waitFor();
      await page.getByLabel("Display name").waitFor();
      await page.getByLabel("Password", { exact: true }).waitFor();
      await page.getByLabel("Confirm password").waitFor();
      screenshots.push(await shot(page, artifactDir, "setup-first-run"));
      observations.push(
        "first-run setup form rendered with labeled fields and no inline style attribute",
      );
      await page.getByLabel("Setup token").fill(setupToken);
      await page.getByLabel("Instance name").fill(instanceName);
      await page.getByLabel("Admin username").fill(credentials.username);
      await page.getByLabel("Display name").fill(credentials.displayName);
      await page
        .getByLabel("Password", { exact: true })
        .fill(credentials.password);
      await page.getByLabel("Confirm password").fill(credentials.password);
      await page
        .getByRole("button", { name: "Create instance and admin" })
        .click();
      await waitForSetupResult(page, secrets);
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      screenshots.push(await shot(page, artifactDir, "setup-reached-sign-in"));
      observations.push(
        "setup submitted through the form and reached the sign-in page",
      );
      assertClean(bridge, secrets, "setup");
    });
  } catch (error) {
    await writeReport(artifactDir, "setup-browser-proof.json", {
      ok: false,
      observations,
      screenshots,
      error: redact(errorText(error), secrets),
    });
    throw new Error(redact(errorText(error), secrets));
  }
  await writeReport(artifactDir, "setup-browser-proof.json", {
    ok: true,
    observations,
    screenshots,
  });
  return { ok: true, screenshots, observations };
}

export async function exerciseBrowser(input) {
  const origin = requireOrigin(input?.origin);
  const credentials = requireCredentials(input?.credentials);
  const matches = requireMatches(input?.matches);
  const artifactDir = requireString(input?.artifactDir, "artifactDir");
  const secrets = [credentials.password, credentials.username];
  const screenshots = [];
  const observations = [];
  const failures = [];
  let violations = [];
  await mkdir(artifactDir, { recursive: true });
  try {
    await withBrowser(async ({ context, page }) => {
      const bridge = await installObservers(context, page, origin);
      const dataImages = [];
      await signIn(page, origin, credentials, secrets);
      screenshots.push(await shot(page, artifactDir, "exercise-home"));
      observations.push(
        "signed in through the login form and reached the games index",
      );
      await capture(
        async () => {
          dataImages.push(...(await scanDataImages(page)));
          await assertLocalFonts(page, origin);
          observations.push(
            "Instrument Sans Variable and Geist Mono Variable loaded from the page origin",
          );
        },
        failures,
        secrets,
      );
      await capture(
        async () => {
          await exerciseThemes(page, artifactDir, screenshots);
          observations.push(
            "appearance control painted light and dark themes and kept the choice across reload",
          );
        },
        failures,
        secrets,
      );
      await capture(
        async () => {
          dataImages.push(
            ...(await exerciseCreateDialog(page, artifactDir, screenshots)),
          );
          observations.push(
            "create dialog opened and its game dropdown switched Crossword, Trivia, and Cipher",
          );
        },
        failures,
        secrets,
      );
      await capture(
        async () => {
          dataImages.push(
            ...(await exerciseCrossword(
              page,
              context,
              origin,
              matches.crossword,
              artifactDir,
              screenshots,
            )),
          );
          observations.push(
            "crossword Warm Up grid set --crossword-cols to 5, accepted a clue letter, and refetched after live reconnect",
          );
        },
        failures,
        secrets,
      );
      await capture(
        async () => {
          dataImages.push(
            ...(await exerciseTrivia(
              page,
              origin,
              matches.trivia,
              artifactDir,
              screenshots,
            )),
          );
          observations.push(
            "trivia mounted round 1 of the starter bank and a choice could be selected",
          );
        },
        failures,
        secrets,
      );
      await capture(
        async () => {
          dataImages.push(
            ...(await exerciseCipher(
              page,
              origin,
              matches.cipher,
              artifactDir,
              screenshots,
            )),
          );
          observations.push(
            "cipher standard palette painted six symbol colors and accepted a symbol",
          );
        },
        failures,
        secrets,
      );
      await capture(
        async () => {
          assertClean(bridge, secrets, "legitimate flows");
        },
        failures,
        secrets,
      );
      observations.push(
        dataImages.some((image) => image.visible && image.qrLike)
          ? "shipped UI painted a visible data-image QR"
          : "FINDING: shipped UI lacks a QR surface",
      );
      await capture(
        async () => {
          const decoded = await proveQrDataImage(
            page,
            artifactDir,
            screenshots,
            bridge,
            secrets,
          );
          observations.push(
            `qrcode 1.5.4 data:image probe decoded visible ${decoded.naturalWidth}x${decoded.naturalHeight} on the compiled page with no CSP violation`,
          );
        },
        failures,
        secrets,
      );
      if (
        bridge.records.length === 0 &&
        bridge.foreign.length === 0 &&
        bridge.negativeRequests.length === 0
      ) {
        await capture(
          async () => {
            violations = await runNegativeControl(page, bridge, secrets);
            observations.push(
              "deliberate inline script and example.invalid fetch were blocked with enforced CSP violations and no request",
            );
          },
          failures,
          secrets,
        );
      }
      if (failures.length > 0) {
        throw new Error(failures.join("; "));
      }
    });
  } catch (error) {
    const message = redact(errorText(error), secrets);
    await writeReport(artifactDir, "exercise-browser-proof.json", {
      ok: false,
      observations,
      screenshots,
      violations,
      error: message,
    });
    throw new Error(message);
  }
  await writeReport(artifactDir, "exercise-browser-proof.json", {
    ok: true,
    observations,
    screenshots,
    violations,
  });
  return { ok: true, screenshots, observations, violations };
}

async function withBrowser(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1280 },
      deviceScaleFactor: 1,
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(SURFACE_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(SURFACE_TIMEOUT_MS);
      await run({ browser, context, page });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

async function installObservers(context, page, origin) {
  const records = [];
  const waiters = [];
  const foreign = [];
  const negativeRequests = [];
  const wake = () => {
    const pending = waiters.splice(0);
    for (const waiter of pending) {
      if (!waiter()) waiters.push(waiter);
    }
  };
  const note = (incoming) => {
    for (const record of incoming) {
      if (
        records.some(
          (existing) =>
            existing.directive === record.directive &&
            existing.blockedURI === record.blockedURI &&
            existing.disposition === record.disposition,
        )
      ) {
        continue;
      }
      records.push(record);
    }
    wake();
  };
  await context.exposeFunction("__nrRecordCspViolation", (record) => {
    note([record]);
  });
  await context.addInitScript(() => {
    // Instrument real sockets; no transport or server response is mocked.
    const NativeWebSocket = window.WebSocket;
    window.__nrLiveSockets = [];
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(Target, args) {
        const socket = new Target(...args);
        window.__nrLiveSockets.push(socket);
        return socket;
      },
    });
    const store = (window.__nrCsp = window.__nrCsp || {
      violations: [],
      executed: false,
    });
    document.addEventListener("securitypolicyviolation", (event) => {
      const record = {
        directive: event.effectiveDirective || event.violatedDirective,
        blockedURI: event.blockedURI,
        disposition: event.disposition,
      };
      store.violations.push(record);
      const report = window.__nrRecordCspViolation;
      if (typeof report === "function") void report(record);
    });
  });
  page.on("request", (request) => {
    noteRequest(request.url(), origin, foreign, negativeRequests);
  });
  page.on("requestfailed", (request) => {
    noteRequest(request.url(), origin, foreign, negativeRequests);
  });
  page.on("console", (message) => {
    if (message.type() === "error" && isCspConsole(message.text())) {
      note([
        {
          directive: "console",
          blockedURI: message.text().slice(0, 240),
          disposition: "console",
        },
      ]);
    }
  });
  return {
    records,
    foreign,
    negativeRequests,
    note,
    waitFor(predicate, timeoutMs, label) {
      if (records.some(predicate)) {
        return Promise.resolve(records.filter(predicate));
      }
      const { promise, resolve, reject } = Promise.withResolvers();
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      const waiter = () => {
        if (!records.some(predicate)) return false;
        clearTimeout(timer);
        resolve(records.filter(predicate));
        return true;
      };
      waiters.push(waiter);
      promise.catch(() => {});
      return promise;
    },
  };
}

function noteRequest(rawUrl, origin, foreign, negativeRequests) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (url.origin === NEGATIVE_ORIGIN) {
    negativeRequests.push(`${url.origin}${url.pathname}`);
    return;
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return;
  if (url.origin !== new URL(origin).origin) {
    foreign.push(`${url.origin}${url.pathname}`);
  }
}

function assertClean(bridge, secrets, label) {
  if (bridge.records.length > 0) {
    throw new Error(
      `${label} produced CSP violations: ${summarizeViolations(bridge.records, secrets)}`,
    );
  }
  if (bridge.foreign.length > 0) {
    throw new Error(
      `${label} requested another origin: ${bridge.foreign.join(", ")}`,
    );
  }
  if (bridge.negativeRequests.length > 0) {
    throw new Error(
      `${label} requested ${NEGATIVE_ORIGIN} before the negative control`,
    );
  }
}

async function signIn(page, origin, credentials, secrets) {
  await openApp(page, new URL("/login", origin).toString());
  await page.getByRole("heading", { name: "Sign in" }).waitFor();
  await page.getByLabel("Username").fill(credentials.username);
  await page.getByLabel("Password", { exact: true }).fill(credentials.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const games = page.getByRole("heading", { name: "The games" });
  const rejected = page
    .locator("form [role=alert]")
    .waitFor()
    .then(async () => {
      const text = await page.locator("form [role=alert]").innerText();
      throw new Error(`sign-in rejected: ${redact(text, secrets)}`);
    });
  rejected.catch(() => {});
  await Promise.race([games.waitFor().then(() => "home"), rejected]);
  await page.locator(".header-identity").waitFor();
  const identity = await page.locator(".header-identity").innerText();
  if (identity.trim() !== credentials.displayName) {
    throw new Error("signed-in header did not show the supplied display name");
  }
}

async function exerciseThemes(page, artifactDir, screenshots) {
  const toggle = page.getByRole("button", {
    name: /Switch to (light|dark) theme/,
  });
  await toggle.waitFor();
  const initial = await themeOf(page);
  if (initial !== "light" && initial !== "dark") {
    throw new Error(
      `appearance did not set a theme (got ${initial || "none"})`,
    );
  }
  await assertThemePaint(page, initial);
  screenshots.push(await shot(page, artifactDir, `exercise-theme-${initial}`));
  await toggle.click();
  await page.waitForFunction(
    (previous) => document.documentElement.dataset.theme !== previous,
    initial,
  );
  const toggled = await themeOf(page);
  if (toggled === initial || (toggled !== "light" && toggled !== "dark")) {
    throw new Error("appearance control did not switch theme");
  }
  await assertThemePaint(page, toggled);
  const saved = await page.evaluate(() =>
    localStorage.getItem("next-round:appearance:v1"),
  );
  if (saved !== toggled) {
    throw new Error("appearance choice was not stored for the next load");
  }
  screenshots.push(await shot(page, artifactDir, `exercise-theme-${toggled}`));
  assertCspHeader(await page.reload({ waitUntil: "domcontentloaded" }));
  await page.getByRole("heading", { name: "The games" }).waitFor();
  await page.waitForFunction(
    (expected) => document.documentElement.dataset.theme === expected,
    toggled,
  );
  if ((await themeOf(page)) !== toggled) {
    throw new Error("reloaded page did not keep the selected theme");
  }
  await assertThemePaint(page, toggled);
  screenshots.push(await shot(page, artifactDir, "exercise-theme-reloaded"));
  const other = toggled === "dark" ? "light" : "dark";
  if (initial !== other) {
    await page
      .getByRole("button", { name: /Switch to (light|dark) theme/ })
      .click();
    await page.waitForFunction(
      (expected) => document.documentElement.dataset.theme === expected,
      other,
    );
    await assertThemePaint(page, other);
  }
}

async function exerciseCreateDialog(page, artifactDir, screenshots) {
  await page.getByRole("button", { name: "Start a game", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Start a game" });
  await dialog.waitFor();
  const gameSelect = dialog.locator("#create-game");
  await gameSelect.waitFor();
  const labels = await gameSelect.locator("option").allTextContents();
  for (const name of ["Crossword", "Trivia", "Cipher"]) {
    if (!labels.some((label) => label.trim() === name)) {
      throw new Error(`create dialog dropdown is missing ${name}`);
    }
  }
  await gameSelect.selectOption("cipher");
  await dialog.locator("#cipher-preset").waitFor();
  const preset = await dialog.locator("#cipher-preset").inputValue();
  if (preset !== "standard") {
    throw new Error(`cipher preset dropdown defaulted to ${preset}`);
  }
  screenshots.push(await shot(page, artifactDir, "exercise-create-dialog"));
  await gameSelect.selectOption("trivia");
  await dialog.locator("#trivia-rounds").waitFor();
  await gameSelect.selectOption("crossword");
  await dialog.locator("#create-mode").waitFor();
  const images = await scanDataImages(page);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "hidden" });
  return images;
}

async function exerciseCrossword(
  page,
  context,
  origin,
  matchId,
  artifactDir,
  screenshots,
) {
  let liveSocket;
  await openApp(page, matchUrl(origin, matchId), () => {
    liveSocket = waitForEvent(
      page,
      "websocket",
      (socket) => socket.url().includes("/api/v1/live"),
      SURFACE_TIMEOUT_MS,
      "crossword live socket",
    );
  });
  const grid = page.locator(".crossword-grid");
  await grid.waitFor();
  await assertGameAssetLoaded(page, "crossword");
  const socket = await liveSocket;
  assertLiveUrl(socket.url(), origin);
  await page.getByRole("heading", { name: "Warm Up" }).first().waitFor();
  await page.getByText("Before-noon hours marker").waitFor();
  const measured = await grid.evaluate((element) => ({
    property: element.style.getPropertyValue("--crossword-cols"),
    children: element.children.length,
  }));
  if (measured.property !== "5" || measured.children !== 25) {
    throw new Error(
      `crossword column count was ${measured.property || "unset"} across ${measured.children} cells`,
    );
  }
  await page
    .locator(".crossword-clue")
    .filter({ hasText: "Before-noon hours marker" })
    .click();
  const input = page.locator("#nr-crossword-answer-input");
  await input.waitFor();
  if (await input.isDisabled()) {
    throw new Error(
      "crossword clue input stayed disabled after selecting a clue",
    );
  }
  await input.fill("A");
  await page.waitForFunction(() => {
    const field = document.querySelector("#nr-crossword-answer-input");
    return field instanceof HTMLInputElement && field.value === "A";
  });
  screenshots.push(await shot(page, artifactDir, "exercise-crossword"));
  const images = await scanDataImages(page);
  await reconnectLive(page, context, origin, matchId, socket);
  await grid.waitFor();
  screenshots.push(await shot(page, artifactDir, "exercise-live-reconnect"));
  return images;
}

async function reconnectLive(page, context, origin, matchId, firstSocket) {
  const closed = waitForEvent(firstSocket, "close", null, LIVE_TIMEOUT_MS, "live socket close");
  const reconnected = waitForEvent(
    page, "websocket", (socket) => socket.url().includes("/api/v1/live"),
    LIVE_TIMEOUT_MS, "live reconnect",
  );
  const refetched = waitForEvent(
    page, "response", (response) => isMatchGet(response, matchId),
    LIVE_TIMEOUT_MS, "match refetch",
  );
  await context.setOffline(false);
  await page.evaluate(() => {
    const socket = window.__nrLiveSockets.find(
      (candidate) => candidate.readyState === WebSocket.OPEN &&
        new URL(candidate.url).pathname === "/api/v1/live",
    );
    if (!socket) throw new Error("live socket to disconnect was not found");
    socket.close(1000, "security smoke reconnect");
  });
  await closed;
  assertLiveUrl((await reconnected).url(), origin);
  if (!(await refetched).ok()) throw new Error("live refetch failed");
}

async function exerciseTrivia(page, origin, matchId, artifactDir, screenshots) {
  await openApp(page, matchUrl(origin, matchId));
  const game = page.locator(".next-round-trivia-game");
  await game.waitFor();
  await assertGameAssetLoaded(page, "trivia");
  await game.getByText("Round 1 of 1").waitFor();
  await game
    .getByRole("heading", { name: "How many sides does a hexagon have?" })
    .waitFor();
  const choice = game.getByLabel("Six");
  await choice.waitFor();
  await choice.check();
  await page.waitForFunction(() => {
    const selected = document.querySelector(
      '.next-round-trivia-game input[name="trivia-choice"]:checked',
    );
    return selected instanceof HTMLInputElement && selected.checked;
  });
  screenshots.push(await shot(page, artifactDir, "exercise-trivia"));
  return scanDataImages(page);
}

async function exerciseCipher(page, origin, matchId, artifactDir, screenshots) {
  await openApp(page, matchUrl(origin, matchId));
  const game = page.locator(".next-round-cipher-game");
  await game.waitFor();
  await assertGameAssetLoaded(page, "cipher");
  await game.getByText(/Standard · crack the 4-symbol code/).waitFor();
  await game.getByText("Your turn — build your guess.").waitFor();
  const palette = game.locator(".inline-actions").first();
  const colors = await palette
    .locator("button")
    .evaluateAll((buttons) =>
      buttons.map((button) => getComputedStyle(button).backgroundColor),
    );
  if (colors.length !== 6) {
    throw new Error(
      `cipher palette rendered ${colors.length} symbols, expected 6`,
    );
  }
  colors.forEach((color, index) => {
    if (normalizeColor(color) !== hexToRgb(CIPHER_PALETTE[index])) {
      throw new Error(`cipher symbol ${index + 1} painted ${color}`);
    }
  });
  await palette.getByRole("button", { name: "1", exact: true }).click();
  await page.waitForFunction(() => {
    const root = document.querySelector(".next-round-cipher-game");
    const heading = [...(root?.querySelectorAll("h3") ?? [])].find(
      (node) => node.textContent === "Your guess",
    );
    return (
      heading?.nextElementSibling?.querySelector("span")?.textContent === "1"
    );
  });
  const chipColor = await game.evaluate((root) => {
    const heading = [...root.querySelectorAll("h3")].find(
      (node) => node.textContent === "Your guess",
    );
    const chip = heading?.nextElementSibling?.querySelector("span span");
    return chip ? getComputedStyle(chip).backgroundColor : "";
  });
  if (normalizeColor(chipColor) !== hexToRgb(CIPHER_PALETTE[0])) {
    throw new Error(`cipher draft chip painted ${chipColor || "nothing"}`);
  }
  screenshots.push(await shot(page, artifactDir, "exercise-cipher"));
  return scanDataImages(page);
}

async function assertLocalFonts(page, origin) {
  const loaded = await page.evaluate(async (families) => {
    const faces = [];
    const collect = (rules, sheetHref) => {
      for (const rule of rules) {
        if (rule instanceof CSSFontFaceRule) {
          const family = rule.style.getPropertyValue("font-family");
          const src = rule.style.getPropertyValue("src");
          const urls = [...src.matchAll(/url\((['"]?)(.*?)\1\)/g)].map(
            (match) => new URL(match[2], sheetHref || location.href).href,
          );
          faces.push({ family, urls });
        } else if (rule.cssRules) {
          collect([...rule.cssRules], sheetHref);
        }
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        collect([...sheet.cssRules], sheet.href || location.href);
      } catch {
        /* Ignore a stylesheet the page cannot read. */
      }
    }
    await Promise.all(
      families.map((family) => document.fonts.load(`16px "${family}"`)),
    );
    await document.fonts.ready;
    return {
      faces,
      checks: families.map((family) => ({
        family,
        loaded: document.fonts.check(`16px "${family}"`),
      })),
      resources: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.includes(".woff2")),
    };
  }, LOCAL_FONTS);
  for (const family of LOCAL_FONTS) {
    const faces = loaded.faces.filter((entry) => entry.family.includes(family));
    if (faces.length === 0) {
      throw new Error(`compiled CSS has no @font-face for ${family}`);
    }
    for (const face of faces) {
      if (face.urls.length === 0) {
        throw new Error(`${family} @font-face has no font file URL`);
      }
      for (const url of face.urls) {
        if (!url.startsWith(origin)) {
          throw new Error(`${family} font is not a same-origin file`);
        }
      }
    }
  }
  for (const check of loaded.checks) {
    if (!check.loaded) throw new Error(`${check.family} did not load`);
  }
  if (
    loaded.resources.length === 0 ||
    loaded.resources.some((url) => !url.startsWith(origin))
  ) {
    throw new Error("bundled font files were not fetched from the page origin");
  }
}

async function assertThemePaint(page, theme) {
  const expected = theme === "dark" ? hexToRgb("#20211f") : hexToRgb("#efece2");
  const painted = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    background: getComputedStyle(document.body).backgroundColor,
    grain: getComputedStyle(document.body).backgroundImage,
  }));
  if (painted.theme !== theme) {
    throw new Error(`theme attribute was ${painted.theme}, expected ${theme}`);
  }
  if (normalizeColor(painted.background) !== expected) {
    throw new Error(`${theme} theme painted ${painted.background}`);
  }
  const grain = painted.grain.includes("/newsprint-grain.png");
  if (theme === "light" && !grain) {
    throw new Error("light theme did not paint the local newsprint grain");
  }
  if (theme === "dark" && grain) {
    throw new Error("dark theme still painted the light-only grain");
  }
}

async function proveQrDataImage(
  page,
  artifactDir,
  screenshots,
  bridge,
  secrets,
) {
  const payload = `${NEGATIVE_ORIGIN}/next-round-csp-qr-probe`;
  const QRCode = createRequire(
    new URL("../../packages/platform/package.json", import.meta.url),
  )("qrcode");
  const src = await QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 2,
    type: "image/png",
  });
  if (!src.startsWith("data:image/png;base64,")) {
    throw new Error("qrcode did not produce a PNG data image");
  }
  const expected = pngSize(src);
  if (expected.width < 24 || expected.width !== expected.height) {
    throw new Error(
      `qrcode produced an unexpected PNG size ${expected.width}x${expected.height}`,
    );
  }
  const before = bridge.records.length;
  await page.evaluate(
    ({ imageSource, width, height }) => {
      const image = new Image();
      image.id = "nr-csp-qr-proof";
      image.alt = "CSP QR data image probe";
      image.width = width;
      image.height = height;
      image.src = imageSource;
      document.body.append(image);
    },
    { imageSource: src, width: expected.width, height: expected.height },
  );
  const decoded = await decodeQrProbe(page);
  if (
    decoded.naturalWidth !== expected.width ||
    decoded.naturalHeight !== expected.height ||
    decoded.width < 24 ||
    decoded.height < 24
  ) {
    throw new Error(
      `QR data image decoded ${decoded.naturalWidth}x${decoded.naturalHeight} and painted ${decoded.width}x${decoded.height}`,
    );
  }
  const image = page.locator("#nr-csp-qr-proof");
  await image.waitFor({ state: "visible" });
  const file = path.join(artifactDir, "exercise-qr-data-image.png");
  await image.screenshot({ path: file });
  screenshots.push(file);
  await image.evaluate((element) => element.remove());
  const added = bridge.records.slice(before);
  if (added.length > 0) {
    throw new Error(
      `QR data image produced CSP violations: ${summarizeViolations(added, secrets)}`,
    );
  }
  return decoded;
}

function decodeQrProbe(page) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(() => {
    reject(new Error("timed out waiting for QR data image decode"));
  }, SURFACE_TIMEOUT_MS);
  page
    .evaluate(async () => {
      const image = document.querySelector("#nr-csp-qr-proof");
      if (!(image instanceof HTMLImageElement)) {
        throw new Error("QR probe image is missing");
      }
      if (!image.src.startsWith("data:image/png")) {
        throw new Error("QR probe image is not a PNG data URL");
      }
      await image.decode();
      const box = image.getBoundingClientRect();
      return {
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        width: box.width,
        height: box.height,
      };
    })
    .then(
      (size) => {
        clearTimeout(timer);
        resolve(size);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  return promise;
}

function pngSize(dataUrl) {
  const encoded = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Buffer.from(encoded, "base64");
  const signature = bytes.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a" || bytes.length < 24) {
    throw new Error("qrcode data image is not a PNG");
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function scanDataImages(page) {
  return page.evaluate(() => {
    const hits = [];
    const push = (kind, src, width, height) => {
      const data = src.startsWith("data:image/")
        ? src
        : (src.match(/data:image\/[^)"'\s]+/) ?? [null])[0];
      if (!data) return;
      hits.push({
        kind,
        qrLike: /^data:image\/(?:png|svg\+xml|gif|webp)/.test(data),
        visible: width >= 24 && height >= 24,
      });
    };
    for (const image of document.querySelectorAll("img, image")) {
      const src = image.getAttribute("src") || image.getAttribute("href") || "";
      const rect = image.getBoundingClientRect();
      const width =
        "naturalWidth" in image && image.naturalWidth
          ? image.naturalWidth
          : rect.width;
      const height =
        "naturalHeight" in image && image.naturalHeight
          ? image.naturalHeight
          : rect.height;
      push(image.tagName.toLowerCase(), src, width, height);
    }
    for (const element of document.querySelectorAll("body *")) {
      const image = getComputedStyle(element).backgroundImage;
      if (!image.includes("data:image/")) continue;
      const rect = element.getBoundingClientRect();
      push("background", image, rect.width, rect.height);
    }
    return hits;
  });
}

async function runNegativeControl(page, bridge, secrets) {
  const before = bridge.records.length;
  const probe = `${NEGATIVE_ORIGIN}${NEGATIVE_PATH}`;
  const inlineViolation = bridge.waitFor(
    (record) =>
      record.directive.startsWith("script-src") &&
      record.blockedURI === "inline" &&
      record.disposition === "enforce",
    5_000,
    "inline script violation",
  );
  const externalFetch = bridge.waitFor(
    (record) =>
      record.directive === "connect-src" &&
      String(record.blockedURI).includes("example.invalid") &&
      record.disposition === "enforce",
    5_000,
    "external fetch violation",
  );
  const result = await page.evaluate(async (url) => {
    const store = window.__nrCsp;
    store.executed = false;
    const inline = document.createElement("script");
    inline.textContent = "window.__nrCsp.executed = true";
    document.documentElement.append(inline);
    let fetchReached = false;
    try {
      await fetch(url, { method: "GET", credentials: "omit", mode: "cors" });
      fetchReached = true;
    } catch {
      fetchReached = false;
    }
    return {
      executed: store.executed === true,
      fetchReached,
      violations: store.violations.slice(),
    };
  }, probe);
  bridge.note(result.violations);
  const [inline, connect] = await Promise.all([
    inlineViolation, externalFetch,
  ]);
  if (result.executed) {
    throw new Error("inline script executed under the enforced CSP");
  }
  if (result.fetchReached) {
    throw new Error("example.invalid fetch was not blocked");
  }
  if (bridge.negativeRequests.length > 0) {
    throw new Error("negative control fetch emitted an external request");
  }
  const blocked = [inline, connect]
    .flat()
    .filter(
      (record, index, all) =>
        all.findIndex(
          (item) =>
            item.directive === record.directive &&
            item.blockedURI === record.blockedURI,
        ) === index,
    );
  if (blocked.length < 2) {
    throw new Error(
      `negative control did not produce enforced violations: ${summarizeViolations(bridge.records.slice(before), secrets)}`,
    );
  }
  return blocked.map((record) => ({
    directive: record.directive,
    blockedURI: record.blockedURI,
    disposition: record.disposition,
  }));
}

async function openApp(page, url, beforeNavigate) {
  // The preceding API/abuse probes share the real 100/minute source budget.
  // Wait for its advertised reset before a navigation, never replay a command.
  for (let attempt = 0; attempt < 2; attempt++) {
    const budget = await page.request.get(new URL("/api/v1/setup", url).href);
    const remaining = Number(budget.headers()["x-ratelimit-remaining"]);
    if (budget.status() === 200 && remaining >= 35) break;
    if (![200, 429].includes(budget.status()))
      throw new Error(`navigation budget probe returned ${budget.status()}`);
    const resetSeconds = Number(
      budget.headers()["retry-after"] ?? budget.headers()["x-ratelimit-reset"],
    );
    if (!Number.isFinite(resetSeconds) || resetSeconds < 0 || resetSeconds > 60)
      throw new Error("navigation budget reset was unavailable");
    if (attempt === 1) throw new Error("navigation budget did not reset");
    const { promise, resolve } = Promise.withResolvers();
    setTimeout(resolve, (resetSeconds + 1) * 1000);
    await promise;
  }
  beforeNavigate?.();
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  assertCspHeader(response);
  return response;
}

function assertCspHeader(response) {
  if (!response) throw new Error("document navigation produced no response");
  const csp = response.headers()["content-security-policy"] ?? "";
  if (
    !csp.includes("default-src 'self'") ||
    !csp.includes("script-src 'self'") ||
    !csp.includes("style-src-attr 'none'") ||
    !csp.includes("img-src 'self' data:")
  ) {
    throw new Error("document was served without the enforced self CSP");
  }
  if (/unsafe-inline|unsafe-eval/.test(csp)) {
    throw new Error("document CSP allows unsafe inline script or eval");
  }
}

async function waitForSetupResult(page, secrets) {
  const login = page.waitForURL(/\/login$/).then(() => "login");
  const alert = page
    .locator("form [role=alert]")
    .waitFor()
    .then(async () => {
      const text = await page.locator("form [role=alert]").innerText();
      throw new Error(`setup rejected: ${redact(text, secrets)}`);
    });
  login.catch(() => {});
  alert.catch(() => {});
  await Promise.race([login, alert]);
}

function waitForEvent(emitter, event, predicate, timeoutMs, label) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const timer = setTimeout(() => {
    cleanup();
    reject(new Error(`timed out waiting for ${label}`));
  }, timeoutMs);
  const onEvent = (payload) => {
    try {
      if (predicate && !predicate(payload)) return;
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    cleanup();
    resolve(payload);
  };
  const cleanup = () => {
    clearTimeout(timer);
    emitter.off(event, onEvent);
  };
  emitter.on(event, onEvent);
  // A preceding navigation assertion can fail before its event is awaited.
  // Keep the rejection observable to awaiters without an uncaught rejection.
  promise.catch(() => {});
  return promise;
}

async function assertGameAssetLoaded(page, moduleId) {
  // Immutable clients may come from browser cache without a fresh 2xx event.
  // Require the real asset timing entry as well as the rendered/input checks.
  const loaded = await page.evaluate((id) =>
    performance.getEntriesByType("resource").some((entry) => {
      const url = new URL(entry.name);
      return url.pathname.includes(`/games/${id}/`) && url.pathname.endsWith(".js");
    }), moduleId);
  if (!loaded) throw new Error(`${moduleId} client asset was not loaded`);
}

function isMatchGet(response, matchId) {
  if (!response.ok() || response.request().method() !== "GET") return false;
  return new URL(response.url()).pathname === `/api/v1/matches/${matchId}`;
}

function assertLiveUrl(rawUrl, origin) {
  const url = new URL(rawUrl);
  const expected = new URL(origin);
  if (url.protocol !== "wss:" || url.host !== expected.host) {
    throw new Error("live socket did not use the page's wss origin");
  }
  if (url.pathname !== "/api/v1/live") {
    throw new Error(`live socket path was ${url.pathname}`);
  }
}

function matchUrl(origin, matchId) {
  return new URL(`/matches/${encodeURIComponent(matchId)}`, origin).toString();
}

async function themeOf(page) {
  return page.evaluate(() => document.documentElement.dataset.theme ?? "");
}

async function shot(page, artifactDir, name) {
  const file = path.join(artifactDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function capture(run, failures, secrets) {
  try {
    await run();
  } catch (error) {
    failures.push(redact(errorText(error), secrets));
  }
}

async function writeReport(artifactDir, name, report) {
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    path.join(artifactDir, name),
    `${JSON.stringify(report, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

function summarizeViolations(records, secrets) {
  if (records.length === 0) return "none";
  return records
    .map((record) =>
      redact(`${record.directive} ${record.blockedURI}`, secrets),
    )
    .join("; ");
}

function isCspConsole(text) {
  return /content security policy|refused to (execute|load|connect|apply)/i.test(
    text,
  );
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return `rgb(${parseInt(value.slice(0, 2), 16)},${parseInt(value.slice(2, 4), 16)},${parseInt(value.slice(4, 6), 16)})`;
}

function normalizeColor(value) {
  const match = String(value)
    .replace(/\s+/g, "")
    .match(/^rgba?\((\d+),(\d+),(\d+)/i);
  if (!match) return String(value).toLowerCase();
  return `rgb(${match[1]},${match[2]},${match[3]})`;
}

function requireOrigin(value) {
  const origin = requireString(value, "origin");
  const url = new URL(origin);
  if (url.protocol !== "https:") throw new Error("origin must be https");
  return url.origin;
}

function requireCredentials(value) {
  return {
    username: requireString(value?.username, "credentials.username"),
    password: requireString(value?.password, "credentials.password"),
    displayName: requireString(value?.displayName, "credentials.displayName"),
  };
}

function requireMatches(value) {
  return {
    crossword: requireString(value?.crossword, "matches.crossword"),
    trivia: requireString(value?.trivia, "matches.trivia"),
    cipher: requireString(value?.cipher, "matches.cipher"),
  };
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`missing ${name}`);
  }
  return value;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function redact(text, secrets) {
  let out = String(text ?? "");
  const values = secrets
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort((left, right) => right.length - left.length);
  for (const secret of values) out = out.split(secret).join("[redacted]");
  return out;
}
