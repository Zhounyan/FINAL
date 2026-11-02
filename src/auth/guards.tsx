import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';
import type { Capability } from '@/lib/permissions';
import { FullPageLoader } from '@/components/ui/Spinner';
import { ShieldAlert } from 'lucide-react';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  if (loading || (session && !profile)) return <FullPageLoader label="Loading your workspace…" />;
  if (!session || !profile) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (profile.must_change_password && location.pathname !== '/profile') {
    return <Navigate to="/profile?tab=password&required=1" replace />;
  }
  return <>{children}</>;
}

export function RequireCapability({ capability, children }: { capability: Capability; children: ReactNode }) {
  const { can } = useAuth();
  if (!can[capability]) return <AccessDenied />;
  return <>{children}</>;
}

export function AccessDenied() {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-2xl border border-line bg-surface p-8 text-center shadow-card">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-red-50 text-red-600">
        <ShieldAlert className="size-6" />
      </div>
      <h2 className="text-lg font-semibold text-ink">Access restricted</h2>
      <p className="mt-2 text-sm text-muted">
        Your role does not have permission to open this page. Contact the administrator if you need access.
      </p>
    </div>
  );
}
