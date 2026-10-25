# Newspaper redesign validation

Branch: `design/newspaper-interface`. Baseline: main `8f605dc40c3ecc727cc18a24a45e3b6f3f83467f`. Initial redesign verification is recorded at `47065552ae508a8bcaadf9fe1b1668a921aeff2c`; the light-paper refinement and its new captures are recorded below. This replaces the PR #47 interface validation; earlier evidence remains in Git history.

## Initial redesign gates (4706555)

Run with Node **24.22.1** and pnpm **12.14.0** through `npm exec --yes --package=node@24.22.1 --package=pnpm@12.14.0 -- …`, since the host default is Node 22 and has no pnpm executable.

| Command | Observed result |
| --- | --- |
| `sh scripts/fetch-cipher.sh` | Fetched pinned Cipher `4fbbfee1655a5f5c87456534f868c7bd9b0fac51` |
| `pnpm install --frozen-lockfile` | Pass; lockfile and dependency pins unchanged |
| `pnpm build` | Full workspace pass, including browser-boundary scan |
| `pnpm typecheck` | Full workspace pass |
| `pnpm lint` | Pass, zero warnings |
| `pnpm check:spdx` | Pass, 159 tracked source files |
| Final `pnpm --filter @next-round/web build && pnpm check:browser-bundle` | Pass after responsive/control fixes and texture removal; 17 browser artifacts scanned, no server fixture secret |

The existing non-blocking Vite warning remains: main JavaScript is 503.07 kB minified / 146.17 kB gzip. It is already tracked as BL-072; no limit was raised to hide it. No rules/API/database changes were made, and no new unit tests or local PostgreSQL matrix are claimed for this UI change.

## Browser smoke

Managed Chromium rendered the actual compiled build at a disposable loopback server. HTTP fixtures supplied synthetic sessions, public manifests, matches, invitations and empty/error/guest states. Native WebSocket subscription acknowledgments were served. The Warm Up play view was produced by real `parseCrosswordImport`, `server.transition(create/start)` and `server.view` calls, then mounted through the production GameBridge/client path. The fixture server is not application code and is not committed.

| Scenario | Observed result |
| --- | --- |
| Newspaper Home | Masthead, numbered puzzle columns, match rows, invitation/open-match rail and footer render in both palettes; final PNGs visually inspected |
| Phone Home | 390×844 screenshots in both themes; fixed navigation remains usable and content continues below the viewport |
| Home widths | 320, 360, 390, 430, 720, 768, 1024 and 1440 CSS px: no horizontal document overflow; all Home button targets at least 44px high |
| Crossword widths | 320, 390, 720, 768, 1024 and 1440 checked; no horizontal document overflow |
| Tablet correction | Initial 768px check exposed a 9.625px collapsed board; after stacking board/clues through 1100px, the same viewport renders a 361.625px board without overflow |
| Button contrast correction | Initial dark Submit word label and fill were both `rgb(239, 237, 229)`; the zero-specificity reset restores label `rgb(32, 33, 31)` on that fill. Light label/fill are `rgb(255, 255, 255)` / `rgb(34, 34, 31)` |
| Theme persistence | UI selection survives reload, HTML theme and native color scheme agree; a second tab's UI selection updates the first tab; cleared selection plus emulated dark OS preference boots dark |
| Creation dialog | Play Cipher selects Cipher; Mode changes to Solo; Escape closes and restores focus to Play Cipher |
| Navigation | History opens; desktop Games reaches `/#games`; skip-link activation focuses the actual MAIN landmark |
| Crossword interaction | Production play client mounts; selecting 5 Across selects the clue; entering LEMON retains a local draft and sends zero commands |
| Long identity | Long synthetic display name wraps in the phone header without horizontal overflow |
| Guest | Invited-game presentation remains; Start control absent |
| Empty | Useful empty copy, disabled Start, no phone overflow |
| Error | Controlled HTTP 503 renders a readable alert without phone overflow |
| Normal console | Final normal routes have no captured console errors or page exceptions |

Original `4706555` text/background contrast: light body 14.62:1 and muted text 5.71:1; dark body 13.79:1 and muted text 8.08:1. Updated light-material measurements appear below. This is a focused palette measurement, not a claim of a complete accessibility audit.

## Capture and verification limits

Six real PNG screenshots live in `screenshots/`: desktop and phone Home plus crossword play, each in light and dark. Desktop viewport is 1440×1280 CSS px, phone 390×844; browser device scale 1.25. Desktop/play captures are full-page; phone captures show the viewport. Crossword captures show a selected clue with no submitted answer.

This smoke does not claim production authentication, command acceptance, multiplayer transactions, PostgreSQL integration, real-time invalidation delivery, all game variants, or other browser engines. No production service, database, account or deployment was changed. Existing Phase B scope and backlog items are separate.

## Light newsprint refinement

Matthew approved both themes and requested only a little more newspaper character in the light background. Light paper/card/popover tokens change from `#f7f5ee` to `#efece2`; a local 128×128, 10,973-byte grain tile repeats behind the light page. Black grain alpha is bounded to 0–7/255. The rule applies only to `:root:not(.dark) body`; layout, dark tokens and interaction code are unchanged.

- `pnpm --filter @next-round/web build && pnpm check:browser-bundle` passed with the same pinned toolchain. The boundary scan includes the new tile: 18 artifacts, no server fixture secret. Existing BL-072 warning unchanged.
- Managed Chromium rendered the new production build with the same disposable visual fixtures. The grain decoded successfully at 128×128; computed light background is `rgb(239, 236, 226)`.
- Desktop Home, phone Home and crossword light screenshots were refreshed. The 320px and 390px Home checks have no horizontal overflow. Theme switching and light-preference reload work.
- Dark mode was visually checked and remains `rgb(32, 33, 31)` paper / `rgb(239, 237, 229)` ink with `background-image: none`. Dark screenshot files were not modified.
- Light body/base contrast is 13.49:1, muted/base 5.27:1. Compositing the darkest possible grain gives 12.72:1 and 4.96:1 respectively; text is not obscured by a foreground overlay.
- Final normal-flow browser console errors and page exceptions are empty. The temporary fixture server and browser tab are removed after capture; no production state changes.
