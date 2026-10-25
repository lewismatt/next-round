# Puzzle Club validation

Implementation branch: `feat/puzzle-club-interface`, based on main `8fcb2ca842430f764012f2b14599f3efb2a87edf`. The commit containing this document and its screenshots is the reviewed source snapshot; no production deployment is included.

## Automated checks

Node 24.22.1 and pnpm 12.14.0 were run through an isolated npm-exec tool environment because the host's default Node is 22. Dependencies were installed with the frozen lockfile, and the external Cipher module was fetched at the repository's pinned revision. No dependency pins or lockfile changes were needed.

| Check | Result |
| --- | --- |
| `pnpm build` | Pass; browser boundary scan passed for 18 artifacts |
| `pnpm typecheck` | Pass across the workspace |
| `pnpm lint` | Pass, zero warnings |
| `pnpm exec vitest run --maxWorkers=2` | 25 files / 294 tests passed; 14 files / 128 database-dependent tests skipped |
| Appearance first-paint tests | Explicit preferences override OS; invalid values and blocked storage fall back safely; dark class and native color scheme agree |
| `git diff --check` | Pass |
| `pnpm check:spdx` after staging | Pass; 159 tracked source files verified |

The production entry chunk is about 502 kB minified / 146 kB gzip and emits Vite's non-blocking size warning, recorded as BL-072. No limit was increased to hide it.

## Browser checks

The flow under test was: compiled app Home → theme switch / game creation / navigation → correct visible state with the selected appearance.

The built-in in-app Chromium browser was used through `cua_repl`; final PNG captures used its developer screenshot capability at the checked viewport dimensions. No Playwright fallback or new browser dependency was needed. A disposable server at `http://127.0.0.1:4317` served the actual production build with controlled HTTP and native-WebSocket fixtures. It supplied synthetic sessions, matches and invitations and real public game manifests. The server and fixture script stayed outside committed application source.

| Check | Result |
| --- | --- |
| Identity, meaningful content, framework overlay | Correct Next Round title/Home; populated content; no framework overlay |
| Console health | No app warnings/errors on populated Home and theme/dialog/navigation flow; the injected error state intentionally returns HTTP 503 |
| Desktop | Final captures at 1280×1100, both themes; no horizontal overflow |
| Phone | Final captures at 390×844, both themes; primary actions measure 44px high and bottom navigation targets 48px |
| Breakpoints | 360, 430, 768, 1024 and 1440 CSS-pixel widths checked; no horizontal document overflow |
| Theme persistence | Switched theme, reloaded and observed the selected theme; a second tab's theme selection updated the first tab |
| Creation | Start opens the existing accessible dialog; catalog Cipher action preselects Cipher; mode controls respond; Escape closes and restores focus |
| Navigation | History shows retained-results/standings presentation; Games reaches the catalog and marks its navigation item selected |
| Live refresh | With `#games` retained and the reader scrolled back to the top, an actual fixture WS invalidation reloads Home data without snapping back to the catalog |
| Empty/error | Empty Home disables Start and retains useful explanatory text; a controlled 503 produces a readable alert without overflow |
| Guest | Invited-game Home remains available; Start and catalog navigation are absent; no phone overflow |

The boot script's OS fallback is unit-tested. Live OS-media emulation was not browser-verified: the in-app browser does not expose the attempted raw-CDP storage operation. Actual local-storage reload and cross-tab behavior were verified through the UI. Full live-game command submission, production authentication, PostgreSQL integrations and other browser engines were not rerun in this visual fixture; existing automated suites/CI remain the integration gates.

## Concept-to-render review

Both selected concept PNGs and the latest implementation captures were opened with `view_image` in the final QA pass. A concept board contains two viewports, so its 1536×1024 board dimensions are not a single application viewport; desktop and phone were compared separately at the dimensions above.

| Comparison | Evidence / disposition |
| --- | --- |
| Copy | Your Home, short intro, section labels, game summaries and primary actions match the approved concepts; identity, dates, statuses and alerts remain data-driven |
| Layout | Centered masthead, open match rows, invitation rail and game index match; phone reflows into one column with full-width actions |
| Typography | Serif content/masthead, 64px desktop page title, distinct readable sans-serif controls; native serif fallbacks are intentional |
| Palette/material | Newsprint/slate light and charcoal/white/amber dark use shared semantic tokens; one subtle local paper texture sits behind live text |
| Controls | Flat low-radius actions; an early pale-on-pale dark-label conflict and narrow catalog/invitation actions were corrected before final capture |
| Icons | Consistent simple vector grid, pegs, question cards, envelope and labeled navigation; decorative images stay outside the accessibility tree |
| Responsive behavior | No clipped primary content at checked widths; safe-area bottom padding and scrollable continuation retain access to lower content |

The implementation was faithfully verified against the selected design, with the explicit product adaptations recorded in the main design document: usable appearance/sign-out controls, permission-dependent phone navigation, native font fallbacks and variable real data. No material unaddressed visual mismatch was found in the checked Home views. Artwork is reusable SVG; the generated concepts themselves are never shipped as UI.

## Asset provenance

The paper tile was generated using the built-in Image Gen tool, then converted from PNG to WebP for transfer size. Its generation prompt was:

> Create one production web UI background asset: a perfectly seamless tile of fine uncoated newspaper paper grain, 1024x1024. Full-frame flat orthographic scan, neutral pale warm-gray/off-white with extremely subtle tiny cellulose fibers and gentle natural matte variation. Microtexture only, edited and quiet; texture must work as a low-opacity repeating overlay behind readable newspaper puzzle app typography. All four edges must tile seamlessly. No objects, text, letters, logos, printed marks, ink, borders, shadows, folds, stains, scratches, creases, vignettes, lighting gradients, rough parchment or yellow/brown vintage coloration. Uniform brightness, fine detail, very low contrast. This is an actual texture asset rather than a UI mockup.
