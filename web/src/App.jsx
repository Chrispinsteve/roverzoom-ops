import { useState, useCallback, useEffect } from 'react';
import { AuthProvider, useAuth } from './lib/auth';
import { api } from './lib/api';
import { useApi } from './lib/useApi';
import { Shell, NAV } from './components/Shell';
import { Loading } from './components/ui';
import { SignIn } from './screens/SignIn';
import { Overview } from './screens/Overview';
import { Dispatch } from './screens/Dispatch';
import { Rides } from './screens/Rides';
import { RideDetail } from './screens/RideDetail';
import { Drivers } from './screens/Drivers';
import { DriverDetail } from './screens/DriverDetail';
import { Finance } from './screens/Finance';
import { Audit } from './screens/Audit';

export default function App() {
  return (
    <AuthProvider>
      <Gate />
    </AuthProvider>
  );
}

function Gate() {
  const { session, admin, loadingProfile } = useAuth();

  // `undefined` means we have not finished asking Supabase whether a session
  // exists. Rendering the sign-in form during that moment would flash the
  // login screen at an operator who is already signed in.
  if (session === undefined || (session && loadingProfile && !admin)) {
    return <div style={{ padding: 40, maxWidth: 480, margin: '0 auto' }}><Loading rows={3} height={56} /></div>;
  }
  if (!session || !admin) return <SignIn />;
  return <Console />;
}

function Console() {
  const { can } = useAuth();
  const [route, setRoute] = useState(() => firstAllowedRoute(can));
  const [filters, setFilters] = useState({});
  const [openRide, setOpenRide] = useState(null);
  const [openDriver, setOpenDriver] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  // A quiet background poll purely to keep the nav badge honest, so an
  // operator sitting on the Finance screen still sees a critical dispatch
  // problem appear in the sidebar.
  const pulse = useApi(() => api.overview(), { poll: 30_000, enabled: can('overview.read') });
  const criticalCount = pulse.data?.attention?.counts?.critical ?? 0;

  const navigate = useCallback((next, nextFilters = {}) => {
    setRoute(next);
    setFilters(nextFilters);
  }, []);

  // Escape closes whichever detail sheet is open, always.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (openRide) setOpenRide(null);
      else if (openDriver) setOpenDriver(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openRide, openDriver]);

  const afterChange = useCallback(() => {
    setReloadKey((k) => k + 1);
    pulse.refresh();
  }, [pulse]);

  const badges = {
    dispatch: route === 'dispatch' ? 0 : criticalCount,
  };

  return (
    <Shell route={route} onNavigate={navigate} badges={badges}>
      {route === 'overview' && (
        <Overview key={reloadKey} onOpenRide={setOpenRide} onNavigate={navigate} />
      )}
      {route === 'dispatch' && <Dispatch key={reloadKey} onOpenRide={setOpenRide} />}
      {/* The filter is part of the key: navigating here WITH a filter (from an
          Overview metric, say) remounts the screen so its initial state is
          already right, rather than being corrected in an effect afterwards. */}
      {route === 'rides' && (
        <Rides key={`${reloadKey}:${filters.group || ''}`} initialFilters={filters} onOpenRide={setOpenRide} />
      )}
      {route === 'drivers' && (
        <Drivers key={`${reloadKey}:${filters.standing || ''}`} initialFilters={filters} onOpenDriver={setOpenDriver} />
      )}
      {route === 'finance' && <Finance key={reloadKey} />}
      {route === 'audit' && <Audit key={reloadKey} />}

      {openRide && (
        <RideDetail rideId={openRide} onClose={() => setOpenRide(null)} onChanged={afterChange} />
      )}
      {openDriver && (
        <DriverDetail driverId={openDriver} onClose={() => setOpenDriver(null)} onChanged={afterChange} />
      )}
    </Shell>
  );
}

// A finance analyst has no Overview permission, so the console must open on
// whatever their role CAN see rather than a screen that immediately 403s.
function firstAllowedRoute(can) {
  const match = NAV.find((item) => can(item.permission));
  return match ? match.id : 'overview';
}
