export function normalizeQueryRewriteQueries(value: unknown, maxQueries: number): string[] {
  const items = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const item of items) {
    if (typeof item !== "string") continue;
    const query = singleLine(item).slice(0, 500);
    if (!query) continue;
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
    if (queries.length >= maxQueries) break;
  }
  return queries;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
