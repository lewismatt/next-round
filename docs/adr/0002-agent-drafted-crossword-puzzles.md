# ADR 0002: Agent-drafted crossword puzzles under a human author of record

Status: Accepted. Amends the D49 content rule in master specification section 9 (C1) only; the F3 exit gate is unchanged in substance.

Date: 2026-10-20

Sources: [master specification sections 9 and 10](../spec/master-spec.md) (D49, D54), [canonical Notion specification](https://app.notion.com/p/3fd972a22c75816eb745fdf71d2b6fc7), decision by Matthew Lewis, 2026-10-20.

## Problem

D49 required the three bundled puzzles to be human-authored, and the original text stated that generated content does not establish authorship, rights or playability. The protective purpose of that rule is provenance for the CC0-1.0 attestation, solution/clue correctness, and demonstrated playability — not hand construction as such. Hand construction is also the track's bottleneck: the author of record's scarce time was going into grid mechanics rather than the review and playtest gates that carry the rule's actual weight.

## Decision

An agent may draft a puzzle's grid, fill and clues. A draft counts toward the three bundled puzzles only after the named human author of record (Matthew Lewis, also rights reviewer) has:

1. reviewed and edited the draft, taking editorial responsibility for grid, fill and every clue;
2. completed the solution/clue correctness review;
3. completed a clean cold human playtest (no prior exposure to the solution); and
4. signed the CC0-1.0 attestation in writing.

Drafting must use plain, factual clueing, and the drafting agent spot-checks distinctive clues for prior publication. Scraped or commercial puzzle content remains prohibited, as does any fabricated authorship, review or playtest record. Schema validation via the project validator is required as before.

## Consequences and verification

The F3 exit gate is unchanged: three puzzles, each passing the full content checklist. What changes is who performs the drafting labor. Residual risks are clue regurgitation from training data (mitigated by plain-style clueing, spot checks and the human editorial pass) and draft quality (mitigated by the structural validator plus the cold playtest; a failed playtest sends the puzzle back for revision or replacement). Provenance records name both the drafting agent and the author of record, so the chain stays auditable.
