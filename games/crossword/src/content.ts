// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";

/**
 * Master Spec §9 C1 — crossword content/import contract.
 *
 * This module is server-side only: it validates imported puzzle documents,
 * derives the conventional crossword structure (entries, clue numbers, answers)
 * and computes the documented exact-puzzle identity digest.
 */

export const CROSSWORD_IMPORT_FORMAT = "next-round.crossword/1" as const;
export const CROSSWORD_IDENTITY_FORMAT = "next-round.crossword.identity/1" as const;

export type CrosswordDirection = "across" | "down";
export type CrosswordDifficulty = "easy" | "medium" | "hard" | "unspecified";

export const CROSSWORD_DIFFICULTIES: readonly CrosswordDifficulty[] = [
  "easy",
  "medium",
  "hard",
  "unspecified",
];

/**
 * Initial rights allowlist (Master Spec §9 C1). A license outside this list is
 * not machine-verifiable, so it is rejected until the operator records an
 * explicit, reviewed exception in this allowlist. An import cannot verify
 * legality by itself.
 */
export const CROSSWORD_RIGHTS_ALLOWLIST: readonly string[] = [
  "CC0-1.0",
  "CC-BY-4.0",
  "CC-BY-SA-4.0",
];

const MIN_GRID_DIMENSION = 3;
const MAX_GRID_DIMENSION = 25;
const MAX_TITLE_LENGTH = 120;
const MAX_AUTHOR_LENGTH = 120;
const MAX_CLUE_LENGTH = 500;
const MAX_ATTRIBUTION_LENGTH = 500;
const MAX_PERMISSION_NOTE_LENGTH = 1000;

export interface CrosswordRights {
  license: string;
  sourceUrl: string | null;
  attribution: string;
  permissionNote: string | null;
}

export interface CrosswordClueInput {
  direction: CrosswordDirection;
  row: number;
  col: number;
  text: string;
}

export interface CrosswordImportDocument {
  format: typeof CROSSWORD_IMPORT_FORMAT;
  title: string;
  author: string;
  language: "en";
  difficulty: CrosswordDifficulty;
  rights: CrosswordRights;
  rows: string[];
  clues: CrosswordClueInput[];
}

export interface CrosswordEntryCell {
  row: number;
  col: number;
}

export interface CrosswordEntry {
  id: string;
  number: number;
  direction: CrosswordDirection;
  row: number;
  col: number;
  length: number;
  cells: CrosswordEntryCell[];
  answer: string;
  clue: string;
}

/** Server-private puzzle content. Never exposed verbatim to a player. */
export interface CrosswordContentV1 {
  format: typeof CROSSWORD_IMPORT_FORMAT;
  title: string;
  author: string;
  language: "en";
  difficulty: CrosswordDifficulty;
  rights: CrosswordRights;
  rows: string[];
  /** Row-major conventional clue numbers; null for cells without a number. */
  numbers: Array<number | null>;
  entries: CrosswordEntry[];
}

/** Public catalog metadata. Never contains solution rows or the identity digest. */
export interface CrosswordPublicMetadata {
  title: string;
  author: string;
  difficulty: CrosswordDifficulty;
  rows: number;
  cols: number;
  rights: CrosswordRights;
}

