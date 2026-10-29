import { describe, expect, test } from "vitest";
import { assertGrant, PRINCIPAL_KINDS } from "./types.js";

const grant = (principal: unknown, role: unknown = "editor") => ({ principal, role });

describe("assertGrant refuses a bad principal", () => {
  test.each([
    ["no principal", grant(undefined)],
    ["a missing kind", grant({ id: "ana" })],
    ["an unknown kind", grant({ id: "ana", kind: "bot" })],
    ["an empty id", grant({ id: "", kind: "human" })],
    ["an id over 128 characters", grant({ id: "a".repeat(129), kind: "human" })],
    ["an id with a space", grant({ id: "ana bo", kind: "human" })],
    ["an id that is an email", grant({ id: "ana@example.org", kind: "human" })],
    ["an id that starts with a dot", grant({ id: ".ana", kind: "human" })],
    ["a role that is unknown", grant({ id: "ana", kind: "human" }, "admin")],
  ])("refuses %s", (_, value) => {
    expect(() => assertGrant(value)).toThrow("authorize returned an invalid grant");
  });
});

describe("assertGrant accepts a good principal", () => {
  test("every kind in the identity list", () => {
    for (const kind of PRINCIPAL_KINDS) {
      expect(assertGrant(grant({ id: "a", kind })).principal.kind).toBe(kind);
    }
  });

  test("an id of 128 characters", () => {
    const id = "a".repeat(128);
    expect(assertGrant(grant({ id, kind: "agent" })).principal.id).toBe(id);
  });
});
