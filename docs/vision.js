/**
 * Vision: the image processing behind the scanner.
 *
 *  - detectQuad:  finds the page outline in a frame (needs OpenCV.js)
 *  - sharpness:   variance of the Laplacian, a standard focus measure
 *  - warp:        perspective correction (de-skew) of the page to a flat rectangle
 *  - applyFilter: shadow removal + contrast for a clean "scanned" look
 *  - removeFingers: paints over fingers holding the page edge
 *
 * Everything except detectQuad is plain JavaScript, so the app keeps working
 * (with manual cropping) if OpenCV can't be loaded.
 */
const Vision = (() => {
  'use strict';

  function createCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function ctx2d(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true });
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /** Puts 4 points in top-left, top-right, bottom-right, bottom-left order. */
  function orderCorners(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const sorted = pts.slice().sort((a, b) =>
      Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let start = 0;
    sorted.forEach((p, i) => {
      if (p.x + p.y < sorted[start].x + sorted[start].y) start = i;
    });
    return sorted.slice(start).concat(sorted.slice(0, start));
  }

  function fullFrame(w, h) {
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
  }

  function polygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  // -------------------------------------------------------------------------
  // Frame analysis (focus + motion)
  // -------------------------------------------------------------------------

  function toGray(imageData) {
    const d = imageData.data, n = imageData.width * imageData.height;
    const g = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    }
    return g;
  }

  /** Average brightness change between two frames (0–255). Used to tell if the camera is steady. */
  function meanAbsDiff(a, b) {
    let sum = 0, n = 0;
    for (let i = 0; i < a.length; i += 3) {
      sum += Math.abs(a[i] - b[i]);
      n++;
    }
    return sum / n;
  }

  /**
   * Tenengrad focus measure: mean squared Sobel gradient above a noise floor.
   * Pertuz et al. (2013) found Laplacian-based measures the most sensitive to
   * noise; gradient measures hold up better on noisy laptop webcams.
   */
  function sharpness(imageData) {
    const w = imageData.width, h = imageData.height;
    const g = toGray(imageData);
    const floor = 24 * 24; // ignore sensor-noise gradients (Sobel units, 4× pixel step)
    let sum = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
        const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
        const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
        const m = gx * gx + gy * gy;
        if (m > floor) sum += m;
        n++;
      }
    }
    return n ? sum / n / 16 : 0;
  }

  // -------------------------------------------------------------------------
  // Fingers (skin detection)
  // -------------------------------------------------------------------------

  /**
   * Marks skin-coloured pixels. Colour is judged relative to the paper (the
   * brightest 30% of the image), so warm or cool lighting that tints the whole
   * page doesn't make the paper itself look like skin. Skin is redder and less
   * blue than the paper under the same light, but not as saturated as
   * orange/yellow highlighter.
   */
  function skinMask(imageData) {
    const d = imageData.data, n = imageData.width * imageData.height;
    const Y = new Uint8Array(n), Cb = new Float32Array(n), Cr = new Float32Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = d[j], g = d[j + 1], b = d[j + 2];
      const y = (r * 77 + g * 150 + b * 29) >> 8;
      Y[i] = y;
      hist[y]++;
      Cb[i] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      Cr[i] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    }
    let cut = 255;
    for (let v = 255, acc = 0; v >= 0; v--) {
      acc += hist[v];
      if (acc >= n * 0.3) { cut = v; break; }
    }
    let refCb = 0, refCr = 0, m = 0;
    for (let i = 0; i < n; i++) {
      if (Y[i] >= cut) { refCb += Cb[i]; refCr += Cr[i]; m++; }
    }
    refCb /= m || 1;
    refCr /= m || 1;
    // Cameras white-balance, so paper is close to neutral. Only allow a small
    // tint: if a brightly lit face is the brightest thing in view, it must not
    // become the reference (it would then stop counting as skin).
    refCb = Math.min(134, Math.max(118, refCb));
    refCr = Math.min(136, Math.max(122, refCr));

    const mask = new Uint8Array(n);
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (Y[i] < 35) continue; // too dark to judge colour
      const dcr = Cr[i] - refCr, dcb = Cb[i] - refCb;
      if (dcr > 8 && dcb < 0 && dcr - dcb > 16 && -dcb < 1.6 * dcr + 4 && dcr * dcr + dcb * dcb < 3600) {
        mask[i] = 1;
        count++;
      }
    }
    return { mask, count };
  }

  /**
   * Keeps only skin-coloured regions that could be hands: a cream wall, a wooden
   * door or warm lighting can match skin colour, but those regions are far
   * bigger than a hand (or a face).
   */
  function handSizedSkin(skin, w, h, maxShare = 0.08) {
    const n = w * h, mask = skin.mask;
    const seen = new Uint8Array(n), queue = new Int32Array(n), out = new Uint8Array(n);
    let count = 0;
    for (let start = 0; start < n; start++) {
      if (!mask[start] || seen[start]) continue;
      let head = 0, tail = 0;
      queue[tail++] = start; seen[start] = 1;
      while (head < tail) {
        const i = queue[head++], x = i % w;
        if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; queue[tail++] = i - 1; }
        if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; queue[tail++] = i + 1; }
        if (i >= w && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; queue[tail++] = i - w; }
        if (i + w < n && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; queue[tail++] = i + w; }
      }
      if (tail <= n * maxShare) { for (let k = 0; k < tail; k++) out[queue[k]] = 1; count += tail; }
    }
    return { mask: out, count };
  }

  /** Binary max (r>0) or min (r<0) filter, separable, in place. */
  function morph(mask, w, h, r) {
    const grow = r > 0;
    r = Math.abs(r);
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 1;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
          const m = mask[y * w + k];
          if (grow ? m : !m) { v = grow ? 1 : 0; break; }
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = grow ? 0 : 1;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
          const m = tmp[k * w + x];
          if (grow ? m : !m) { v = grow ? 1 : 0; break; }
        }
        mask[y * w + x] = v;
      }
    }
  }

  /**
   * Extends a finger mask into the darker rim and shadow around it: pixels
   * next to the mask that are clearly darker than the paper, up to `limit`
   * pixels away. Skin colour alone misses these.
   */
  function growIntoShadow(mask, lum, paperLevel, w, h, limit) {
    const n = w * h;
    const darker = paperLevel * 0.85;
    const dist = new Uint16Array(n).fill(65535);
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    for (let i = 0; i < n; i++) if (mask[i]) { dist[i] = 0; queue[tail++] = i; }
    while (head < tail) {
      const i = queue[head++];
      const next = dist[i] + 1;
      if (next > limit) continue;
      const x = i % w;
      const around = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const j of around) {
        if (j < 0 || j >= n || mask[j] || lum[j] >= darker) continue;
        mask[j] = 1;
        dist[j] = next;
        queue[tail++] = j;
      }
    }
  }

  /**
   * Finds fingers on a straightened page and paints over them with the
   * surrounding paper colour. Only skin regions that reach in from the page
   * edge count, so coloured marks in the middle of the page are left alone.
   * Returns the fraction of the page that was painted over (0 if none).
   */
  /**
   * @param opts.hand  optional hand-tracker mask in the *source frame*:
   *   { mask, width, height, corners, srcW, srcH } where corners are the page
   *   corners (source pixels) the canvas was flattened from. When given, only
   *   those pixels count as fingers (no skin-colour guessing); pass
   *   { none: true } when the tracker ran and saw no hands.
   */
  function removeFingers(canvas, opts = {}) {
    if (opts.none) return 0;
    const W = canvas.width, H = canvas.height;
    const s = Math.min(1, 600 / Math.max(W, H));
    const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
    const small = createCanvas(w, h);
    const sctx = ctx2d(small);
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, w, h);
    const d = sctx.getImageData(0, 0, w, h).data;
    const n = w * h;

    const lum = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      lum[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
      hist[lum[i]]++;
    }
    let paperLevel = 255; // 70th percentile brightness = paper
    for (let v = 0, acc = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= n * 0.7) { paperLevel = v; break; }
    }
    let keep = new Uint8Array(n);
    let kept = 0;
    if (opts.hand) {
      // Map each page pixel back into the camera frame and look it up in the hand mask.
      const hm = opts.hand, sx = hm.width / hm.srcW, sy = hm.height / hm.srcH;
      const m = squareToQuad(orderCorners(hm.corners).map(p => ({ x: p.x * sx, y: p.y * sy })));
      for (let y = 0; y < h; y++) {
        const v = (y + 0.5) / h;
        for (let x = 0; x < w; x++) {
          const u = (x + 0.5) / w;
          const den = m.g * u + m.h * v + 1;
          const fx = ((m.a * u + m.b * v + m.c) / den) | 0, fy = ((m.d * u + m.e * v + m.f) / den) | 0;
          if (fx >= 0 && fy >= 0 && fx < hm.width && fy < hm.height && hm.mask[fy * hm.width + fx]) { keep[y * w + x] = 1; kept++; }
        }
      }
      if (!kept) return 0;
      // The tracker's outline is approximate: grow into the finger's rim and shadow, a little.
      growIntoShadow(keep, lum, paperLevel, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.015)));
    }
    const mask = opts.hand ? null : skinMask({ data: d, width: w, height: h }).mask;
    if (mask) {
    morph(mask, w, h, -1); // drop specks
    morph(mask, w, h, 1);

    // Keep connected skin regions that touch the border band.
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
    const minArea = n * 0.0004;
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    for (let start = 0; start < n; start++) {
      if (!mask[start] || seen[start]) continue;
      let head = 0, tail = 0, touches = false;
      queue[tail++] = start;
      seen[start] = 1;
      while (head < tail) {
        const i = queue[head++];
        const x = i % w, y = (i / w) | 0;
        if (x < band || y < band || x >= w - band || y >= h - band) touches = true;
        if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; queue[tail++] = i - 1; }
        if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; queue[tail++] = i + 1; }
        if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; queue[tail++] = i - w; }
        if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; queue[tail++] = i + w; }
      }
      if (touches && tail >= minArea) {
        for (let k = 0; k < tail; k++) keep[queue[k]] = 1;
        kept += tail;
      }
    }
    // Nothing found, or so much "skin" that it's probably coloured paper.
    if (!kept || kept > n * 0.35) return 0;
    growIntoShadow(keep, lum, paperLevel, w, h, Math.max(3, Math.round(Math.min(w, h) * 0.03)));
    }
    morph(keep, w, h, Math.max(2, Math.round(Math.min(w, h) * 0.008)));

    // Paper colour field: average the unmasked paper pixels (not ink, not
    // shadow) in 4×4 cells, then fill the other cells from their neighbours.
    const g = 4, gw = Math.ceil(w / g), gh = Math.ceil(h / g), cells = gw * gh;
    const sum = new Float32Array(cells * 3), cnt = new Float32Array(cells);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (keep[i] || lum[i] < paperLevel * 0.88) continue;
        const c = ((y / g) | 0) * gw + ((x / g) | 0);
        sum[c * 3] += d[i * 4];
        sum[c * 3 + 1] += d[i * 4 + 1];
        sum[c * 3 + 2] += d[i * 4 + 2];
        cnt[c]++;
      }
    }
    let color = new Float32Array(cells * 3);
    let known = new Uint8Array(cells);
    for (let c = 0; c < cells; c++) {
      if (cnt[c]) {
        known[c] = 1;
        color[c * 3] = sum[c * 3] / cnt[c];
        color[c * 3 + 1] = sum[c * 3 + 1] / cnt[c];
        color[c * 3 + 2] = sum[c * 3 + 2] / cnt[c];
      }
    }
    for (let pass = 0; pass < gw + gh; pass++) {
      const nextColor = color.slice(), nextKnown = known.slice();
      let missing = 0;
      for (let cy = 0; cy < gh; cy++) {
        for (let cx = 0; cx < gw; cx++) {
          const c = cy * gw + cx;
          if (known[c]) continue;
          let r = 0, gg = 0, b = 0, k = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = cx + dx, ny = cy + dy;
              if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
              const nc = ny * gw + nx;
              if (!known[nc]) continue;
              r += color[nc * 3]; gg += color[nc * 3 + 1]; b += color[nc * 3 + 2]; k++;
            }
          }
          if (k) {
            nextColor[c * 3] = r / k; nextColor[c * 3 + 1] = gg / k; nextColor[c * 3 + 2] = b / k;
            nextKnown[c] = 1;
          } else {
            missing++;
          }
        }
      }
      color = nextColor;
      known = nextKnown;
      if (!missing) break;
    }

    // Scale the colour field and the mask up to full size (bilinear = soft edges) and blend.
    const field = createCanvas(gw, gh);
    const fctx = ctx2d(field);
    const fimg = fctx.createImageData(gw, gh);
    for (let c = 0; c < cells; c++) {
      fimg.data[c * 4] = color[c * 3];
      fimg.data[c * 4 + 1] = color[c * 3 + 1];
      fimg.data[c * 4 + 2] = color[c * 3 + 2];
      fimg.data[c * 4 + 3] = 255;
    }
    fctx.putImageData(fimg, 0, 0);
    const maskSmall = createCanvas(w, h);
    const mctx = ctx2d(maskSmall);
    const mimg = mctx.createImageData(w, h);
    for (let i = 0; i < n; i++) mimg.data[i * 4 + 3] = keep[i] ? 255 : 0;
    mctx.putImageData(mimg, 0, 0);

    const big = createCanvas(W, H);
    const bctx = ctx2d(big);
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(field, 0, 0, W, H);
    const fd = bctx.getImageData(0, 0, W, H).data;
    bctx.clearRect(0, 0, W, H);
    bctx.drawImage(maskSmall, 0, 0, W, H);
    const md = bctx.getImageData(0, 0, W, H).data;

    const ctx = ctx2d(canvas);
    const out = ctx.getImageData(0, 0, W, H);
    const od = out.data;
    for (let i = 0; i < od.length; i += 4) {
      const a = md[i + 3] / 255;
      if (!a) continue;
      od[i] += (fd[i] - od[i]) * a;
      od[i + 1] += (fd[i + 1] - od[i + 1]) * a;
      od[i + 2] += (fd[i + 2] - od[i + 2]) * a;
    }
    ctx.putImageData(out, 0, 0);
    return kept / n;
  }

  // -------------------------------------------------------------------------
  // Page detection (OpenCV.js)
  // -------------------------------------------------------------------------

  function median(u8) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < u8.length; i++) hist[u8[i]]++;
    let acc = 0;
    const half = u8.length / 2;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= half) return v;
    }
    return 128;
  }

  function otsuThreshold(hist, total) {
    let sum = 0;
    for (let v = 0; v < 256; v++) sum += v * hist[v];
    let sumB = 0, wB = 0, best = 0, t = 128;
    for (let v = 0; v < 256; v++) {
      wB += hist[v];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += v * hist[v];
      const diff = sumB / wB - (sum - sumB) / wF;
      const between = wB * wF * diff * diff;
      if (between > best) { best = between; t = v; }
    }
    return t;
  }

  /**
   * Marks pixels that look like paper: bright (above the Otsu split between
   * light and dark), nearly colourless, and not skin. Saturation is allowed to
   * rise with the scene's own tint, so paper under warm light still counts.
   */
  function paperMask(imageData, skin) {
    const d = imageData.data, n = imageData.width * imageData.height;
    const Y = new Uint8Array(n), sat = new Float32Array(n), hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const r = d[j], g = d[j + 1], b = d[j + 2];
      const y = (r * 77 + g * 150 + b * 29) >> 8;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      Y[i] = y;
      sat[i] = max ? (max - min) / max : 0;
      hist[y]++;
    }
    const t = Math.max(80, otsuThreshold(hist, n));
    // Typical saturation of the brightest 10% of the scene = the light's tint.
    let cut = 255;
    for (let v = 255, acc = 0; v >= 0; v--) {
      acc += hist[v];
      if (acc >= n * 0.1) { cut = v; break; }
    }
    const bright = [];
    for (let i = 0; i < n; i += 7) if (Y[i] >= cut && !skin[i]) bright.push(sat[i]);
    bright.sort((a, b) => a - b);
    const tint = bright.length ? bright[bright.length >> 1] : 0;
    const maxSat = Math.min(0.4, Math.max(0.25, tint + 0.12));

    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = Y[i] >= t && sat[i] < maxSat && !skin[i] ? 1 : 0;

    // A light wall can pass as paper too. If the bright pixels split clearly
    // into two levels, the brighter level is the paper: build a strict mask too.
    const upper = new Uint32Array(256);
    let upperTotal = 0;
    for (let v = t; v < 256; v++) { upper[v] = hist[v]; upperTotal += hist[v]; }
    let strict = mask;
    if (upperTotal) {
      const t2 = otsuThreshold(upper, upperTotal);
      let lo = 0, loN = 0, hi = 0, hiN = 0;
      for (let v = t; v < 256; v++) {
        if (v < t2) { lo += v * upper[v]; loN += upper[v]; } else { hi += v * upper[v]; hiN += upper[v]; }
      }
      if (loN && hiN && hi / hiN - lo / loN > 25 && hiN > n * 0.03) {
        strict = new Uint8Array(n);
        for (let i = 0; i < n; i++) strict[i] = mask[i] && Y[i] >= t2 ? 1 : 0;
      }
    }
    return { mask, strict, Y };
  }

  /** Reduces a convex hull to 4 corners. */
  function quadFromHull(cv, hull) {
    const peri = cv.arcLength(hull, true);
    for (const eps of [0.02, 0.035, 0.05, 0.08]) {
      const approx = new cv.Mat();
      cv.approxPolyDP(hull, approx, eps * peri, true);
      const rows = approx.rows, d = approx.data32S;
      const pts = rows === 4 ? [0, 1, 2, 3].map(k => ({ x: d[k * 2], y: d[k * 2 + 1] })) : null;
      approx.delete();
      if (pts) return pts;
      if (rows < 4) break;
    }
    // Fallback: the hull's extreme points towards each corner.
    const d = hull.data32S, pts = [];
    for (let k = 0; k < hull.rows; k++) pts.push({ x: d[k * 2], y: d[k * 2 + 1] });
    if (pts.length < 4) return null;
    const pick = f => pts.reduce((a, b) => (f(b) > f(a) ? b : a));
    return [pick(p => -p.x - p.y), pick(p => p.x - p.y), pick(p => p.x + p.y), pick(p => p.y - p.x)];
  }

  /**
   * Four straight sides from a region's boundary, skipping boundary points next
   * to a hand: sequential RANSAC finds the 4 dominant lines, which are ordered
   * around the region and intersected. A corner under a thumb comes back as
   * the meeting point of its two visible sides. Returns null when 4 clear
   * sides can't be found (the caller falls back to the convex hull).
   */
  function quadFromContour(cv, contour, hand, w, h) {
    const d = contour.data32S, n = contour.rows;
    if (n < 40) return null;
    const near = (x, y) => {
      if (!hand) return false;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h && hand[yy * w + xx]) return true;
        }
      }
      return false;
    };
    let pts = [];
    let cx = 0, cy = 0;
    for (let k = 0; k < n; k++) {
      const x = d[k * 2], y = d[k * 2 + 1];
      cx += x; cy += y;
      // Skip the frame border too: a page running off the frame has no real edge there.
      if (x <= 1 || y <= 1 || x >= w - 2 || y >= h - 2 || near(x, y)) continue;
      pts.push({ x, y });
    }
    cx /= n; cy /= n;
    const total = pts.length;
    const lines = [];
    for (let k = 0; k < 4 && pts.length >= 10; k++) {
      const fit = ransacLine(pts, 1.5, 120);
      if (!fit || fit.inliers < Math.max(10, total * 0.06)) break;
      const l = fit.line;
      const inl = pts.filter(p => Math.abs(l.nx * p.x + l.ny * p.y - l.c) <= 2.5);
      const mx = inl.reduce((s, p) => s + p.x, 0) / inl.length, my = inl.reduce((s, p) => s + p.y, 0) / inl.length;
      lines.push({ l, angle: Math.atan2(my - cy, mx - cx) });
      pts = pts.filter(p => Math.abs(l.nx * p.x + l.ny * p.y - l.c) > 2.5);
    }
    if (lines.length < 4) return null;
    lines.sort((a, b) => a.angle - b.angle);
    const out = [];
    for (let k = 0; k < 4; k++) {
      const p = intersect(lines[k].l, lines[(k + 1) % 4].l);
      if (!p) return null;
      out.push(p);
    }
    const q = orderCorners(out);
    return isConvex(q) ? q : null;
  }

  /**
   * How page-like a candidate is: mostly paper-coloured inside, brighter than
   * its surroundings, large, and near the middle. Faces, bookshelves and
   * clothing fail the paper test; a window loses on size and position.
   */
  /**
   * Fill measure for outlines built from lines: the share of the interior with
   * the same tint as this candidate's own paper (or neutral grey print). Paper
   * isn't always colourless on a webcam (warm light, auto white balance), so
   * this compares against the page itself rather than against grey.
   */
  function tintFill(q, imageData, w, h) {
    const d = imageData.data;
    const xs = q.map(p => p.x), ys = q.map(p => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
    const inside = (x, y) => {
      for (let k = 0; k < 4; k++) {
        const a = q[k], b = q[(k + 1) % 4];
        if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) return false;
      }
      return true;
    };
    const ys2 = [], cbs = [], crs = [];
    for (let y = y0; y <= y1; y += 2) for (let x = x0; x <= x1; x += 2) {
      if (!inside(x, y)) continue;
      const j = (y * w + x) * 4;
      ys2.push(lumaOf(d, j)); cbs.push(cbOf(d, j)); crs.push(crOf(d, j));
    }
    if (ys2.length < 20) return 0;
    const sortedY = ys2.slice().sort((a, b) => a - b), yCut = sortedY[Math.floor(sortedY.length * 0.6)];
    const bc = [], br = [];
    ys2.forEach((v, i) => { if (v >= yCut) { bc.push(cbs[i]); br.push(crs[i]); } });
    const med = arr => arr.sort((a, b) => a - b)[arr.length >> 1];
    const pcb = med(bc), pcr = med(br);
    let ok = 0;
    for (let i = 0; i < ys2.length; i++) {
      const paperTint = Math.abs(cbs[i] - pcb) < 9 && Math.abs(crs[i] - pcr) < 9;
      const greyPrint = Math.abs(cbs[i] - 128) < 7 && Math.abs(crs[i] - 128) < 7 && ys2[i] < yCut;
      if (paperTint || greyPrint) ok++;
    }
    return ok / ys2.length;
  }

  function scoreQuad(pts, paper, Y, ink, w, h, imageData) {
    const q = orderCorners(pts);
    const area = polygonArea(q);
    const margin = Math.sqrt(area) * 0.08;
    const xs = q.map(p => p.x), ys = q.map(p => p.y);
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - margin)), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs) + margin));
    const y0 = Math.max(0, Math.floor(Math.min(...ys) - margin)), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys) + margin));
    let nIn = 0, paperIn = 0, sumIn = 0, nOut = 0, sumOut = 0, inkIn = 0, clippedIn = 0;
    for (let y = y0; y <= y1; y += 2) {
      for (let x = x0; x <= x1; x += 2) {
        let inside = true;
        for (let k = 0; k < 4 && inside; k++) {
          const a = q[k], b = q[(k + 1) % 4];
          if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) inside = false;
        }
        const i = y * w + x;
        if (inside) {
          nIn++; if (paper !== 'tint') paperIn += paper[i]; sumIn += Y[i]; inkIn += ink[i];
          if (Y[i] >= 250) clippedIn++;
        } else {
          nOut++; sumOut += Y[i];
        }
      }
    }
    if (!nIn) return { score: 0 };
    const fill = paper === 'tint' ? tintFill(q, imageData, w, h) : paperIn / nIn;
    const contrast = nOut ? sumIn / nIn - sumOut / nOut : 0;
    const inkFrac = inkIn / nIn, clipped = clippedIn / nIn;
    const cx = xs.reduce((a, b) => a + b) / 4, cy = ys.reduce((a, b) => a + b) / 4;
    const centre = 1 - 0.5 * Math.min(1, Math.hypot(cx - w / 2, cy - h / 2) / (Math.hypot(w, h) / 2));
    const edge = Math.max(1.5, Math.min(w, h) * 0.004); // a cut-off page sits right on the border
    const touchesEdge = q.some(p => p.x <= edge || p.y <= edge || p.x >= w - 1 - edge || p.y >= h - 1 - edge);
    // The page is held up in the middle of the view; shapes centred near the
    // edges (windows, door frames, pictures on the wall) are background.
    const offCentre = Math.abs(cx - w / 2) > w * 0.3 || Math.abs(cy - h / 2) > h * 0.32;
    const info = { fill, contrast, inkFrac, clipped, touchesEdge, quad: q };
    // A light fixture or glare is blown-out white with no writing; a wall,
    // window or door has no writing either. (A brightly lit page can be
    // blown-out white too, but its writing still shows.)
    let reason = '';
    if (offCentre) reason = 'off-centre';
    else if (clipped > 0.15 && inkFrac < 0.03) reason = 'light/glare';
    else if (inkFrac < 0.01) reason = 'no writing';
    else if (fill < 0.7) reason = 'not paper-coloured';
    if (reason) return Object.assign(info, { score: 0, reason });
    // The page can be brighter or darker than what's behind it (exposure is often set for a ceiling light).
    // Size helps, but only gently (√area): a room-sized outline built from wall lines mustn't outrank the page.
    const score = Math.sqrt(area / (w * h)) * fill * fill * centre * (Math.abs(contrast) > 10 ? 1 : 0.4) * (touchesEdge ? 0.6 : 1);
    return Object.assign(info, { score });
  }

  const lumaOf = (d, j) => (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  const cbOf = (d, j) => 128 - 0.168736 * d[j] - 0.331264 * d[j + 1] + 0.5 * d[j + 2];
  const crOf = (d, j) => 128 + 0.5 * d[j] - 0.418688 * d[j + 1] - 0.081312 * d[j + 2];

  /**
   * Writing-first page finding, for rooms where the page isn't the brightest
   * thing in view (e.g. the camera's exposure is set for a ceiling light).
   *
   *  1. Ink: thin dark strokes, found as (closing − image) on a colourless background.
   *  2. Text zones: where ink is dense. These seed the search.
   *  3. The paper's colour is sampled around the ink, wherever exposure puts it.
   *  4. The region grows across smoothly-changing pixels of that colour
   *     (in the ink-free closed image) and stops at sharp changes: the page edge.
   *
   * Returns the ink mask (used by scoring for every candidate) and candidates
   * as { pts, mask } where mask is that page's own region.
   */
  function inkSeededCandidates(cv, src, imageData, skin, w, h, minArea, track) {
    const n = w * h, d = imageData.data;
    const k = Math.max(3, Math.round(w / 480 * 7)) | 1;
    const kernel = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k)));
    const closed = track(new cv.Mat());
    cv.morphologyEx(src, closed, cv.MORPH_CLOSE, kernel); // erases thin dark strokes, per channel
    const cd = closed.data;

    const Yc = new Uint8Array(n), Cbc = new Float32Array(n), Crc = new Float32Array(n);
    const ink = new Uint8Array(n);
    const density = track(cv.Mat.zeros(h, w, cv.CV_8UC1)); // zeros: only ink pixels are written below
    const dd = density.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const yc = lumaOf(cd, j), y = lumaOf(d, j);
      Yc[i] = yc; Cbc[i] = cbOf(cd, j); Crc[i] = crOf(cd, j);
      const max = Math.max(cd[j], cd[j + 1], cd[j + 2]), min = Math.min(cd[j], cd[j + 1], cd[j + 2]);
      const neutral = max > 40 && (max - min) / max < 0.25;
      if (neutral && !skin[i] && yc - y > Math.max(10, yc * 0.1)) { ink[i] = 1; dd[i] = 255; }
    }
    // Dense ink = text zone.
    const zk = Math.max(9, Math.round(w / 480 * 15)) | 1;
    cv.blur(density, density, new cv.Size(zk, zk));
    const zones = track(new cv.Mat());
    cv.threshold(density, zones, 255 * 0.05, 255, cv.THRESH_BINARY);
    const zoneK = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(zk, zk)));
    cv.morphologyEx(zones, zones, cv.MORPH_CLOSE, zoneK);
    const contours = track(new cv.MatVector());
    const hier = track(new cv.Mat());
    cv.findContours(zones, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const zoneList = [];
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const a = cv.contourArea(c);
      if (a >= n * 0.025) zoneList.push({ i, a }); // a real block of text, not a lanyard or logo
      c.delete();
    }
    zoneList.sort((a, b) => b.a - a.a);

    const candidates = [];
    for (const zone of zoneList.slice(0, 3)) {
      const zm = track(cv.Mat.zeros(h, w, cv.CV_8UC1));
      cv.drawContours(zm, contours, zone.i, new cv.Scalar(255), -1);
      const zd = zm.data;
      // Paper colour: median of the ink-free closed image inside the zone.
      const ys = [], cbs = [], crs = [];
      for (let i = 0; i < n; i += 3) if (zd[i] && !ink[i] && !skin[i]) { ys.push(Yc[i]); cbs.push(Cbc[i]); crs.push(Crc[i]); }
      if (ys.length < 30) continue;
      const med = arr => arr.sort((a, b) => a - b)[arr.length >> 1];
      const py = med(ys), pcb = med(cbs), pcr = med(crs);
      const tolY = Math.max(18, py * 0.22);

      // Grow from the zone across smooth, paper-coloured pixels.
      const region = new Uint8Array(n);
      const queue = new Int32Array(n);
      let head = 0, tail = 0;
      for (let i = 0; i < n; i++) {
        if (zd[i] && !skin[i] && Math.abs(Yc[i] - py) <= tolY) { region[i] = 1; queue[tail++] = i; }
      }
      while (head < tail) {
        const i = queue[head++];
        const x = i % w;
        const around = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i + w < n ? i + w : -1];
        for (const j of around) {
          if (j < 0 || region[j] || skin[j]) continue;
          if (Math.abs(Yc[j] - Yc[i]) > 4 || Math.abs(Cbc[j] - Cbc[i]) > 2.5 || Math.abs(Crc[j] - Crc[i]) > 2.5) continue;
          if (Math.abs(Yc[j] - py) > tolY || Math.abs(Cbc[j] - pcb) > 7 || Math.abs(Crc[j] - pcr) > 7) continue;
          region[j] = 1;
          queue[tail++] = j;
        }
      }
      if (tail < minArea) continue;

      // Region outline → hull → 4 corners.
      const rm = track(cv.Mat.zeros(h, w, cv.CV_8UC1));
      const rd = rm.data;
      for (let i = 0; i < n; i++) if (region[i]) rd[i] = 255;
      cv.morphologyEx(rm, rm, cv.MORPH_CLOSE, zoneK);
      // Cut thin leaks into similar-coloured background, then keep the page body.
      const cutK = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(zk, zk)));
      cv.morphologyEx(rm, rm, cv.MORPH_OPEN, cutK);
      for (let i = 0; i < n; i++) region[i] = rd[i] ? 1 : 0;
      const rc = track(new cv.MatVector());
      const rh = track(new cv.Mat());
      cv.findContours(rm, rc, rh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
      let bestI = -1, bestA = 0;
      for (let i = 0; i < rc.size(); i++) {
        const c = rc.get(i);
        const a = cv.contourArea(c);
        if (a > bestA) { bestA = a; bestI = i; }
        c.delete();
      }
      if (bestI < 0) continue;
      const c = rc.get(bestI);
      const lineQuad = quadFromContour(cv, c, skin, w, h);
      if (lineQuad) candidates.push({ pts: lineQuad, mask: region });
      const hull = new cv.Mat();
      cv.convexHull(c, hull);
      const pts = quadFromHull(cv, hull);
      hull.delete();
      c.delete();
      if (pts) candidates.push({ pts, mask: region });
    }
    return { ink, candidates };
  }

  // -------------------------------------------------------------------------
  // Line-based refinement (robust to fingers over the edges)
  // -------------------------------------------------------------------------

  function lineThrough(p, d) { // normalised line n·x = c through p with direction d
    const len = Math.hypot(d.x, d.y) || 1;
    const nx = -d.y / len, ny = d.x / len;
    return { nx, ny, c: nx * p.x + ny * p.y };
  }

  function intersect(l1, l2) {
    const det = l1.nx * l2.ny - l1.ny * l2.nx;
    if (Math.abs(det) < 1e-9) return null;
    return { x: (l1.c * l2.ny - l1.ny * l2.c) / det, y: (l1.nx * l2.c - l1.c * l2.nx) / det };
  }

  /** Total-least-squares line through points (principal axis). */
  function fitLine(pts) {
    let mx = 0, my = 0;
    pts.forEach(p => { mx += p.x; my += p.y; });
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    pts.forEach(p => { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; });
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return lineThrough({ x: mx, y: my }, { x: Math.cos(theta), y: Math.sin(theta) });
  }

  /** RANSAC line fit; returns the refit line and its inliers. */
  function ransacLine(pts, tol, iterations = 60) {
    if (pts.length < 2) return null;
    let bestInliers = null;
    let seed = 12345; // deterministic, so the same frame gives the same answer
    const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let it = 0; it < iterations; it++) {
      const a = pts[(rand() * pts.length) | 0], b = pts[(rand() * pts.length) | 0];
      if (a === b) continue;
      const l = lineThrough(a, { x: b.x - a.x, y: b.y - a.y });
      const inl = pts.filter(p => Math.abs(l.nx * p.x + l.ny * p.y - l.c) <= tol);
      if (!bestInliers || inl.length > bestInliers.length) bestInliers = inl;
    }
    if (!bestInliers || bestInliers.length < 2) return null;
    let line = fitLine(bestInliers);
    // One more pass with the refit line.
    const inl = pts.filter(p => Math.abs(line.nx * p.x + line.ny * p.y - line.c) <= tol);
    if (inl.length >= 2) line = fitLine(inl);
    return { line, inliers: inl.length };
  }

  /**
   * Snaps a rough page outline onto the real page edges, the way the best
   * SmartDoc 2015 methods do: search across a band around each side for the
   * strongest step in brightness/colour (a step, not a thin ink line), skip
   * points under fingers, fit a straight line to each side with RANSAC, and
   * intersect neighbouring lines for the corners. A corner hidden under a
   * thumb is recovered from its two sides. Sides with too little support
   * (covered, or off the frame) keep their rough position.
   *
   * @param imageData  RGBA frame at the refinement resolution
   * @param quad       rough corners in that frame's pixels (TL, TR, BR, BL)
   * @param opts.hand  optional { mask, width, height } finger mask at any resolution
   * @returns { quad, support: [4 fractions], meanSupport }
   */
  function refineQuad(imageData, quad, opts = {}) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const q = orderCorners(quad);
    const size = Math.sqrt(polygonArea(q));
    const band = Math.max(4, Math.round(opts.band || size * 0.05));
    const win = Math.max(2, Math.round(Math.min(w, h) / 270 * 1.5)); // step window ~ blur width
    const tol = Math.max(1, Math.min(w, h) / 270 * 0.8);
    const hand = opts.hand;
    const handAt = (x, y) => {
      if (!hand) return false;
      const hx = (x * hand.width / w) | 0, hy = (y * hand.height / h) | 0;
      return hx >= 0 && hy >= 0 && hx < hand.width && hy < hand.height && hand.mask[hy * hand.width + hx] === 1;
    };
    const sample = (x, y) => { // bilinear luma + Cb (paper vs. cream walls differ in both)
      if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return null;
      const x0 = x | 0, y0 = y | 0, ax = x - x0, ay = y - y0;
      const i = (y0 * w + x0) * 4;
      let Y = 0, C = 0;
      const wts = [(1 - ax) * (1 - ay), ax * (1 - ay), (1 - ax) * ay, ax * ay];
      [i, i + 4, i + w * 4, i + w * 4 + 4].forEach((j, k) => {
        Y += wts[k] * (d[j] * 0.299 + d[j + 1] * 0.587 + d[j + 2] * 0.114);
        C += wts[k] * (-0.168736 * d[j] - 0.331264 * d[j + 1] + 0.5 * d[j + 2]);
      });
      return { Y, C };
    };

    const lines = [], support = [];
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      const len = dist(a, b);
      const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      const cx = (q[0].x + q[1].x + q[2].x + q[3].x) / 4, cy = (q[0].y + q[1].y + q[2].y + q[3].y) / 4;
      let nrm = { x: -dir.y, y: dir.x };
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if ((cx - mid.x) * nrm.x + (cy - mid.y) * nrm.y > 0) nrm = { x: -nrm.x, y: -nrm.y }; // point outwards
      const steps = Math.max(8, Math.round(len / Math.max(2, len / 80)));
      const pts = [];
      let usable = 0;
      for (let si = 0; si < steps; si++) {
        const t = 0.06 + 0.88 * si / (steps - 1);
        const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        if (handAt(px, py)) continue;
        // profile across the side, from inside (−band) to outside (+band)
        const prof = [];
        let ok = true;
        for (let o = -band - win; o <= band + win; o++) {
          const v = sample(px + nrm.x * o, py + nrm.y * o);
          if (!v) { ok = false; break; }
          prof.push(v);
        }
        if (!ok) continue;
        usable++;
        let bestE = 0, bestO = 0;
        for (let o = -band; o <= band; o++) {
          const c = o + band + win;
          let yin = 0, yout = 0, cin = 0, cout = 0;
          for (let k2 = 1; k2 <= win; k2++) {
            yin += prof[c - k2].Y; yout += prof[c + k2].Y;
            cin += prof[c - k2].C; cout += prof[c + k2].C;
          }
          const e = Math.abs(yin - yout) / win + 1.5 * Math.abs(cin - cout) / win;
          if (e > bestE) { bestE = e; bestO = o; }
        }
        if (bestE < 10) continue; // no clear edge here
        const ex = px + nrm.x * bestO, ey = py + nrm.y * bestO;
        if (handAt(ex, ey)) continue;
        pts.push({ x: ex, y: ey });
      }
      const fit = pts.length >= 6 ? ransacLine(pts, tol) : null;
      const sup = fit ? fit.inliers / steps : 0;
      support.push(sup);
      // Trust the fitted side only with enough support and a sane angle change.
      const roughLine = lineThrough(a, dir);
      if (fit && sup >= 0.3 && Math.abs(fit.line.nx * roughLine.nx + fit.line.ny * roughLine.ny) > Math.cos(0.2)) {
        lines.push(fit.line);
      } else {
        lines.push(roughLine);
      }
    }
    const out = [];
    for (let k = 0; k < 4; k++) {
      const p = intersect(lines[(k + 3) % 4], lines[k]); // corner k is between side k-1 and side k
      if (!p || dist(p, q[k]) > size * 0.15) return { quad: q, support, meanSupport: support.reduce((x, y) => x + y) / 4, refined: false };
      out.push(p);
    }
    if (!isConvex(out)) return { quad: q, support, meanSupport: support.reduce((x, y) => x + y) / 4, refined: false };
    return { quad: out, support, meanSupport: support.reduce((x, y) => x + y) / 4, refined: true };
  }

  /**
   * Border check (after Tropin et al.'s inside/outside contrast re-ranking):
   * just inside every side of a real page is the same paper colour, and it
   * differs from what's just outside. An outline that wanders onto a wall or a
   * face fails on those sides. Sides hidden by a hand don't count against it.
   * @returns fraction (0–1) of sides that look like a page border
   */
  function rimScore(imageData, quad, hand, details, ink) {
    const w = imageData.width, h = imageData.height, d = imageData.data;
    const q = orderCorners(quad);
    const size = Math.sqrt(polygonArea(q));
    const off = Math.max(2, size * 0.035);
    const cx = q.reduce((a, p) => a + p.x, 0) / 4, cy = q.reduce((a, p) => a + p.y, 0) / 4;
    const colour = (x, y) => {
      x = Math.round(x); y = Math.round(y);
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      if (hand && hand[y * w + x]) return 'hand';
      const j = (y * w + x) * 4;
      return [lumaOf(d, j), cbOf(d, j), crOf(d, j)];
    };
    const med = arr => { const s2 = arr.slice().sort((a, b) => a - b); return s2[s2.length >> 1]; };
    const sides = [];
    for (let k = 0; k < 4; k++) {
      const a = q[k], b = q[(k + 1) % 4];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      let nx = -(b.y - a.y), ny = b.x - a.x;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl; ny /= nl;
      if ((cx - mid.x) * nx + (cy - mid.y) * ny < 0) { nx = -nx; ny = -ny; } // point inwards
      const inn = [[], [], []], out = [[], [], []];
      let hidden = 0, total = 0, inkOut = 0, inkN = 0;
      for (let t = 0.15; t <= 0.851; t += 0.07) {
        const px = a.x + (b.x - a.x) * t, py = a.y + (b.y - a.y) * t;
        // Inside: the brightest of a few depths, i.e. the paper rather than print near the edge.
        let ci = null;
        for (const depth of [0.7, 1.3, 2]) {
          const c = colour(px + nx * off * depth, py + ny * off * depth);
          if (c === 'hand') { ci = 'hand'; break; }
          if (c && (!ci || c[0] > ci[0])) ci = c;
        }
        const co = colour(px - nx * off, py - ny * off);
        // Writing just outside this side? Then the page continues past it.
        if (ink) {
          for (const depth of [0.5, 1, 1.5, 2, 2.5]) {
            const ox = Math.round(px - nx * off * depth), oy = Math.round(py - ny * off * depth);
            if (ox < 0 || oy < 0 || ox >= w || oy >= h) continue;
            for (let dt = -2; dt <= 2; dt++) { // a few pixels along the side too
              const sx = Math.round(ox + (b.x - a.x) / dist(a, b) * dt), sy = Math.round(oy + (b.y - a.y) / dist(a, b) * dt);
              if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
              inkN++;
              if (ink[sy * w + sx]) inkOut++;
            }
          }
        }
        total++;
        if (ci === 'hand' || co === 'hand') { hidden++; continue; }
        if (!ci || !co) continue;
        for (let c = 0; c < 3; c++) { inn[c].push(ci[c]); out[c].push(co[c]); }
      }
      if (hidden > total * 0.5 || inn[0].length < 3) { sides.push(null); continue; } // covered by a hand / off the frame
      sides.push({ inner: inn.map(med), outer: out.map(med), inkOut: inkN ? inkOut / inkN : 0 });
    }
    const known = sides.filter(Boolean);
    if (!known.length) return 0.5;
    const paper = [0, 1, 2].map(c => med(known.map(sd => sd.inner[c])));
    // Lighting changes brightness across a page; the paper's tint stays put, so weigh colour more.
    const diff = (u, v) => 0.5 * Math.abs(u[0] - v[0]) + 2 * (Math.abs(u[1] - v[1]) + Math.abs(u[2] - v[2]));
    // A side with page-coloured paper *and* writing beyond it runs through the page
    // (a text line or table rule), not along its edge: not a page outline at all.
    if (sides.some(sd => sd && sd.inkOut > 0.04 && diff(sd.outer, paper) < 20)) {
      if (details) details.push('cuts through the page');
      return 0;
    }
    let good = 0;
    sides.forEach(sd => {
      if (details) details.push(sd ? { toPaper: Math.round(diff(sd.inner, paper)), across: Math.round(diff(sd.inner, sd.outer)), inkOut: +(sd.inkOut * 100).toFixed(1), inner: sd.inner.map(Math.round), outer: sd.outer.map(Math.round) } : 'hidden');
      if (!sd) { good += 0.9; return; } // hidden by a hand: give it the benefit of the doubt
      if (diff(sd.inner, paper) < 32 && diff(sd.inner, sd.outer) > 10) good++;
    });
    return good / 4;
  }

  // -------------------------------------------------------------------------
  // Page aspect ratio (Zhang & He, "Whiteboard scanning and image enhancement")
  // -------------------------------------------------------------------------

  const PAPER_RATIOS = [{ name: 'Letter', r: 11 / 8.5 }, { name: 'A4', r: Math.SQRT2 }, { name: 'Legal', r: 14 / 8.5 }];

  /**
   * Recovers the real height/width ratio of the page from its outline in the
   * image, assuming square pixels and the principal point at the image centre.
   * Falls back to the affine estimate when the page faces the camera almost
   * square-on (focal length can't be recovered), and snaps to Letter/A4/Legal
   * when close. Measuring edge lengths in the image instead is badly wrong once
   * the page is tilted (≈6% at 25°, 21% at 30°).
   * @returns {{ ratio: number, focal: number|null, method: string }}  ratio = height / width
   */
  function estimateAspect(corners, imageW, imageH) {
    const [tl, tr, br, bl] = orderCorners(corners);
    const u0 = imageW / 2, v0 = imageH / 2;
    // Zhang & He's numbering: m1=(0,0), m2=(w,0), m3=(0,h), m4=(w,h).
    const m = [tl, tr, bl, br].map(p => [p.x - u0, p.y - v0, 1]);
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const c14 = cross(m[0], m[3]);
    const k2 = dot(c14, m[2]) / dot(cross(m[1], m[3]), m[2]);
    const k3 = dot(c14, m[1]) / dot(cross(m[2], m[3]), m[1]);
    const n2 = [k2 * m[1][0] - m[0][0], k2 * m[1][1] - m[0][1], k2 - 1];
    const n3 = [k3 * m[2][0] - m[0][0], k3 * m[2][1] - m[0][1], k3 - 1];
    const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
    let ratio, focal = null, method;
    const fOk = isFinite(f2) && f2 > Math.pow(0.35 * imageW, 2) && f2 < Math.pow(3 * imageW, 2) &&
      Math.abs(n2[2] * n3[2]) > 1e-6;
    if (fOk) {
      focal = Math.sqrt(f2);
      const wLen = (n2[0] * n2[0] + n2[1] * n2[1]) / f2 + n2[2] * n2[2];
      const hLen = (n3[0] * n3[0] + n3[1] * n3[1]) / f2 + n3[2] * n3[2];
      ratio = Math.sqrt(hLen / wLen);
      method = 'perspective';
    } else {
      ratio = Math.sqrt((n3[0] * n3[0] + n3[1] * n3[1]) / (n2[0] * n2[0] + n2[1] * n2[1]));
      method = 'affine';
    }
    if (!isFinite(ratio) || ratio <= 0) {
      const s = quadSize([tl, tr, br, bl]);
      ratio = s.h / s.w;
      method = 'edges';
    }
    // Snap to a standard paper size when close (either orientation).
    const tolerance = method === 'perspective' ? 0.05 : 0.08;
    for (const p of PAPER_RATIOS) {
      for (const r of [p.r, 1 / p.r]) {
        if (Math.abs(ratio - r) / r < tolerance) return { ratio: r, focal, method: method + '→' + p.name };
      }
    }
    return { ratio, focal, method };
  }

  /** Fraction of the page's interior (the quad shrunk by `shrink`) covered by a mask. */
  function maskCoverage(quad, mask, w, h, shrink = 0.15) {
    const q = inset(orderCorners(quad), shrink);
    const xs = q.map(p => p.x), ys = q.map(p => p.y);
    let n = 0, hit = 0;
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(h - 1, Math.ceil(Math.max(...ys))); y += 2) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(w - 1, Math.ceil(Math.max(...xs))); x += 2) {
        let inside = true;
        for (let k = 0; k < 4 && inside; k++) {
          const a = q[k], b = q[(k + 1) % 4];
          if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) inside = false;
        }
        if (!inside) continue;
        n++;
        if (mask[y * w + x]) hit++;
      }
    }
    return n ? hit / n : 0;
  }

  /** Downscales a canvas/video/bitmap to `width` px wide, halving first when shrinking a lot (avoids aliasing). */
  function shrinkTo(source, width) {
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    const height = Math.round(sh * width / sw);
    let src = source, cw = sw;
    while (cw > width * 2.5) {
      const half = createCanvas(Math.round(cw / 2), Math.round(sh * (cw / 2) / sw));
      const hctx = half.getContext('2d');
      hctx.imageSmoothingQuality = 'high';
      hctx.drawImage(src, 0, 0, half.width, half.height);
      src = half;
      cw = half.width;
    }
    const out = createCanvas(width, height);
    const octx = ctx2d(out);
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(src, 0, 0, width, height);
    return octx.getImageData(0, 0, width, height);
  }

  /**
   * Full pipeline for one image (uploads, the evaluation harness): detect at
   * 480 px, refine at ~960 px, then refine again at full resolution.
   * @returns {{ corners, touchesEdge, support } | null}  corners in source pixels
   */
  function locatePage(source, opts = {}) {
    const sw = source.videoWidth || source.width, sh = source.videoHeight || source.height;
    const small = shrinkTo(source, Math.min(480, sw));
    const det = detectQuad(small, opts);
    if (!det) return null;
    let quad = det.map(p => ({ x: p.x * sw / small.width, y: p.y * sh / small.height }));
    let support = det.support;
    const levels = sw > 1200 ? [960, sw] : [sw];
    for (const lw of levels) {
      const img = lw === sw ? (() => { const c = createCanvas(sw, sh); const x = ctx2d(c); x.drawImage(source, 0, 0); return x.getImageData(0, 0, sw, sh); })() : shrinkTo(source, lw);
      const s = img.width / sw;
      const r = refineQuad(img, quad.map(p => ({ x: p.x * s, y: p.y * s })), { hand: opts.hand, band: Math.sqrt(polygonArea(quad)) * s * (lw === sw ? 0.015 : 0.025) });
      quad = r.quad.map(p => ({ x: p.x / s, y: p.y / s }));
      support = r.support;
    }
    return { corners: quad, touchesEdge: det.touchesEdge, support };
  }

  /**
   * Page outlines assembled from straight edge segments, as the best SmartDoc
   * 2015 methods do (ISPL-CVML, SmartEngines): edges in brightness and in the
   * blue–yellow channel (a cool white page against a warm cream wall differs
   * mostly there; LRDE used L and b* the same way), minus edges under hands;
   * straight segments from the probabilistic Hough transform, merged into
   * lines; then every pair of roughly-parallel line pairs is a candidate page,
   * scored by how much of each side is covered by real edge segments.
   * @returns [{ pts, support }]
   */
  function lineCandidates(cv, imageData, hand, w, h, minArea, track, debug) {
    const n = w * h, d = imageData.data;
    const L = track(new cv.Mat(h, w, cv.CV_8UC1)), B = track(new cv.Mat(h, w, cv.CV_8UC1));
    const ld = L.data, bd = B.data;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      ld[i] = lumaOf(d, j);
      bd[i] = Math.max(0, Math.min(255, 128 + 3 * (cbOf(d, j) - 128)));
    }
    const edges = track(new cv.Mat());
    const tmp = track(new cv.Mat());
    const ksize = new cv.Size(5, 5);
    [L, B].forEach((m, k) => {
      cv.GaussianBlur(m, m, ksize, 0);
      const med = median(m.data);
      cv.Canny(m, k ? tmp : edges, Math.max(15, 0.5 * med * (k ? 0.4 : 1)), Math.max(40, Math.min(255, med * (k ? 0.5 : 1.1))));
    });
    cv.bitwise_or(edges, tmp, edges);
    if (hand) {
      const ed = edges.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // drop edges on or right next to a hand
          let near = false;
          for (let dy = -2; dy <= 2 && !near; dy += 2) {
            for (let dx = -2; dx <= 2 && !near; dx += 2) {
              const xx = x + dx, yy = y + dy;
              if (xx >= 0 && yy >= 0 && xx < w && yy < h && hand[yy * w + xx]) near = true;
            }
          }
          if (near) ed[y * w + x] = 0;
        }
      }
    }
    const segsMat = track(new cv.Mat());
    const minLen = Math.round(Math.min(w, h) * 0.1);
    cv.HoughLinesP(edges, segsMat, 1, Math.PI / 180, 22, minLen, Math.round(w * 0.025));
    const sd = segsMat.data32S;
    const segs = [];
    for (let k = 0; k < segsMat.rows; k++) {
      const x1 = sd[k * 4], y1 = sd[k * 4 + 1], x2 = sd[k * 4 + 2], y2 = sd[k * 4 + 3];
      const len = Math.hypot(x2 - x1, y2 - y1);
      let theta = Math.atan2(y2 - y1, x2 - x1);
      if (theta < 0) theta += Math.PI;
      if (theta >= Math.PI) theta -= Math.PI;
      segs.push({ x1, y1, x2, y2, len, theta });
    }
    segs.sort((a, b) => b.len - a.len);

    // Merge collinear segments into lines.
    const angDiff = (a, b) => { const t = Math.abs(a - b) % Math.PI; return Math.min(t, Math.PI - t); };
    const lines = [];
    for (const sg of segs) {
      const mx = (sg.x1 + sg.x2) / 2, my = (sg.y1 + sg.y2) / 2;
      let home = null;
      for (const ln of lines) {
        if (angDiff(ln.theta, sg.theta) > 0.06) continue;
        if (Math.abs(ln.l.nx * mx + ln.l.ny * my - ln.l.c) > 3.5) continue;
        home = ln;
        break;
      }
      if (home) { home.segs.push(sg); home.len += sg.len; }
      else lines.push({ theta: sg.theta, l: lineThrough({ x: sg.x1, y: sg.y1 }, { x: sg.x2 - sg.x1, y: sg.y2 - sg.y1 }), segs: [sg], len: sg.len });
    }
    lines.forEach(ln => {
      const pts = [];
      ln.segs.forEach(sg => { for (let t = 0; t <= 1; t += 0.25) pts.push({ x: sg.x1 + (sg.x2 - sg.x1) * t, y: sg.y1 + (sg.y2 - sg.y1) * t }); });
      ln.l = fitLine(pts);
    });
    lines.sort((a, b) => b.len - a.len);
    const top = lines.slice(0, 24);
    if (debug) { debug.segments = segs; debug.lineCount = lines.length; }

    // How much of a side (from corner p to corner q) the line's segments cover.
    const coverage = (ln, p, q) => {
      const len = dist(p, q);
      if (len < 1) return 0;
      const ux = (q.x - p.x) / len, uy = (q.y - p.y) / len;
      const spans = ln.segs.map(sg => {
        const a = (sg.x1 - p.x) * ux + (sg.y1 - p.y) * uy, b = (sg.x2 - p.x) * ux + (sg.y2 - p.y) * uy;
        return [Math.max(0, Math.min(a, b)), Math.min(len, Math.max(a, b))];
      }).filter(sp => sp[1] > sp[0]).sort((a, b) => a[0] - b[0]);
      let covered = 0, end = 0;
      for (const [a, b] of spans) {
        if (b <= end) continue;
        covered += b - Math.max(a, end);
        end = b;
      }
      return covered / len;
    };

    const minSep = Math.min(w, h) * 0.15;
    const sepAt = (a, b) => Math.abs((a.l.nx * w / 2 + a.l.ny * h / 2 - a.l.c) - (b.l.nx * w / 2 + b.l.ny * h / 2 - b.l.c) * Math.sign(a.l.nx * b.l.nx + a.l.ny * b.l.ny));
    const pairs = [];
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        if (angDiff(top[i].theta, top[j].theta) < 0.5 && sepAt(top[i], top[j]) > minSep) pairs.push([top[i], top[j]]);
      }
    }
    const results = [];
    const margin = 0.02;
    for (let a = 0; a < pairs.length; a++) {
      for (let b = a + 1; b < pairs.length; b++) {
        const [l1, l2] = pairs[a], [l3, l4] = pairs[b];
        if (l1 === l3 || l1 === l4 || l2 === l3 || l2 === l4) continue;
        const cross = angDiff(l1.theta, l3.theta);
        if (cross < 0.95 || cross > Math.PI - 0.95) continue; // sides meet at 55°..125°
        const c = [intersect(l1.l, l3.l), intersect(l3.l, l2.l), intersect(l2.l, l4.l), intersect(l4.l, l1.l)];
        if (c.some(p => !p || p.x < -w * margin || p.y < -h * margin || p.x > w * (1 + margin) || p.y > h * (1 + margin))) continue;
        const q = orderCorners(c);
        if (!isConvex(q) || polygonArea(q) < minArea || !looksLikePage(q)) continue;
        // which line runs along which side
        const sides = [0, 1, 2, 3].map(k => {
          const p = q[k], r = q[(k + 1) % 4];
          const mid = { x: (p.x + r.x) / 2, y: (p.y + r.y) / 2 };
          let bestL = null, bestD = Infinity;
          for (const ln of [l1, l2, l3, l4]) {
            const dd = Math.abs(ln.l.nx * mid.x + ln.l.ny * mid.y - ln.l.c);
            if (dd < bestD) { bestD = dd; bestL = ln; }
          }
          return coverage(bestL, p, r);
        });
        const sorted = sides.slice().sort((x, y) => x - y);
        // One side may be mostly hidden (a hand), but the other three must be real edges.
        if (sorted[1] < 0.3) continue;
        const support = sides.reduce((x, y) => x + y) / 4;
        results.push({ pts: q.map(p => ({ x: Math.min(w - 1, Math.max(0, p.x)), y: Math.min(h - 1, Math.max(0, p.y)) })), support, sides });
      }
    }
    results.sort((x, y) => y.support * Math.sqrt(polygonArea(y.pts)) - x.support * Math.sqrt(polygonArea(x.pts)));
    if (debug) debug.lineQuads = results.slice(0, 8);
    return results.slice(0, 8);
  }

  /**
   * Finds the page in a frame. Candidates come from two places: regions that
   * look like paper (bright, colourless, not skin), and outlines found by Canny
   * edge detection. Each is scored by scoreQuad and the best one wins.
   * Returns 4 ordered corners in the image's pixel coordinates (with
   * `touchesEdge` set when the page runs off the frame), or null.
   */
  function detectQuad(imageData, opts = {}) {
    const { minAreaRatio = 0.04, debug = null, prior = null, hand = null, handTracker = false } = opts;
    const cv = window.cv;
    if (!cv || !cv.Mat) return null;
    const w = imageData.width, h = imageData.height;
    const frameArea = w * h;
    // Where the hands are. With the hand tracker running, trust it alone: skin
    // colour also matches cream walls, wood and warm lighting.
    let skin;
    if (handTracker || (hand && hand.width === w && hand.height === h)) {
      skin = { mask: new Uint8Array(frameArea), count: 0 };
      if (hand && hand.width === w && hand.height === h) {
        for (let i = 0; i < frameArea; i++) if (hand.mask[i]) { skin.mask[i] = 1; skin.count++; }
      }
      if (!handTracker) { // tracker found nothing but isn't authoritative: add skin colour
        const sc = handSizedSkin(skinMask(imageData), w, h);
        for (let i = 0; i < frameArea; i++) if (sc.mask[i] && !skin.mask[i]) { skin.mask[i] = 1; skin.count++; }
      }
    } else {
      skin = handSizedSkin(skinMask(imageData), w, h);
    }
    const skinUsable = skin.count < frameArea * 0.4;
    const noSkin = new Uint8Array(frameArea);
    const paper = paperMask(imageData, skinUsable ? skin.mask : noSkin);
    const candidates = [];
    const consider = (pts, mask, lineSupport) => {
      if (!pts) return;
      const area = polygonArea(pts);
      if (area >= frameArea * minAreaRatio && area < frameArea * 0.985 && looksLikePage(pts)) candidates.push({ pts, mask, lineSupport });
    };
    let ink = new Uint8Array(frameArea);

    const mats = [];
    const track = m => { mats.push(m); return m; };
    try {
      // 1. Paper-coloured regions. Closing fills in the text; opening cuts thin bridges to the background.
      const kc = Math.max(3, Math.round(w * 0.03)) | 1, ko = Math.max(3, Math.round(w * 0.012)) | 1;
      const closeK = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kc, kc)));
      const openK = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(ko, ko)));
      const masks = paper.strict === paper.mask ? [paper.mask] : [paper.mask, paper.strict];
      // Pad with an empty margin: OpenCV's morphology treats pixels beyond the
      // border as paper, which would glue a page near the edge onto the border.
      const pad = kc, pw = w + pad * 2;
      for (const mask of masks) {
        const region = track(cv.Mat.zeros(h + pad * 2, pw, cv.CV_8UC1));
        const rd = region.data;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) if (mask[y * w + x]) rd[(y + pad) * pw + x + pad] = 255;
        }
        cv.morphologyEx(region, region, cv.MORPH_CLOSE, closeK);
        cv.morphologyEx(region, region, cv.MORPH_OPEN, openK);
        const regionContours = track(new cv.MatVector());
        const hier = track(new cv.Mat());
        cv.findContours(region, regionContours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
        for (let i = 0; i < regionContours.size(); i++) {
          const c = regionContours.get(i);
          if (cv.contourArea(c) >= frameArea * minAreaRatio * 0.6) {
            const unpad = q => q && q.map(p => ({ x: Math.min(w - 1, Math.max(0, p.x - pad)), y: Math.min(h - 1, Math.max(0, p.y - pad)) }));
            const shifted = c.clone(); // contour in unpadded coordinates, for the line fit
            const sd = shifted.data32S;
            for (let k = 0; k < sd.length; k++) sd[k] -= pad;
            consider(quadFromContour(cv, shifted, skinUsable ? skin.mask : null, w, h));
            shifted.delete();
            const hull = new cv.Mat();
            cv.convexHull(c, hull); // the hull fills the notches left by thumbs
            consider(unpad(quadFromHull(cv, hull)));
            hull.delete();
          }
          c.delete();
        }
      }

      // 2. Pages found from their writing (works whatever the exposure).
      const src = track(cv.matFromImageData(imageData));
      const seeded = inkSeededCandidates(cv, src, imageData, skinUsable ? skin.mask : noSkin, w, h, frameArea * minAreaRatio, track);
      ink = seeded.ink;
      seeded.candidates.forEach(c => consider(c.pts, c.mask));

      // 3. Pages assembled from straight edge segments.
      const neutral = new Uint8Array(frameArea); // lenient "could be paper or print": not colourful, not very dark, not a hand
      for (let i = 0, j = 0; i < frameArea; i++, j += 4) {
        const r = imageData.data[j], g = imageData.data[j + 1], b = imageData.data[j + 2];
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        neutral[i] = max > 45 && (max - min) / max < 0.3 && !(skinUsable && skin.mask[i]) ? 1 : 0;
      }
      const lineCands = lineCandidates(cv, imageData, skinUsable ? skin.mask : null, w, h, frameArea * minAreaRatio, track, debug);
      lineCands.forEach(c => consider(c.pts, 'tint', c.support));

      // 4. Edge outlines (good on low-contrast backgrounds where colour alone isn't enough).
      const gray = track(new cv.Mat());
      const edges = track(new cv.Mat());
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      if (skinUsable) {
        const g = gray.data;
        for (let i = 0; i < frameArea; i++) if (skin.mask[i]) g[i] = 0;
      }
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      const med = median(gray.data);
      cv.Canny(gray, edges, Math.max(20, 0.66 * med), Math.max(60, Math.min(255, 1.33 * med)));
      const k3 = track(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3)));
      cv.dilate(edges, edges, k3);
      const edgeContours = track(new cv.MatVector());
      const h2 = track(new cv.Mat());
      cv.findContours(edges, edgeContours, h2, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < edgeContours.size(); i++) {
        const c = edgeContours.get(i);
        if (cv.contourArea(c) >= frameArea * minAreaRatio * 0.6) {
          const hull = new cv.Mat();
          cv.convexHull(c, hull);
          consider(quadFromHull(cv, hull));
          hull.delete();
        }
        c.delete();
      }
    } finally {
      mats.forEach(m => m.delete());
    }
    // 5. The previous frame's page, re-checked on this frame (temporal prior, as in SmartDoc's best entries).
    if (prior) consider(prior.map(p => ({ x: p.x, y: p.y })));

    const handInfo = { mask: skinUsable ? skin.mask : noSkin, width: w, height: h };
    const scored = candidates.map(c => scoreQuad(c.pts, c.mask || paper.strict, paper.Y, ink, w, h, imageData));
    // Re-rank the top candidates by edge support after snapping them to the page edges (Tropin et al.).
    const top = scored.map((s, i) => ({ s, i })).filter(x => x.s.score > 0)
      .sort((a, b) => b.s.score - a.s.score).slice(0, 10);
    const diag = Math.hypot(w, h);
    let best = null;
    for (const { s } of top) {
      const r = refineQuad(imageData, s.quad, { hand: handInfo });
      s.quad = r.quad;
      s.support = r.support;
      s.meanSupport = r.meanSupport;
      s.rim = rimScore(imageData, r.quad, skinUsable ? skin.mask : null, null, ink);
      if (s.rim < 0.7) { s.reason = 'border isn\'t a page edge'; continue; } // needs ~3 real page-border sides
      // A side that isn't a real page border (a printed table line, a wall edge) costs a lot.
      let score = s.score * (0.4 + 0.6 * r.meanSupport) * Math.pow(s.rim, 4);
      if (prior) {
        const pq = orderCorners(prior);
        const dMean = s.quad.reduce((acc, p, k) => acc + dist(p, pq[k]), 0) / 4;
        if (dMean < diag * 0.05) score *= 1.3; // agrees with the previous frame
      }
      s.finalScore = score;
      if (!best || score > best.finalScore) best = s;
    }
    if (best) {
      const edge = Math.max(1.5, Math.min(w, h) * 0.004);
      best.touchesEdge = best.touchesEdge || best.quad.some(p => p.x <= edge || p.y <= edge || p.x >= w - 1 - edge || p.y >= h - 1 - edge);
    }
    if (debug) {
      debug.width = w;
      debug.height = h;
      debug.skin = skinUsable ? skin.mask : noSkin;
      debug.paper = paper.strict;
      debug.ink = ink;
      debug.candidates = scored.filter(c => c.quad);
      debug.regions = candidates.map((c, i) => (scored[i].quad ? c.mask || null : undefined)).filter(m => m !== undefined);
      debug.best = best;
    }
    if (!best) return null;
    const quad = best.quad.map(p => ({ x: p.x, y: p.y }));
    quad.touchesEdge = best.touchesEdge;
    quad.support = best.support;
    return quad;
  }

  /** Pulls corners slightly toward the centre so the background doesn't show at the edges. */
  function inset(pts, amount) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    return pts.map(p => ({ x: p.x + (cx - p.x) * amount * 2, y: p.y + (cy - p.y) * amount * 2 }));
  }

  /** Rejects slivers and badly distorted shapes. */
  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(z) < 1e-6) return false;
      if (sign && Math.sign(z) !== sign) return false;
      sign = Math.sign(z);
    }
    return true;
  }

  function looksLikePage(pts) {
    if (!isConvex(orderCorners(pts))) return false;
    const [a, b, c, d] = orderCorners(pts);
    const top = dist(a, b), bottom = dist(d, c), left = dist(a, d), right = dist(b, c);
    const ratio = Math.min(top, bottom, left, right) / Math.max(top, bottom, left, right);
    return ratio > 0.25 && Math.min(top, bottom) / Math.max(top, bottom) > 0.5 &&
      Math.min(left, right) / Math.max(left, right) > 0.5;
  }

  // -------------------------------------------------------------------------
  // Perspective correction
  // -------------------------------------------------------------------------

  /**
   * Projective mapping from the unit square to a quad (Heckbert, 1989).
   * (0,0)->p0, (1,0)->p1, (1,1)->p2, (0,1)->p3
   */
  function squareToQuad(p) {
    const [p0, p1, p2, p3] = p;
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const sx = p0.x - p1.x + p2.x - p3.x, sy = p0.y - p1.y + p2.y - p3.y;
    const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
    const g = (sx * dy2 - dx2 * sy) / den;
    const h = (dx1 * sy - sx * dy1) / den;
    return {
      a: p1.x - p0.x + g * p1.x, b: p3.x - p0.x + h * p3.x, c: p0.x,
      d: p1.y - p0.y + g * p1.y, e: p3.y - p0.y + h * p3.y, f: p0.y,
      g, h
    };
  }

  /** Output size for a quad: the longest of each pair of opposite edges. */
  function quadSize(corners) {
    const [tl, tr, br, bl] = corners;
    return {
      w: Math.max(dist(tl, tr), dist(bl, br)),
      h: Math.max(dist(tl, bl), dist(tr, br))
    };
  }

  /**
   * Cuts the quad out of the source and flattens it into a rectangle.
   * @param {HTMLCanvasElement|ImageBitmap} source
   */
  function warp(source, corners, maxDim, aspect) {
    let { w, h } = quadSize(corners);
    if (aspect) {
      // Keep the true page shape; size so each source pixel maps to at least one output pixel.
      w = Math.max(w, h / aspect);
      h = w * aspect;
    }
    let scale = Math.min(1, maxDim / Math.max(w, h));

    // Let the browser downscale first (better quality than point sampling).
    const srcW = Math.round(source.width * scale), srcH = Math.round(source.height * scale);
    const src = createCanvas(srcW, srcH);
    const sctx = ctx2d(src);
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(source, 0, 0, srcW, srcH);
    const quad = corners.map(p => ({ x: p.x * scale, y: p.y * scale }));
    const W = Math.max(1, Math.round(w * scale)), H = Math.max(1, Math.round(h * scale));

    const sd = sctx.getImageData(0, 0, srcW, srcH).data;
    const out = createCanvas(W, H);
    const octx = ctx2d(out);
    const img = octx.createImageData(W, H);
    const od = img.data;
    const m = squareToQuad(quad);
    const maxX = srcW - 1, maxY = srcH - 1;

    let o = 0;
    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      for (let x = 0; x < W; x++, o += 4) {
        const u = (x + 0.5) / W;
        const den = m.g * u + m.h * v + 1;
        let fx = (m.a * u + m.b * v + m.c) / den - 0.5;
        let fy = (m.d * u + m.e * v + m.f) / den - 0.5;
        fx = fx < 0 ? 0 : fx > maxX ? maxX : fx;
        fy = fy < 0 ? 0 : fy > maxY ? maxY : fy;
        const x0 = fx | 0, y0 = fy | 0;
        const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
        const ax = fx - x0, ay = fy - y0;
        const i00 = (y0 * srcW + x0) * 4, i10 = (y0 * srcW + x1) * 4;
        const i01 = (y1 * srcW + x0) * 4, i11 = (y1 * srcW + x1) * 4;
        for (let ch = 0; ch < 3; ch++) {
          const top = sd[i00 + ch] + (sd[i10 + ch] - sd[i00 + ch]) * ax;
          const bot = sd[i01 + ch] + (sd[i11 + ch] - sd[i01 + ch]) * ax;
          od[o + ch] = top + (bot - top) * ay;
        }
        od[o + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  function rotate(canvas, degrees) {
    const deg = ((degrees % 360) + 360) % 360;
    if (!deg) return canvas;
    const swap = deg === 90 || deg === 270;
    const out = createCanvas(swap ? canvas.height : canvas.width, swap ? canvas.width : canvas.height);
    const ctx = ctx2d(out);
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    return out;
  }

  // -------------------------------------------------------------------------
  // Clean-up filters
  // -------------------------------------------------------------------------

  /**
   * Estimates the paper's colour at every point (the lighting) so it can be
   * divided out, removing shadows and uneven light.
   *
   * The page is split into cells; each cell's paper colour is the average of
   * its brightest pixels (ink is darker). Cells that are much darker than the
   * paper around them are print, not shadow: a filled box, a dark header bar,
   * a shaded table cell. Those cells are left out and filled in from the
   * neighbouring paper, so dark print stays dark instead of being "corrected"
   * to white.
   * @returns {Float32Array} RGB paper estimate per pixel (3 values per pixel)
   */
  function estimatePaper(canvas) {
    const w = canvas.width, h = canvas.height;
    const d = ctx2d(canvas).getImageData(0, 0, w, h).data;
    const cell = Math.max(6, Math.round(Math.max(w, h) / 48));
    const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell), cells = gw * gh;
    const col = new Float32Array(cells * 3), lum = new Float32Array(cells);
    const hist = new Uint32Array(256);
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        hist.fill(0);
        const x0 = cx * cell, y0 = cy * cell, x1 = Math.min(w, x0 + cell), y1 = Math.min(h, y0 + cell);
        let n = 0;
        for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { const j = (y * w + x) * 4; hist[lumaOf(d, j)]++; n++; }
        let cut = 255;
        for (let v = 255, acc = 0; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.15) { cut = v; break; } }
        let r = 0, g = 0, b = 0, m = 0;
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const j = (y * w + x) * 4;
            if (lumaOf(d, j) >= cut) { r += d[j]; g += d[j + 1]; b += d[j + 2]; m++; }
          }
        }
        const c = cy * gw + cx;
        col[c * 3] = r / m; col[c * 3 + 1] = g / m; col[c * 3 + 2] = b / m;
        lum[c] = (col[c * 3] * 77 + col[c * 3 + 1] * 150 + col[c * 3 + 2] * 29) / 256;
      }
    }
    // Paper or print? Compare each cell with the paper level around it and on the whole page.
    const sortedLum = Array.from(lum).sort((a, b) => a - b);
    const pageLevel = sortedLum[Math.floor(sortedLum.length * 0.75)];
    let known = new Uint8Array(cells);
    const R = 3;
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        const around = [];
        for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
          const xx = cx + dx, yy = cy + dy;
          if ((dx || dy) && xx >= 0 && yy >= 0 && xx < gw && yy < gh) around.push(lum[yy * gw + xx]);
        }
        around.sort((a, b) => a - b);
        const local = around.length ? around[Math.floor(around.length * 0.75)] : pageLevel;
        const c = cy * gw + cx;
        known[c] = lum[c] >= 0.88 * local && lum[c] >= 0.78 * pageLevel ? 1 : 0;
      }
    }
    // Fill print cells from neighbouring paper.
    let colour = col;
    for (let pass = 0; pass < gw + gh; pass++) {
      const next = colour.slice(), nextKnown = known.slice();
      let missing = 0;
      for (let cy = 0; cy < gh; cy++) {
        for (let cx = 0; cx < gw; cx++) {
          const c = cy * gw + cx;
          if (known[c]) continue;
          let r = 0, g = 0, b = 0, k = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = cx + dx, yy = cy + dy;
            if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
            const nc = yy * gw + xx;
            if (!known[nc]) continue;
            r += colour[nc * 3]; g += colour[nc * 3 + 1]; b += colour[nc * 3 + 2]; k++;
          }
          if (k) { next[c * 3] = r / k; next[c * 3 + 1] = g / k; next[c * 3 + 2] = b / k; nextKnown[c] = 1; } else missing++;
        }
      }
      colour = next; known = nextKnown;
      if (!missing) break;
    }
    // Smooth, then scale up to full size (bilinear).
    const sm = createCanvas(gw, gh);
    const sctx = ctx2d(sm);
    const simg = sctx.createImageData(gw, gh);
    for (let c = 0; c < cells; c++) {
      let r = 0, g = 0, b = 0, k = 0;
      const cx = c % gw, cy = (c / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = cx + dx, yy = cy + dy;
        if (xx < 0 || yy < 0 || xx >= gw || yy >= gh) continue;
        const nc = yy * gw + xx;
        r += colour[nc * 3]; g += colour[nc * 3 + 1]; b += colour[nc * 3 + 2]; k++;
      }
      simg.data[c * 4] = r / k; simg.data[c * 4 + 1] = g / k; simg.data[c * 4 + 2] = b / k; simg.data[c * 4 + 3] = 255;
    }
    sctx.putImageData(simg, 0, 0);
    const big = createCanvas(w, h);
    const bctx = ctx2d(big);
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(sm, 0, 0, w, h);
    return bctx.getImageData(0, 0, w, h).data;
  }

  /** Box blur of a single-channel float image (separable, running sums). */
  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  /**
   * Scanner-style clean-up.
   *  - enhanced: lighting divided out (paper → white, colours kept), text sharpened and darkened
   *  - gray:     the same in greyscale
   *  - bw:       black and white; local thresholding keeps text inside shaded table cells,
   *              and large dark print (filled boxes) stays black
   * @param {'enhanced'|'original'|'gray'|'bw'} filter
   */
  function applyFilter(canvas, filter) {
    if (!filter || filter === 'original') return canvas;
    const w = canvas.width, h = canvas.height, n = w * h;
    const ctx = ctx2d(canvas);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const paper = estimatePaper(canvas);

    // 1. Divide out the lighting: paper becomes 1.0 in every channel.
    const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), L = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      R[i] = Math.min(1.1, d[j] / Math.max(paper[j], 20));
      G[i] = Math.min(1.1, d[j + 1] / Math.max(paper[j + 1], 20));
      B[i] = Math.min(1.1, d[j + 2] / Math.max(paper[j + 2], 20));
      L[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
    }
    // 2. Unsharp mask on brightness: webcam text is soft.
    const radius = Math.max(1, Math.round(Math.max(w, h) / 600));
    const blurred = boxBlur(L, w, h, radius);
    const sharp = new Float32Array(n);
    for (let i = 0; i < n; i++) sharp[i] = L[i] + 1.2 * (L[i] - blurred[i]);

    // 3. Tone curve: the darkest print → black, paper → white, faint text darkened.
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i += 3) hist[Math.max(0, Math.min(255, Math.round(L[i] * 230)))]++;
    let black = 0, total = 0;
    for (let v = 0; v < 256; v++) total += hist[v];
    for (let v = 0, acc = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { black = v / 230; break; } }
    black = Math.min(0.45, black);
    const white = 0.93;
    const tone = v => { const t = Math.min(1, Math.max(0, (v - black) / (white - black))); return Math.pow(t, 1.5); };

    if (filter === 'bw') {
      // Sauvola thresholding (local mean and spread): faint text inside a shaded
      // table cell still comes out black, the shading itself white, and large
      // dark print (filled boxes) stays black.
      const r = Math.max(4, Math.round(Math.max(w, h) / 80));
      const sq = new Float32Array(n);
      for (let i = 0; i < n; i++) sq[i] = sharp[i] * sharp[i];
      const mean = boxBlur(sharp, w, h, r), meanSq = boxBlur(sq, w, h, r);
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        const sd = Math.sqrt(Math.max(0, meanSq[i] - mean[i] * mean[i]));
        const t = mean[i] * (1 + 0.1 * (sd / 0.5 - 1));
        const ink = sharp[i] < 0.45 || sharp[i] < t;
        d[j] = d[j + 1] = d[j + 2] = ink ? 0 : 255;
      }
    } else if (filter === 'gray') {
      for (let i = 0, j = 0; i < n; i++, j += 4) d[j] = d[j + 1] = d[j + 2] = Math.round(255 * tone(sharp[i]));
    } else {
      for (let i = 0, j = 0; i < n; i++, j += 4) {
        // Apply the tone change to brightness and keep each pixel's colour ratio.
        const target = tone(sharp[i]);
        const k = L[i] > 0.02 ? target / L[i] : 0;
        d[j] = Math.max(0, Math.min(255, Math.round(255 * R[i] * k)));
        d[j + 1] = Math.max(0, Math.min(255, Math.round(255 * G[i] * k)));
        d[j + 2] = Math.max(0, Math.min(255, Math.round(255 * B[i] * k)));
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  return {
    createCanvas, ctx2d, orderCorners, fullFrame, polygonArea,
    toGray, meanAbsDiff, sharpness,
    detectQuad, warp, rotate, applyFilter, quadSize, removeFingers,
    refineQuad, estimateAspect, maskCoverage, locatePage, shrinkTo, inset, skinMask, rimScore
  };
})();
