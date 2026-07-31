import { createClient } from '@supabase/supabase-js';

const supabase = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

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

async function routeAfterLogin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return window.location.href = '/index.html';

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

  window.location.href = profile.role === 'nurse' ? '/nurse-portal.html' : profile.role === 'admin' ? '/admin.html' : '/account.html';
}

async function requireAuth(expectedRole) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return window.location.href = '/index.html', null;
  if (expectedRole) {
    const { data: profile } = await supabase
      .from('profiles').select('role').eq('id', session.user.id).single();
    if (profile?.role !== expectedRole) return window.location.href = '/index.html', null;
  }
  return session;
}

export { supabase, signInWithGoogle, signOut, routeAfterLogin, requireAuth };