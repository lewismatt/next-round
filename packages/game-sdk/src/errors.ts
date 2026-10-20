// SPDX-License-Identifier: Apache-2.0

/**
 * Raised by a module import hook when the submitted document is rejected.
 *
 * The messages describe the rejected document (shape, rights and grid rules)
 * for the operator who submitted it. They never contain solution data.
 */
export class ResourceImportError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super("The resource document was rejected.");
    this.name = "ResourceImportError";
    this.errors = errors;
  }
}
