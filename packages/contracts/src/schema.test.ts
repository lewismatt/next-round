// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { ApiError, ERROR_CODES } from "./errors.js";
import { compileJsonSchema, parseJsonSchemaValue } from "./auth.js";

describe("compileJsonSchema and parseJsonSchemaValue (F1-SCHEMA)", () => {
  describe("oneOf semantics (reproduced bug regression)", () => {
    it("rejects values that match multiple subschemas and accepts values that match exactly one", () => {
      const schema = {
        oneOf: [
          { type: "number" },
          { type: "integer" },
        ],
      };

      // 1 is both a number and an integer -> count = 2 -> must be rejected!
      expect(() => parseJsonSchemaValue(schema, 1)).toThrow(ApiError);
      try {
        parseJsonSchemaValue(schema, 1);
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
      }

      // 1.5 is a number but NOT an integer -> count = 1 -> must be accepted!
      expect(parseJsonSchemaValue(schema, 1.5)).toBe(1.5);

      // "not-a-number" matches neither -> count = 0 -> must be rejected!
      expect(() => parseJsonSchemaValue(schema, "not-a-number")).toThrow(ApiError);
    });

    it("evaluates oneOf with three alternatives correctly", () => {
      const schema = {
        oneOf: [
          { type: "string", minLength: 3 },
          { type: "string", maxLength: 5 },
          { type: "number" },
        ],
      };

      // "hi" length 2: matches maxLength: 5 only -> count = 1 -> accepted
      expect(parseJsonSchemaValue(schema, "hi")).toBe("hi");

      // "hello" length 5: matches minLength: 3 AND maxLength: 5 -> count = 2 -> rejected
      expect(() => parseJsonSchemaValue(schema, "hello")).toThrow(ApiError);

      // "hello world" length 11: matches minLength: 3 only -> count = 1 -> accepted
      expect(parseJsonSchemaValue(schema, "hello world")).toBe("hello world");

      // 42: matches number only -> count = 1 -> accepted
      expect(parseJsonSchemaValue(schema, 42)).toBe(42);

      // true: matches none -> rejected
      expect(() => parseJsonSchemaValue(schema, true)).toThrow(ApiError);
    });

    it("rejects empty oneOf array as never matching", () => {
      const schema = { oneOf: [] };
      expect(() => parseJsonSchemaValue(schema, "anything")).toThrow(ApiError);
    });

    it("throws ApiError if oneOf is not an array", () => {
      expect(() => compileJsonSchema({ oneOf: "invalid" })).toThrow(ApiError);
      try {
        compileJsonSchema({ oneOf: "invalid" });
      } catch (error) {
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
      }
    });
  });

  describe("required on object (reproduced bug regression)", () => {
    it("rejects empty object when required properties are not declared in properties", () => {
      const schema = {
        type: "object",
        required: ["mustExist"],
      };

      // {} has no mustExist property -> must be rejected!
      expect(() => parseJsonSchemaValue(schema, {})).toThrow(ApiError);
      try {
        parseJsonSchemaValue(schema, {});
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
        expect((error as ApiError).details).toEqual({
          fields: ["/mustExist"],
        });
      }

      // Object with mustExist property -> must be accepted!
      expect(parseJsonSchemaValue(schema, { mustExist: 123 })).toEqual({ mustExist: 123 });
      expect(parseJsonSchemaValue(schema, { mustExist: null })).toEqual({ mustExist: null });
      expect(parseJsonSchemaValue(schema, { mustExist: "ok" })).toEqual({ mustExist: "ok" });
    });

    it("rejects missing properties when some are in properties and some are not", () => {
      const schema = {
        type: "object",
        properties: {
          declared: { type: "string" },
        },
        required: ["declared", "undeclaredRequired"],
      };

      // Neither present
      expect(() => parseJsonSchemaValue(schema, {})).toThrow(ApiError);

      // Only declared present
      expect(() => parseJsonSchemaValue(schema, { declared: "ok" })).toThrow(ApiError);

      // Only undeclared present
      expect(() => parseJsonSchemaValue(schema, { undeclaredRequired: 1 })).toThrow(ApiError);

      // Both present
      expect(parseJsonSchemaValue(schema, { declared: "ok", undeclaredRequired: 1 })).toEqual({
        declared: "ok",
        undeclaredRequired: 1,
      });
    });

    it("enforces required without explicit type: object", () => {
      const schema = {
        required: ["mustExist"],
      };

      expect(() => parseJsonSchemaValue(schema, {})).toThrow(ApiError);
      expect(parseJsonSchemaValue(schema, { mustExist: "present" })).toEqual({
        mustExist: "present",
      });
    });

    it("throws ApiError if required is not an array or has non-string items", () => {
      expect(() => compileJsonSchema({ type: "object", required: "not-an-array" })).toThrow(ApiError);
      expect(() => compileJsonSchema({ type: "object", required: [123] })).toThrow(ApiError);
    });

    it("throws ApiError if properties is not an object", () => {
      expect(() => compileJsonSchema({ type: "object", properties: "not-an-object" })).toThrow(ApiError);
      expect(() => compileJsonSchema({ type: "object", properties: [] })).toThrow(ApiError);
    });
  });

  describe("rejecting unsupported schemas without silent widening to Any", () => {
    it("rejects unknown primitive type strings", () => {
      expect(() => compileJsonSchema({ type: "unknown" })).toThrow(ApiError);
      expect(() => compileJsonSchema({ type: "date" })).toThrow(ApiError);
      expect(() => compileJsonSchema({ type: "function" })).toThrow(ApiError);
      try {
        compileJsonSchema({ type: "invalid" });
      } catch (error) {
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
      }
    });

    it("rejects non-string/non-array type property", () => {
      expect(() => compileJsonSchema({ type: 123 })).toThrow(ApiError);
      expect(() => compileJsonSchema({ type: {} })).toThrow(ApiError);
    });

    it("rejects empty array type", () => {
      expect(() => compileJsonSchema({ type: [] })).toThrow(ApiError);
    });

    it("rejects unsupported keywords explicitly like $ref", () => {
      expect(() => compileJsonSchema({ $ref: "#/definitions/Foo" })).toThrow(ApiError);
      try {
        compileJsonSchema({ $ref: "#/definitions/Foo" });
      } catch (error) {
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
      }
    });

    it("rejects unknown arbitrary keywords", () => {
      expect(() => compileJsonSchema({ customKeyword: "value" })).toThrow(ApiError);
      expect(() => compileJsonSchema({ patternProperties: {} })).toThrow(ApiError);
    });

    it("rejects prototype-polluting and inherited object keys such as __proto__ and constructor", () => {
      const protoSchema = JSON.parse('{"__proto__": {"type": "string"}}');
      expect(() => compileJsonSchema(protoSchema)).toThrow(ApiError);
      try {
        compileJsonSchema(protoSchema);
      } catch (error) {
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
      }

      const ctorSchema = JSON.parse('{"constructor": {"type": "string"}}');
      expect(() => compileJsonSchema(ctorSchema)).toThrow(ApiError);

      const toStringSchema = JSON.parse('{"toString": true}');
      expect(() => compileJsonSchema(toStringSchema)).toThrow(ApiError);
    });

    it("rejects non-object schema inputs", () => {
      expect(() => compileJsonSchema(null)).toThrow(ApiError);
      expect(() => compileJsonSchema("string")).toThrow(ApiError);
      expect(() => compileJsonSchema(123)).toThrow(ApiError);
      expect(() => compileJsonSchema([1, 2, 3])).toThrow(ApiError);
    });

    it("supports boolean schemas true and false", () => {
      expect(parseJsonSchemaValue(true, { anything: 123 })).toEqual({ anything: 123 });
      expect(() => parseJsonSchemaValue(false, { anything: 123 })).toThrow(ApiError);
    });

    it("supports empty schema {} and metadata-only schemas", () => {
      expect(parseJsonSchemaValue({}, 42)).toBe(42);
      expect(parseJsonSchemaValue({ title: "My Schema", description: "Accepts any" }, "test")).toBe("test");
    });
  });

  describe("anyOf, allOf, const, and enum composition", () => {
    it("handles anyOf (union) correctly", () => {
      const schema = {
        anyOf: [{ type: "string" }, { type: "number" }],
      };
      expect(parseJsonSchemaValue(schema, "str")).toBe("str");
      expect(parseJsonSchemaValue(schema, 42)).toBe(42);
      expect(() => parseJsonSchemaValue(schema, true)).toThrow(ApiError);
    });

    it("handles allOf (intersection) correctly", () => {
      const schema = {
        allOf: [
          { type: "number", minimum: 5 },
          { type: "number", maximum: 10 },
        ],
      };
      expect(parseJsonSchemaValue(schema, 7)).toBe(7);
      expect(() => parseJsonSchemaValue(schema, 4)).toThrow(ApiError);
      expect(() => parseJsonSchemaValue(schema, 11)).toThrow(ApiError);
    });

    it("handles const values", () => {
      const schema = { const: "hello" };
      expect(parseJsonSchemaValue(schema, "hello")).toBe("hello");
      expect(() => parseJsonSchemaValue(schema, "world")).toThrow(ApiError);

      const nullSchema = { const: null };
      expect(parseJsonSchemaValue(nullSchema, null)).toBe(null);
      expect(() => parseJsonSchemaValue(nullSchema, false)).toThrow(ApiError);
    });

    it("handles enum values", () => {
      const schema = { enum: ["red", "green", 1, null] };
      expect(parseJsonSchemaValue(schema, "red")).toBe("red");
      expect(parseJsonSchemaValue(schema, 1)).toBe(1);
      expect(parseJsonSchemaValue(schema, null)).toBe(null);
      expect(() => parseJsonSchemaValue(schema, "blue")).toThrow(ApiError);
    });
  });

  describe("primitives and arrays", () => {
    it("validates string constraints (minLength, maxLength, pattern)", () => {
      const schema = {
        type: "string",
        minLength: 2,
        maxLength: 5,
        pattern: "^[a-z]+$",
      };
      expect(parseJsonSchemaValue(schema, "abc")).toBe("abc");
      expect(() => parseJsonSchemaValue(schema, "a")).toThrow(ApiError);
      expect(() => parseJsonSchemaValue(schema, "abcdef")).toThrow(ApiError);
      expect(() => parseJsonSchemaValue(schema, "123")).toThrow(ApiError);
    });

    it("validates integer constraints", () => {
      const schema = {
        type: "integer",
        minimum: 1,
        maximum: 10,
        multipleOf: 2,
      };
      expect(parseJsonSchemaValue(schema, 6)).toBe(6);
      expect(() => parseJsonSchemaValue(schema, 5)).toThrow(ApiError);
      expect(() => parseJsonSchemaValue(schema, 6.5)).toThrow(ApiError);
      expect(() => parseJsonSchemaValue(schema, 12)).toThrow(ApiError);
    });

    it("validates array items and constraints", () => {
      const schema = {
        type: "array",
        items: { type: "integer" },
        minItems: 1,
        maxItems: 3,
      };
      expect(parseJsonSchemaValue(schema, [1, 2])).toEqual([1, 2]);
      expect(() => parseJsonSchemaValue(schema, [])).toThrow(ApiError);
      expect(() => parseJsonSchemaValue(schema, [1, 2, 3, 4])).toThrow(ApiError);
      expect(() => parseJsonSchemaValue(schema, ["not-an-int"])).toThrow(ApiError);
    });

    it("validates array tuple items with draft-07 prefix semantics", () => {
      const schema = {
        type: "array",
        items: [{ type: "string" }, { type: "integer" }],
      };
      // Exactly matches prefix
      expect(parseJsonSchemaValue(schema, ["score", 100])).toEqual(["score", 100]);
      // Shorter than prefix items: [] and ["score"] must be accepted by default draft-07 prefix semantics
      expect(parseJsonSchemaValue(schema, [])).toEqual([]);
      expect(parseJsonSchemaValue(schema, ["score"])).toEqual(["score"]);
      // Longer than prefix items: trailing items permitted by default
      expect(parseJsonSchemaValue(schema, ["score", 100, "extra", true])).toEqual(["score", 100, "extra", true]);
      // Type mismatch in prefix
      expect(() => parseJsonSchemaValue(schema, [100, "score"])).toThrow(ApiError);
      expect(() => parseJsonSchemaValue(schema, ["score", "not-an-int"])).toThrow(ApiError);

      // With additionalItems: false
      const schemaNoAdditional = {
        type: "array",
        items: [{ type: "string" }, { type: "integer" }],
        additionalItems: false,
      };
      expect(parseJsonSchemaValue(schemaNoAdditional, [])).toEqual([]);
      expect(parseJsonSchemaValue(schemaNoAdditional, ["score"])).toEqual(["score"]);
      expect(parseJsonSchemaValue(schemaNoAdditional, ["score", 100])).toEqual(["score", 100]);
      expect(() => parseJsonSchemaValue(schemaNoAdditional, ["score", 100, "extra"])).toThrow(ApiError);

      // With additionalItems as schema
      const schemaTypedAdditional = {
        type: "array",
        items: [{ type: "string" }, { type: "integer" }],
        additionalItems: { type: "boolean" },
      };
      expect(parseJsonSchemaValue(schemaTypedAdditional, ["score", 100, true, false])).toEqual(["score", 100, true, false]);
      expect(() => parseJsonSchemaValue(schemaTypedAdditional, ["score", 100, "not-a-boolean"])).toThrow(ApiError);
    });
  });

  describe("review regressions: required and additionalProperties interaction (item 1)", () => {
    it("rejects undeclared required property when additionalProperties is false", () => {
      const schema = {
        type: "object",
        required: ["x"],
        additionalProperties: false,
      };

      // Empty object fails required check
      try {
        parseJsonSchemaValue(schema, {});
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
        expect((error as ApiError).details).toEqual({ fields: ["/x"] });
      }

      // Object with x fails additionalProperties: false check because x is not in properties
      try {
        parseJsonSchemaValue(schema, { x: 1 });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
        expect((error as ApiError).details).toEqual({ fields: ["/x"] });
      }
    });

    it("enforces additionalProperties schema on undeclared required property", () => {
      const schema = {
        type: "object",
        required: ["x"],
        additionalProperties: { type: "string" },
      };

      // Empty object fails required check
      try {
        parseJsonSchemaValue(schema, {});
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
        expect((error as ApiError).details).toEqual({ fields: ["/x"] });
      }

      // Numeric x violates additionalProperties: { type: "string" }
      try {
        parseJsonSchemaValue(schema, { x: 1 });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
        expect((error as ApiError).details).toEqual({ fields: ["/x"] });
      }

      // String x satisfies both required and additionalProperties
      expect(parseJsonSchemaValue(schema, { x: "hello" })).toEqual({ x: "hello" });
    });
  });

  describe("review regressions: prototype property names (item 2)", () => {
    it("rejects empty object when prototype property names like toString are required", () => {
      const schema = {
        type: "object",
        required: ["toString"],
      };

      // Empty object does not have own property toString
      try {
        parseJsonSchemaValue(schema, {});
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
        expect((error as ApiError).details).toEqual({ fields: ["/toString"] });
      }

      // Object with own property toString is accepted
      expect(parseJsonSchemaValue(schema, { toString: "custom" })).toEqual({ toString: "custom" });
    });

    it("rejects empty object when __proto__ is required", () => {
      const schema = {
        type: "object",
        required: ["__proto__"],
      };

      try {
        parseJsonSchemaValue(schema, {});
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
        expect((error as ApiError).details).toEqual({ fields: ["/__proto__"] });
      }

      const inputWithProto = JSON.parse('{"__proto__": "present"}');
      expect(parseJsonSchemaValue(schema, inputWithProto)).toEqual(inputWithProto);
    });

    it("validates declared prototype property names against property schemas", () => {
      const schema = {
        type: "object",
        properties: {
          toString: { type: "string" },
        },
        required: ["toString"],
      };

      try {
        parseJsonSchemaValue(schema, {});
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
        expect((error as ApiError).details).toEqual({ fields: ["/toString"] });
      }

      try {
        parseJsonSchemaValue(schema, { toString: 123 });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
        expect((error as ApiError).details).toEqual({ fields: ["/toString"] });
      }

      expect(parseJsonSchemaValue(schema, { toString: "hello" })).toEqual({ toString: "hello" });
    });
  });

  describe("review regressions: typeless keyword applicability (item 3)", () => {
    it("does not constrain non-numbers when numeric constraints are specified without type", () => {
      const schema = { minimum: 5 };

      // Strings, booleans, null, arrays, and objects are not numbers, so minimum does not constrain them
      expect(parseJsonSchemaValue(schema, "hello")).toBe("hello");
      expect(parseJsonSchemaValue(schema, true)).toBe(true);
      expect(parseJsonSchemaValue(schema, null)).toBe(null);
      expect(parseJsonSchemaValue(schema, [1, 2, 3])).toEqual([1, 2, 3]);
      expect(parseJsonSchemaValue(schema, { a: 1 })).toEqual({ a: 1 });

      // Numbers must satisfy minimum
      expect(parseJsonSchemaValue(schema, 7)).toBe(7);
      expect(() => parseJsonSchemaValue(schema, 3)).toThrow(ApiError);
    });

    it("does not constrain non-strings when string constraints are specified without type", () => {
      const schema = { maxLength: 5 };

      expect(parseJsonSchemaValue(schema, 100)).toBe(100);
      expect(parseJsonSchemaValue(schema, true)).toBe(true);
      expect(parseJsonSchemaValue(schema, "abc")).toBe("abc");
      expect(() => parseJsonSchemaValue(schema, "too long string")).toThrow(ApiError);
    });

    it("applies multiple keyword families independently without ignoring other families", () => {
      const schema = { minimum: 5, maxLength: 5 };

      // Number satisfies minimum
      expect(parseJsonSchemaValue(schema, 7)).toBe(7);
      expect(() => parseJsonSchemaValue(schema, 3)).toThrow(ApiError);

      // String satisfies maxLength
      expect(parseJsonSchemaValue(schema, "abc")).toBe("abc");
      expect(() => parseJsonSchemaValue(schema, "too long string")).toThrow(ApiError);

      // Boolean is neither number nor string
      expect(parseJsonSchemaValue(schema, true)).toBe(true);
    });
  });

  describe("review regressions: malformed type with composition (item 5)", () => {
    it("rejects invalid type property even when composition keywords are present", () => {
      expect(() => compileJsonSchema({ type: 123, anyOf: [{ type: "number" }] })).toThrow(ApiError);
      try {
        compileJsonSchema({ type: 123, anyOf: [{ type: "number" }] });
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).code).toBe(ERROR_CODES.INVALID_REQUEST);
      }

      expect(() => compileJsonSchema({ type: true, oneOf: [{ type: "string" }] })).toThrow(ApiError);
      expect(() => compileJsonSchema({ type: ["number", 123], allOf: [{ type: "number" }] })).toThrow(ApiError);
      expect(() => compileJsonSchema({ type: "unknown_type", const: "value" })).toThrow(ApiError);
      expect(() => compileJsonSchema({ type: [], anyOf: [{ type: "string" }] })).toThrow(ApiError);
    });
  });
});
