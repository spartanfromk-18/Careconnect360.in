/**
 * auth-callback.js — OAuth return target handler.
 * Consumes the access_token delivered in the URL hash (detectSessionInUrl),
 * then routes the user by profile role. Silently cleans the URL back to the
 * clean path so tokens never persist in the address bar.
 */
(async function () {
  try {
    await CareAuth.initSupabase({ detectSessionInUrl: true });

    if (window.history && window.history.replaceState) {
      window.history.replaceState({}, document.title, '/auth-callback.html');
    }

    const session = await CareAuth.getSession();
    if (!session) {
      window.location.href = '/login.html';
      return;
    }

    await CareAuth.routeAfterLogin();
  } catch (err) {
    console.error('[auth-callback] callback failed:', err);
    window.location.href = '/login.html';
  }
})();