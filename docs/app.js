(() => {
  'use strict';

  // Tunables. Focus and motion values come from Vision.sharpness / Vision.meanAbsDiff.
  const CONFIG = {
    detectWidth: 480,     // frames are shrunk to this width for page detection
    tickMs: 100,          // analysis loop interval
    autoFrames: 6,        // consecutive "ready" frames before auto-capture (~0.6 s)
    cooldownMs: 1500,     // minimum time between auto-captures
    minSharpness: 6,      // below this the image is blurry no matter what
    relSharpness: 0.7,    // sharp = at least this fraction of the camera's typical sharpness
    focusWindow: 25,      // frames (~2.5 s) used to learn the camera's typical sharpness
    burstFrames: 5,       // frames grabbed per capture; the sharpest one is kept
    steadyMotion: 6,      // frame-to-frame change below this = steady (hand-held paper trembles)
    steadyQuad: 0.025,    // outline movement per frame below this = steady (fraction of frame)
    rearmMotion: 8,       // change above this = the page is being swapped
    maxOutputDim: 2200,   // longest edge of a finished page, in pixels
    maxSourceDim: 3200,   // uploaded photos are shrunk to this first
    jpegQuality: 0.85,
    maxUploadBytes: 45 * 1024 * 1024
  };
  const CV_URLS = [
    'https://docs.opencv.org/4.10.0/opencv.js',
    'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js'
  ];
  const FILTERS = ['enhanced', 'original', 'gray', 'bw'];
  const STATE_LABELS = {
    NEW: ['Assigned', ''], CREATED: ['Assigned', ''], RECLAIMED_BY_STUDENT: ['Unsubmitted', 'warn'],
    TURNED_IN: ['Turned in', 'good'], RETURNED: ['Returned', 'good']
  };
  const ICONS = {
    folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    drive: '<svg viewBox="0 0 24 24"><path d="M3 11.5 12 3l9 8.5M5 10v10h14V10"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17l9-10"/></svg>',
    info: '<svg viewBox="0 0 24 24"><path d="M12 8h.01M11 12h1v5h1M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z"/></svg>',
    pages: '<svg viewBox="0 0 24 24"><path d="M8 3h8l4 4v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM15 3v5h5M3 7v12a2 2 0 0 0 2 2h9"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>'
  };

  const api = ScannerAPI;
  const MAX_RECENT_FOLDERS = 6;
  const ROOT = { id: 'root', name: 'My Drive', path: 'My Drive' };

  const $ = id => document.getElementById(id);
  const el = {};
  [
    'video', 'overlay', 'viewport', 'statusPill', 'statusText', 'focusFill', 'flash', 'cameraError',
    'cameraErrorTitle', 'cameraErrorText', 'retryCamera', 'uploadInstead', 'dropHint', 'autoToggle',
    'captureBtn', 'cameraSelect', 'uploadBtn', 'fileInput', 'pageList', 'pageCount', 'clearBtn', 'saveBtn',
    'cvStatus', 'teacherBtn', 'helpBtn', 'targetBanner', 'targetTitle', 'targetCourse', 'targetClear',
    'editorModal', 'edTitle', 'edPrev', 'edNext', 'cropArea', 'cropCanvas', 'cropSvg', 'loupe', 'previewImg',
    'previewSpin', 'filterSeg', 'edApplyAll', 'edRotL', 'edRotR', 'edAuto', 'edFull', 'edEarlier', 'edLater',
    'edDelete', 'saveModal', 'fileName', 'tabDrive', 'tabClassroom', 'destName', 'destPath', 'browseBtn',
    'recentWrap', 'recentChips', 'browser', 'folderSearch', 'newFolderBtn', 'crumbs', 'newFolderRow',
    'newFolderName', 'newFolderCreate', 'folderList', 'useFolderBtn', 'courseSelect', 'assignmentList',
    'turnInCheck', 'saveError', 'saveSize', 'confirmSave', 'saveBusy', 'saveBusyText', 'resultModal',
    'resultIcon', 'resultTitle', 'resultBody', 'resultActions', 'teacherModal', 'tCourse', 'tCreate', 'tLink',
    'tTitle', 'tDesc', 'tDue', 'tPoints', 'tCreateBtn', 'tWorkList', 'tResult', 'tError', 'tBusy', 'helpModal',
    'toast', 'toastText', 'toastAction', 'edFingers', 'macTip', 'macTipClose', 'signInBtn', 'account', 'accountEmail', 'signOutBtn'
  ].forEach(id => { el[id] = $(id); });

  const state = {
    pages: [],
    stream: null,
    cvReady: false,
    autoEnabled: true,
    defaultFilter: 'enhanced',
    removeFingers: true,
    capturing: false,
    loopTimer: null,
    prevGray: null,
    quad: null,          // detected page corners, normalised 0..1
    quadStable: false,
    quadMiss: 0,
    quadCut: false,      // the page runs off the edge of the frame
    focus: { raw: 0, history: [], typical: 0, rel: 0, sharp: false, log: [] },
    auto: { armed: true, count: 0, disturbed: 0, lastCapture: 0, justCaptured: -Infinity, captured: 0 },
    openModals: [],
    dest: null,          // {id, name, path}
    recent: [],
    browse: null,
    saveTab: 'drive',
    cls: { courses: null, error: null, courseId: null, assignments: {}, selected: null, target: null },
    teacher: { courses: null, work: {} }
  };

  const workCanvas = Vision.createCanvas(CONFIG.detectWidth, 270);
  const workCtx = Vision.ctx2d(workCanvas);
  const focusCanvas = Vision.createCanvas(400, 300);
  const focusCtx = Vision.ctx2d(focusCanvas);

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Calls a ScannerAPI function, always returning a promise. */
  function server(fn, ...args) {
    return Promise.resolve().then(() => api[fn](...args));
  }

  function urlParams() {
    return Object.fromEntries(new URLSearchParams(location.search));
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const uid = () => Math.random().toString(36).slice(2, 10);

  function store(key, value) {
    try {
      if (value === undefined) return JSON.parse(localStorage.getItem('scanner.' + key));
      localStorage.setItem('scanner.' + key, JSON.stringify(value));
    } catch (err) { /* storage unavailable */ }
    return undefined;
  }

  function toBlob(canvas, type, quality) {
    return new Promise((resolve, reject) =>
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not encode image'))), type, quality));
  }

  function friendlyError(err) {
    const msg = String(err && err.message || err || 'Something went wrong.');
    if (/has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) {
      return 'The Google Drive or Classroom API is not turned on for this app yet. Whoever set it up needs to enable it in Google Cloud (see the README).';
    }
    if (/insufficient.*(scope|permission)|PERMISSION_DENIED/i.test(msg) && /Classroom|course/i.test(msg)) {
      return 'Google Classroom said no. Your school may need to allow this app, or you may not have access to that class.';
    }
    if (/Failed to fetch|NetworkError/i.test(msg)) {
      return "Couldn't reach Google. Check your internet connection and try again.";
    }
    return msg;
  }

  function formatDue(iso) {
    if (!iso) return 'No due date';
    const d = new Date(iso);
    const opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return 'Due ' + d.toLocaleDateString(undefined, opts) + ', ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function formatBytes(n) {
    return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  let toastTimer = null;
  function toast(message, action, onAction, ms = 4000) {
    el.toastText.textContent = message;
    el.toastAction.classList.toggle('hidden', !action);
    el.toastAction.textContent = action || '';
    el.toastAction.onclick = () => { hideToast(); onAction && onAction(); };
    el.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, ms);
  }
  function hideToast() { el.toast.classList.add('hidden'); }

  // A short "shutter" click, made with WebAudio so no sound file is needed.
  let audioCtx = null;
  function shutterSound() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const t = audioCtx.currentTime;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1500, t);
      osc.frequency.exponentialRampToValueAtTime(400, t + 0.08);
      gain.gain.setValueAtTime(0.12, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.11);
    } catch (err) { /* audio is optional */ }
  }

  // ===========================================================================
  // Modals
  // ===========================================================================

  function openModal(modal) {
    modal.classList.remove('hidden');
    if (!state.openModals.includes(modal)) state.openModals.push(modal);
  }

  function closeModal(modal) {
    if (modal.querySelector('.busy:not(.hidden)')) return; // don't close mid-save
    modal.classList.add('hidden');
    state.openModals = state.openModals.filter(m => m !== modal);
    if (modal === el.editorModal) closeEditor();
  }

  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('mousedown', e => { if (e.target === modal) closeModal(modal); });
    modal.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(modal)));
  });

  // ===========================================================================
  // OpenCV (edge detection)
  // ===========================================================================

  function loadOpenCv(i = 0) {
    if (i >= CV_URLS.length) {
      el.cvStatus.textContent = 'Manual crop only';
      el.cvStatus.className = 'chip off';
      el.cvStatus.title = "Automatic edge detection couldn't load. You can still capture and drag the corners yourself.";
      return;
    }
    const script = document.createElement('script');
    script.async = true;
    script.src = CV_URLS[i];
    script.onload = () => waitForCv().then(onCvReady, () => loadOpenCv(i + 1));
    script.onerror = () => loadOpenCv(i + 1);
    document.body.appendChild(script);
  }

  // Depending on the build, `cv` is the module, a promise for it, or needs onRuntimeInitialized.
  function waitForCv() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('OpenCV timed out')), 45000);
      const done = mod => { clearTimeout(timer); window.cv = mod; resolve(); };
      const cv = window.cv;
      if (!cv) { clearTimeout(timer); reject(new Error('OpenCV missing')); return; }
      if (cv.Mat) done(cv);
      else if (typeof cv.then === 'function') cv.then(mod => done(mod && mod.Mat ? mod : window.cv));
      else cv.onRuntimeInitialized = () => done(cv);
    });
  }

  function onCvReady() {
    state.cvReady = true;
    el.cvStatus.textContent = 'Edge detection on';
    el.cvStatus.className = 'chip ok';
  }

  // ===========================================================================
  // Camera
  // ===========================================================================

  async function startCamera(deviceId) {
    stopCamera();
    el.cameraError.classList.add('hidden');
    setStatus('Starting camera…', '');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showCameraError('Camera not supported', "This browser can't use the camera here. You can still upload photos.");
      return;
    }
    const video = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = { ideal: 'environment' };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      if (deviceId && err.name === 'OverconstrainedError') return startCamera(null);
      const blocked = err.name === 'NotAllowedError' || err.name === 'SecurityError';
      const missing = err.name === 'NotFoundError' || err.name === 'OverconstrainedError';
      showCameraError(
        blocked ? 'Camera access is blocked' : missing ? 'No camera found' : 'Camera unavailable',
        blocked ? 'Allow camera access using the camera icon in the address bar, then try again.'
          : missing ? 'Plug in a camera and try again, or upload photos instead.'
            : 'Another app may be using the camera. Close it and try again. (' + err.name + ')');
      return;
    }

    state.stream = stream;
    el.video.srcObject = stream;
    await el.video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    enableContinuousFocus(track);
    const settings = track.getSettings ? track.getSettings() : {};
    if (settings.deviceId) store('camera', settings.deviceId);
    populateCameras(settings.deviceId);
    el.captureBtn.disabled = false;
    startLoop();
  }

  function stopCamera() {
    clearTimeout(state.loopTimer);
    if (state.stream) state.stream.getTracks().forEach(t => t.stop());
    state.stream = null;
  }

  function enableContinuousFocus(track) {
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) {
        track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      }
    } catch (err) { /* not supported */ }
  }

  async function populateCameras(currentId) {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      el.cameraSelect.innerHTML = cams.map((c, i) =>
        '<option value="' + esc(c.deviceId) + '">' + esc(c.label || 'Camera ' + (i + 1)) + '</option>').join('');
      if (currentId) el.cameraSelect.value = currentId;
      el.cameraSelect.classList.toggle('hidden', cams.length < 2);
    } catch (err) { /* ignore */ }
  }

  function showCameraError(title, text) {
    el.cameraErrorTitle.textContent = title;
    el.cameraErrorText.textContent = text;
    el.cameraError.classList.remove('hidden');
    el.captureBtn.disabled = true;
    setStatus('No camera', 'bad');
  }

  // ===========================================================================
  // Live analysis: page detection, focus, steadiness, auto-capture
  // ===========================================================================

  function startLoop() {
    clearTimeout(state.loopTimer);
    state.prevGray = null;
    tick();
  }

  function tick() {
    state.loopTimer = setTimeout(tick, CONFIG.tickMs);
    const v = el.video;
    if (!v.videoWidth || document.hidden || state.openModals.length || state.capturing) return;

    const vw = v.videoWidth, vh = v.videoHeight;
    const sw = CONFIG.detectWidth, sh = Math.round(vh * sw / vw);
    if (workCanvas.width !== sw || workCanvas.height !== sh) {
      workCanvas.width = sw;
      workCanvas.height = sh;
    }
    workCtx.drawImage(v, 0, 0, sw, sh);
    const frame = workCtx.getImageData(0, 0, sw, sh);

    const gray = Vision.toGray(frame);
    const motion = state.prevGray && state.prevGray.length === gray.length
      ? Vision.meanAbsDiff(gray, state.prevGray) : 99;
    state.prevGray = gray;

    let found = null;
    if (state.cvReady) {
      try { found = Vision.detectQuad(frame); } catch (err) { console.warn('detect failed', err); }
    }
    updateQuad(found, sw, sh);
    if (found) state.quadCut = !!found.touchesEdge;

    const q = state.quad;
    const r = focusRegion(vw, vh);
    if (focusCanvas.width !== r.w || focusCanvas.height !== r.h) {
      focusCanvas.width = r.w;
      focusCanvas.height = r.h;
    }
    focusCtx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    updateFocus(Vision.sharpness(focusCtx.getImageData(0, 0, r.w, r.h)));

    const steady = motion < CONFIG.steadyMotion && (!q || state.quadStable);
    updateAuto(!!q, steady, motion);
    drawOverlay(steady);
    updateStatus(steady);
  }

  /** Focus is measured at full resolution, on the middle of the page (or frame). */
  function focusRegion(vw, vh) {
    const q = state.quad;
    const cx = (q ? q.reduce((s, p) => s + p.x, 0) / 4 : 0.5) * vw;
    const cy = (q ? q.reduce((s, p) => s + p.y, 0) / 4 : 0.5) * vh;
    const w = Math.min(400, Math.round(vw / 2.5)), h = Math.min(300, Math.round(vh / 2.5));
    return {
      x: Math.max(0, Math.min(vw - w, Math.round(cx - w / 2))),
      y: Math.max(0, Math.min(vh - h, Math.round(cy - h / 2))),
      w, h
    };
  }

  function quadDistance(a, b) {
    return a.reduce((s, p, i) => s + Math.hypot(p.x - b[i].x, p.y - b[i].y), 0) / 4;
  }

  function updateQuad(found, w, h) {
    if (found) {
      const n = found.map(p => ({ x: p.x / w, y: p.y / h }));
      const prev = state.quad;
      const d = prev ? quadDistance(prev, n) : Infinity;
      if (d < 0.08) {
        state.quadStable = d < CONFIG.steadyQuad;
        state.quad = prev.map((p, i) => ({ x: (p.x + n[i].x) / 2, y: (p.y + n[i].y) / 2 }));
      } else {
        if (!prev) state.focus.history = []; // new page: relearn what "sharp" looks like
        state.quad = n;
        state.quadStable = false;
      }
      state.quadMiss = 0;
    } else if (state.quad && ++state.quadMiss <= 3) {
      state.quadStable = false; // brief dropout: keep the last outline
    } else {
      state.quad = null;
      state.quadStable = false;
    }
  }

  /**
   * Most laptop webcams are fixed-focus, so instead of waiting for a focus peak
   * this compares each frame with what the camera typically manages (the 80th
   * percentile of the last couple of seconds). Frames blurred by hand shake or
   * by the camera refocusing fall well below that.
   */
  function updateFocus(raw) {
    const f = state.focus;
    f.raw = raw;
    f.history.push(raw);
    if (f.history.length > CONFIG.focusWindow) f.history.shift();
    const sorted = f.history.slice().sort((a, b) => a - b);
    f.typical = sorted[Math.floor((sorted.length - 1) * 0.8)] || raw;
    const rel = f.typical > 0 ? raw / f.typical : 0;
    f.rel = f.rel * 0.4 + rel * 0.6;
    f.sharp = f.rel >= CONFIG.relSharpness && raw >= CONFIG.minSharpness;
    f.log.push(f.sharp);
    if (f.log.length > CONFIG.autoFrames) f.log.shift();

    const level = raw < CONFIG.minSharpness ? 0.3 * raw / CONFIG.minSharpness : Math.min(1, f.rel);
    el.focusFill.style.width = Math.round(level * 100) + '%';
    el.focusFill.style.background = f.sharp ? '#34d058' : level > 0.5 ? '#ffb020' : '#ff5b4f';
  }

  /** True when at least half of the recent frames were sharp. */
  function mostlySharp() {
    const log = state.focus.log;
    return log.length > 0 && log.filter(Boolean).length * 2 >= Math.min(log.length, CONFIG.autoFrames);
  }

  function updateAuto(hasPage, steady, motion) {
    const a = state.auto;
    const now = performance.now();
    if (!a.armed) {
      // Wait for the page to be moved or swapped before capturing again.
      if (motion > CONFIG.rearmMotion || !hasPage) a.disturbed++;
      if (a.disturbed >= 2 && now - a.lastCapture > CONFIG.cooldownMs) {
        a.armed = true;
        a.disturbed = 0;
      }
    }
    // Every frame doesn't have to be sharp: the capture burst keeps the sharpest one.
    const ready = hasPage && !state.quadCut && steady && mostlySharp();
    a.count = ready ? a.count + 1 : 0;
    const progress = state.autoEnabled && a.armed ? Math.min(1, a.count / CONFIG.autoFrames) : 0;
    el.captureBtn.style.setProperty('--p', progress.toFixed(2));
    if (state.autoEnabled && a.armed && a.count >= CONFIG.autoFrames) capture();
  }

  function setStatus(text, kind) {
    if (el.statusText.textContent !== text) el.statusText.textContent = text;
    el.statusPill.className = 'status-pill ' + (kind || '');
  }

  function updateStatus(steady) {
    const a = state.auto;
    const sinceCapture = performance.now() - a.justCaptured;
    if (sinceCapture < 1800) {
      setStatus('Page ' + a.captured + ' captured' + (state.autoEnabled ? ' — show the next page' : ''), 'good');
    } else if (!state.quad) {
      setStatus(state.cvReady ? 'Hold a page up to the camera' : 'Frame the page, then capture', state.cvReady ? '' : 'warn');
    } else if (state.quadCut) {
      setStatus('Move the page back so all four corners are in view', 'warn');
    } else if (!steady) {
      setStatus('Hold steady…', 'warn');
    } else if (!mostlySharp()) {
      setStatus('Blurry — hold still a moment', 'warn');
    } else if (state.autoEnabled && !a.armed) {
      setStatus('Captured — show the next page', 'good');
    } else {
      setStatus(state.autoEnabled ? 'Hold still — capturing' : 'Looks good — press Space', 'good');
    }
  }

  function videoRect() {
    const cw = el.overlay.clientWidth, ch = el.overlay.clientHeight;
    const vw = el.video.videoWidth || 16, vh = el.video.videoHeight || 9;
    const s = Math.min(cw / vw, ch / vh);
    return { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s, cw, ch };
  }

  function drawOverlay(steady) {
    const c = el.overlay;
    const dpr = window.devicePixelRatio || 1;
    const r = videoRect();
    if (c.width !== Math.round(r.cw * dpr) || c.height !== Math.round(r.ch * dpr)) {
      c.width = Math.round(r.cw * dpr);
      c.height = Math.round(r.ch * dpr);
    }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.cw, r.ch);

    if (!state.quad) {
      // Corner guides showing roughly where to hold the page.
      const gh = r.h * 0.8, gw = Math.min(r.w * 0.8, gh * 0.78);
      const gx = r.x + (r.w - gw) / 2, gy = r.y + (r.h - gh) / 2, L = Math.min(gw, gh) * 0.12;
      ctx.strokeStyle = 'rgba(255,255,255,.55)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      [[gx, gy, 1, 1], [gx + gw, gy, -1, 1], [gx + gw, gy + gh, -1, -1], [gx, gy + gh, 1, -1]].forEach(([x, y, dx, dy]) => {
        ctx.moveTo(x + dx * L, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + dy * L);
      });
      ctx.stroke();
      return;
    }

    const ready = !state.quadCut && steady && mostlySharp();
    const pts = state.quad.map(p => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
    const color = ready ? '52,208,88' : state.quadCut ? '255,176,32' : '138,180,248';
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(' + color + ',.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgb(' + color + ')';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  // ===========================================================================
  // Capturing & importing pages
  // ===========================================================================

  // Reused between captures: the sharpest frame of a burst, and a scratch frame.
  let burstBest = null, burstScratch = null;

  function nextVideoFrame(v) {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, 100);
      if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    });
  }

  /** Grabs a few frames in a row and keeps the sharpest, so hand shake doesn't blur the scan. */
  async function grabSharpestFrame() {
    const v = el.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!burstBest || burstBest.width !== vw || burstBest.height !== vh) {
      burstBest = Vision.createCanvas(vw, vh);
      burstScratch = Vision.createCanvas(vw, vh);
    }
    const r = focusRegion(vw, vh);
    let bestScore = -1;
    for (let i = 0; i < CONFIG.burstFrames; i++) {
      if (i) await nextVideoFrame(v);
      const ctx = Vision.ctx2d(burstScratch);
      ctx.drawImage(v, 0, 0);
      const score = Vision.sharpness(ctx.getImageData(r.x, r.y, r.w, r.h));
      if (score > bestScore) {
        bestScore = score;
        [burstBest, burstScratch] = [burstScratch, burstBest];
      }
    }
    return burstBest;
  }

  async function capture() {
    const v = el.video;
    if (!v.videoWidth || state.capturing) return;
    state.capturing = true;
    try {
      const vw = v.videoWidth, vh = v.videoHeight;
      const quad = state.quad;
      el.flash.classList.remove('go');
      void el.flash.offsetWidth;
      el.flash.classList.add('go');
      shutterSound();
      const canvas = await grabSharpestFrame();

      const a = state.auto;
      a.armed = false;
      a.count = 0;
      a.disturbed = 0;
      a.lastCapture = a.justCaptured = performance.now();
      a.captured = state.pages.length + 1;
      el.captureBtn.style.setProperty('--p', 0);

      const corners = quad ? quad.map(p => ({ x: p.x * vw, y: p.y * vh })) : null;
      const blob = await toBlob(canvas, 'image/jpeg', 0.92);
      await addPage(blob, vw, vh, corners);
    } catch (err) {
      console.error(err);
      toast("Couldn't capture that page. Please try again.");
    } finally {
      state.capturing = false;
    }
  }

  async function importFiles(files) {
    const images = Array.from(files || []).filter(f => /^image\//.test(f.type));
    if (!images.length) {
      toast('Please choose image files (JPG, PNG, HEIC is not supported).');
      return;
    }
    for (const file of images) {
      try {
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const s = Math.min(1, CONFIG.maxSourceDim / Math.max(bmp.width, bmp.height));
        const canvas = Vision.createCanvas(bmp.width * s, bmp.height * s);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close();
        const corners = detectInImage(canvas);
        const blob = await toBlob(canvas, 'image/jpeg', 0.92);
        await addPage(blob, canvas.width, canvas.height, corners);
      } catch (err) {
        console.error(err);
        toast("Couldn't read " + file.name + '.');
      }
    }
  }

  /** Runs page detection on a still image. Returns corners in its pixels, or null. */
  function detectInImage(source) {
    if (!state.cvReady) return null;
    const w = 720, h = Math.round(source.height * w / source.width);
    const c = Vision.createCanvas(w, h);
    const ctx = Vision.ctx2d(c);
    ctx.drawImage(source, 0, 0, w, h);
    try {
      const q = Vision.detectQuad(ctx.getImageData(0, 0, w, h), 0.08);
      const s = source.width / w;
      return q ? q.map(p => ({ x: p.x * s, y: p.y * s })) : null;
    } catch (err) {
      return null;
    }
  }

  async function addPage(blob, w, h, corners) {
    const page = {
      id: uid(), blob, w, h,
      autoCorners: corners,
      corners: corners || Vision.fullFrame(w, h),
      rotation: 0,
      filter: state.defaultFilter,
      removeFingers: state.removeFingers,
      isNew: true,
      version: 0
    };
    state.pages.push(page);
    renderPages();
    await processPage(page);
    renderPages();
  }

  /** Crop → straighten → rotate → remove fingers → clean up. Results are cached on the page. */
  function processPage(page) {
    const version = ++page.version;
    page.pending = (async () => {
      const bmp = await createImageBitmap(page.blob);
      try {
        let out = Vision.warp(bmp, page.corners, CONFIG.maxOutputDim);
        out = Vision.rotate(out, page.rotation);
        page.fingersFound = page.removeFingers ? Vision.removeFingers(out) > 0 : false;
        Vision.applyFilter(out, page.filter);
        if (version !== page.version) return; // superseded by a newer edit
        page.outUrl = out.toDataURL('image/jpeg', page.filter === 'bw' ? 0.8 : CONFIG.jpegQuality);
        page.outW = out.width;
        page.outH = out.height;
        const t = Vision.createCanvas(220, 220 * out.height / out.width);
        const tctx = t.getContext('2d');
        tctx.imageSmoothingQuality = 'high';
        tctx.drawImage(out, 0, 0, t.width, t.height);
        page.thumbUrl = t.toDataURL('image/jpeg', 0.8);
      } finally {
        bmp.close();
      }
    })();
    return page.pending;
  }

  // ===========================================================================
  // Page list
  // ===========================================================================

  let dragId = null;

  function renderPages() {
    const n = state.pages.length;
    el.pageCount.textContent = n;
    el.clearBtn.classList.toggle('hidden', !n);
    el.saveBtn.disabled = !n;
    updateSaveButtonLabel();

    if (!n) {
      el.pageList.innerHTML = '<div class="empty">' + ICONS.pages +
        '<div>Captured pages will appear here.</div></div>';
      return;
    }
    el.pageList.innerHTML = state.pages.map((p, i) =>
      '<div class="thumb' + (p.isNew ? ' new' : '') + '" draggable="true" data-id="' + p.id + '" tabindex="0" ' +
      'role="button" aria-label="Edit page ' + (i + 1) + '">' +
      (p.thumbUrl ? '<img src="' + p.thumbUrl + '" alt="">' : '<div class="spinner"></div>') +
      '<span class="num">' + (i + 1) + '</span>' +
      '<button class="del" type="button" title="Delete page" aria-label="Delete page ' + (i + 1) + '">×</button>' +
      '</div>').join('');
    state.pages.forEach(p => { if (p.thumbUrl) p.isNew = false; });
    el.pageList.scrollTop = el.pageList.scrollHeight;
  }

  el.pageList.addEventListener('click', e => {
    const thumb = e.target.closest('.thumb');
    if (!thumb) return;
    if (e.target.closest('.del')) deletePage(thumb.dataset.id);
    else openEditor(thumb.dataset.id);
  });
  el.pageList.addEventListener('keydown', e => {
    const thumb = e.target.closest('.thumb');
    if (!thumb) return;
    if (e.key === 'Enter') { e.preventDefault(); openEditor(thumb.dataset.id); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deletePage(thumb.dataset.id); }
  });
  el.pageList.addEventListener('dragstart', e => {
    const thumb = e.target.closest('.thumb');
    if (!thumb) return;
    dragId = thumb.dataset.id;
    thumb.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  el.pageList.addEventListener('dragover', e => {
    if (!dragId) return;
    e.preventDefault();
    const thumb = e.target.closest('.thumb');
    el.pageList.querySelectorAll('.drop-before,.drop-after').forEach(t => t.classList.remove('drop-before', 'drop-after'));
    if (thumb && thumb.dataset.id !== dragId) {
      const r = thumb.getBoundingClientRect();
      thumb.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
    }
  });
  el.pageList.addEventListener('drop', e => {
    if (!dragId) return;
    e.preventDefault();
    e.stopPropagation();
    const target = el.pageList.querySelector('.drop-before,.drop-after');
    if (target) {
      const from = state.pages.findIndex(p => p.id === dragId);
      const [moved] = state.pages.splice(from, 1);
      let to = state.pages.findIndex(p => p.id === target.dataset.id);
      if (target.classList.contains('drop-after')) to++;
      state.pages.splice(to, 0, moved);
    }
    dragId = null;
    renderPages();
  });
  el.pageList.addEventListener('dragend', () => { dragId = null; renderPages(); });

  function deletePage(id) {
    const index = state.pages.findIndex(p => p.id === id);
    if (index < 0) return;
    const [page] = state.pages.splice(index, 1);
    renderPages();
    toast('Page ' + (index + 1) + ' deleted', 'Undo', () => {
      state.pages.splice(Math.min(index, state.pages.length), 0, page);
      renderPages();
    });
  }

  function clearPages() {
    const removed = state.pages;
    state.pages = [];
    renderPages();
    return removed;
  }

  // ===========================================================================
  // Page editor (corners, rotation, look, order)
  // ===========================================================================

  const editor = { page: null, bmp: null, drag: -1, layout: null };
  const SVG_NS = 'http://www.w3.org/2000/svg';

  async function openEditor(id) {
    const page = state.pages.find(p => p.id === id);
    if (!page) return;
    if (editor.bmp) editor.bmp.close();
    editor.page = page;
    editor.bmp = await createImageBitmap(page.blob);
    openModal(el.editorModal);
    refreshEditor();
    requestAnimationFrame(layoutEditor);
  }

  function closeEditor() {
    if (editor.bmp) editor.bmp.close();
    editor.bmp = null;
    editor.page = null;
    renderPages();
  }

  function refreshEditor() {
    const page = editor.page;
    const i = state.pages.indexOf(page);
    el.edTitle.textContent = 'Page ' + (i + 1) + ' of ' + state.pages.length;
    el.edPrev.disabled = i <= 0;
    el.edNext.disabled = i >= state.pages.length - 1;
    el.edEarlier.disabled = i <= 0;
    el.edLater.disabled = i >= state.pages.length - 1;
    el.filterSeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.filter === page.filter));
    el.edFingers.checked = page.removeFingers;
    showPreview();
  }

  async function showPreview() {
    const page = editor.page;
    el.previewSpin.classList.remove('hidden');
    try { await page.pending; } catch (err) { /* shown below */ }
    if (editor.page !== page) return;
    el.previewSpin.classList.add('hidden');
    if (page.outUrl) el.previewImg.src = page.outUrl;
  }

  function layoutEditor() {
    if (!editor.bmp) return;
    const area = el.cropArea;
    const aw = area.clientWidth, ah = area.clientHeight;
    const iw = editor.bmp.width, ih = editor.bmp.height;
    const s = Math.min(aw / iw, ah / ih);
    const w = Math.round(iw * s), h = Math.round(ih * s);
    const left = Math.round((aw - w) / 2), top = Math.round((ah - h) / 2);
    const dpr = window.devicePixelRatio || 1;
    editor.layout = { s, w, h, left, top };

    const c = el.cropCanvas;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    Object.assign(c.style, { width: w + 'px', height: h + 'px', left: left + 'px', top: top + 'px' });
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(editor.bmp, 0, 0, c.width, c.height);

    const svg = el.cropSvg;
    svg.setAttribute('viewBox', '0 0 ' + iw + ' ' + ih);
    svg.setAttribute('preserveAspectRatio', 'none');
    Object.assign(svg.style, { width: w + 'px', height: h + 'px', left: left + 'px', top: top + 'px' });
    drawHandles();
  }

  function drawHandles() {
    const page = editor.page, L = editor.layout;
    if (!page || !L) return;
    const iw = editor.bmp.width, ih = editor.bmp.height;
    const pts = page.corners.map(p => p.x + ',' + p.y).join(' ');
    const r = 9 / L.s, hit = 24 / L.s;
    let html = '<path class="shade" d="M0 0H' + iw + 'V' + ih + 'H0Z M' +
      page.corners.map(p => p.x + ' ' + p.y).join(' L') + 'Z"/>' +
      '<polygon class="edge" points="' + pts + '"/>';
    page.corners.forEach((p, i) => {
      html += '<circle class="hit" data-i="' + i + '" cx="' + p.x + '" cy="' + p.y + '" r="' + hit + '"/>' +
        '<circle class="handle" data-i="' + i + '" cx="' + p.x + '" cy="' + p.y + '" r="' + r + '"/>';
    });
    el.cropSvg.innerHTML = html;
  }

  function pointerToImage(e) {
    const rect = el.cropSvg.getBoundingClientRect();
    const iw = editor.bmp.width, ih = editor.bmp.height;
    return {
      x: Math.max(0, Math.min(iw, (e.clientX - rect.left) / rect.width * iw)),
      y: Math.max(0, Math.min(ih, (e.clientY - rect.top) / rect.height * ih))
    };
  }

  el.cropSvg.addEventListener('pointerdown', e => {
    const i = e.target.getAttribute && e.target.getAttribute('data-i');
    if (i == null) return;
    editor.drag = Number(i);
    el.cropSvg.setPointerCapture(e.pointerId);
    el.cropArea.classList.add('dragging');
    e.preventDefault();
  });
  el.cropSvg.addEventListener('pointermove', e => {
    if (editor.drag < 0) return;
    const p = pointerToImage(e);
    editor.page.corners[editor.drag] = p;
    drawHandles();
    drawLoupe(p);
  });
  const endDrag = () => {
    if (editor.drag < 0) return;
    editor.drag = -1;
    el.cropArea.classList.remove('dragging');
    el.loupe.classList.add('hidden');
    editor.page.corners = Vision.orderCorners(editor.page.corners);
    drawHandles();
    reprocess();
  };
  el.cropSvg.addEventListener('pointerup', endDrag);
  el.cropSvg.addEventListener('pointercancel', endDrag);

  /** Magnified view under the corner being dragged, for precise placement. */
  function drawLoupe(p) {
    const L = editor.layout, lc = el.loupe, size = lc.width;
    const zoom = 3;
    const srcSize = size / (L.s * zoom);
    const ctx = lc.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(editor.bmp, p.x - srcSize / 2, p.y - srcSize / 2, srcSize, srcSize, 0, 0, size, size);
    ctx.strokeStyle = '#1a73e8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
    ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
    ctx.stroke();

    const sx = L.left + p.x * L.s, sy = L.top + p.y * L.s;
    const offset = 90;
    let lx = sx - size / 2, ly = sy - size - offset / 2;
    if (ly < 0) ly = sy + offset / 2;
    lx = Math.max(0, Math.min(el.cropArea.clientWidth - size, lx));
    lc.style.left = lx + 'px';
    lc.style.top = ly + 'px';
    lc.classList.remove('hidden');
  }

  async function reprocess(page = editor.page) {
    const p = processPage(page);
    if (page === editor.page) showPreview();
    await p;
    renderPages();
  }

  function moveEditorPage(delta) {
    const i = state.pages.indexOf(editor.page);
    const j = i + delta;
    if (j < 0 || j >= state.pages.length) return;
    state.pages.splice(i, 1);
    state.pages.splice(j, 0, editor.page);
    refreshEditor();
  }

  async function gotoEditorPage(delta) {
    const i = state.pages.indexOf(editor.page) + delta;
    if (i >= 0 && i < state.pages.length) {
      await openEditor(state.pages[i].id);
    }
  }

  el.filterSeg.addEventListener('click', e => {
    const b = e.target.closest('button[data-filter]');
    if (!b || !editor.page) return;
    editor.page.filter = state.defaultFilter = b.dataset.filter;
    store('filter', state.defaultFilter);
    refreshEditor();
    reprocess();
  });
  el.edApplyAll.addEventListener('click', () => {
    const f = editor.page.filter;
    state.pages.forEach(p => {
      if (p.filter !== f) { p.filter = f; reprocess(p); }
    });
    toast('All pages now use the ' + el.filterSeg.querySelector('.active').textContent + ' look');
  });
  el.edFingers.addEventListener('change', () => {
    editor.page.removeFingers = state.removeFingers = el.edFingers.checked;
    store('removeFingers', state.removeFingers);
    reprocess();
  });
  el.edRotL.addEventListener('click', () => { editor.page.rotation -= 90; reprocess(); });
  el.edRotR.addEventListener('click', () => { editor.page.rotation += 90; reprocess(); });
  el.edAuto.addEventListener('click', () => {
    const page = editor.page;
    const corners = page.autoCorners || detectInImage(editor.bmp);
    if (!corners) {
      toast(state.cvReady ? "Couldn't find the page edges — drag the corners instead." : 'Edge detection is not available.');
      return;
    }
    page.autoCorners = corners;
    page.corners = corners.map(p => ({ ...p }));
    drawHandles();
    reprocess();
  });
  el.edFull.addEventListener('click', () => {
    editor.page.corners = Vision.fullFrame(editor.bmp.width, editor.bmp.height);
    drawHandles();
    reprocess();
  });
  el.edEarlier.addEventListener('click', () => moveEditorPage(-1));
  el.edLater.addEventListener('click', () => moveEditorPage(1));
  el.edPrev.addEventListener('click', () => gotoEditorPage(-1));
  el.edNext.addEventListener('click', () => gotoEditorPage(1));
  el.edDelete.addEventListener('click', () => {
    const id = editor.page.id;
    closeModal(el.editorModal);
    deletePage(id);
  });
  window.addEventListener('resize', () => { if (editor.page) layoutEditor(); });

  // ===========================================================================
  // Save: Drive destination
  // ===========================================================================

  function updateSaveButtonLabel() {
    el.saveBtn.textContent = state.cls.target ? 'Turn in to Classroom' : 'Save to Drive';
  }

  function defaultFileName() {
    if (state.saveTab === 'classroom' && state.cls.selected) return state.cls.selected.title;
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return 'Scan ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + '.' + pad(d.getMinutes());
  }

  async function openSave() {
    if (!state.pages.length || state.openModals.length) return;
    el.saveError.classList.add('hidden');
    el.browser.classList.add('hidden');
    setSaveTab(state.cls.target ? 'classroom' : state.saveTab);
    el.fileName.value = defaultFileName();
    el.fileName.dataset.auto = '1';
    renderDest();
    openModal(el.saveModal);
    el.fileName.focus();
    el.fileName.select();
    el.saveSize.textContent = '';
    await Promise.all(state.pages.map(p => p.pending));
    const bytes = state.pages.reduce((s, p) => s + (p.outUrl ? p.outUrl.length * 0.75 : 0), 0);
    el.saveSize.textContent = state.pages.length + (state.pages.length === 1 ? ' page' : ' pages') + ' · ' + formatBytes(bytes);
  }

  el.fileName.addEventListener('input', () => { el.fileName.dataset.auto = ''; });

  function setSaveTab(tab) {
    state.saveTab = tab;
    el.saveModal.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    el.tabDrive.classList.toggle('hidden', tab !== 'drive');
    el.tabClassroom.classList.toggle('hidden', tab !== 'classroom');
    el.confirmSave.textContent = tab === 'classroom'
      ? (el.turnInCheck.checked ? 'Turn in' : 'Attach') : 'Save';
    if (tab === 'classroom') ensureCourses();
    if (el.fileName.dataset.auto) el.fileName.value = defaultFileName();
  }

  el.saveModal.querySelectorAll('[data-tab]').forEach(b =>
    b.addEventListener('click', () => setSaveTab(b.dataset.tab)));

  function rememberFolder(folder) {
    const entry = { id: folder.id, name: folder.name, path: folder.path || folder.name };
    state.recent = [entry].concat(state.recent.filter(f => f.id !== entry.id)).slice(0, MAX_RECENT_FOLDERS);
    store('recentFolders', state.recent);
  }

  function forgetFolder(id) {
    state.recent = state.recent.filter(f => f.id !== id);
    store('recentFolders', state.recent);
    if (state.dest && state.dest.id === id) setDest(null);
  }

  function setDest(dest) {
    state.dest = dest;
    store('dest', dest);
    renderDest();
  }

  function renderDest() {
    const d = state.dest || ROOT;
    el.destName.textContent = d.name;
    el.destPath.textContent = d.path || '';
    el.destPath.classList.toggle('hidden', !d.path || d.path === d.name);

    const chips = state.recent.slice();
    if (!chips.some(f => f.id === ROOT.id)) chips.push(ROOT);
    el.recentWrap.classList.toggle('hidden', chips.length < 2);
    el.recentChips.innerHTML = chips.map(f =>
      '<button type="button" data-id="' + esc(f.id) + '" title="' + esc(f.path || f.name) + '" class="' +
      (f.id === d.id ? 'active' : '') + '">' + (f.id === ROOT.id ? ICONS.drive : ICONS.folder) +
      '<span>' + esc(f.name) + '</span></button>').join('');
  }

  el.recentChips.addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    const f = state.recent.find(x => x.id === b.dataset.id) || ROOT;
    setDest(f);
    el.browser.classList.add('hidden');
  });

  el.browseBtn.addEventListener('click', () => {
    const open = el.browser.classList.toggle('hidden') === false;
    if (open) {
      el.folderSearch.value = '';
      browseTo((state.dest && state.dest.id) || null);
    }
  });

  let browseSeq = 0;
  async function browseTo(id) {
    const seq = ++browseSeq;
    el.newFolderRow.classList.add('hidden');
    el.folderList.innerHTML = '<li class="msg">Loading…</li>';
    try {
      const data = await server('listFolder', id);
      if (seq !== browseSeq) return;
      state.browse = data;
      el.crumbs.innerHTML = data.path.map((p, i) =>
        (i ? '<span class="sep">›</span>' : '') + '<button type="button" data-id="' + esc(p.id) + '">' + esc(p.name) + '</button>').join('');
      el.crumbs.classList.remove('hidden');
      el.useFolderBtn.textContent = data.selectable === false ? 'Open a shared drive to save in it' : 'Save in "' + data.name + '"';
      el.useFolderBtn.disabled = data.selectable === false;
      el.newFolderBtn.disabled = data.selectable === false;
      el.folderList.innerHTML = data.children.length
        ? data.children.map(f => '<li><button type="button" data-id="' + esc(f.id) + '">' + ICONS.folder +
          '<span class="name">' + esc(f.name) + '</span>' + ICONS.chevron + '</button></li>').join('')
        : '<li class="msg">No folders inside. You can save here or create a new folder.</li>';
    } catch (err) {
      if (seq === browseSeq) el.folderList.innerHTML = '<li class="msg">' + esc(friendlyError(err)) + '</li>';
    }
  }

  let searchTimer = null;
  el.folderSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = el.folderSearch.value.trim();
    if (!q) { browseTo(state.browse ? state.browse.id : null); return; }
    searchTimer = setTimeout(async () => {
      const seq = ++browseSeq;
      el.folderList.innerHTML = '<li class="msg">Searching…</li>';
      el.crumbs.classList.add('hidden');
      el.useFolderBtn.disabled = true;
      try {
        const results = await server('searchFolders', q);
        if (seq !== browseSeq) return;
        el.folderList.innerHTML = results.length
          ? results.map(f => '<li><button type="button" data-id="' + esc(f.id) + '">' + ICONS.folder +
            '<span class="name">' + esc(f.name) + (f.parent ? '<div class="sub">in ' + esc(f.parent) + '</div>' : '') +
            '</span>' + ICONS.chevron + '</button></li>').join('')
          : '<li class="msg">No folders match "' + esc(q) + '".</li>';
      } catch (err) {
        if (seq === browseSeq) el.folderList.innerHTML = '<li class="msg">' + esc(friendlyError(err)) + '</li>';
      }
    }, 300);
  });

  el.folderList.addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (!b) return;
    el.folderSearch.value = '';
    browseTo(b.dataset.id);
  });
  el.crumbs.addEventListener('click', e => {
    const b = e.target.closest('button[data-id]');
    if (b) browseTo(b.dataset.id);
  });
  el.useFolderBtn.addEventListener('click', () => {
    const b = state.browse;
    if (!b || b.selectable === false) return;
    setDest({ id: b.id, name: b.name, path: b.path.map(p => p.name).join(' › ') });
    el.browser.classList.add('hidden');
  });
  el.newFolderBtn.addEventListener('click', () => {
    el.newFolderRow.classList.toggle('hidden');
    el.newFolderName.value = '';
    el.newFolderName.focus();
  });
  async function createFolder() {
    const name = el.newFolderName.value.trim();
    if (!name || !state.browse) return;
    el.newFolderCreate.disabled = true;
    try {
      const f = await server('createFolder', state.browse.id, name);
      setDest({ id: f.id, name: f.name, path: f.path.map(p => p.name).join(' › ') });
      el.browser.classList.add('hidden');
      toast('Created folder "' + f.name + '"');
    } catch (err) {
      toast(friendlyError(err));
    } finally {
      el.newFolderCreate.disabled = false;
    }
  }
  el.newFolderCreate.addEventListener('click', createFolder);
  el.newFolderName.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); createFolder(); } });

  // ===========================================================================
  // Save: Google Classroom
  // ===========================================================================

  async function ensureCourses() {
    const cls = state.cls;
    if (cls.courses || cls.loadingCourses) { renderCourses(); return; }
    cls.loadingCourses = true;
    el.courseSelect.innerHTML = '<option>Loading classes…</option>';
    el.courseSelect.disabled = true;
    el.assignmentList.innerHTML = '';
    try {
      cls.courses = await server('getStudentCourses');
      cls.error = null;
    } catch (err) {
      cls.error = friendlyError(err);
    } finally {
      cls.loadingCourses = false;
    }
    renderCourses();
  }

  function renderCourses() {
    const cls = state.cls;
    if (cls.loadingCourses) return;
    if (cls.error || !cls.courses) {
      el.courseSelect.innerHTML = '<option>Unavailable</option>';
      el.courseSelect.disabled = true;
      el.assignmentList.innerHTML = '<div class="msg">' + esc(cls.error || 'Classroom is not available.') + '</div>';
      return;
    }
    if (!cls.courses.length) {
      el.courseSelect.innerHTML = '<option>No classes</option>';
      el.courseSelect.disabled = true;
      el.assignmentList.innerHTML = "<div class=\"msg\">You aren't enrolled as a student in any active classes.</div>";
      return;
    }
    el.courseSelect.disabled = false;
    if (!cls.courseId || !cls.courses.some(c => c.id === cls.courseId)) {
      cls.courseId = store('course') || cls.courses[0].id;
      if (!cls.courses.some(c => c.id === cls.courseId)) cls.courseId = cls.courses[0].id;
    }
    el.courseSelect.innerHTML = cls.courses.map(c =>
      '<option value="' + esc(c.id) + '">' + esc(c.name + (c.section ? ' — ' + c.section : '')) + '</option>').join('');
    el.courseSelect.value = cls.courseId;
    loadAssignments(cls.courseId);
  }

  el.courseSelect.addEventListener('change', () => {
    state.cls.courseId = el.courseSelect.value;
    state.cls.selected = null;
    store('course', state.cls.courseId);
    loadAssignments(state.cls.courseId);
  });

  async function loadAssignments(courseId, force) {
    const cls = state.cls;
    if (!cls.assignments[courseId] || force) {
      el.assignmentList.innerHTML = '<div class="msg">Loading assignments…</div>';
      try {
        cls.assignments[courseId] = await server('getAssignments', courseId);
      } catch (err) {
        if (cls.courseId === courseId) el.assignmentList.innerHTML = '<div class="msg">' + esc(friendlyError(err)) + '</div>';
        return;
      }
    }
    if (cls.courseId !== courseId) return;
    const list = cls.assignments[courseId];
    if (cls.target && cls.target.courseId === courseId && !cls.selected) {
      cls.selected = list.find(a => a.id === cls.target.assignmentId) || null;
    }
    renderAssignments();
  }

  function canAttach(a) {
    return a.state !== 'TURNED_IN';
  }

  function renderAssignments() {
    const cls = state.cls;
    const list = cls.assignments[cls.courseId] || [];
    if (!list.length) {
      el.assignmentList.innerHTML = '<div class="msg">No assignments in this class.</div>';
      return;
    }
    el.assignmentList.innerHTML = list.map(a => {
      const [label, kind] = STATE_LABELS[a.state] || [a.state, ''];
      const missing = a.due && new Date(a.due) < new Date() && canAttach(a) && a.state !== 'RETURNED';
      const sel = cls.selected && cls.selected.id === a.id;
      return '<label class="assignment' + (sel ? ' selected' : '') + (canAttach(a) ? '' : ' disabled') + '" data-id="' + esc(a.id) + '">' +
        '<input type="radio" name="assignment" ' + (sel ? 'checked ' : '') + (canAttach(a) ? '' : 'disabled ') + '>' +
        '<div class="a-main"><div class="a-title">' + esc(a.title) + '</div>' +
        '<div class="a-meta"><span>' + esc(formatDue(a.due)) + '</span>' +
        '<span class="badge ' + (missing ? 'bad' : kind) + '">' + (missing ? 'Missing' : label) + '</span>' +
        (a.oneClick ? '<span class="badge accent">⚡ One-click turn in</span>' : '<span class="badge">Finish in Classroom</span>') +
        '</div>' + (canAttach(a) ? '' : '<div class="a-meta">Already turned in. Unsubmit it in Classroom to add more.</div>') +
        '</div></label>';
    }).join('');
  }

  el.assignmentList.addEventListener('click', e => {
    const row = e.target.closest('.assignment');
    if (!row || row.classList.contains('disabled')) return;
    const list = state.cls.assignments[state.cls.courseId] || [];
    state.cls.selected = list.find(a => a.id === row.dataset.id) || null;
    if (el.fileName.dataset.auto && state.cls.selected) el.fileName.value = state.cls.selected.title;
    renderAssignments();
  });

  el.turnInCheck.addEventListener('change', () => setSaveTab(state.saveTab));

  /** Opened with ?course=…&assignment=… (a teacher's scanner link). */
  async function setTarget(courseId, assignmentId) {
    const cls = state.cls;
    cls.target = { courseId, assignmentId };
    cls.courseId = courseId;
    state.saveTab = 'classroom';
    updateSaveButtonLabel();
    el.targetTitle.textContent = 'a Classroom assignment';
    el.targetBanner.classList.remove('hidden');
    refreshTarget();
  }

  /** Fills in the banner once we're signed in and can ask Classroom. */
  async function refreshTarget() {
    const cls = state.cls;
    if (!cls.target || !api.isSignedIn()) return;
    const { courseId, assignmentId } = cls.target;
    try {
      await ensureCourses();
      await loadAssignments(courseId);
      const course = (cls.courses || []).find(c => c.id === courseId);
      const a = (cls.assignments[courseId] || []).find(x => x.id === assignmentId);
      if (a) {
        el.targetTitle.textContent = a.title;
        el.targetCourse.textContent = course ? '· ' + course.name : '';
      }
    } catch (err) { /* the banner stays generic */ }
  }

  el.targetClear.addEventListener('click', () => {
    state.cls.target = null;
    state.saveTab = 'drive';
    el.targetBanner.classList.add('hidden');
    updateSaveButtonLabel();
  });

  // ===========================================================================
  // Save: submit
  // ===========================================================================

  async function confirmSave() {
    const name = el.fileName.value.trim();
    const showError = msg => {
      el.saveError.textContent = msg;
      el.saveError.classList.remove('hidden');
    };
    el.saveError.classList.add('hidden');
    if (!name) { showError('Please enter a file name.'); el.fileName.focus(); return; }

    const assignment = state.cls.selected;
    if (state.saveTab === 'classroom' && !assignment) { showError('Please pick an assignment.'); return; }

    el.saveBusy.classList.remove('hidden');
    el.saveBusyText.textContent = 'Preparing pages…';
    try {
      await Promise.all(state.pages.map(p => p.pending));
      const pages = state.pages.map(p => ({ data: p.outUrl.split(',')[1], width: p.outW, height: p.outH }));
      const bytes = pages.reduce((s, p) => s + p.data.length, 0);
      if (bytes > CONFIG.maxUploadBytes) {
        throw new Error('This scan is too large to upload at once. Try the B&W look or save fewer pages.');
      }
      const uploading = 'Uploading ' + pages.length + (pages.length === 1 ? ' page' : ' pages');
      const onProgress = f => { el.saveBusyText.textContent = uploading + '… ' + Math.round(f * 100) + '%'; };
      el.saveBusyText.textContent = uploading + '…';

      if (state.saveTab === 'classroom') {
        const res = await server('submitToClassroom', {
          name, pages, onProgress,
          courseId: assignment.courseId,
          courseWorkId: assignment.id,
          submissionId: assignment.submissionId,
          link: assignment.link,
          turnIn: el.turnInCheck.checked
        });
        state.cls.assignments[assignment.courseId] = null; // refresh states next time
        state.cls.selected = null;
        el.saveBusy.classList.add('hidden');
        closeModal(el.saveModal);
        showClassroomResult(res, assignment);
      } else {
        const dest = state.dest || ROOT;
        let res;
        try {
          res = await server('saveScan', { name, folderId: dest.id, pages, onProgress });
        } catch (err) {
          if (err.code === 'folder_missing') forgetFolder(dest.id);
          throw err;
        }
        rememberFolder(res.folder);
        setDest(state.recent[0]);
        el.saveBusy.classList.add('hidden');
        closeModal(el.saveModal);
        showDriveResult(res);
      }
    } catch (err) {
      el.saveBusy.classList.add('hidden');
      showError(friendlyError(err));
    }
  }

  function showResult({ kind, title, body, actions }) {
    el.resultIcon.className = 'result-icon ' + kind;
    el.resultIcon.innerHTML = kind === 'good' ? ICONS.check : ICONS.info;
    el.resultTitle.textContent = title;
    el.resultBody.innerHTML = body;
    el.resultActions.innerHTML = '';
    actions.forEach(a => {
      const node = document.createElement(a.href ? 'a' : 'button');
      node.className = 'btn block ' + (a.primary ? 'primary' : 'ghost');
      node.textContent = a.label;
      if (a.href) { node.href = a.href; node.target = '_blank'; node.rel = 'noopener'; }
      else node.type = 'button';
      node.addEventListener('click', () => { if (a.onClick) a.onClick(); if (a.close !== false) closeModal(el.resultModal); });
      el.resultActions.appendChild(node);
    });
    openModal(el.resultModal);
  }

  const newScan = () => { clearPages(); };

  function showDriveResult(res) {
    showResult({
      kind: 'good',
      title: 'Saved to ' + res.folder.name,
      body: '<p>' + esc(res.file.name) + '</p>',
      actions: [
        { label: 'Start a new scan', primary: true, onClick: newScan },
        { label: 'Open the PDF', href: res.file.url, close: false },
        { label: 'Open the folder', href: res.folder.url, close: false },
        { label: 'Keep these pages' }
      ]
    });
  }

  function showClassroomResult(res, assignment) {
    if (res.status === 'turnedIn') {
      showResult({
        kind: 'good',
        title: 'Turned in!',
        body: '<p>' + esc(res.file.name) + ' was attached to <b>' + esc(assignment.title) + '</b> and turned in.</p>',
        actions: [
          { label: 'Start a new scan', primary: true, onClick: () => { newScan(); el.targetClear.click(); } },
          { label: 'View in Classroom', href: res.link, close: false }
        ]
      });
      return;
    }
    if (res.status === 'attached') {
      showResult({
        kind: 'good',
        title: 'Attached',
        body: '<p>' + esc(res.file.name) + ' was attached to <b>' + esc(assignment.title) + '</b>' +
          (res.message ? ', but could not be turned in: ' + esc(res.message) : '. Turn it in from Classroom when you are ready.') + '</p>',
        actions: [
          { label: 'Open in Classroom', href: res.link, primary: true, close: false },
          { label: 'Start a new scan', onClick: newScan }
        ]
      });
      return;
    }
    showResult({
      kind: 'warn',
      title: 'One more step in Classroom',
      body: '<p>Your scan is saved in Drive as <b>' + esc(res.file.name) + '</b> (folder "Scanned Assignments").</p>' +
        '<ol><li>Click <b>Open assignment</b> below.</li>' +
        '<li>Under <b>Your work</b>, click <b>+ Add or create</b> → <b>Google Drive</b>.</li>' +
        '<li>Pick <b>' + esc(res.file.name) + '</b> (it is at the top of Recent).</li>' +
        '<li>Click <b>Turn in</b>.</li></ol>',
      actions: [
        { label: 'Open assignment', href: res.link, primary: true, close: false },
        { label: 'Open the PDF', href: res.file.url, close: false },
        { label: 'Start a new scan', onClick: newScan }
      ]
    });
  }

  // ===========================================================================
  // Teacher tools
  // ===========================================================================

  async function checkTeacher() {
    try {
      const courses = await server('getTeachingCourses');
      if (courses && courses.length) {
        state.teacher.courses = courses;
        el.teacherBtn.classList.remove('hidden');
      }
    } catch (err) { /* not a teacher, or Classroom unavailable */ }
  }

  function openTeacher() {
    const t = state.teacher;
    el.tCourse.innerHTML = t.courses.map(c =>
      '<option value="' + esc(c.id) + '">' + esc(c.name + (c.section ? ' — ' + c.section : '')) + '</option>').join('');
    const last = store('teachCourse');
    if (last && t.courses.some(c => c.id === last)) el.tCourse.value = last;
    el.tResult.classList.add('hidden');
    el.tError.classList.add('hidden');
    setTeacherTab('create');
    openModal(el.teacherModal);
  }

  function setTeacherTab(tab) {
    el.teacherModal.querySelectorAll('[data-ttab]').forEach(b => b.classList.toggle('active', b.dataset.ttab === tab));
    el.tCreate.classList.toggle('hidden', tab !== 'create');
    el.tLink.classList.toggle('hidden', tab !== 'link');
    el.tResult.classList.add('hidden');
    if (tab === 'link') loadTeacherWork();
  }

  async function loadTeacherWork(force) {
    const courseId = el.tCourse.value;
    const t = state.teacher;
    if (!t.work[courseId] || force) {
      el.tWorkList.innerHTML = '<div class="msg">Loading assignments…</div>';
      try {
        t.work[courseId] = await server('getCourseWorkForTeacher', courseId);
      } catch (err) {
        el.tWorkList.innerHTML = '<div class="msg">' + esc(friendlyError(err)) + '</div>';
        return;
      }
    }
    if (el.tCourse.value !== courseId) return;
    const list = t.work[courseId];
    el.tWorkList.innerHTML = list.length ? list.map(w =>
      '<div class="assignment"><div class="a-main"><div class="a-title">' + esc(w.title) + '</div>' +
      '<div class="a-meta">' + (w.oneClick ? '<span class="badge accent">⚡ One-click turn in</span>' : '<span class="badge">Students attach in Classroom</span>') +
      '</div></div><button class="btn ghost small" type="button" data-link="' + esc(w.scanLink) + '">Copy link</button></div>').join('')
      : '<div class="msg">No assignments in this class yet.</div>';
  }

  el.tWorkList.addEventListener('click', e => {
    const b = e.target.closest('button[data-link]');
    if (b) copyText(b.dataset.link, 'Scanner link copied');
  });

  async function copyText(text, message) {
    try {
      await navigator.clipboard.writeText(text);
      toast(message);
    } catch (err) {
      window.prompt('Copy this link:', text);
    }
  }

  async function createAssignment() {
    el.tError.classList.add('hidden');
    const title = el.tTitle.value.trim();
    if (!title) {
      el.tError.textContent = 'Please give the assignment a title.';
      el.tError.classList.remove('hidden');
      return;
    }
    el.tBusy.classList.remove('hidden');
    try {
      const courseId = el.tCourse.value;
      const res = await server('createScanAssignment', {
        courseId, title,
        description: el.tDesc.value.trim(),
        dueIso: el.tDue.value ? new Date(el.tDue.value).toISOString() : '',
        maxPoints: el.tPoints.value ? Number(el.tPoints.value) : 0
      });
      state.teacher.work[courseId] = null;
      el.tTitle.value = '';
      el.tDesc.value = '';
      el.tDue.value = '';
      el.tResult.innerHTML = '<b>Posted "' + esc(res.title) + '".</b> The scanner link is in the instructions, so students can open it from Classroom.' +
        '<div class="copy-row"><input type="text" readonly value="' + esc(res.scanLink) + '">' +
        '<button class="btn ghost small" type="button" id="tCopy">Copy</button></div>' +
        '<div class="copy-row"><a class="btn link small" href="' + esc(res.link) + '" target="_blank" rel="noopener">Open in Classroom ↗</a></div>';
      el.tResult.classList.remove('hidden');
      $('tCopy').addEventListener('click', () => copyText(res.scanLink, 'Scanner link copied'));
    } catch (err) {
      el.tError.textContent = friendlyError(err);
      el.tError.classList.remove('hidden');
    } finally {
      el.tBusy.classList.add('hidden');
    }
  }

  el.teacherBtn.addEventListener('click', () => signedIn(openTeacher));
  el.teacherModal.querySelectorAll('[data-ttab]').forEach(b => b.addEventListener('click', () => setTeacherTab(b.dataset.ttab)));
  el.tCourse.addEventListener('change', () => {
    store('teachCourse', el.tCourse.value);
    if (!el.tLink.classList.contains('hidden')) loadTeacherWork();
  });
  // Creating assignments needs one extra Classroom permission, asked for only here.
  el.tCreateBtn.addEventListener('click', () => signedIn(createAssignment, api.TEACHER_SCOPES));

  // ===========================================================================
  // Wiring
  // ===========================================================================

  el.captureBtn.addEventListener('click', () => capture());
  el.autoToggle.addEventListener('change', () => {
    state.autoEnabled = el.autoToggle.checked;
    store('auto', state.autoEnabled);
    state.auto.count = 0;
  });
  el.cameraSelect.addEventListener('change', () => startCamera(el.cameraSelect.value));
  el.retryCamera.addEventListener('click', () => startCamera(store('camera')));
  el.uploadBtn.addEventListener('click', () => el.fileInput.click());
  el.uploadInstead.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => {
    importFiles(el.fileInput.files);
    el.fileInput.value = '';
  });
  el.saveBtn.addEventListener('click', () => signedIn(openSave));
  el.signInBtn.addEventListener('click', () => signedIn(() => toast('Signed in as ' + api.getEmail())));
  el.signOutBtn.addEventListener('click', () => {
    api.signOut();
    state.cls = { courses: null, error: null, courseId: null, assignments: {}, selected: null, target: state.cls.target };
    state.teacher = { courses: null, work: {} };
    el.teacherBtn.classList.add('hidden');
    toast('Signed out');
  });
  el.confirmSave.addEventListener('click', confirmSave);
  el.fileName.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); confirmSave(); } });
  el.clearBtn.addEventListener('click', () => {
    const removed = clearPages();
    toast('Cleared ' + removed.length + (removed.length === 1 ? ' page' : ' pages'), 'Undo', () => {
      state.pages = removed.concat(state.pages);
      renderPages();
    });
  });
  el.helpBtn.addEventListener('click', () => openModal(el.helpModal));

  // Drag & drop photos onto the page.
  let dragDepth = 0;
  const isFileDrag = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  document.addEventListener('dragenter', e => {
    if (!isFileDrag(e)) return;
    dragDepth++;
    el.dropHint.classList.remove('hidden');
  });
  document.addEventListener('dragleave', e => {
    if (!isFileDrag(e)) return;
    if (--dragDepth <= 0) { dragDepth = 0; el.dropHint.classList.add('hidden'); }
  });
  document.addEventListener('dragover', e => { if (isFileDrag(e)) e.preventDefault(); });
  document.addEventListener('drop', e => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    dragDepth = 0;
    el.dropHint.classList.add('hidden');
    importFiles(e.dataTransfer.files);
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.openModals.length) {
      closeModal(state.openModals[state.openModals.length - 1]);
      return;
    }
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (editor.page && state.openModals[state.openModals.length - 1] === el.editorModal) {
      if (e.key === 'ArrowLeft') gotoEditorPage(-1);
      if (e.key === 'ArrowRight') gotoEditorPage(1);
      return;
    }
    if (state.openModals.length) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!el.captureBtn.disabled) capture();
    } else if (e.key === 'a' || e.key === 'A') {
      el.autoToggle.click();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      signedIn(openSave);
    }
  });

  window.addEventListener('beforeunload', e => {
    if (state.pages.length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /**
   * Macs (and iPads) have Center Stage, which pans and zooms to follow your
   * face. That moves the whole picture, so the page never looks steady.
   * Web pages can't switch it off, so explain how.
   */
  function showMacTip() {
    const apple = /Macintosh|Mac OS X|iPad/.test(navigator.userAgent);
    if (!apple || store('macTipDismissed')) return;
    el.macTip.classList.remove('hidden');
  }
  el.macTipClose.addEventListener('click', () => {
    el.macTip.classList.add('hidden');
    store('macTipDismissed', true);
  });

  // ===========================================================================
  // Sign-in
  // ===========================================================================

  /**
   * Runs `action` once signed in. Must be called straight from a click so the
   * browser lets Google's sign-in pop-up open.
   */
  function signedIn(action, extraScopes) {
    api.ensureSignedIn(extraScopes).then(action, err => {
      if (err.code === 'not_configured') {
        showResult({
          kind: 'warn',
          title: 'Setup needed',
          body: '<p>' + esc(err.message) + '</p>',
          actions: [{ label: 'OK', primary: true }]
        });
      } else {
        toast(friendlyError(err), null, null, 6000);
      }
    });
  }

  function renderAccount(signedInNow) {
    el.signInBtn.classList.toggle('hidden', signedInNow);
    el.account.classList.toggle('hidden', !signedInNow);
    el.accountEmail.textContent = api.getEmail();
    el.accountEmail.title = api.getEmail();
  }

  let wasSignedIn = false;
  api.onAuthChange(now => {
    renderAccount(now);
    if (now && !wasSignedIn) {
      refreshTarget();
      checkTeacher();
    }
    wasSignedIn = now;
  });

  // ===========================================================================
  // Start
  // ===========================================================================

  async function init() {
    const savedAuto = store('auto');
    if (typeof savedAuto === 'boolean') state.autoEnabled = el.autoToggle.checked = savedAuto;
    const savedFilter = store('filter');
    if (FILTERS.includes(savedFilter)) state.defaultFilter = savedFilter;
    if (store('removeFingers') === false) state.removeFingers = false;
    state.dest = store('dest');
    el.captureBtn.disabled = true;
    renderPages();

    loadOpenCv();
    startCamera(store('camera'));
    showMacTip();

    state.recent = store('recentFolders') || [];
    if (!state.dest) state.dest = state.recent[0] || null;
    wasSignedIn = api.isSignedIn();
    renderAccount(wasSignedIn);
    const params = urlParams();
    if (params.course && params.assignment) setTarget(params.course, params.assignment);
    if (wasSignedIn) checkTeacher();
  }

  init();
})();
