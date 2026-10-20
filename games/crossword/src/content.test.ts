// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CROSSWORD_IDENTITY_FORMAT,
  CROSSWORD_IMPORT_FORMAT,
  crosswordIdentity,
  crosswordPublicMetadata,
  parseCrosswordImport,
  type CrosswordContentV1,
  type CrosswordEntry,
} from "./content.js";

/**
 * Master Spec §9 C1 — crossword content/import contract.
 *
 * These tests assert the documented import contract (schema, grid rules, clue
 * rules, identity digest, public catalog metadata) rather than incidental
 * implementation output. Where a naive implementation would plausibly differ
 * (clue numbering in particular) the expectation follows the spec.
 */

interface FixtureRights {
  license: string;
  sourceUrl: string | null;
  attribution: string;
  permissionNote: string | null;
}

interface FixtureClue {
  direction: string;
  row: number;
  col: number;
  text: string;
}

interface FixtureDocument {
  format: string;
  title: string;
  author: string;
  language: string;
  difficulty: string;
  rights: FixtureRights;
  rows: string[];
  clues: FixtureClue[];
}

const THREE_BY_THREE_ROWS = ["CAT", "ARE", "TEN"];

const THREE_BY_THREE_CLUES: FixtureClue[] = [
  { direction: "across", row: 0, col: 0, text: "Household feline" },
  { direction: "across", row: 1, col: 0, text: "Exist, with a plural" },
  { direction: "across", row: 2, col: 0, text: "Grasp firmly" },
  { direction: "down", row: 0, col: 0, text: "Whiskered pet" },
  { direction: "down", row: 0, col: 1, text: "Plural of be" },
  { direction: "down", row: 0, col: 2, text: "Hold on to" },
];

function makeDocument(
  overrides: Partial<FixtureDocument> = {},
): FixtureDocument {
  return {
    format: CROSSWORD_IMPORT_FORMAT,
    title: "Tiny Cross",
    author: "Test Author",
    language: "en",
    difficulty: "easy",
    rights: {
      license: "CC0-1.0",
      sourceUrl: "https://example.com/puzzle",
      attribution: "Original work for Next Round",
      permissionNote: null,
    },
    rows: [...THREE_BY_THREE_ROWS],
    clues: THREE_BY_THREE_CLUES.map((clue) => ({ ...clue })),
    ...overrides,
  };
}

function parseOk(document: unknown): {
  content: CrosswordContentV1;
  identity: string;
} {
  const result = parseCrosswordImport(document);
  if (!result.ok) {
    throw new Error(
      `Expected a valid import but got errors: ${result.errors.join(" | ")}`,
    );
  }
  return result;
}

function expectRejection(document: unknown, expectedMessage: string): void {
  const result = parseCrosswordImport(document);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected a rejection containing "${expectedMessage}"`);
  }
  expect(result.errors).toContain(expectedMessage);
}

/** SHA-256 of the canonical identity JSON, computed independently of the module. */
function expectedIdentity(rows: readonly string[]): string {
  const normalized = rows.map((row) => row.toUpperCase());
  const canonical = `{"format":"${CROSSWORD_IDENTITY_FORMAT}","rows":${JSON.stringify(normalized)}}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** One clue per maximal open run of at least two cells, for otherwise valid grids. */
function cluesForRows(rows: string[]): FixtureClue[] {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const isOpen = (row: number, col: number): boolean => {
    const character = rows[row]?.[col];
    return character !== undefined && character !== "#";
  };
  const clues: FixtureClue[] = [];
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      if (!isOpen(row, col)) continue;
      if (col === 0 || !isOpen(row, col - 1)) {
        let length = 0;
        while (col + length < width && isOpen(row, col + length)) length += 1;
        if (length >= 2) {
          clues.push({
            direction: "across",
            row,
            col,
            text: `Across clue at ${row + 1},${col + 1}`,
          });
        }
      }
      if (row === 0 || !isOpen(row - 1, col)) {
        let length = 0;
        while (row + length < height && isOpen(row + length, col)) length += 1;
        if (length >= 2) {
          clues.push({
            direction: "down",
            row,
            col,
            text: `Down clue at ${row + 1},${col + 1}`,
          });
        }
      }
    }
  }
  return clues;
}

function entryById(
  content: CrosswordContentV1,
  id: string,
): CrosswordEntry | undefined {
  return content.entries.find((entry) => entry.id === id);
}

