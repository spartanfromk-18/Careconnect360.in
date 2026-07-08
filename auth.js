/**
 * auth.js — Google sign-in for CareConnect360.
 * One login flow for both customers and nurses. After sign-in, the user's
 * `profiles.role` decides which portal they land on. New sign-ins default
 * to 'customer' (set by the DB trigger) — a nurse becomes a nurse only when
 * an admin promotes their profile after reviewing their application
 * (see api/admin-assign-nurse.js, not yet built — flag this to your agent
 * next if you want that admin action wired up).
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  window.SUPABASE_URL,      // injected via a small inline script tag or build-time env
  window.SUPABASE_ANON_KEY  // publishable/anon key — safe for the browser
);

async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${window.location.origin}/auth-callback.html`
    }
  });
  if (error) console.error('[auth] Google sign-in failed:', error.message);
}

async function signOut() {
  await supabase.auth.signOut();
  window.location.href = '/index.html';
}

/**
 * Call this on auth-callback.html after Supabase redirects back post-login.
 * Looks up the user's role and sends them to the right portal.
 */
async function routeAfterLogin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = '/index.html';
    return;
  }

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', session.user.id)
    .single();

  if (error || !profile) {
    console.error('[auth] Could not resolve profile role:', error?.message);
    window.location.href = '/index.html';
    return;
  }

  if (profile.role === 'nurse') {
    window.location.href = '/nurse-portal.html';
  } else if (profile.role === 'admin') {
    window.location.href = '/admin.html';
  } else {
    window.location.href = '/account.html'; // customer portal
  }
}

/**
 * Call this on page load of account.html / nurse-portal.html to guard
 * against unauthenticated access — belt-and-suspenders alongside RLS,
 * since RLS blocks the data but this stops the page from even rendering
 * an empty shell to a logged-out visitor.
 */
async function requireAuth(expectedRole) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    window.location.href = '/index.html';
    return null;
  }
  if (expectedRole) {
    const { data: profile } = await supabase
      .from('profiles').select('role').eq('id', session.user.id).single();
    if (profile?.role !== expectedRole) {
      window.location.href = '/index.html';
      return null;
    }
  }
  return session;
}

export { supabase, signInWithGoogle, signOut, routeAfterLogin, requireAuth };