export type CrosswordImportResult =
  | { ok: true; content: CrosswordContentV1; identity: string }
  | { ok: false; errors: string[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rejects control characters and HTML markup in operator- and player-visible
 * text. All rendering escapes text as well; this keeps hostile content out of
 * the stored document in the first place.
 */
function hasControlOrMarkup(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
    if (character === "<" || character === ">") return true;
  }
  return false;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

interface CrosswordGrid {
  rows: number;
  cols: number;
  /** Row-major open/blocked mask. */
  open: boolean[];
  /** Row-major conventional clue numbers; null for cells without a number. */
  numbers: Array<number | null>;
  entries: CrosswordEntry[];
  /** Entry id per cell for each direction; empty string when the cell starts no entry. */
  acrossEntryId: string[][];
  downEntryId: string[][];
}

interface GridBuild {
  grid: CrosswordGrid;
  /** Cells that belong to a maximal run of exactly one cell. */
  shortRunCells: CrosswordEntryCell[];
}

function buildGrid(rows: string[]): GridBuild {
  const rowCount = rows.length;
  const colCount = rows[0]?.length ?? 0;
  const open: boolean[] = [];
  for (const row of rows) {
    for (const character of row) {
      open.push(character !== "#");
    }
  }

  const openAt = (row: number, col: number): boolean =>
    open[row * colCount + col] === true;

  const numbers: Array<number | null> = new Array(rowCount * colCount).fill(null);
  let nextNumber = 1;
  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      if (!openAt(row, col)) continue;
      const startsAcross = col === 0 || !openAt(row, col - 1);
      const startsDown = row === 0 || !openAt(row - 1, col);
      if (startsAcross || startsDown) {
        numbers[row * colCount + col] = nextNumber;
        nextNumber += 1;
      }
    }
  }

  const entries: CrosswordEntry[] = [];
  const acrossEntryId: string[][] = Array.from({ length: rowCount }, () =>
    Array.from({ length: colCount }, () => ""),
  );
  const downEntryId: string[][] = Array.from({ length: rowCount }, () =>
    Array.from({ length: colCount }, () => ""),
  );
  const shortRunCells: CrosswordEntryCell[] = [];

  const addRun = (
    direction: CrosswordDirection,
    cells: CrosswordEntryCell[],
  ) => {
    const start = cells[0];
    if (cells.length < 2) {
      shortRunCells.push(start);
      return;
    }
    const number = numbers[start.row * colCount + start.col];
    if (number === null || number === undefined) return;
    const id = `${number}${direction === "across" ? "A" : "D"}`;
    const answer = cells.map((cell) => rows[cell.row]?.[cell.col] ?? "").join("");
    entries.push({
      id,
      number,
      direction,
      row: start.row,
      col: start.col,
      length: cells.length,
      cells,
      answer,
      clue: "",
    });
    const target = direction === "across" ? acrossEntryId : downEntryId;
    for (const cell of cells) {
      target[cell.row][cell.col] = id;
    }
  };

  for (let row = 0; row < rowCount; row += 1) {
    let col = 0;
    while (col < colCount) {
      if (!openAt(row, col)) {
        col += 1;
        continue;
      }
      const cells: CrosswordEntryCell[] = [];
      while (col < colCount && openAt(row, col)) {
        cells.push({ row, col });
        col += 1;
      }
      addRun("across", cells);
    }
  }

  for (let col = 0; col < colCount; col += 1) {
    let row = 0;
    while (row < rowCount) {
      if (!openAt(row, col)) {
        row += 1;
        continue;
      }
      const cells: CrosswordEntryCell[] = [];
      while (row < rowCount && openAt(row, col)) {
        cells.push({ row, col });
        row += 1;
      }
      addRun("down", cells);
    }
  }

  return {
    grid: { rows: rowCount, cols: colCount, open, numbers, entries, acrossEntryId, downEntryId },
    shortRunCells,
  };
}

function countConnectedComponents(grid: CrosswordGrid): number {
  const seen = new Array<boolean>(grid.rows * grid.cols).fill(false);
  let components = 0;
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const index = row * grid.cols + col;
      if (!grid.open[index] || seen[index]) continue;
      components += 1;
      const queue: CrosswordEntryCell[] = [{ row, col }];
      seen[index] = true;
      while (queue.length > 0) {
        const cell = queue.shift()!;
        const neighbours = [
          { row: cell.row - 1, col: cell.col },
          { row: cell.row + 1, col: cell.col },
          { row: cell.row, col: cell.col - 1 },
          { row: cell.row, col: cell.col + 1 },
        ];
        for (const neighbour of neighbours) {
          if (
            neighbour.row < 0 ||
            neighbour.col < 0 ||
            neighbour.row >= grid.rows ||
            neighbour.col >= grid.cols
          ) {
            continue;
          }
          const neighbourIndex = neighbour.row * grid.cols + neighbour.col;
          if (!grid.open[neighbourIndex] || seen[neighbourIndex]) continue;
          seen[neighbourIndex] = true;
          queue.push(neighbour);
        }
      }
    }
  }
  return components;
}

/**
 * SHA-256 of the canonical identity JSON: uppercase normalized cells, row order
 * preserved, no whitespace between JSON tokens.
 */
