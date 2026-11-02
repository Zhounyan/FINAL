/**
 * Makes free text safe to embed inside a PostgREST `or=(col.ilike.*term*)`
 * filter: removes filter-syntax characters and escapes LIKE wildcards so the
 * user cannot inject extra filter clauses.
 */
export function sanitizeSearch(input: string): string {
  return input
    .replace(/[(),"'\\:*]/g, ' ')
    .replace(/[%_]/g, (m) => `\\${m}`)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

export function ilikeOr(columns: string[], term: string): string | null {
  const safe = sanitizeSearch(term);
  if (!safe) return null;
  return columns.map((c) => `${c}.ilike.*${safe}*`).join(',');
}
