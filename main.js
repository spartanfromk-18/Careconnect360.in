 /**
 * CareConnect — main.js (Production Hardened)
 * Memory-leak fixes applied. Idempotency wired. Dead state removed.
 */
(function () {
  'use strict';

  /* ──────────────────────────────────────────
     ENTERPRISE TOAST SYSTEM
  ────────────────────────────────────────── */
  const Toast = {
    show: function(title, message, type, duration) {
      type = type || 'success';
      duration = duration || 5000;
      let container = document.getElementById('toast-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:10px;';
        document.body.appendChild(container);
      }
      
      const icons = { success: '✅', error: '❌', info: 'ℹ️' };
      const toast = document.createElement('div');
      toast.style.cssText = 'background:white;padding:12px 20px;border-radius:8px;box-shadow:0 4px 12px rgba(0,0,0,0.15);display:flex;align-items:center;gap:12px;min-width:250px;transform:translateX(100%);transition:transform 0.3s ease;border-left:4px solid ' + (type === 'error' ? '#dc3545' : type === 'success' ? '#28a745' : '#0056b3');
      
      toast.innerHTML = `<div style="font-size:1.2rem;">${icons[type] || '🔔'}</div>
                         <div><div style="font-weight:600;font-size:0.95rem;">${title}</div>
                         <div style="font-size:0.85rem;color:#666;">${message}</div></div>`;
                         
      container.appendChild(toast);
      requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; });
      
      setTimeout(() => {
        toast.style.transform = 'translateX(100%)';
        setTimeout(() => toast.remove(), 300);
      }, duration);
    }
  };

  /* ──────────────────────────────────────────
     MOBILE MENU
  ────────────────────────────────────────── */
  function initMobileMenu() {
    const btn = document.getElementById('mobile-menu-btn');
    const menu = document.getElementById('mobile-menu');
    if (!btn || !menu) return;
    let escHandler = null;

    function openMenu() {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';
      escHandler = function (e) {
        if (e.key === 'Escape') { closeMenu(); btn.focus(); }
      };
      document.addEventListener('keydown', escHandler);
    }

    function closeMenu() {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
      if (escHandler) {
        document.removeEventListener('keydown', escHandler);
        escHandler = null;
      }
    }

    btn.addEventListener('click', () => menu.classList.contains('open') ? closeMenu() : openMenu());
    menu.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  }

  /* ──────────────────────────────────────────
     FORM UTILITIES
  ────────────────────────────────────────── */
  function sanitize(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/[<>"'&]/g, c => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' })[c]).trim();
  }

  function setFieldError(field, msg) {
    field.classList.add('error');
    field.setAttribute('aria-invalid', 'true');
    const errEl = document.getElementById(field.id + '-error');
    if (errEl) errEl.textContent = msg;
  }

  function clearFieldError(field) {
    field.classList.remove('error');
    field.removeAttribute('aria-invalid');
    const errEl = document.getElementById(field.id + '-error');
    if (errEl) errEl.textContent = '';
  }

  function validateEmail(val) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val); }
  function validatePhone(val) { return /^\+?[\d\s\-().]{7,20}$/.test(val); }

  function validateRequired(form) {
    let valid = true;
    form.querySelectorAll('[required]').forEach(field => {
      clearFieldError(field);
      const val = field.value.trim();
      if (!val) { setFieldError(field, 'This field is required.'); valid = false; }
      else if (field.type === 'email' && !validateEmail(val)) { setFieldError(field, 'Please enter a valid email address.'); valid = false; }
      else if (field.type === 'tel' && !validatePhone(val)) { setFieldError(field, 'Please enter a valid phone number.'); valid = false; }
      else if (field.type === 'date') {
        const chosen = new Date(val); const today = new Date(); today.setHours(0, 0, 0, 0);
        if (chosen < today) { setFieldError(field, 'Please choose a date in the future.'); valid = false; }
      }
    });
    return valid;
  }

  function submitForm(form, extraData) {
    const btn = form.querySelector('[type="submit"]');
    if (btn) { btn.classList.add('loading'); btn.disabled = true; }

    const data = Object.assign({}, extraData || {});
    new FormData(form).forEach((val, key) => { data[key] = sanitize(val); });

    fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
    .then(res => {
      if (!res.ok) return res.json().then(d => { throw new Error(d.error || 'Server error'); });
      return res.json();
    })
    .then(() => {
      if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
      Toast.show('Success', 'Your request has been submitted securely.', 'success');
      form.reset();
    })
    .catch(error => {
      if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
      Toast.show('Submission Failed', error.message || 'Something went wrong.', 'error');
    });
  }

  /* ──────────────────────────────────────────
     RAZORPAY CHECKOUT INTEGRATION
  ────────────────────────────────────────── */
  function initiateRazorpayCheckout(form) {
    const btn = form.querySelector('[type="submit"]');
    if (btn) { btn.classList.add('loading'); btn.disabled = true; }

    const formData = new FormData(form);
    const bookingData = { type: 'booking' };
    formData.forEach((val, key) => { bookingData[key] = sanitize(val); });

    const amount = 500; 
    const receiptId = 'booking_' + Date.now();
    
    // [FIX] Generate Idempotency Key to activate backend duplicate protection
    const idempotencyKey = crypto.randomUUID();

    Toast.show('Initializing', 'Securing payment gateway...', 'info', 2000);

    fetch('/api/create-order', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'X-Idempotency-Key': idempotencyKey 
      },
      body: JSON.stringify({ 
        amount: amount, 
        receiptId: receiptId,
        customer: { name: bookingData.name, phone: bookingData.phone || '' }
      })
    })
    .then(res => res.json())
    .then(orderData => {
      if (!orderData.ok) throw new Error(orderData.error || 'Failed to create order');

      const options = {
        key: orderData.keyId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: "CareConnect 360",
        description: "Professional Nursing Care Booking",
        image: "/favicon.svg",
        order_id: orderData.orderId,
        handler: function (response) {
          Toast.show('Payment Successful', 'Verifying your booking...', 'success');
          bookingData.payment_id = response.razorpay_payment_id;
          // REMOVED: bookingData.payment_status = 'Paid'; (Backend strictly verifies via Razorpay API)
          submitForm(form, bookingData); 
        },
        prefill: { name: bookingData.name, contact: bookingData.phone || '' },
        notes: { booking_ref: receiptId, service: bookingData.service || '' },
        theme: { color: "#0056b3" },
        modal: {
          ondismiss: function() {
            Toast.show('Payment Cancelled', 'You can complete your booking anytime.', 'info');
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
          }
        }
      };

      const rzp = new Razorpay(options);
      rzp.on('payment.failed', function (response) {
        Toast.show('Payment Failed', response.error.description || 'Please try again.', 'error');
        if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
      });
      
      rzp.open();
    })
    .catch(error => {
      Toast.show('Error', error.message || 'Could not initialize payment.', 'error');
      if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
    });
  }

  /* ──────────────────────────────────────────
     FORM INITIALIZATIONS
  ────────────────────────────────────────── */
  function initBookingForm() {
    const form = document.getElementById('booking-form');
    if (!form) return;
    const dateInput = form.querySelector('#date');
    if (dateInput) dateInput.min = new Date().toISOString().split('T')[0];

    form.querySelectorAll('[required]').forEach(field => {
      ['input', 'change'].forEach(ev => field.addEventListener(ev, () => clearFieldError(field)));
    });

    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!validateRequired(form)) return;
      initiateRazorpayCheckout(form);
    });
  }

  function initContactForm() {
    const form = document.getElementById('contact-form');
    if (!form) return;
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!validateRequired(form)) return;
      submitForm(form, { type: 'application' });
    });
  }

  function initCallbackForm() {
    const form = document.getElementById('callback-form');
    if (!form) return;
    form.addEventListener('submit', e => {
      e.preventDefault();
      if (!validateRequired(form)) return;
      submitForm(form, { type: 'callback' });
    });
  }

  /* ──────────────────────────────────────────
     UI UTILITIES (Scroll, Reveal, Tabs, etc.)
  ────────────────────────────────────────── */
  function initScrollHeader() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    let ticking = false;
    window.addEventListener('scroll', () => {
      if (!ticking) {
        requestAnimationFrame(() => {
          header.classList.toggle('scrolled', window.scrollY > 10);
          ticking = false;
        });
        ticking = true;
      }
    }, { passive: true });
  }

  function initReveal() {
    const els = document.querySelectorAll('.reveal');
    if (!els.length) return;
    if ('IntersectionObserver' in window) {
      const obs = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            obs.unobserve(entry.target);
          }
        });
      }, { threshold: 0.12 });
      els.forEach(el => obs.observe(el));
    } else {
      els.forEach(el => el.classList.add('visible'));
    }
  }

  function initAuthTabs() {
    const tabs = document.querySelectorAll('.auth-tab');
    if (!tabs.length) return;
    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        tabs.forEach(t => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
        document.querySelectorAll('.auth-panel').forEach(p => { p.classList.remove('active'); p.setAttribute('hidden', ''); });
        tab.classList.add('active'); tab.setAttribute('aria-selected', 'true');
        const panel = document.getElementById(target);
        if (panel) { panel.classList.add('active'); panel.removeAttribute('hidden'); }
      });
    });
  }

  function initFAQ() {
    const items = document.querySelectorAll('.faq-item');
    if (!items.length) return;
    items.forEach(item => {
      const btn = item.querySelector('.faq-question');
      if (!btn) return;
      btn.addEventListener('click', () => {
        const isOpen = item.classList.contains('open');
        items.forEach(other => { other.classList.remove('open'); const q = other.querySelector('.faq-question'); if (q) q.setAttribute('aria-expanded', 'false'); });
        if (!isOpen) { item.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); }
      });
    });
  }

  function initActiveNav() {
    const page = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-link, .mobile-nav-link').forEach(link => {
      const href = link.getAttribute('href') || '';
      const linkPage = href.split('/').pop().split('?')[0].split('#')[0];
      if (linkPage === page || (page === '' && linkPage === 'index.html')) {
        link.classList.add('active'); link.setAttribute('aria-current', 'page');
      }
    });
  }

  function initCopyright() {
    const el = document.getElementById('copyright-year');
    if (el) el.textContent = new Date().getFullYear();
  }

  function initCookieConsent() {
    if (localStorage.getItem('cookieConsent')) return;
    const banner = document.createElement('div');
    banner.className = 'cookie-consent-banner';
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML = `
      <div class="cookie-text">
          <strong>Cookie & Pre-Launch Notice:</strong> CareConnect uses basic browser cookies/local storage 
        to guarantee platform security and record booking entries. Note that CareConnect is a pre-launch platform.
        By clicking Accept, you consent to our security cookie usage. Learn more in our <a href="privacy.html">Privacy Policy</a>.
      </div>
      <div class="cookie-actions">
        <button class="btn btn-primary btn-sm" id="cookie-accept">Accept Cookies</button>
        <button class="btn btn-secondary btn-sm" id="cookie-decline">Decline</button>
      </div>`;
    document.body.appendChild(banner);

    let showTimer = setTimeout(() => banner.classList.add('show'), 1000);
    let removeTimer = null;

    function dismiss(consent) {
      clearTimeout(showTimer); clearTimeout(removeTimer);
      localStorage.setItem('cookieConsent', consent);
      banner.classList.remove('show');
      removeTimer = setTimeout(() => { if (banner.parentNode) banner.parentNode.removeChild(banner); }, 600);
    }

    document.getElementById('cookie-accept').addEventListener('click', () => dismiss('accepted'));
    document.getElementById('cookie-decline').addEventListener('click', () => dismiss('declined'));
  }

  /* ──────────────────────────────────────────
     BOOTSTRAP
  ────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', () => {
    initMobileMenu(); initScrollHeader(); initReveal();
    initBookingForm(); initContactForm(); initCallbackForm();
    initAuthTabs(); initFAQ(); initActiveNav(); initCopyright(); initCookieConsent();
  });
})();