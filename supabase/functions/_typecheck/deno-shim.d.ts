// Type-checking shim so `tsc` can verify the Edge Functions in CI without Deno.
// At runtime Supabase Edge (Deno) provides these globals natively.
declare namespace Deno {
  const env: { get(name: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}