const THREE_BY_THREE_ENTRIES: CrosswordEntry[] = [
  {
    id: "1A",
    number: 1,
    direction: "across",
    row: 0,
    col: 0,
    length: 3,
    cells: [
      { row: 0, col: 0 },
      { row: 0, col: 1 },
      { row: 0, col: 2 },
    ],
    answer: "CAT",
    clue: "Household feline",
  },
  {
    id: "4A",
    number: 4,
    direction: "across",
    row: 1,
    col: 0,
    length: 3,
    cells: [
      { row: 1, col: 0 },
      { row: 1, col: 1 },
      { row: 1, col: 2 },
    ],
    answer: "ARE",
    clue: "Exist, with a plural",
  },
  {
    id: "5A",
    number: 5,
    direction: "across",
    row: 2,
    col: 0,
    length: 3,
    cells: [
      { row: 2, col: 0 },
      { row: 2, col: 1 },
      { row: 2, col: 2 },
    ],
    answer: "TEN",
    clue: "Grasp firmly",
  },
  {
    id: "1D",
    number: 1,
    direction: "down",
    row: 0,
    col: 0,
    length: 3,
    cells: [
      { row: 0, col: 0 },
      { row: 1, col: 0 },
      { row: 2, col: 0 },
    ],
    answer: "CAT",
    clue: "Whiskered pet",
  },
  {
    id: "2D",
    number: 2,
    direction: "down",
    row: 0,
    col: 1,
    length: 3,
    cells: [
      { row: 0, col: 1 },
      { row: 1, col: 1 },
      { row: 2, col: 1 },
    ],
    answer: "ARE",
    clue: "Plural of be",
  },
  {
    id: "3D",
    number: 3,
    direction: "down",
    row: 0,
    col: 2,
    length: 3,
    cells: [
      { row: 0, col: 2 },
      { row: 1, col: 2 },
      { row: 2, col: 2 },
    ],
    answer: "TEN",
    clue: "Hold on to",
  },
];

