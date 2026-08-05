/**
 * login-google.js — wires the "Continue with Google" button on login.html.
 * Requires /auth.js (global CareAuth) + the Supabase UMD build to be loaded
 * first (both loaded with `defer`, in order).
 */
(function () {
  const btn = document.getElementById('google-btn');
  if (!btn || !window.CareAuth) return;

  const errorBox = document.getElementById('error-box');

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Redirecting to Google…';
    if (errorBox) errorBox.classList.remove('visible');

    try {
      await CareAuth.signInWithGoogle();
      // signInWithOAuth performs a full-page redirect; nothing after this runs.
    } catch (err) {
      console.error('[auth] Google sign-in failed:', err);
      if (errorBox) {
        errorBox.textContent = 'Could not start Google sign-in. Please try again.';
        errorBox.classList.add('visible');
      }
      btn.disabled = false;
      btn.textContent = 'Continue with Google';
    }
  });
})();
