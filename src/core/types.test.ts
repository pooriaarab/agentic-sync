import { describe, expect, test } from "vitest";
import { assertGrant, isPrincipalId, PRINCIPAL_KINDS } from "./types.js";

const principal = { id: "ana", kind: "human" };
const grant = (extra: Record<string, unknown>) => ({ principal, role: "editor", ...extra });

describe("assertGrant refuses a bad principal or grant", () => {
  test.each([
    ["no principal", { role: "editor" }],
    ["a missing kind", { principal: { id: "ana" }, role: "editor" }],
    ["an unknown kind", { principal: { id: "ana", kind: "bot" }, role: "editor" }],
    ["an empty id", { principal: { id: "", kind: "human" }, role: "editor" }],
    ["an id over 128 characters", { principal: { id: "a".repeat(129), kind: "human" }, role: "editor" }],
    ["an id with a space", { principal: { id: "ana bo", kind: "human" }, role: "editor" }],
    ["an id that is an email", { principal: { id: "ana@example.org", kind: "human" }, role: "editor" }],
    ["an id that starts with a dot", { principal: { id: ".ana", kind: "human" }, role: "editor" }],
    ["a missing role", { principal }],
    ["a role that is unknown", grant({ role: "admin" })],
    ["an empty name", grant({ name: "" })],
    ["a name that is not a string", grant({ name: 7 })],
    ["a name over 128 characters", grant({ name: "a".repeat(129) })],
  ])("refuses %s", (_, value) => {
    expect(() => assertGrant(value)).toThrow("authorize returned an invalid grant");
  });
});

describe("isPrincipalId uses the grant rule for an id alone", () => {
  test.each([["ana"], ["agent-7"], ["a".repeat(128)]])("accepts %s", (id) => {
    expect(isPrincipalId(id)).toBe(true);
  });

  test.each([[""], ["a".repeat(129)], ["ana@example.org"], ["ana bo"], [7], [undefined]])("refuses %s", (id) => {
    expect(isPrincipalId(id)).toBe(false);
  });
});

describe("assertGrant accepts a good principal", () => {
  test("every kind in the identity list", () => {
    for (const kind of PRINCIPAL_KINDS) {
      expect(assertGrant({ principal: { id: "a", kind }, role: "editor" }).principal.kind).toBe(kind);
    }
  });

  test("an id of 128 characters", () => {
    const id = "a".repeat(128);
    expect(assertGrant({ principal: { id, kind: "agent" }, role: "editor" }).principal.id).toBe(id);
  });
});