describe("crossword content/import contract (Master Spec §9 C1)", () => {
  describe("valid puzzle documents", () => {
    it("parses a 3x3 all-open puzzle and derives its entries, answers, cells and clues", () => {
      const { content } = parseOk(makeDocument());

      expect(content.format).toBe("next-round.crossword/1");
      expect(content.title).toBe("Tiny Cross");
      expect(content.author).toBe("Test Author");
      expect(content.language).toBe("en");
      expect(content.difficulty).toBe("easy");
      expect(content.rights).toEqual({
        license: "CC0-1.0",
        sourceUrl: "https://example.com/puzzle",
        attribution: "Original work for Next Round",
        permissionNote: null,
      });
      expect(content.rows).toEqual(THREE_BY_THREE_ROWS);
      expect(content.entries).toHaveLength(6);
      expect([...content.entries.map((entry) => entry.id)].sort()).toEqual([
        "1A",
        "1D",
        "2D",
        "3D",
        "4A",
        "5A",
      ]);
      for (const expected of THREE_BY_THREE_ENTRIES) {
        expect(entryById(content, expected.id)).toEqual(expected);
      }
    });

    it("numbers cells in row-major order so a cell starting both directions shares one number", () => {
      const { content } = parseOk(makeDocument());

      // (0,0) starts both an across and a down entry, so both carry number 1.
      expect(entryById(content, "1A")?.number).toBe(1);
      expect(entryById(content, "1D")?.number).toBe(1);
      // (0,1) and (0,2) only start down entries, so they take numbers 2 and 3.
      expect(entryById(content, "2D")?.number).toBe(2);
      expect(entryById(content, "3D")?.number).toBe(3);
      // (1,0) and (2,0) only start across entries, so they take numbers 4 and 5:
      // a per-entry counter would wrongly call them 2A and 3A.
      expect(entryById(content, "4A")?.number).toBe(4);
      expect(entryById(content, "5A")?.number).toBe(5);
      expect(entryById(content, "2A")).toBeUndefined();
      expect(entryById(content, "3A")).toBeUndefined();

      expect(content.numbers).toEqual([
        1, 2, 3, 4, null, null, 5, null, null,
      ]);
    });

    it("ignores any numbering supplied in the imported document", () => {
      const document = {
        ...makeDocument(),
        numbers: [9, 9, 9, 9, 9, 9, 9, 9, 9],
      };
      const { content } = parseOk(document);

      expect(content.numbers).toEqual([
        1, 2, 3, 4, null, null, 5, null, null,
      ]);
    });

    it("parses a grid with blocked cells and leaves cells that start no entry unnumbered", () => {
      const rows = ["#CAT#", "#ORE#", "#TEN#"];
      const document = makeDocument({
        rows,
        clues: [
          { direction: "across", row: 0, col: 1, text: "Household feline" },
          { direction: "across", row: 1, col: 1, text: "Exist, with a plural" },
          { direction: "across", row: 2, col: 1, text: "Grasp firmly" },
          { direction: "down", row: 0, col: 1, text: "Whiskered pet" },
          { direction: "down", row: 0, col: 2, text: "Plural of be" },
          { direction: "down", row: 0, col: 3, text: "Hold on to" },
        ],
      });
      const { content } = parseOk(document);

      expect(content.numbers).toEqual([
        null, 1, 2, 3, null,
        null, 4, null, null, null,
        null, 5, null, null, null,
      ]);
      expect([...content.entries.map((entry) => entry.id)].sort()).toEqual([
        "1A",
        "1D",
        "2D",
        "3D",
        "4A",
        "5A",
      ]);
      expect(entryById(content, "1A")?.answer).toBe("CAT");
      expect(entryById(content, "4A")?.answer).toBe("ORE");
      expect(entryById(content, "5A")?.answer).toBe("TEN");
      expect(entryById(content, "1D")?.answer).toBe("COT");
      expect(entryById(content, "2D")?.answer).toBe("ARE");
      expect(entryById(content, "3D")?.answer).toBe("TEN");
    });
  });

  describe("identity digest", () => {
    it("equals a SHA-256 of the canonical identity JSON computed independently", () => {
      const { identity } = parseOk(makeDocument());

      expect(identity).toBe(expectedIdentity(THREE_BY_THREE_ROWS));
      expect(identity).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is stable for the same grid", () => {
      const first = parseOk(makeDocument());
      const second = parseOk(makeDocument());

      expect(first.identity).toBe(second.identity);
    });

    it("ignores title and clue changes", () => {
      const original = parseOk(makeDocument());
      const renamed = parseOk(
        makeDocument({
          title: "A Completely Different Title",
          clues: THREE_BY_THREE_CLUES.map((clue) => ({
            ...clue,
            text: `${clue.text} (revised)`,
          })),
        }),
      );

      expect(renamed.identity).toBe(original.identity);
    });

    it("changes when the grid changes", () => {
      const original = parseOk(makeDocument());
      const changed = parseOk(makeDocument({ rows: ["CAT", "ARE", "TES"] }));

      expect(changed.identity).not.toBe(original.identity);
      expect(changed.identity).toBe(expectedIdentity(["CAT", "ARE", "TES"]));
    });

    it("does not normalize rotations or rearrangements into one identity", () => {
      const original = parseOk(makeDocument());
      const rotated = parseOk(
        makeDocument({ rows: ["TAC", "ERA", "NET"] }),
      );

      expect(rotated.identity).not.toBe(original.identity);
    });

    it("normalizes cell case in the canonical rows", () => {
      expect(crosswordIdentity(["cat", "are", "ten"])).toBe(
        crosswordIdentity(["CAT", "ARE", "TEN"]),
      );
    });
  });

  describe("rejections", () => {
    it("rejects a document that is not a JSON object", () => {
      expectRejection("not a document", "The import document must be a JSON object.");
    });

    it("rejects a wrong format", () => {
      expectRejection(
        makeDocument({ format: "next-round.crossword/2" }),
        'format must be "next-round.crossword/1".',
      );
    });

    it("rejects a missing title", () => {
      expectRejection(
        makeDocument({ title: undefined as unknown as string }),
        "title is required.",
      );
    });

    it("rejects a blank title", () => {
      expectRejection(makeDocument({ title: "   " }), "title is required.");
    });

    it("rejects a title longer than 120 characters", () => {
      expectRejection(
        makeDocument({ title: "a".repeat(121) }),
        "title must be at most 120 characters.",
      );
    });

    it("accepts a title of exactly 120 characters", () => {
      const { content } = parseOk(makeDocument({ title: "a".repeat(120) }));

      expect(content.title).toHaveLength(120);
    });

    it("rejects a missing author", () => {
      expectRejection(
        makeDocument({ author: undefined as unknown as string }),
        "author is required.",
      );
    });

    it("rejects an author longer than 120 characters", () => {
      expectRejection(
        makeDocument({ author: "a".repeat(121) }),
        "author must be at most 120 characters.",
      );
    });

    it("rejects a language other than en", () => {
      expectRejection(
        makeDocument({ language: "fr" }),
        'language must be "en".',
      );
    });

    it("rejects an invalid difficulty", () => {
      expectRejection(
        makeDocument({ difficulty: "impossible" }),
        "difficulty must be one of easy, medium, hard, unspecified.",
      );
    });

    it("rejects missing rights", () => {
      expectRejection(
        makeDocument({ rights: undefined as unknown as FixtureRights }),
        "rights are required and must be reviewed before import.",
      );
    });

    it("rejects a license outside the rights allowlist", () => {
      expectRejection(
        makeDocument({
          rights: {
            license: "MIT",
            sourceUrl: null,
            attribution: "Original work for Next Round",
            permissionNote: null,
          },
        }),
        "rights.license must be one of CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0 until an operator-reviewed exception is recorded.",
      );
    });

    it.each(["CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0"])(
      "accepts the allowlisted license %s",
      (license) => {
        const { content } = parseOk(
          makeDocument({
            rights: {
              license,
              sourceUrl: null,
              attribution: "Original work for Next Round",
              permissionNote: null,
            },
          }),
        );

        expect(content.rights.license).toBe(license);
      },
    );

    it("rejects a non-https sourceUrl", () => {
      expectRejection(
        makeDocument({
          rights: {
            license: "CC0-1.0",
            sourceUrl: "http://example.com/puzzle",
            attribution: "Original work for Next Round",
            permissionNote: null,
          },
        }),
        "rights.sourceUrl must be null or an https URL.",
      );
    });

    it("rejects missing attribution", () => {
      expectRejection(
        makeDocument({
          rights: {
            license: "CC0-1.0",
            sourceUrl: null,
            attribution: "   ",
            permissionNote: null,
          },
        }),
        "rights.attribution is required.",
      );
    });

    it("rejects a grid with fewer than 3 rows", () => {
      const rows = ["CAT", "ARE"];
      expectRejection(
        makeDocument({ rows, clues: cluesForRows(rows) }),
        "rows must contain at least 3 rows.",
      );
    });

    it("rejects a grid with fewer than 3 columns", () => {
      const rows = ["CA", "AR", "TE"];
      expectRejection(
        makeDocument({ rows, clues: cluesForRows(rows) }),
        "rows must contain at least 3 columns.",
      );
    });

    it("rejects a grid with more than 25 rows", () => {
      const rows = Array.from({ length: 26 }, () => "AAA");
      expectRejection(
        makeDocument({ rows, clues: cluesForRows(rows) }),
        "rows must contain at most 25 rows.",
      );
    });

    it("rejects a grid with more than 25 columns", () => {
      const rows = Array.from({ length: 3 }, () => "A".repeat(26));
      expectRejection(
        makeDocument({ rows, clues: cluesForRows(rows) }),
        "rows must contain at most 25 columns.",
      );
    });

    it("rejects ragged rows", () => {
      const rows = ["CAT", "AR", "TEN"];
      expectRejection(
        makeDocument({ rows, clues: cluesForRows(rows) }),
        "rows must all have the same length.",
      );
    });

    it("rejects a lowercase cell character", () => {
      expectRejection(
        makeDocument({ rows: ["CAT", "are", "TEN"] }),
        'rows[1] must contain only "#" for blocked cells and A-Z letters.',
      );
    });

    it("rejects a cell character outside A-Z", () => {
      expectRejection(
        makeDocument({ rows: ["C1T", "ARE", "TEN"] }),
        'rows[0] must contain only "#" for blocked cells and A-Z letters.',
      );
    });

    it("rejects a grid whose open cells form two separate regions", () => {
      const rows = ["AA##", "AA##", "##BB", "##BB"];
      expectRejection(
        makeDocument({ rows, clues: cluesForRows(rows) }),
        "Open cells must form one orthogonally connected region.",
      );
    });

    it("rejects a one-cell entry", () => {
      const rows = ["ABCDE", "FGHIJ", "K#LMN", "OPQRS", "#TUVW"];
      expectRejection(
        makeDocument({ rows, clues: cluesForRows(rows) }),
        "The grid contains a one-cell entry at row 3, column 1.",
      );
    });

    it("rejects an open cell that is not part of both an across and a down entry", () => {
      const rows = ["X#AB", "CDEF", "GHIJ"];
      expectRejection(
        makeDocument({ rows, clues: cluesForRows(rows) }),
        "Every open cell must belong to an across and a down entry (row 1, column 1).",
      );
    });

    it("does not report a connected grid as having separate open regions", () => {
      // Every open cell of this grid is orthogonally connected, so the only
      // problem is the one-cell entry in the middle row.
      const rows = ["ABCDE", "FGHIJ", "K#LMN", "OPQRS", "#TUVW"];
      const result = parseCrosswordImport(
        makeDocument({ rows, clues: cluesForRows(rows) }),
      );
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error("Expected a rejection");
      }
      expect(result.errors).not.toContain(
        "Open cells must form one orthogonally connected region.",
      );
    });

    it("rejects an empty grid", () => {
      const rows = ["###", "###", "###"];
      expectRejection(
        makeDocument({ rows, clues: [] }),
        "The grid must contain at least one open cell.",
      );
    });

    it("rejects a duplicate clue start", () => {
      const clues = [
        ...THREE_BY_THREE_CLUES,
        { direction: "across", row: 0, col: 0, text: "Second across clue" },
      ];
      expectRejection(
        makeDocument({ clues }),
        "clues contains more than one across clue at row 1, column 1.",
      );
    });

    it("rejects a clue that does not start an entry", () => {
      const clues = [
        ...THREE_BY_THREE_CLUES,
        { direction: "down", row: 1, col: 1, text: "Not a start" },
      ];
      expectRejection(
        makeDocument({ clues }),
        "clues[6] does not start an entry at row 2, column 2.",
      );
    });

    it("rejects a missing clue for a derived entry", () => {
      const clues = THREE_BY_THREE_CLUES.slice(1);
      expectRejection(
        makeDocument({ clues }),
        "The across entry 1A at row 1, column 1 has no clue.",
      );
    });

    it("rejects an out-of-range clue start", () => {
      const clues = [
        ...THREE_BY_THREE_CLUES,
        { direction: "down", row: 9, col: 0, text: "Off the grid" },
      ];
      expectRejection(
        makeDocument({ clues }),
        "clues[6] is outside the grid.",
      );
    });

    it("rejects a negative clue start", () => {
      const clues = [
        ...THREE_BY_THREE_CLUES,
        { direction: "down", row: -1, col: 0, text: "Off the grid" },
      ];
      expectRejection(
        makeDocument({ clues }),
        "clues[6] is outside the grid.",
      );
    });

    it("rejects a non-integer clue coordinate", () => {
      const clues = [
        ...THREE_BY_THREE_CLUES,
        { direction: "down", row: 0.5, col: 0, text: "Half a row" },
      ];
      expectRejection(
        makeDocument({ clues }),
        "clues[6] must use integer zero-based row and col.",
      );
    });

    it("rejects an empty clue text", () => {
      const clues = THREE_BY_THREE_CLUES.map((clue, index) =>
        index === 0 ? { ...clue, text: "   " } : { ...clue },
      );
      expectRejection(makeDocument({ clues }), "clues[0].text is required.");
    });

    it("rejects a clue text with control characters", () => {
      const clues = THREE_BY_THREE_CLUES.map((clue, index) =>
        index === 0 ? { ...clue, text: "bad\u0007clue" } : { ...clue },
      );
      expectRejection(
        makeDocument({ clues }),
        "clues[0].text must not contain control characters or HTML markup.",
      );
    });

    it("rejects a clue text with HTML markup", () => {
      const clues = THREE_BY_THREE_CLUES.map((clue, index) =>
        index === 0 ? { ...clue, text: "<b>clue</b>" } : { ...clue },
      );
      expectRejection(
        makeDocument({ clues }),
        "clues[0].text must not contain control characters or HTML markup.",
      );
    });

    it("rejects a title with control characters or HTML markup", () => {
      expectRejection(
        makeDocument({ title: "Tiny <Cross>" }),
        "title must not contain control characters or HTML markup.",
      );
    });
  });

  describe("public catalog metadata", () => {
    it("exposes title, author, difficulty, dimensions and rights", () => {
      const { content } = parseOk(makeDocument());
      const metadata = crosswordPublicMetadata(content);

      expect(metadata).toEqual({
        title: "Tiny Cross",
        author: "Test Author",
        difficulty: "easy",
        rows: 3,
        cols: 3,
        rights: {
          license: "CC0-1.0",
          sourceUrl: "https://example.com/puzzle",
          attribution: "Original work for Next Round",
          permissionNote: null,
        },
      });
    });

    it("never exposes the solution rows or the identity digest", () => {
      const { content, identity } = parseOk(makeDocument());
      const metadata = crosswordPublicMetadata(content);

      expect(Object.keys(metadata).sort()).toEqual([
        "author",
        "cols",
        "difficulty",
        "rights",
        "rows",
        "title",
      ]);
      const serialized = JSON.stringify(metadata);
      expect(serialized).not.toContain("CAT");
      expect(serialized).not.toContain("ARE");
      expect(serialized).not.toContain("TEN");
      expect(serialized).not.toContain(identity);
      expect(serialized).not.toContain(content.rows[0]);
    });
  });
});
