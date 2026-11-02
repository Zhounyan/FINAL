import { AuthShell } from './AuthShell';

export function ConfigMissing() {
  return (
    <AuthShell title="Configuration required" subtitle="INVPORTIQ is not connected to its Supabase backend yet.">
      <div className="space-y-3 text-sm text-muted">
        <p>
          Create a <code className="rounded bg-brand-50 px-1 text-brand-900">.env.local</code> file (see <code>.env.example</code>) with:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-brand-950 p-3 text-xs text-brand-50">
{`VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<public anon key>`}
        </pre>
        <p>Then restart the development server or rebuild the app.</p>
      </div>
    </AuthShell>
  );
}
