/**
 * account.js — patient/nurse dashboard. Requires CareAuth (auth.js).
 * Renders the profile via the RLS-scoped profiles query and the caller's
 * bookings via GET /api/bookings (server verifies the Bearer session).
 */
(function () {
  const $ = (id) => document.getElementById(id);

  const showError = (message) => {
    const box = $('error-box');
    box.textContent = message;
    box.classList.add('visible');
  };

  const badgeFor = (status) => {
    const s = status || '';
    return `<span class="badge ${s}">${s.replace(/_/g, ' ')}</span>`;
  };

  const renderBookings = (bookings) => {
    const wrap = $('bookings-wrap');
    if (!Array.isArray(bookings) || bookings.length === 0) {
      wrap.innerHTML = '<p class="empty">No bookings yet. Book a care visit to get started.</p>';
      return;
    }
    const rows = bookings.map((b) => `
      <tr>
        <td>${b.service || b.care_type || '—'}</td>
        <td>${b.location || '—'}</td>
        <td>${b.scheduled_date || 'ASAP'} ${b.scheduled_time ? '@ ' + b.scheduled_time : ''}</td>
        <td>${badgeFor(b.status)}</td>
        <td>${b.invoice?.invoice_number || '—'}</td>
        <td>${b.nurse ? b.nurse.first_name + ' ' + (b.nurse.last_name || '') : '—'}</td>
      </tr>`).join('');
    wrap.innerHTML = `
      <table>
        <thead><tr><th>Service</th><th>Location</th><th>Scheduled</th><th>Status</th><th>Invoice</th><th>Nurse</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  };

  async function boot() {
    const session = await CareAuth.requireAuth();
    if (!session) return; // requireAuth redirected

    document.title = 'My Account — CareConnect360';

    const profile = await CareAuth.getProfile();
    if (profile) {
      $('profile-name').textContent = profile.full_name || 'Welcome';
      $('profile-detail').textContent = `${profile.role || 'customer'} • ${profile.email || session.user.email || ''}`.trim();
      const avatar = $('profile-avatar');
      if (profile.avatar_url) {
        avatar.src = profile.avatar_url;
      } else {
        avatar.style.display = 'none';
      }
    }

    try {
      const res = await fetch('/api/bookings', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not load bookings.');
      renderBookings(data.bookings);
    } catch (err) {
      console.error('[account] bookings failed:', err);
      $('bookings-wrap').innerHTML = '<p class="empty">Could not load your bookings. Please try again.</p>';
    }
  }

  $('logout-btn').addEventListener('click', () => {
    CareAuth.signOut();
  });

  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      console.error('[account] boot failed:', err);
      showError(err.message || 'Something went wrong.');
    });
  });
})();