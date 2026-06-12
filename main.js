/**
 * CareConnect — main.js  (fixed)
 *
 * Memory-leak fixes applied:
 *  1. Mobile menu keydown listener now stored in a module-level variable
 *     and removed when menu closes, preventing accumulation across re-opens.
 *  2. Cookie consent setTimeout handles stored and cleared on early banner
 *     removal to prevent dangling timers.
 *  3. IntersectionObserver already correctly calls unobserve — confirmed clean.
 *  4. Scroll listener uses { passive: true } — already correct; kept.
 *  5. No naked setInterval anywhere in the codebase — confirmed clean.
 *  6. FormData event listeners scoped to form lifetime — confirmed clean.
 */
(function () {
  'use strict';

  /* ──────────────────────────────────────────
     MOBILE MENU
     Fix: keydown listener now properly removed
     when the menu closes to prevent stacking.
  ────────────────────────────────────────── */
  function initMobileMenu() {
    var btn  = document.getElementById('mobile-menu-btn');
    var menu = document.getElementById('mobile-menu');
    if (!btn || !menu) return;

    // Stored reference so we can removeEventListener
    var escHandler = null;

    function openMenu() {
      menu.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      document.body.style.overflow = 'hidden';

      // Attach escape handler only while open
      escHandler = function (e) {
        if (e.key === 'Escape') {
          closeMenu();
          btn.focus();
        }
      };
      document.addEventListener('keydown', escHandler);
    }

    function closeMenu() {
      menu.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';

      // Remove escape handler when closed — prevents listener accumulation
      if (escHandler) {
        document.removeEventListener('keydown', escHandler);
        escHandler = null;
      }
    }

    btn.addEventListener('click', function () {
      menu.classList.contains('open') ? closeMenu() : openMenu();
    });

    menu.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', closeMenu);
    });
  }

  /* ──────────────────────────────────────────
     STICKY HEADER SHADOW ON SCROLL
  ────────────────────────────────────────── */
  function initScrollHeader() {
    var header = document.querySelector('.site-header');
    if (!header) return;

    var ticking = false;
    function onScroll() {
      if (!ticking) {
        requestAnimationFrame(function () {
          header.classList.toggle('scrolled', window.scrollY > 10);
          ticking = false;
        });
        ticking = true;
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ──────────────────────────────────────────
     REVEAL-ON-SCROLL (IntersectionObserver)
     Already clean — unobserve called correctly.
  ────────────────────────────────────────── */
  function initReveal() {
    var els = document.querySelectorAll('.reveal');
    if (!els.length) return;

    if ('IntersectionObserver' in window) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            obs.unobserve(entry.target); // prevents observer holding element reference
          }
        });
      }, { threshold: 0.12 });
      els.forEach(function (el) { obs.observe(el); });
    } else {
      els.forEach(function (el) { el.classList.add('visible'); });
    }
  }

  /* ──────────────────────────────────────────
     FORM UTILITIES
  ────────────────────────────────────────── */
  function sanitize(str) {
    return String(str)
      .replace(/[<>"'&]/g, function (c) {
        return ({ '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":"&#039;", '&':'&amp;' })[c];
      })
      .trim();
  }

  function setFieldError(field, msg) {
    field.classList.add('error');
    field.setAttribute('aria-invalid', 'true');
    var errEl = document.getElementById(field.id + '-error');
    if (errEl) errEl.textContent = msg;
  }

  function clearFieldError(field) {
    field.classList.remove('error');
    field.removeAttribute('aria-invalid');
    var errEl = document.getElementById(field.id + '-error');
    if (errEl) errEl.textContent = '';
  }

  function showBanner(form, type) {
    var ok  = form.querySelector('.form-success-banner');
    var err = form.querySelector('.form-error-banner');
    if (ok)  ok.classList.toggle('show', type === 'success');
    if (err) err.classList.toggle('show', type === 'error');
    var shown = type === 'success' ? ok : err;
    if (shown) shown.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function validateEmail(val) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
  }
  function validatePhone(val) {
    return /^\+?[\d\s\-().]{7,20}$/.test(val);
  }

  function validateRequired(form) {
    var valid = true;
    form.querySelectorAll('[required]').forEach(function (field) {
      clearFieldError(field);
      var val = field.value.trim();
      if (!val) {
        setFieldError(field, 'This field is required.');
        valid = false;
      } else if (field.type === 'email' && !validateEmail(val)) {
        setFieldError(field, 'Please enter a valid email address.');
        valid = false;
      } else if (field.type === 'tel' && !validatePhone(val)) {
        setFieldError(field, 'Please enter a valid phone number.');
        valid = false;
      } else if (field.type === 'date') {
        var chosen = new Date(val);
        var today  = new Date(); today.setHours(0, 0, 0, 0);
        if (chosen < today) {
          setFieldError(field, 'Please choose a date in the future.');
          valid = false;
        }
      }
    });
    return valid;
  }

  /* Generic form submit factory — DRY pattern */
  function submitForm(form, extraData) {
    var btn = form.querySelector('[type="submit"]');
    var ok  = form.querySelector('.form-success-banner');
    var err = form.querySelector('.form-error-banner');

    if (btn) { btn.classList.add('loading'); btn.disabled = true; }
    if (ok)  ok.classList.remove('show');
    if (err) err.classList.remove('show');

    var data = Object.assign({}, extraData || {});
    new FormData(form).forEach(function (val, key) { data[key] = sanitize(val); });

    fetch('/api/submit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(data),
    })
    .then(function (res) {
      if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'Server error'); });
      return res.json();
    })
    .then(function () {
      if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
      showBanner(form, 'success');
      form.reset();
    })
    .catch(function (error) {
      if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
      var errEl = form.querySelector('.form-error-banner');
      if (errEl) {
        errEl.textContent = '⚠️ ' + (error.message || 'Something went wrong. Please try again.');
        errEl.classList.add('show');
        errEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        showBanner(form, 'error');
      }
    });
  }

  /* ──────────────────────────────────────────
     BOOKING FORM
  ────────────────────────────────────────── */
    /* ──────────────────────────────────────────
     ENTERPRISE TOAST SYSTEM (UPGRADE 1)
  ────────────────────────────────────────── */
  var Toast = {
    show: function(title, message, type, duration) {
      type = type || 'success';
      duration = duration || 5000;
      var container = document.getElementById('toast-container');
      if (!container) return; // Fallback if container missing
      var icons = { success: '✅', error: '❌', info: 'ℹ️' };
      var toast = document.createElement('div');
      toast.className = 'toast ' + type;
      toast.innerHTML = '<div class="toast-icon">' + (icons[type] || '🔔') + '</div>' +
                        '<div class="toast-content"><div class="toast-title">' + title + '</div>' +
                        '<div class="toast-message">' + message + '</div></div>';
      container.appendChild(toast);
      requestAnimationFrame(function() { toast.classList.add('show'); });
      setTimeout(function() {
        toast.classList.remove('show');
        setTimeout(function() { toast.remove(); }, 400);
      }, duration);
    }
  };

  /* ──────────────────────────────────────────
     RAZORPAY CHECKOUT INTEGRATION (UPGRADE 2)
  ────────────────────────────────────────── */
  function initiateRazorpayCheckout(form) {
    var btn = form.querySelector('[type="submit"]');
    if (btn) { btn.classList.add('loading'); btn.disabled = true; }

    // 1. Collect form data using your existing sanitize function
    var formData = new FormData(form);
    var bookingData = { type: 'booking' };
    formData.forEach(function(val, key) { bookingData[key] = sanitize(val); });

    // 2. Determine Amount 
    // (Defaulting to 500 INR for booking fee. Change this logic based on your pricing)
    var amount = 500; 
    var receiptId = 'booking_' + Date.now();

    Toast.show('Initializing', 'Securing payment gateway...', 'info', 2000);

    // 3. Create Order via Backend
    fetch('/api/create-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        amount: amount, 
        receiptId: receiptId,
        customer: { name: bookingData.name, phone: bookingData.phone || '' }
      })
    })
    .then(function(res) { return res.json(); })
    .then(function(orderData) {
      if (!orderData.ok) throw new Error(orderData.error || 'Failed to create order');

      // 4. Configure Razorpay Popup
      var options = {
        key: orderData.keyId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: "CareConnect 360",
        description: "Professional Nursing Care Booking",
        image: "/favicon.svg",
        order_id: orderData.orderId,
        handler: function (response) {
          // 5. Payment Success! Now submit the form to Airtable
          Toast.show('Payment Successful', 'Verifying your booking...', 'success');
          bookingData.payment_id = response.razorpay_payment_id;
          bookingData.payment_status = 'Paid';
          
          // Use your existing submitForm to save to Airtable & send email
          submitForm(form, bookingData); 
        },
        prefill: { name: bookingData.name, contact: bookingData.phone || '' },
        notes: { booking_ref: receiptId, service: bookingData.service || '' },
        theme: { color: "#0056b3" }, // Your brand color
        modal: {
          ondismiss: function() {
            Toast.show('Payment Cancelled', 'You can complete your booking anytime.', 'info');
            if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
          }
        }
      };

      var rzp = new Razorpay(options);
      rzp.on('payment.failed', function (response) {
        Toast.show('Payment Failed', response.error.description || 'Please try again.', 'error');
        if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
      });
      
      rzp.open(); // Open the popup
    })
    .catch(function(error) {
      Toast.show('Error', error.message || 'Could not initialize payment.', 'error');
      if (btn) { btn.classList.remove('loading'); btn.disabled = false; }
    });
  }

  function initBookingForm() {
    var form = document.getElementById('booking-form');
    if (!form) return;

    var dateInput = form.querySelector('#date');
    if (dateInput) dateInput.min = new Date().toISOString().split('T')[0];

    form.querySelectorAll('[required]').forEach(function (field) {
      ['input', 'change'].forEach(function (ev) {
        field.addEventListener(ev, function () { clearFieldError(field); });
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!validateRequired(form)) {
        var firstErr = form.querySelector('.error');
        if (firstErr) firstErr.focus();
        return;
      }
       initiateRazorpayCheckout(form);
    });
  }

  /* ──────────────────────────────────────────
     GENERIC CONTACT / APPLICATION FORM
  ────────────────────────────────────────── */
  function initContactForm() {
    var form = document.getElementById('contact-form');
    if (!form) return;

    form.querySelectorAll('[required]').forEach(function (field) {
      ['input', 'change'].forEach(function (ev) {
        field.addEventListener(ev, function () { clearFieldError(field); });
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!validateRequired(form)) {
        var firstErr = form.querySelector('.error');
        if (firstErr) firstErr.focus();
        return;
      }
      submitForm(form, { type: 'application' });
    });
  }

  /* ──────────────────────────────────────────
     CALLBACK FORM
  ────────────────────────────────────────── */
  function initCallbackForm() {
    var form = document.getElementById('callback-form');
    if (!form) return;

    form.querySelectorAll('[required]').forEach(function (field) {
      ['input', 'change'].forEach(function (ev) {
        field.addEventListener(ev, function () { clearFieldError(field); });
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!validateRequired(form)) {
        var firstErr = form.querySelector('.error');
        if (firstErr) firstErr.focus();
        return;
      }
      submitForm(form, { type: 'callback' });
    });
  }

  /* ──────────────────────────────────────────
     LOGIN / SIGNUP TABS
  ────────────────────────────────────────── */
  function initAuthTabs() {
    var tabs = document.querySelectorAll('.auth-tab');
    if (!tabs.length) return;

    tabs.forEach(function (tab) {
      tab.addEventListener('click', function () {
        var target = tab.dataset.tab;
        tabs.forEach(function (t) {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.auth-panel').forEach(function (p) {
          p.classList.remove('active');
          p.setAttribute('hidden', '');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        var panel = document.getElementById(target);
        if (panel) { panel.classList.add('active'); panel.removeAttribute('hidden'); }
      });
    });
  }

  /* ──────────────────────────────────────────
     FAQ ACCORDION
  ────────────────────────────────────────── */
  function initFAQ() {
    var items = document.querySelectorAll('.faq-item');
    if (!items.length) return;

    items.forEach(function (item) {
      var btn = item.querySelector('.faq-question');
      if (!btn) return;
      btn.addEventListener('click', function () {
        var isOpen = item.classList.contains('open');
        items.forEach(function (other) {
          other.classList.remove('open');
          var q = other.querySelector('.faq-question');
          if (q) q.setAttribute('aria-expanded', 'false');
        });
        if (!isOpen) {
          item.classList.add('open');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });
  }

  /* ──────────────────────────────────────────
     ACTIVE NAV LINK
  ────────────────────────────────────────── */
  function initActiveNav() {
    var page = window.location.pathname.split('/').pop() || 'index.html';
    document.querySelectorAll('.nav-link, .mobile-nav-link').forEach(function (link) {
      var href     = link.getAttribute('href') || '';
      var linkPage = href.split('/').pop().split('?')[0].split('#')[0];
      if (linkPage === page || (page === '' && linkPage === 'index.html')) {
        link.classList.add('active');
        link.setAttribute('aria-current', 'page');
      }
    });
  }

  /* ──────────────────────────────────────────
     AUTO-UPDATE COPYRIGHT YEAR
  ────────────────────────────────────────── */
  function initCopyright() {
    var el = document.getElementById('copyright-year');
    if (el) el.textContent = new Date().getFullYear();
  }

  /* ──────────────────────────────────────────
     COOKIE CONSENT BANNER
     Fix: setTimeout references tracked and
     cleared when banner is dismissed early
     to prevent dangling timer callbacks.
  ────────────────────────────────────────── */
  function initCookieConsent() {
    if (localStorage.getItem('cookieConsent')) return;

    var banner = document.createElement('div');
    banner.className = 'cookie-consent-banner';
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-live', 'polite');

    banner.innerHTML = [
      '<div class="cookie-text">',
        '🍪 <strong>Cookie &amp; Pre-Launch Notice:</strong> CareConnect uses basic browser cookies/local storage ',
        'to guarantee platform security and record booking entries. ',
        'Note that CareConnect is a pre-launch platform currently operating as an unregistered business. ',
        'Full legal registration is in progress. ',
        'By clicking Accept, you consent to our security cookie usage. ',
        'Learn more in our <a href="privacy.html">Privacy Policy</a>.',
      '</div>',
      '<div class="cookie-actions">',
        '<button class="btn btn-primary btn-sm" id="cookie-accept" style="padding:4px 10px;font-size:var(--font-xs);">Accept Cookies</button>',
        '<button class="btn btn-secondary btn-sm" id="cookie-decline" style="padding:4px 10px;font-size:var(--font-xs);">Decline</button>',
      '</div>',
    ].join('');

    document.body.appendChild(banner);

    // Track timers so we can clear them
    var showTimer   = null;
    var removeTimer = null;

    showTimer = setTimeout(function () { banner.classList.add('show'); }, 1000);

    function dismiss(consent) {
      clearTimeout(showTimer);
      clearTimeout(removeTimer);
      localStorage.setItem('cookieConsent', consent);
      banner.classList.remove('show');
      removeTimer = setTimeout(function () {
        if (banner.parentNode) banner.parentNode.removeChild(banner);
      }, 600);
    }

    var acceptBtn  = document.getElementById('cookie-accept');
    var declineBtn = document.getElementById('cookie-decline');
    if (acceptBtn)  acceptBtn.addEventListener('click',  function () { dismiss('accepted'); });
    if (declineBtn) declineBtn.addEventListener('click', function () { dismiss('declined'); });
  }

  /* ──────────────────────────────────────────
     BOOTSTRAP
  ────────────────────────────────────────── */
  document.addEventListener('DOMContentLoaded', function () {
    initMobileMenu();
    initScrollHeader();
    initReveal();
    initBookingForm();
    initContactForm();
    initCallbackForm();
    initAuthTabs();
    initFAQ();
    initActiveNav();
    initCopyright();
    initCookieConsent();
  });
})();
