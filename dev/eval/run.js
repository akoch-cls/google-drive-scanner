#!/usr/bin/env node
/**
 * Scores page detection on frames with known corners, using the metrics from
 * the document-capture literature (SmartDoc 2015):
 *
 *   IoU          area overlap of detected vs. true page outline (1 = perfect)
 *   corner err   largest corner error ÷ true page perimeter (Tropin et al. use < 0.017 as "correct")
 *   aspect err   error of the estimated page aspect ratio, where the truth has one
 *
 * Scenes with `expect: "none"` must find nothing; `expect: "cut"` must flag the
 * page as running off the frame. Both count as false captures otherwise.
 *
 *   python3 dev/eval/make_fixtures.py          # synthetic scenes (once)
 *   node dev/eval/run.js                       # score dev/eval/fixtures
 *   node dev/eval/run.js dev/eval/private      # score your own frames (see README)
 *
 * Options: --opencv <path to opencv.js> (default: download from docs.opencv.org),
 *          --show (write annotated images next to the frames, in ./out).
 * Needs Playwright: npm install --no-save playwright
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const flag = name => { const i = args.indexOf(name); if (i >= 0) args.splice(i, 1); return i >= 0; };
const opencvPath = opt('--opencv');
const show = flag('--show');
const dir = path.resolve(args[0] || path.join(__dirname, 'fixtures'));
const docs = path.join(__dirname, '..', '..', 'docs');
const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'));

// ---- geometry -------------------------------------------------------------
const area = p => Math.abs(p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2;
const orient = p => { const s = p.reduce((t, a, i) => { const b = p[(i + 1) % p.length]; return t + a[0] * b[1] - b[0] * a[1]; }, 0); return s < 0 ? p.slice().reverse() : p; };
function clip(subject, clipper) { // Sutherland–Hodgman, convex clipper
  let out = subject;
  for (let i = 0; i < clipper.length && out.length; i++) {
    const a = clipper[i], b = clipper[(i + 1) % clipper.length];
    const inside = p => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const cross = (p, q) => {
      const x1 = p[0], y1 = p[1], x2 = q[0], y2 = q[1], x3 = a[0], y3 = a[1], x4 = b[0], y4 = b[1];
      const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / d;
      return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
    };
    const input = out; out = [];
    input.forEach((p, k) => {
      const q = input[(k + 1) % input.length];
      if (inside(q)) { if (!inside(p)) out.push(cross(p, q)); out.push(q); }
      else if (inside(p)) out.push(cross(p, q));
    });
  }
  return out;
}
function iou(a, b) {
  a = orient(a); b = orient(b);
  const inter = area(clip(a, b));
  return inter / (area(a) + area(b) - inter);
}
function cornerError(det, gt) { // best cyclic alignment, max corner distance / perimeter
  const per = gt.reduce((s, p, i) => s + Math.hypot(p[0] - gt[(i + 1) % 4][0], p[1] - gt[(i + 1) % 4][1]), 0);
  let best = Infinity;
  for (let shift = 0; shift < 4; shift++) {
    const e = Math.max(...gt.map((g, i) => Math.hypot(g[0] - det[(i + shift) % 4][0], g[1] - det[(i + shift) % 4][1])));
    best = Math.min(best, e);
  }
  return best / per;
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', e => console.error('page error:', e.message));
  await page.route('http://eval.local/**', r => {
    const p = new URL(r.request().url()).pathname;
    if (p === '/') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
    if (p === '/opencv.js' && opencvPath) return r.fulfill({ path: opencvPath, contentType: 'text/javascript' });
    if (p === '/opencv.js') return r.fulfill({ status: 302, headers: { location: 'https://docs.opencv.org/4.10.0/opencv.js' } });
    if (p.startsWith('/docs/')) return r.fulfill({ path: path.join(docs, p.slice(6)) });
    return r.fulfill({ path: path.join(dir, decodeURIComponent(p.slice(1))) });
  });
  await page.goto('http://eval.local/');
  await page.addScriptTag({ url: 'http://eval.local/opencv.js' });
  await page.waitForFunction(() => window.cv && (window.cv.Mat || window.cv.then || window.cv.onRuntimeInitialized !== undefined), null, { timeout: 120000 });
  await page.evaluate(() => new Promise(r => { if (cv.Mat) r(); else if (typeof cv.then === 'function') cv.then(m => { window.cv = m; r(); }); else cv.onRuntimeInitialized = r; }));
  await page.addScriptTag({ url: 'http://eval.local/docs/vision.js' });

  const rows = [];
  if (show) fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  for (const name of Object.keys(truth)) {
    const t = truth[name];
    const r = await page.evaluate(async ({ name, show }) => {
      const img = new Image(); img.src = '/' + encodeURIComponent(name); await img.decode();
      const full = document.createElement('canvas'); full.width = img.width; full.height = img.height;
      full.getContext('2d').drawImage(img, 0, 0);
      const t0 = performance.now();
      const res = Vision.locatePage ? Vision.locatePage(full) : (() => {
        const w = 480, h = Math.round(img.height * w / img.width);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d', { willReadFrequently: true }); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, w, h);
        const q = Vision.detectQuad(x.getImageData(0, 0, w, h));
        const s = img.width / w;
        return q && { corners: q.map(p => ({ x: p.x * s, y: p.y * s })), touchesEdge: q.touchesEdge };
      })();
      const ms = performance.now() - t0;
      let png = null;
      if (show) {
        const o = full.getContext('2d');
        if (res) { o.strokeStyle = res.touchesEdge ? '#ff9800' : '#00e676'; o.lineWidth = 4; o.beginPath(); res.corners.forEach((p, i) => i ? o.lineTo(p.x, p.y) : o.moveTo(p.x, p.y)); o.closePath(); o.stroke(); }
        png = full.toDataURL('image/png').split(',')[1];
      }
      const aspect = res && Vision.estimateAspect ? Vision.estimateAspect(res.corners, img.width, img.height) : null;
      return { ms, png, corners: res && res.corners.map(p => [p.x, p.y]), touchesEdge: !!(res && res.touchesEdge), aspect };
    }, { name, show });
    if (r.png) fs.writeFileSync(path.join(dir, 'out', name.replace(/\.\w+$/, '.png')), Buffer.from(r.png, 'base64'));
    const row = { name, ms: Math.round(r.ms) };
    if (t.expect === 'none') row.ok = !r.corners, row.note = r.corners ? 'FALSE DETECTION' : 'nothing found (correct)';
    else if (t.expect === 'cut') row.ok = !r.corners || r.touchesEdge, row.note = !r.corners ? 'nothing found' : r.touchesEdge ? 'flagged as cut off (correct)' : 'NOT FLAGGED AS CUT OFF';
    else if (!r.corners) row.ok = false, row.note = 'MISSED';
    else {
      row.iou = iou(r.corners, t.corners);
      row.err = cornerError(r.corners, t.corners);
      row.ok = row.iou > 0.9;
      if (t.aspect && r.aspect) row.aspectErr = Math.abs(r.aspect.ratio - t.aspect) / t.aspect;
      row.note = (row.iou > 0.9 ? '' : 'POOR ') + (r.touchesEdge ? '(flagged cut) ' : '');
    }
    rows.push(row);
  }
  await browser.close();

  const pad = (s, n) => String(s).padEnd(n);
  console.log(pad('frame', 34) + pad('IoU', 8) + pad('corner err', 12) + pad('aspect err', 12) + pad('ms', 6) + 'note');
  rows.forEach(r => console.log(pad(r.name, 34) + pad(r.iou != null ? r.iou.toFixed(3) : '–', 8) + pad(r.err != null ? r.err.toFixed(4) : '–', 12) +
    pad(r.aspectErr != null ? (r.aspectErr * 100).toFixed(1) + '%' : '–', 12) + pad(r.ms, 6) + (r.note || '')));
  const pages = rows.filter(r => r.iou != null || r.note === 'MISSED');
  const scored = rows.filter(r => r.iou != null);
  const mean = scored.reduce((s, r) => s + r.iou, 0) / Math.max(1, pages.length);
  console.log('\npages found: ' + scored.length + '/' + pages.length +
    '   mean IoU (misses count as 0): ' + mean.toFixed(3) +
    '   IoU>0.9: ' + pages.filter(r => r.iou > 0.9).length + '/' + pages.length +
    '   corner err<0.017: ' + scored.filter(r => r.err < 0.017).length + '/' + pages.length +
    '   no-page/cut scenes correct: ' + rows.filter(r => !('iou' in r) && r.note !== 'MISSED' && r.ok).length + '/' + rows.filter(r => !('iou' in r) && r.note !== 'MISSED').length);
  process.exitCode = rows.every(r => r.ok) ? 0 : 1;
})();
