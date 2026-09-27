import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.44.0';
import { CONFIG } from './config.js';

export const supabase = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);

/** Where auth emails / Google OAuth should land after completion. */
export function authRedirectUrl() {
  // Same directory as the current page, landing on index.html.
  // Works for http://localhost:8000/auth.html and https://www.gruffy.in/auth.html
  // without hardcoding a path.
  try {
    const url = new URL('./index.html', window.location.href);
    return url.toString();
  } catch {
    return `${CONFIG.appUrl}/index.html`;
  }
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

export function onSessionChange(cb) {
  return supabase.auth.onAuthStateChange((_event, session) => cb(session ?? null));
}

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: authRedirectUrl() },
  });
  if (error) throw error;
}

export async function sendMagicLink(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: authRedirectUrl() },
  });
  if (error) throw error;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
  // Drop per-user cached exploration so the next login on this browser can't
  // inherit it (device-level prefs like region/gate choice are kept).
  try {
    const drop = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('tortle.v0.hex-progress')) drop.push(k);
    }
    drop.forEach((k) => localStorage.removeItem(k));
  } catch {}
}

/** Call at the top of protected pages. Redirects to auth.html when signed out. */
export async function requireSessionOrRedirect() {
  const session = await getSession();
  if (session) return session;
  const url = new URL('./auth.html', window.location.href);
  // Preserve where they were trying to go.
  url.searchParams.set('next', window.location.pathname);
  window.location.replace(url.toString());
  // Never resolves after redirect; throw to halt callers that awaited us.
  throw new Error('redirecting to auth');
}
