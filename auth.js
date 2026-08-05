/**
 * auth.js — Google OAuth client layer (plain script, no module/build step).
 *
 * Load order on any auth-aware page:
 *   1. <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2" defer></script>
 *   2. <script src="/auth.js" defer></script>
 *   3. page script (defer) — calls CareAuth.initSupabase() first.
 *
 * Connection details are fetched from /api/config (server env), so the real
 * anon key never ships in a static file. Session is persisted in localStorage
 * by supabase-js and refreshed automatically.
 */
(function (global) {
  let supabaseClient = null;
  let configPromise = null;

  async function fetchConfig() {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Auth config unavailable.');
    return res.json();
  }

  /**
   * Initializes the Supabase client singleton.
   * @param {object} [options] - { detectSessionInUrl: bool } — set true ONLY on
   *   the OAuth callback page so the returned access_token hash is consumed.
   */
  async function initSupabase(options = {}) {
    if (supabaseClient) return supabaseClient;
    if (!global.supabase) throw new Error('Supabase SDK not loaded.');
    configPromise = configPromise || fetchConfig();
    const cfg = await configPromise;
    supabaseClient = global.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: Boolean(options.detectSessionInUrl),
      },
    });
    return supabaseClient;
  }

  /** Starts the Google OAuth redirect flow. */
  async function signInWithGoogle() {
    const sb = await initSupabase();
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: `${window.location.origin}/auth-callback`,
        queryParams: { access_type: 'online', prompt: 'select_account' },
      },
    });
    if (error) throw error;
  }

  /** @returns {Promise<object|null>} the active session or null. */
  async function getSession() {
    const sb = await initSupabase();
    const { data } = await sb.auth.getSession();
    return data.session || null;
  }

  /** @returns {Promise<object|null>} the caller's profiles row (RLS-scoped). */
  async function getProfile() {
    const session = await getSession();
    if (!session) return null;
    const sb = await initSupabase();
    const { data, error } = await sb
      .from('profiles')
      .select('role, full_name, avatar_url, email')
      .eq('id', session.user.id)
      .maybeSingle();
    return error ? null : data;
  }

  /** Routes the freshly-authenticated user by role. */
  async function routeAfterLogin() {
    const session = await getSession();
    if (!session) { window.location.href = '/login.html'; return; }
    const profile = await getProfile();
    if (!profile) { window.location.href = '/index.html'; return; }
    const target = profile.role === 'admin' ? '/admin.html' : '/account.html';
    window.location.href = target;
  }

  /**
   * Guards a page: redirects to /login.html when unauthenticated.
   * @param {string} [expectedRole] - optional role gate ('customer'|'nurse'|'admin').
   * @returns {Promise<object|null>} the session, or null (redirect issued).
   */
  async function requireAuth(expectedRole) {
    const session = await getSession();
    if (!session) { window.location.href = '/login.html'; return null; }
    if (expectedRole) {
      const profile = await getProfile();
      if (profile?.role !== expectedRole) { window.location.href = '/index.html'; return null; }
    }
    return session;
  }

  /** Signs out and returns to the landing page. */
  async function signOut() {
    const sb = await initSupabase();
    await sb.auth.signOut();
    window.location.href = '/index.html';
  }

  global.CareAuth = {
    initSupabase,
    getSession,
    getProfile,
    signInWithGoogle,
    signOut,
    routeAfterLogin,
    requireAuth,
  };
})(window);
