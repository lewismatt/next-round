# F4 — Integration review and contract stabilization

Record of the F4 close-out review (Master Spec §10, slice F4), performed by
Larry on 2026-10-21 under claim `larry-f4-closeout-20261021`, at the
operator's direction ("finish the final coding sprint"). Base: main
`c8409721` (PR #39). This document records what was checked, what was found,
and what remains — it is evidence, not an acceptance claim beyond its scope.

## Exit state of the earlier slices

- F0–F2: integrated (PRs #28–#32), acceptance rows closed on Page 08.
- F3: code integrated (PRs #33, #34); Sprint 6 hardening (PR #35) integrated.
  The two human F3 exit gates closed on 2026-10-21: the D54 content gates
  (editorial review, correctness review, clean cold playtest, written
  CC0-1.0 attestation — all by the author of record, Matthew Lewis) and the
  human C5 walkthrough (passed, per Matthew). With the bundled puzzles in
  this change, F3 §10 exit criteria are fully met.
- Backlog: 60 Fixed / 0 Open at the start of this review.

## This change

1. **Bundled puzzles shipped.** The three attested launch puzzles now live
   in `games/crossword/content/` (`warm-up.json`, `game-night.json`,
   `rural-route.json`) as import documents, with provenance and import
   instructions in `games/crossword/README.md`.
   `games/crossword/src/bundled-content.test.ts` parses each file through
   the real C1 import contract (`parseCrosswordImport`) and pins its
   identity digest to the authoring kit's attested values
   (`012b04f7…`, `676d7d84…`, `56e971e5…`), plus CC0-1.0 license,
   attribution and attested permission-note wording — so the shipped
   files cannot drift from the attested puzzles unnoticed.
2. **Stale milestone text corrected** in `games/crossword/README.md`
   ("Still open in F3" replaced with the delivered state).

## Focused checks (docs vs behavior)

Per §10 F4: "ensure version/error/privacy docs match behavior, and resolve
remaining release risks with focused checks." All checks run against the
exact base above; no drift found, no code changes required.

- **Version surface.** The SDK identifier has a single source of truth,
  `SDK_IDENTIFIER = "next-round-game/0.1"` in the game-sdk package; spec
  and README references are to Master Spec v1.2 throughout. Game modules
  remain pinned at `0.1.0` with exact-version install/disable behavior
  (F1-10 evidence).
- **Error catalog.** Every public error code in Master Spec §2
  (INVALID_REQUEST, AUTH_REQUIRED, SESSION_EXPIRED, INVALID_CREDENTIALS,
  FORBIDDEN, ACCOUNT_DISABLED, NOT_FOUND, STALE_REVISION,
  IDEMPOTENCY_CONFLICT, MATCH_CLOSED, MODULE_DISABLED, CAPACITY_REACHED,
  TOKEN_INVALID, RULE_REJECTED, INCOMPATIBLE_MODULE, RATE_LIMITED,
  MODULE_UNAVAILABLE, SERVICE_UNAVAILABLE, MODULE_FAILURE, INTERNAL_ERROR)
  is emitted by the API/platform code. One additional code,
  `MODULE_CLIENT_MISSING`, appears only as an internal startup diagnostic
  in the API/worker module loaders (the BL-055 class of failure); it is
  never returned as an API error response, which matches its documented
  use in the playtest record.
- **Privacy defaults (D48).** The first-run setup policy submitted by the
  web client is `historyVisibility: "participants"` (participant-only
  detailed results), `statsVisibility: "instance"` (instance-visible
  registered stats), `rejoinChat: "full"`, and null retention in all four
  categories (retain-until-removed) — exactly the spec defaults. Policy is
  snapshotted per match at creation (F2 H3 evidence), so later default
  changes cannot rewrite existing matches.
- **Author guide / second game on paper.** The README game-author section
  (minimal Test Counter example plus the simultaneous-trivia contract
  review) was re-read against the current SDK: the trivia design needs no
  contract change, and its stated caveat stands — a future game must prove
  simultaneous-submission conflict UX, private views and timeout races
  through real transactions before broader compatibility is claimed. The
  contract stays at `next-round-game/0.1`; nothing in F3/F4 integration
  required a breaking change.
- **Release readiness.** The Compose setup uses no paid services: locally
  built app image, PostgreSQL `18.6-alpine` and Caddy `2.11.7-alpine`,
  both digest-pinned, matching `THIRD_PARTY_NOTICES.md` and the image
  inventory (562 locked npm entries inventoried; unknown licenses fail
  generation rather than defaulting). Backup/restore recoverability has
  passing evidence on PostgreSQL 18.6 and 17.11 (docs/operations.md,
  Sprint 3/4 restore drills: custom-format dump restored into an isolated
  database, row counts and fingerprints compared, compiled API ready
  against the restored copy). CI's deployment-image job proves a fresh
  container registers both bundled games with real files (PR #38).
  Operations documentation (docs/operations.md) matches the current
  deploy files.

## Remaining risks and explicit non-claims

- **Playtest stack currency.** The smallpc playtest stack still runs the
  PR #38 image with the playtest-wording puzzle imports. Updating it to
  current main (which also brings the BL-058/BL-059 UI fixes live) and
  re-importing the attested bundled puzzles is an operator-side step on
  smallpc (`/home/matty/next-round`, matty's sudo); it is not done by
  this change and does not block F4 acceptance.
- **50-outstanding invitation cap** was not independently filled live
  (recorded in docs/playtest-2026-10-21.md); isolation integration
  coverage is the standing evidence.
- **No capacity/load exercise** was run: §10 F4 calls for one only when it
  answers a concrete risk, and none is open. The design envelope
  (50 accounts / 20 live connections / 10 active matches) remains a
  target, not a benchmarked guarantee (D45).
- **Production deployment** (server, domain, TLS) is the operator's lane
  and is not part of this review.

## Verdict

With this change integrated, F3 §10 exit criteria are met and the F4
integration review is complete: version, error and privacy documentation
match behavior at the checked surfaces, the SDK contract is unchanged and
stabilized at `next-round-game/0.1`, and the remaining items above are
operator steps or explicitly accepted non-claims rather than open defects.
