// A fake of the Firestore REST surface the adapter calls: batchGet, commit, and runQuery.
// It follows Firestore: the URL shapes, UTF-8 byte order for strings, a commit that applies
// all writes or none, a 500-write limit, a 1 MiB limit on string values (not field names or
// the document name), a 1500-byte id limit, the startAt cursor, and a missing document
// named in batchGet. It does not model the 10 MiB request cap.
type Fields = Record<string, { stringValue?: string }>;

const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const failure = (status: number, code: string) => json(status, { error: { code: status, status: code } });

export function createFakeFirestore() {
  const docs = new Map<string, Fields>();
  const requests: { url: string; authorization: string | null; operation?: string; startAtBefore?: boolean }[] = [];

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url: url.href, authorization: new Headers(init?.headers).get("authorization") });
    const path = decodeURIComponent(url.pathname);
    const match = /^\/v1\/(projects\/[^/]+\/databases\/[^/]+)\/documents(.*)$/.exec(path);
    if (!match || (init?.method ?? "GET") !== "POST") return failure(404, "NOT_FOUND");
    const base = `${match[1]}/documents`;
    // Only "documents:commit", "documents:batchGet", and "<parent>:runQuery" exist. "documents/:commit" does not.
    const documents = match[2]!.startsWith(":") ? match[2]! : match[2]!.slice(1);
    if (!/^(:commit|:batchGet|[^:]+:runQuery)$/.test(documents)) return failure(400, "INVALID_ARGUMENT");
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    requests.at(-1)!.operation = documents.slice(documents.lastIndexOf(":"));

    if (documents === ":commit") {
      const writes = body.writes as { update?: { name: string; fields: Fields }; delete?: string }[];
      if (writes.length > 500) return failure(400, "INVALID_ARGUMENT");
      for (const write of writes) {
        const name = write.update?.name ?? write.delete ?? "";
        if (Buffer.byteLength(name.slice(name.lastIndexOf("/") + 1)) > 1500) return failure(400, "INVALID_ARGUMENT");
        const size = Object.values(write.update?.fields ?? {}).reduce((sum, v) => sum + Buffer.byteLength(v.stringValue ?? ""), 0);
        if (size > 1_048_576) return failure(400, "INVALID_ARGUMENT");
      }
      for (const write of writes) {
        if (write.update) docs.set(write.update.name, write.update.fields);
        else if (write.delete) docs.delete(write.delete);
      }
      return json(200, { writeResults: writes.map(() => ({})) });
    }
    if (documents === ":batchGet") {
      return json(
        200,
        (body.documents as string[]).map((name) => {
          const id = name.slice(name.lastIndexOf("/") + 1);
          if (id === "" || Buffer.byteLength(id) > 1500) return { missing: name };
          return docs.has(name) ? { found: { name, fields: docs.get(name) } } : { missing: name };
        }),
      );
    }
    if (documents.endsWith(":runQuery")) {
      const parent = `${base}/${documents.slice(0, -":runQuery".length)}`;
      const q = body.structuredQuery;
      if (q.startAt) requests.at(-1)!.startAtBefore = q.startAt.before;
      const collection = q.from[0].collectionId as string;
      const filters: { fieldFilter: { op: string; value: { stringValue: string } } }[] = !q.where
        ? []
        : q.where.compositeFilter
          ? q.where.compositeFilter.filters
          : [q.where];
      let rows = [...docs.entries()]
        .filter(([name]) => name.startsWith(`${parent}/${collection}/`) && !name.slice(parent.length + collection.length + 2).includes("/"))
        .map(([name, fields]) => ({ name, fields }));
      for (const { fieldFilter } of filters) {
        if ((fieldFilter as { field?: { fieldPath?: string } }).field?.fieldPath !== "key") return failure(400, "INVALID_ARGUMENT");
        const v = fieldFilter.value.stringValue;
        rows = rows.filter((r) => {
          const c = compare(r.fields.key?.stringValue ?? "", v);
          return fieldFilter.op === "GREATER_THAN_OR_EQUAL" ? c >= 0 : fieldFilter.op === "LESS_THAN" ? c < 0 : false;
        });
      }
      const order = q.orderBy as { field: { fieldPath: string }; direction: string }[] | undefined;
      if (order && (order.length !== 1 || order[0]!.field.fieldPath !== "key" || order[0]!.direction !== "ASCENDING")) return failure(400, "INVALID_ARGUMENT");
      const sortKey = (r: { name: string; fields: Fields }) => (order ? r.fields.key!.stringValue! : r.name);
      rows.sort((a, b) => compare(sortKey(a), sortKey(b)));
      if (q.startAt) {
        const v = q.startAt.values[0].stringValue as string;
        rows = rows.filter((r) => (q.startAt.before ? compare(sortKey(r), v) >= 0 : compare(sortKey(r), v) > 0));
      }
      rows = rows.slice(0, q.limit);
      return json(200, rows.length === 0 ? [{ readTime: "now" }] : rows.map((r) => ({ document: r })));
    }
    return failure(400, "INVALID_ARGUMENT");
  }) as typeof globalThis.fetch;

  return { fetch, docs, requests };
}
