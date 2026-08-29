import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { supabase } from './supabase';
import { api, ApiError } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = still checking
  // The profile is stored together with the token it was fetched for, and
  // `admin` is DERIVED from that pairing rather than cleared by hand. A
  // profile therefore can never outlive the session it belongs to — switching
  // accounts cannot briefly show the previous operator's role and permissions.
  const [profile, setProfile] = useState(null); // { token, admin, denial }
  const [loadingProfile, setLoadingProfile] = useState(false);

  const token = session?.access_token ?? null;
  const admin = profile && profile.token === token ? profile.admin : null;
  const denial = profile && profile.token === token ? profile.denial : null;

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  // A valid Supabase session is NOT the same as console access. The API is the
  // authority on whether this account has an admin role, so we always ask it.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    // Same shape as useApi: resolving "is this account an admin?" is a fetch
    // that has to raise a loading flag from inside an effect. It settles once
    // per token and cannot cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoadingProfile(true);
    api.me()
      .then((res) => { if (!cancelled) setProfile({ token, admin: res.admin, denial: null }); })
      .catch((err) => {
        if (cancelled) return;
        const info = err instanceof ApiError
          ? { message: err.message, code: err.code }
          : { message: String(err) };
        setProfile({ token, admin: null, denial: info });
      })
      .finally(() => { if (!cancelled) setLoadingProfile(false); });
    return () => { cancelled = true; };
  }, [token]);

  const signIn = useCallback(async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setProfile(null);
  }, []);

  // Permission checks drive which controls render. This is an affordance only
  // — the API enforces every permission independently, so a hidden button is
  // never the thing keeping anyone out.
  const can = useCallback(
    (permission) => Boolean(admin && admin.permissions.includes(permission)),
    [admin]
  );

  return (
    <AuthContext.Provider value={{ session, admin, denial, loadingProfile, signIn, signOut, can }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
};
