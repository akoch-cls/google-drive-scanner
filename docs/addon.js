/**
 * Teacher-facing pages of the Classroom add-on (addon.html). The student view
 * is the scanner itself (index.html?addon=student, handled in app.js), so the
 * two never drift apart. Everything that talks to Google is in google.js.
 */
(() => {
  'use strict';

  const api = ScannerAPI;
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const params = Object.fromEntries(new URLSearchParams(location.search));
  const view = params.view || 'setup';
  const ctx = api.addOnContext(params);
  const VIEWS = ['vSignIn', 'vSetup', 'vTeacher', 'vReview', 'vMessage'];

  function show(id) {
    VIEWS.forEach(v => $(v).classList.toggle('hidden', v !== id));
  }

  function busy(on) {
    $('busy').classList.toggle('hidden', !on);
  }

  function showError(err) {
    busy(false);
    const msg = String(err && err.message || err || 'Something went wrong.');
    $('error').textContent = /has not been used|is disabled|SERVICE_DISABLED/i.test(msg)
      ? 'The Classroom API is not turned on for this app yet (see the README).' : msg;
    $('error').classList.remove('hidden');
  }

  function message(title, text) {
    $('msgTitle').textContent = title;
    $('msgText').textContent = text;
    show('vMessage');
  }

  function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /**
   * Shows the sign-in card until the user has granted `scopes`, then runs `then`.
   * (Google's pop-up only opens from a click.)
   */
  function withSignIn(scopes, then) {
    const go = () => {
      $('accountEmail').textContent = api.getEmail();
      $('error').classList.add('hidden');
      then();
    };
    api.ensureSignedIn(scopes).then(go, () => {
      show('vSignIn');
      $('signInBtn').onclick = () => api.ensureSignedIn(scopes).then(go, showError);
    });
  }

  // ---------------------------------------------------------------------------
  // Attachment set-up (teacher picks Doc Scanner under Add-ons)
  // ---------------------------------------------------------------------------

  function setup() {
    if (ctx.itemType !== 'courseWork') {
      message('Use Doc Scanner on an assignment',
        'Doc Scanner collects student work, so it can only be added to assignments, not to materials or announcements.');
      return;
    }
    show('vSetup');
    $('setupBtn').onclick = () => api.ensureSignedIn(api.ADDON_TEACHER_SCOPES).then(async () => {
      $('accountEmail').textContent = api.getEmail();
      $('error').classList.add('hidden');
      busy(true);
      try {
        await api.createAddOnAttachment(ctx, $('setupTitle').value);
        busy(false);
        message('Added', 'Doc Scanner is attached to this assignment.');
        api.closeAddOnIframe();
      } catch (err) {
        showError(err);
      }
    }, showError);
  }

  // ---------------------------------------------------------------------------
  // Teacher view: every student's scan
  // ---------------------------------------------------------------------------

  async function teacher() {
    show('vTeacher');
    $('tryScanner').href = 'index.html';
    busy(true);
    try {
      const [info, scans] = await Promise.all([
        api.getAddOnInfo(ctx).catch(() => ({})),
        api.listAddOnScans(ctx)
      ]);
      if (info.isStudent) {
        // A student landed on the teacher page: send them to the scanner.
        location.replace('index.html?addon=student&' + new URLSearchParams(params).toString());
        return;
      }
      if (info.itemTitle) $('teacherTitle').textContent = 'Scans for ' + info.itemTitle;
      $('scanList').innerHTML = scans.length ? scans.map(f =>
        '<li><div><b>' + esc(f.student || 'Student') + '</b><div class="muted small-text">' + esc(f.name) +
        ' · ' + esc(formatTime(f.modified)) + '</div></div>' +
        '<a class="btn ghost small" href="' + esc(f.url) + '" target="_blank" rel="noopener">Open ↗</a></li>').join('')
        : '<li class="empty muted">No scans yet. They appear here as students submit them.</li>';
      busy(false);
    } catch (err) {
      showError(err);
    }
  }
  $('teacherRefresh').addEventListener('click', teacher);

  // ---------------------------------------------------------------------------
  // Student work review: one student's scan, shown in Classroom's grading view
  // ---------------------------------------------------------------------------

  async function review() {
    busy(true);
    try {
      const scan = await api.getAddOnScanForSubmission(ctx);
      busy(false);
      if (!scan) {
        message('No scan yet', "This student hasn't submitted a scan with Doc Scanner.");
        return;
      }
      show('vReview');
      $('reviewName').textContent = scan.name;
      $('reviewMeta').textContent = (scan.student ? scan.student + ' · ' : '') + formatTime(scan.modified);
      $('reviewOpen').href = scan.url;
      $('reviewFrame').src = scan.preview;
    } catch (err) {
      showError(err);
    }
  }

  // ---------------------------------------------------------------------------

  if (!ctx) {
    message('Open this from Google Classroom',
      'This page is part of the Doc Scanner Classroom add-on. Teachers add it to an assignment from the Add-ons menu.');
    return;
  }
  if (view === 'setup') setup();
  else if (view === 'teacher') withSignIn(api.ADDON_TEACHER_SCOPES, teacher);
  else if (view === 'review') withSignIn(api.ADDON_TEACHER_SCOPES, review);
  else message('Unknown page', 'Open Doc Scanner from Google Classroom.');
})();
