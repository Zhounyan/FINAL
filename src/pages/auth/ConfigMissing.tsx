import { AuthShell } from './AuthShell';

export function ConfigMissing() {
  return (
    <AuthShell title="Configuration required" subtitle="INVPORTIQ is not connected to its Supabase backend yet.">
      <div className="space-y-3 text-sm text-muted">
        <p className="font-medium text-ink">On a hosting service (Vercel, Netlify, Cloudflare Pages)</p>
        <p>
          In the project's settings, add these two environment variables for <b>Production</b>, then <b>redeploy</b> (the values are built into
          the site, so a new build is required):
        </p>
        <pre className="overflow-x-auto rounded-lg bg-brand-950 p-3 text-xs text-brand-50">
{`VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<public anon / publishable key>`}
        </pre>
        <p className="font-medium text-ink">On your own computer</p>
        <p>
          Put the same two lines in a <code className="rounded bg-brand-50 px-1 text-brand-900">.env.local</code> file (see <code>.env.example</code>)
          and restart the development server.
        </p>
      </div>
    </AuthShell>
  );
}
