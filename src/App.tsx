import { lazy, Suspense, useEffect, useRef, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth/AuthProvider';
import { authLinkHint } from './lib/supabase';
import { AppLayout } from './components/layout/AppLayout';
import { RequireAuth, RequireCapability } from './auth/guards';
import { FullPageLoader, LoadingBlock } from './components/ui/Spinner';
import { isSupabaseConfigured } from './lib/supabase';
import type { Capability } from './lib/permissions';
import { ConfigMissing } from './pages/auth/ConfigMissing';

const LoginPage = lazy(() => import('./pages/auth/LoginPage'));
const SetupPage = lazy(() => import('./pages/auth/SetupPage'));
const ForgotPasswordPage = lazy(() => import('./pages/auth/ForgotPasswordPage'));
const ResetPasswordPage = lazy(() => import('./pages/auth/ResetPasswordPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ProductsPage = lazy(() => import('./pages/ProductsPage'));
const StockPage = lazy(() => import('./pages/StockPage'));
const DailyMovementsPage = lazy(() => import('./pages/DailyMovementsPage'));
const MovementHistoryPage = lazy(() => import('./pages/MovementHistoryPage'));
const CustomersPage = lazy(() => import('./pages/CustomersPage'));
const SuppliersPage = lazy(() => import('./pages/SuppliersPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const ProfilePage = lazy(() => import('./pages/ProfilePage'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage'));

function Guard({ capability, children }: { capability: Capability; children: ReactNode }) {
  return (
    <RequireCapability capability={capability}>
      <Suspense fallback={<LoadingBlock rows={8} />}>{children}</Suspense>
    </RequireCapability>
  );
}

/** An emailed reset link may land on any page: always continue on the reset screen. */
function RecoveryRedirect() {
  const { recovery } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const shownLinkError = useRef(false);
  useEffect(() => {
    if (location.pathname === '/reset-password') return;
    if (recovery) navigate('/reset-password', { replace: true });
    else if (authLinkHint.error && !shownLinkError.current) {
      shownLinkError.current = true; // show an expired/invalid link once, then let the user move on
      navigate('/reset-password', { replace: true });
    }
  }, [recovery, location.pathname, navigate]);
  return null;
}

export default function App() {
  if (!isSupabaseConfigured) return <ConfigMissing />;
  return (
    <Suspense fallback={<FullPageLoader />}>
      <RecoveryRedirect />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route
          element={
            <RequireAuth>
              <AppLayout />
            </RequireAuth>
          }
        >
          <Route index element={<Guard capability="viewDashboard"><DashboardPage /></Guard>} />
          <Route path="products" element={<Guard capability="viewProducts"><ProductsPage /></Guard>} />
          <Route path="stock" element={<Guard capability="viewStockManagement"><StockPage /></Guard>} />
          <Route path="movements" element={<Navigate to="/movements/daily" replace />} />
          <Route path="movements/daily" element={<Guard capability="viewDailyMovements"><DailyMovementsPage /></Guard>} />
          <Route path="movements/history" element={<Guard capability="viewMovementHistory"><MovementHistoryPage /></Guard>} />
          <Route path="customers" element={<Guard capability="viewCustomers"><CustomersPage /></Guard>} />
          <Route path="suppliers" element={<Guard capability="viewSuppliers"><SuppliersPage /></Guard>} />
          <Route path="reports" element={<Guard capability="viewReports"><ReportsPage /></Guard>} />
          <Route path="users" element={<Guard capability="manageUsers"><UsersPage /></Guard>} />
          <Route path="settings" element={<Guard capability="viewDashboard"><SettingsPage /></Guard>} />
          <Route path="profile" element={<Guard capability="viewDashboard"><ProfilePage /></Guard>} />
          <Route path="*" element={<Suspense fallback={null}><NotFoundPage /></Suspense>} />
        </Route>
      </Routes>
    </Suspense>
  );
}
