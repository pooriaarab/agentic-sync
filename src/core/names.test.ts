import { describe, expect, test } from "vitest";
import { MAX_NAME_LENGTH, assertSafePeerName, displayPeerName, isSafePeerName } from "./names.js";

describe("peer names", () => {
  test.each(["Ana", "Zo\u00EB", "Summary bot", "O'Brien-Lee", "李雷", "\u00C5sa 2", "Agent_7.1", "Claude (work)", "e\u0301".normalize("NFC")])(
    "accepts %s",
    (name) => expect(isSafePeerName(name)).toBe(true),
  );

  const hostile: Record<string, string> = {
    "right-to-left override": "Ana\u202Eevil",
    "left-to-right isolate": "\u2066Ana\u2069",
    "right-to-left mark": "Ana\u200F",
    "zero-width space": "A\u200Bna",
    "zero-width joiner": "A\u200Dna",
    "word joiner": "A\u2060na",
    "byte order mark": "\uFEFFAna",
    "soft hyphen": "A\u00ADna",
    "tag character": "Ana\u{E0041}",
    "variation selector": "Ana\uFE0F",
    "combining grapheme joiner": "A\u034Fna",
    "hangul filler": "\u3164",
    "hangul filler between letters": "A\u3164B",
    "braille blank": "\u2800",
    "no-break space": "A\u00A0na",
    "ideographic space": "A\u3000na",
    "line separator": "A\u2028na",
    "newline": "Ana\nBob",
    "tab": "A\tna",
    "nul": "A\u0000na",
    "control": "A\u001Bna",
    "emoji": "Ana 😀",
    "angle brackets": "<b>Ana</b>",
    "quote and slash": 'A"na/',
    "leading space": " Ana",
    "trailing space": "Ana ",
    "double space": "A  na",
    "only spaces": "   ",
    "only punctuation": "...",
    "empty": "",
    "zalgo": "A\u0300\u0301\u0302\u0303\u0304",
    "not NFC": "e\u0301".normalize("NFD") + "x",
    "lone surrogate": "A\uD800",
    "too long": "a".repeat(MAX_NAME_LENGTH + 1),
    "long run of marks": "a" + "\u0301".repeat(2000),
  };
  test.each(Object.entries(hostile))("rejects %s", (_label, name) => {
    expect(isSafePeerName(name)).toBe(false);
    expect(() => assertSafePeerName(name)).toThrow();
    expect(displayPeerName(name)).toBe("Unknown");
  });

  test.each([undefined, null, 5, {}, ["Ana"]])("rejects the non-string %j", (value) => {
    expect(isSafePeerName(value)).toBe(false);
  });

  test("accepts a name of exactly the cap, counting characters", () => {
    expect(isSafePeerName("a".repeat(MAX_NAME_LENGTH))).toBe(true);
    expect(isSafePeerName("李".repeat(MAX_NAME_LENGTH))).toBe(true);
  });
});
