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
const POSPage = lazy(() => import('./pages/POSPage'));
const ProductsPage = lazy(() => import('./pages/ProductsPage'));
const CategoriesPage = lazy(() => import('./pages/ProductsPage').then((m) => ({ default: m.CategoriesPage })));
const StockInPage = lazy(() => import('./pages/StockOpsPage').then((m) => ({ default: m.StockInPage })));
const StockOutPage = lazy(() => import('./pages/StockOpsPage').then((m) => ({ default: m.StockOutPage })));
const StockMovementHistoryPage = lazy(() => import('./pages/StockMovementHistoryPage'));
const StockReportPage = lazy(() => import('./pages/StockReportPage'));
const SalesReportPage = lazy(() => import('./pages/SalesReportPage'));
const SalesListPage = lazy(() => import('./pages/SalesListPage'));
const CustomersPage = lazy(() => import('./pages/CustomersPage'));
const SuppliersPage = lazy(() => import('./pages/SuppliersPage'));
const UsersPage = lazy(() => import('./pages/UsersPage'));
const ActivityLogsPage = lazy(() => import('./pages/ActivityLogsPage'));
const BackupsPage = lazy(() => import('./pages/BackupsPage'));
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
          <Route path="pos" element={<Guard capability="usePos"><POSPage /></Guard>} />
          <Route path="products" element={<Guard capability="viewProducts"><ProductsPage /></Guard>} />
          <Route path="categories" element={<Guard capability="manageCategories"><CategoriesPage /></Guard>} />
          <Route path="inventory" element={<Navigate to="/products" replace />} />
          <Route path="stock" element={<Navigate to="/stock/in" replace />} />
          <Route path="stock/in" element={<Guard capability="recordStockIn"><StockInPage /></Guard>} />
          <Route path="stock/out" element={<Guard capability="recordStockOut"><StockOutPage /></Guard>} />
          <Route path="stock/history" element={<Guard capability="viewMovementHistory"><StockMovementHistoryPage /></Guard>} />
          <Route path="stock/reports/daily" element={<Guard capability="viewStockReports"><StockReportPage period="daily" /></Guard>} />
          <Route path="stock/reports/weekly" element={<Guard capability="viewStockReports"><StockReportPage period="weekly" /></Guard>} />
          <Route path="stock/reports/monthly" element={<Guard capability="viewStockReports"><StockReportPage period="monthly" /></Guard>} />
          <Route path="sales" element={<Guard capability="viewAllTransactions"><SalesListPage /></Guard>} />
          <Route path="my-sales" element={<Guard capability="viewTransactions"><SalesListPage /></Guard>} />
          {/* earlier addresses of the (now merged) transaction and invoice pages */}
          <Route path="invoices" element={<Navigate to="/sales" replace />} />
          <Route path="my-transactions" element={<Navigate to="/my-sales" replace />} />
          <Route path="my-invoices" element={<Navigate to="/my-sales" replace />} />
          <Route path="sales-reports" element={<Navigate to="/sales-reports/daily" replace />} />
          <Route path="sales-reports/daily" element={<Guard capability="viewSalesReports"><SalesReportPage period="daily" /></Guard>} />
          <Route path="sales-reports/weekly" element={<Guard capability="viewSalesReports"><SalesReportPage period="weekly" /></Guard>} />
          <Route path="sales-reports/monthly" element={<Guard capability="viewSalesReports"><SalesReportPage period="monthly" /></Guard>} />
          <Route path="customers" element={<Guard capability="viewCustomers"><CustomersPage /></Guard>} />
          <Route path="suppliers" element={<Guard capability="viewSuppliers"><SuppliersPage /></Guard>} />
          <Route path="users" element={<Guard capability="manageUsers"><UsersPage /></Guard>} />
          <Route path="activity" element={<Guard capability="viewActivity"><ActivityLogsPage /></Guard>} />
          <Route path="backups" element={<Guard capability="manageBackups"><BackupsPage /></Guard>} />
          <Route path="settings" element={<Guard capability="manageSettings"><SettingsPage /></Guard>} />
          <Route path="profile" element={<Guard capability="viewDashboard"><ProfilePage /></Guard>} />
          <Route path="*" element={<Suspense fallback={null}><NotFoundPage /></Suspense>} />
        </Route>
      </Routes>
    </Suspense>
  );
}
