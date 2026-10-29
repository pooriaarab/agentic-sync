import { describe, expect, it } from "vitest";
import type { RoomStorage } from "./storage.js";

export interface ContractOptions {
  // A storage for the document. Two calls with the same `shared` name and the
  // same `docId` must read the same data, as two instances do on one backend.
  make(options: { shared: string; docId: string }): RoomStorage;
}

const bytes = (...values: number[]) => new Uint8Array(values);

// The suite every RoomStorage adapter must pass.
export function runStorageContract(name: string, { make }: ContractOptions): void {
  const fresh = (docId = "doc") => make({ shared: crypto.randomUUID(), docId });

  describe(`RoomStorage contract: ${name}`, () => {
    it("reads nothing for a missing key", async () => {
      expect(await fresh().get("base")).toBeUndefined();
      expect(await fresh().list("u:")).toEqual(new Map());
    });

    it("round-trips JSON and bytes, also nested", async () => {
      const storage = fresh();
      const record = { update: bytes(0, 1, 255), author: { id: "a", kind: "agent" }, at: 5, list: [1, "x", null, true] };
      await storage.put("u:0000000001", record);
      expect(await storage.get("u:0000000001")).toEqual(record);
      await storage.put("d:raw", bytes(9, 8, 7));
      expect(await storage.get("d:raw")).toEqual(bytes(9, 8, 7));
    });

    it("refuses an empty key and a key with a lone surrogate", async () => {
      const storage = fresh();
      await expect(storage.put("", 1)).rejects.toThrow();
      await expect(storage.get("")).rejects.toThrow();
      await expect(storage.put("s:\ud800", 1)).rejects.toThrow();
      await expect(storage.get("s:\udbff")).rejects.toThrow();
    });

    it("refuses a value that JSON would change", async () => {
      const storage = fresh();
      for (const value of [new Map(), new Date(0), { a: () => 1 }, { a: undefined }, undefined, 1n, { a: NaN }, Infinity, -0]) {
        await expect(storage.put("x", value)).rejects.toThrow();
      }
      expect(await storage.get("x")).toBeUndefined();
    });

    it("overwrites a key", async () => {
      const storage = fresh();
      await storage.put("cap:p1", "viewer");
      await storage.put("cap:p1", "revoked");
      expect(await storage.get("cap:p1")).toBe("revoked");
    });

    it("lists by exact prefix, in key order", async () => {
      const storage = fresh();
      await storage.putAll({ "u:0000000002": 2, "u:0000000001": 1, "ud": 9, "s:one": 3, "cap:p": "x", "u;": 0 });
      expect([...(await storage.list("u:")).entries()]).toEqual([["u:0000000001", 1], ["u:0000000002", 2]]);
      expect((await storage.list("")).size).toBe(6);
    });

    it("lists more entries than one page", async () => {
      const storage = fresh();
      const entries = Object.entries(Object.fromEntries(Array.from({ length: 700 }, (_, i) => [`u:${String(i).padStart(10, "0")}`, i])));
      for (let i = 0; i < 700; i += 100) await storage.putAll(Object.fromEntries(entries.slice(i, i + 100)));
      expect([...(await storage.list("u:")).values()]).toEqual(Array.from({ length: 700 }, (_, i) => i));
    });

    it("lists in UTF-8 byte order", async () => {
      const storage = fresh();
      await storage.putAll({ "k:\u{1F600}": 1, "k:\uFF01": 2, "k:\uE000": 3, "k:z": 4 });
      expect([...(await storage.list("k:")).keys()]).toEqual(["k:z", "k:\uE000", "k:\uFF01", "k:\u{1F600}"]);
    });

    it("keeps the case and the odd characters of a key", async () => {
      const storage = fresh();
      const keys = ["d:Draft", "d:draft", "d:a/b", "d:../x", "d:é 日本 😀", "d:__name__"];
      for (const key of keys) await storage.put(key, key);
      for (const key of keys) expect(await storage.get(key)).toBe(key);
      expect((await storage.list("d:")).size).toBe(6);
      expect([...(await storage.list("d:é")).keys()]).toEqual(["d:é 日本 😀"]);
    });

    it("keeps documents apart, also when ids differ by case", async () => {
      const shared = crypto.randomUUID();
      const a = make({ shared, docId: "Doc" });
      const b = make({ shared, docId: "doc" });
      await a.put("base", 1);
      expect(await b.get("base")).toBeUndefined();
      await b.put("base", 2);
      expect(await a.get("base")).toBe(1);
      await a.deleteAll();
      expect(await b.get("base")).toBe(2);
    });

    it("shares data between two instances on the same backend", async () => {
      const shared = crypto.randomUUID();
      await make({ shared, docId: "doc" }).put("docid", "doc");
      expect(await make({ shared, docId: "doc" }).get("docid")).toBe("doc");
    });

    it("writes putAll as one unit, and refuses a bad value without a partial write", async () => {
      const storage = fresh();
      await storage.putAll({ base: 1, attr: 2 });
      expect(await storage.get("base")).toBe(1);
      await expect(storage.putAll({ base: 5, bad: () => 1 })).rejects.toThrow();
      expect(await storage.get("base")).toBe(1);
    });

    it("deletes keys, counts those that existed, and ignores the rest", async () => {
      const storage = fresh();
      await storage.putAll({ "u:1": 1, "u:2": 2, "u:3": 3 });
      expect(await storage.delete(["u:1", "u:2", "u:9", "u:2"])).toBe(2);
      expect([...(await storage.list("u:")).keys()]).toEqual(["u:3"]);
      expect(await storage.delete([])).toBe(0);
    });

    it("deletes more keys than one commit takes", async () => {
      const storage = fresh();
      const keys = Array.from({ length: 1100 }, (_, i) => `u:${i}`);
      for (let i = 0; i < keys.length; i += 500) await storage.putAll(Object.fromEntries(keys.slice(i, i + 500).map((k) => [k, 1])));
      expect(await storage.delete(keys)).toBe(1100);
      expect((await storage.list("")).size).toBe(0);
    });

    it("erases every entry, then starts empty and takes new writes", async () => {
      const storage = fresh();
      await storage.putAll({ base: 1, "u:1": 1, "s:x": 1, "cap:p": "revoked" });
      await storage.deleteAll();
      expect((await storage.list("")).size).toBe(0);
      expect(await storage.get("cap:p")).toBeUndefined();
      await storage.put("base", 2);
      expect(await storage.get("base")).toBe(2);
    });
  });
}