export function crosswordIdentity(rows: readonly string[]): string {
  const normalized = rows.map((row) => row.toUpperCase());
  const canonical = `{"format":"${CROSSWORD_IDENTITY_FORMAT}","rows":${JSON.stringify(normalized)}}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function crosswordPublicMetadata(
  content: CrosswordContentV1,
): CrosswordPublicMetadata {
  return {
    title: content.title,
    author: content.author,
    difficulty: content.difficulty,
    rows: content.rows.length,
    cols: content.rows[0]?.length ?? 0,
    rights: { ...content.rights },
  };
}

/**
 * Validates a `next-round.crossword/1` import document and derives the
 * puzzle structure. Returns every detected problem instead of the first, so an
 * operator can fix a document in one pass.
 */
export function parseCrosswordImport(input: unknown): CrosswordImportResult {
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ["The import document must be a JSON object."] };
  }

  if (input.format !== CROSSWORD_IMPORT_FORMAT) {
    errors.push(`format must be "${CROSSWORD_IMPORT_FORMAT}".`);
  }

  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (title.length === 0) {
    errors.push("title is required.");
  } else if (Array.from(title).length > MAX_TITLE_LENGTH) {
    errors.push(`title must be at most ${MAX_TITLE_LENGTH} characters.`);
  } else if (hasControlOrMarkup(title)) {
    errors.push("title must not contain control characters or HTML markup.");
  }

  const author = typeof input.author === "string" ? input.author.trim() : "";
  if (author.length === 0) {
    errors.push("author is required.");
  } else if (Array.from(author).length > MAX_AUTHOR_LENGTH) {
    errors.push(`author must be at most ${MAX_AUTHOR_LENGTH} characters.`);
  } else if (hasControlOrMarkup(author)) {
    errors.push("author must not contain control characters or HTML markup.");
  }

  if (input.language !== "en") {
    errors.push('language must be "en".');
  }

  const difficulty = input.difficulty;
  if (
    typeof difficulty !== "string" ||
    !CROSSWORD_DIFFICULTIES.includes(difficulty as CrosswordDifficulty)
  ) {
    errors.push(`difficulty must be one of ${CROSSWORD_DIFFICULTIES.join(", ")}.`);
  }

  let rights: CrosswordRights | null = null;
  if (!isPlainObject(input.rights)) {
    errors.push("rights are required and must be reviewed before import.");
  } else {
    const rawLicense = input.rights.license;
    const normalizedLicense =
      typeof rawLicense === "string"
        ? rawLicense.trim().toUpperCase().replace(/_/g, "-")
        : "";
    const license =
      CROSSWORD_RIGHTS_ALLOWLIST.find((entry) => entry === normalizedLicense) ??
      null;
    if (!license) {
      errors.push(
        `rights.license must be one of ${CROSSWORD_RIGHTS_ALLOWLIST.join(", ")} until an operator-reviewed exception is recorded.`,
      );
    }

    const rawSourceUrl = input.rights.sourceUrl;
    let sourceUrl: string | null = null;
    if (rawSourceUrl !== null && rawSourceUrl !== undefined) {
      if (typeof rawSourceUrl !== "string" || !isHttpsUrl(rawSourceUrl)) {
        errors.push("rights.sourceUrl must be null or an https URL.");
      } else {
        sourceUrl = rawSourceUrl;
      }
    }

    const rawAttribution = input.rights.attribution;
    const attribution =
      typeof rawAttribution === "string" ? rawAttribution.trim() : "";
    if (attribution.length === 0) {
      errors.push("rights.attribution is required.");
    } else if (Array.from(attribution).length > MAX_ATTRIBUTION_LENGTH) {
      errors.push(
        `rights.attribution must be at most ${MAX_ATTRIBUTION_LENGTH} characters.`,
      );
    } else if (hasControlOrMarkup(attribution)) {
      errors.push(
        "rights.attribution must not contain control characters or HTML markup.",
      );
    }

    const rawPermissionNote = input.rights.permissionNote;
    let permissionNote: string | null = null;
    if (rawPermissionNote !== null && rawPermissionNote !== undefined) {
      if (typeof rawPermissionNote !== "string") {
        errors.push("rights.permissionNote must be a string or null.");
      } else if (
        Array.from(rawPermissionNote).length > MAX_PERMISSION_NOTE_LENGTH
      ) {
        errors.push(
          `rights.permissionNote must be at most ${MAX_PERMISSION_NOTE_LENGTH} characters.`,
        );
      } else if (hasControlOrMarkup(rawPermissionNote)) {
        errors.push(
          "rights.permissionNote must not contain control characters or HTML markup.",
        );
      } else {
        permissionNote = rawPermissionNote;
      }
    }

    if (license) {
      rights = { license, sourceUrl, attribution, permissionNote };
    }
  }

  const rows: string[] = [];
  if (!Array.isArray(input.rows)) {
    errors.push("rows must be an array of strings.");
  } else {
    if (input.rows.length < MIN_GRID_DIMENSION) {
      errors.push(`rows must contain at least ${MIN_GRID_DIMENSION} rows.`);
    }
    if (input.rows.length > MAX_GRID_DIMENSION) {
      errors.push(`rows must contain at most ${MAX_GRID_DIMENSION} rows.`);
    }
    const widths = new Set<number>();
    input.rows.forEach((row, index) => {
      if (typeof row !== "string") {
        errors.push(`rows[${index}] must be a string.`);
        return;
      }
      widths.add(Array.from(row).length);
      for (const character of row) {
        if (character !== "#" && !/^[A-Z]$/.test(character)) {
          errors.push(
            `rows[${index}] must contain only "#" for blocked cells and A-Z letters.`,
          );
          return;
        }
      }
    });
    if (widths.size > 1) {
      errors.push("rows must all have the same length.");
    }
    const width = widths.size === 1 ? [...widths][0] : 0;
    if (width > 0 && width < MIN_GRID_DIMENSION) {
      errors.push(`rows must contain at least ${MIN_GRID_DIMENSION} columns.`);
    }
    if (width > MAX_GRID_DIMENSION) {
      errors.push(`rows must contain at most ${MAX_GRID_DIMENSION} columns.`);
    }
    for (const row of input.rows) {
      if (typeof row === "string") rows.push(row);
    }
  }

  const build = rows.length > 0 && rows[0]?.length ? buildGrid(rows) : null;
  const grid = build?.grid ?? null;

  if (grid) {
    const openCells = grid.open.filter(Boolean).length;
    if (openCells === 0) {
      errors.push("The grid must contain at least one open cell.");
    }
    if (openCells > 0 && countConnectedComponents(grid) > 1) {
      errors.push("Open cells must form one orthogonally connected region.");
    }
    for (const cell of build!.shortRunCells) {
      errors.push(
        `The grid contains a one-cell entry at row ${cell.row + 1}, column ${cell.col + 1}.`,
      );
    }
    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.cols; col += 1) {
        if (!grid.open[row * grid.cols + col]) continue;
        if (grid.acrossEntryId[row][col] === "" || grid.downEntryId[row][col] === "") {
          errors.push(
            `Every open cell must belong to an across and a down entry (row ${row + 1}, column ${col + 1}).`,
          );
          break;
        }
      }
    }
  }

  const clueByStart = new Map<string, CrosswordClueInput>();
  if (!Array.isArray(input.clues)) {
    errors.push("clues must be an array.");
  } else {
    input.clues.forEach((clue, index) => {
      if (!isPlainObject(clue)) {
        errors.push(`clues[${index}] must be an object.`);
        return;
      }
      const direction = clue.direction;
      if (direction !== "across" && direction !== "down") {
        errors.push(`clues[${index}].direction must be "across" or "down".`);
        return;
      }
      const row = clue.row;
      const col = clue.col;
      if (
        typeof row !== "number" ||
        !Number.isInteger(row) ||
        typeof col !== "number" ||
        !Number.isInteger(col)
      ) {
        errors.push(`clues[${index}] must use integer zero-based row and col.`);
        return;
      }
      if (
        row < 0 ||
        col < 0 ||
        (grid ? row >= grid.rows || col >= grid.cols : false)
      ) {
        errors.push(`clues[${index}] is outside the grid.`);
        return;
      }
      const text = typeof clue.text === "string" ? clue.text.trim() : "";
      if (text.length === 0) {
        errors.push(`clues[${index}].text is required.`);
        return;
      }
      if (Array.from(text).length > MAX_CLUE_LENGTH) {
        errors.push(
          `clues[${index}].text must be at most ${MAX_CLUE_LENGTH} characters.`,
        );
        return;
      }
      if (hasControlOrMarkup(text)) {
        errors.push(
          `clues[${index}].text must not contain control characters or HTML markup.`,
        );
        return;
      }
      const key = `${direction}:${row}:${col}`;
      if (clueByStart.has(key)) {
        errors.push(
          `clues contains more than one ${direction} clue at row ${row + 1}, column ${col + 1}.`,
        );
        return;
      }
      if (grid) {
        const startEntry = grid.entries.find(
          (entry) =>
            entry.direction === direction &&
            entry.row === row &&
            entry.col === col,
        );
        if (!startEntry) {
          errors.push(
            `clues[${index}] does not start an entry at row ${row + 1}, column ${col + 1}.`,
          );
          return;
        }
      }
      clueByStart.set(key, { direction, row, col, text });
    });
  }

  const entries: CrosswordEntry[] = [];
  if (grid) {
    for (const entry of grid.entries) {
      const clue = clueByStart.get(`${entry.direction}:${entry.row}:${entry.col}`);
      if (!clue) {
        errors.push(
          `The ${entry.direction} entry ${entry.id} at row ${entry.row + 1}, column ${entry.col + 1} has no clue.`,
        );
        continue;
      }
      entries.push({ ...entry, clue: clue.text });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const content: CrosswordContentV1 = {
    format: CROSSWORD_IMPORT_FORMAT,
    title,
    author,
    language: "en",
    difficulty: difficulty as CrosswordDifficulty,
    rights: rights!,
    rows,
    numbers: grid!.numbers,
    entries,
  };

  return { ok: true, content, identity: crosswordIdentity(rows) };
}
