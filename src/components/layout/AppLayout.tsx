import { useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { clsx } from 'clsx';
import {
  ArrowLeftRight,
  BarChart3,
  Boxes,
  CalendarDays,
  ChevronDown,
  FileBarChart,
  History,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Settings,
  ShieldCheck,
  Truck,
  UserCircle,
  Users,
  X,
} from 'lucide-react';
import { useAuth } from '@/auth/AuthProvider';
import { ROLE_LABELS, type Capability } from '@/lib/permissions';
import { useRealtimeInvalidation, useSettings } from '@/hooks/data';
import logo from '@/assets/logo.png';
import { ConfirmDialog } from '../ui/Modal';
import { NotificationBell } from './NotificationBell';
import { Avatar } from '../ui/Avatar';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  capability: Capability;
  children?: Omit<NavItem, 'children'>[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, capability: 'viewDashboard' },
  { to: '/products', label: 'Products', icon: Package, capability: 'viewProducts' },
  { to: '/stock', label: 'Stock Management', icon: Boxes, capability: 'viewStockManagement' },
  {
    to: '/movements',
    label: 'Stock Movements',
    icon: ArrowLeftRight,
    capability: 'viewDailyMovements',
    children: [
      { to: '/movements/daily', label: 'Daily Stock Movements', icon: CalendarDays, capability: 'viewDailyMovements' },
      { to: '/movements/history', label: 'Stock Movement History', icon: History, capability: 'viewMovementHistory' },
    ],
  },
  { to: '/customers', label: 'Customers', icon: Users, capability: 'viewCustomers' },
  { to: '/suppliers', label: 'Suppliers', icon: Truck, capability: 'viewSuppliers' },
  { to: '/reports', label: 'Reports', icon: FileBarChart, capability: 'viewReports' },
  { to: '/users', label: 'User Management', icon: ShieldCheck, capability: 'manageUsers' },
  { to: '/settings', label: 'Settings', icon: Settings, capability: 'viewDashboard' },
  { to: '/profile', label: 'Profile', icon: UserCircle, capability: 'viewDashboard' },
];

function Sidebar({ onNavigate, onLogout }: { onNavigate?: () => void; onLogout: () => void }) {
  const { can } = useAuth();
  const { data: settings } = useSettings();
  const location = useLocation();
  const [openGroup, setOpenGroup] = useState(location.pathname.startsWith('/movements'));

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    clsx(
      'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
      isActive ? 'bg-white/12 text-white shadow-inner shadow-black/10' : 'text-brand-100/80 hover:bg-white/6 hover:text-white',
    );

  return (
    <div className="flex h-full flex-col bg-gradient-to-b from-brand-900 via-brand-900 to-brand-950 text-white">
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <img src={logo} alt="Bill Store logo" className="size-12 rounded-full bg-white p-0.5 shadow-md ring-2 ring-white/20" />
        <div className="min-w-0">
          <p className="text-lg leading-tight font-extrabold tracking-wide">INVPORTIQ</p>
          <p className="truncate text-xs text-brand-200/80">{settings?.store_name ?? 'Bill Store'}</p>
        </div>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2" aria-label="Main navigation">
        {NAV.filter((n) => can[n.capability]).map((item) =>
          item.children ? (
            <div key={item.to}>
              <button
                type="button"
                onClick={() => setOpenGroup((o) => !o)}
                aria-expanded={openGroup}
                className={clsx(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                  location.pathname.startsWith(item.to) ? 'text-white' : 'text-brand-100/80 hover:bg-white/6 hover:text-white',
                )}
              >
                <item.icon className="size-[18px] shrink-0" />
                <span className="flex-1 text-left">{item.label}</span>
                <ChevronDown className={clsx('size-4 transition-transform', openGroup && 'rotate-180')} />
              </button>
              {openGroup && (
                <div className="mt-1 ml-5 space-y-1 border-l border-white/10 pl-3">
                  {item.children
                    .filter((c) => can[c.capability])
                    .map((c) => (
                      <NavLink key={c.to} to={c.to} className={linkClass} onClick={onNavigate}>
                        <c.icon className="size-4 shrink-0" />
                        {c.label}
                      </NavLink>
                    ))}
                </div>
              )}
            </div>
          ) : (
            <NavLink key={item.to} to={item.to} end={item.to === '/'} className={linkClass} onClick={onNavigate}>
              <item.icon className="size-[18px] shrink-0" />
              {item.label}
            </NavLink>
          ),
        )}
        <button type="button" onClick={onLogout} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-brand-100/80 transition-colors hover:bg-red-500/15 hover:text-white">
          <LogOut className="size-[18px]" />
          Logout
        </button>
      </nav>
      <div className="m-3 rounded-xl bg-white/6 p-3 text-xs text-brand-100/70">
        <div className="flex items-center gap-2 font-medium text-brand-50">
          <BarChart3 className="size-4" /> Business Intelligence
        </div>
        <p className="mt-1">Single-branch inventory for {settings?.store_name ?? 'Bill Store'}.</p>
      </div>
    </div>
  );
}

export function AppLayout() {
  const { profile, signOut } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const navigate = useNavigate();
  useRealtimeInvalidation();
  useSettings();

  const doLogout = async () => {
    setLoggingOut(true);
    await signOut();
    setLoggingOut(false);
    setConfirmLogout(false);
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen lg:pl-72">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 lg:block">
        <Sidebar onLogout={() => setConfirmLogout(true)} />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-black/40" onClick={() => setMobileOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] animate-slide-in shadow-2xl">
            <button type="button" className="absolute top-4 right-3 z-10 rounded-lg p-2 text-white/80 hover:bg-white/10" onClick={() => setMobileOpen(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
            <Sidebar onNavigate={() => setMobileOpen(false)} onLogout={() => setConfirmLogout(true)} />
          </aside>
        </div>
      )}

      <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur sm:px-6">
        <button type="button" className="rounded-lg p-2 text-ink hover:bg-brand-50 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open menu">
          <Menu className="size-5" />
        </button>
        <img src={logo} alt="" className="size-8 rounded-full lg:hidden" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-ink lg:text-base">Welcome back, {profile?.full_name.split(' ')[0]}</p>
          <p className="hidden truncate text-xs text-muted sm:block">
            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
          </p>
        </div>
        <NotificationBell />
        <button type="button" onClick={() => navigate('/profile')} className="flex items-center gap-2.5 rounded-xl py-1.5 pr-2 pl-1.5 transition hover:bg-brand-50">
          <Avatar name={profile?.full_name} src={profile?.avatar_url} />
          <span className="hidden text-left sm:block">
            <span className="block max-w-36 truncate text-sm font-semibold text-ink">{profile?.full_name}</span>
            <span className="block text-xs text-muted">{profile ? ROLE_LABELS[profile.role] : ''}</span>
          </span>
        </button>
      </header>

      {/* Extra bottom space so floating badges (e.g. "Powered by Netlify") never hide the last buttons. */}
      <main className="mx-auto w-full max-w-[1500px] px-4 pt-6 pb-24 sm:px-6 lg:px-8">
        <Outlet />
      </main>

      <ConfirmDialog
        open={confirmLogout}
        title="Sign out?"
        message="You will need to sign in again to access INVPORTIQ."
        confirmLabel="Sign out"
        tone="primary"
        loading={loggingOut}
        onConfirm={doLogout}
        onCancel={() => setConfirmLogout(false)}
      />
    </div>
  );
}
