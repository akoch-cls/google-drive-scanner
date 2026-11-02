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

  /** Variance of the Laplacian: high when edges are crisp, low when blurry. */
  function sharpness(imageData) {
    const w = imageData.width, h = imageData.height;
    const g = toGray(imageData);
    let sum = 0, sum2 = 0, n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1, i = y * w + 1; x < w - 1; x++, i++) {
        const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
        sum += lap;
        sum2 += lap * lap;
        n++;
      }
    }
    if (!n) return 0;
    const mean = sum / n;
    return sum2 / n - mean * mean;
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
  function removeFingers(canvas) {
    const W = canvas.width, H = canvas.height;
    const s = Math.min(1, 600 / Math.max(W, H));
    const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s));
    const small = createCanvas(w, h);
    const sctx = ctx2d(small);
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(canvas, 0, 0, w, h);
    const d = sctx.getImageData(0, 0, w, h).data;
    const n = w * h;

    const { mask } = skinMask({ data: d, width: w, height: h });
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
    morph(mask, w, h, -1); // drop specks
    morph(mask, w, h, 1);

    // Keep connected skin regions that touch the border band.
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.04));
    const minArea = n * 0.0004;
    const keep = new Uint8Array(n);
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    let kept = 0;
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
   * How page-like a candidate is: mostly paper-coloured inside, brighter than
   * its surroundings, large, and near the middle. Faces, bookshelves and
   * clothing fail the paper test; a window loses on size and position.
   */
  function scoreQuad(pts, paper, Y, ink, w, h) {
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
          nIn++; paperIn += paper[i]; sumIn += Y[i]; inkIn += ink[i];
          if (Y[i] >= 250) clippedIn++;
        } else {
          nOut++; sumOut += Y[i];
        }
      }
    }
    if (!nIn) return { score: 0 };
    const fill = paperIn / nIn;
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
    const score = (area / (w * h)) * fill * fill * centre * (Math.abs(contrast) > 10 ? 1 : 0.4) * (touchesEdge ? 0.6 : 1);
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
      cv.findContours(rm, rc, rh, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
      let bestI = -1, bestA = 0;
      for (let i = 0; i < rc.size(); i++) {
        const c = rc.get(i);
        const a = cv.contourArea(c);
        if (a > bestA) { bestA = a; bestI = i; }
        c.delete();
      }
      if (bestI < 0) continue;
      const c = rc.get(bestI);
      const hull = new cv.Mat();
      cv.convexHull(c, hull);
      const pts = quadFromHull(cv, hull);
      hull.delete();
      c.delete();
      if (pts) candidates.push({ pts, mask: region });
    }
    return { ink, candidates };
  }

  /**
   * Finds the page in a frame. Candidates come from two places: regions that
   * look like paper (bright, colourless, not skin), and outlines found by Canny
   * edge detection. Each is scored by scoreQuad and the best one wins.
   * Returns 4 ordered corners in the image's pixel coordinates (with
   * `touchesEdge` set when the page runs off the frame), or null.
   */
  function detectQuad(imageData, minAreaRatio = 0.08, debug = null) {
    const cv = window.cv;
    if (!cv || !cv.Mat) return null;
    const w = imageData.width, h = imageData.height;
    const frameArea = w * h;
    const skin = skinMask(imageData);
    const skinUsable = skin.count < frameArea * 0.4;
    const noSkin = new Uint8Array(frameArea);
    const paper = paperMask(imageData, skinUsable ? skin.mask : noSkin);
    const candidates = [];
    const consider = (pts, mask) => {
      if (!pts) return;
      const area = polygonArea(pts);
      if (area >= frameArea * minAreaRatio && area < frameArea * 0.985 && looksLikePage(pts)) candidates.push({ pts, mask });
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
        cv.findContours(region, regionContours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
        for (let i = 0; i < regionContours.size(); i++) {
          const c = regionContours.get(i);
          if (cv.contourArea(c) >= frameArea * minAreaRatio * 0.6) {
            const hull = new cv.Mat();
            cv.convexHull(c, hull); // the hull fills the notches left by thumbs
            const q = quadFromHull(cv, hull);
            consider(q && q.map(p => ({ x: Math.min(w - 1, Math.max(0, p.x - pad)), y: Math.min(h - 1, Math.max(0, p.y - pad)) })));
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

      // 3. Edge outlines (good on low-contrast backgrounds where colour alone isn't enough).
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

    let best = null;
    const scored = candidates.map(c => scoreQuad(c.pts, c.mask || paper.strict, paper.Y, ink, w, h));
    for (const s of scored) {
      if (s.score > 0 && (!best || s.score > best.score)) best = s;
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
    const quad = inset(best.quad, 0.012);
    quad.touchesEdge = best.touchesEdge;
    return quad;
  }

  /** Pulls corners slightly toward the centre so the background doesn't show at the edges. */
  function inset(pts, amount) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    return pts.map(p => ({ x: p.x + (cx - p.x) * amount * 2, y: p.y + (cy - p.y) * amount * 2 }));
  }

  /** Rejects slivers and badly distorted shapes. */
  function looksLikePage(pts) {
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
  function warp(source, corners, maxDim) {
    let { w, h } = quadSize(corners);
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

  /** Separable max filter on one RGBA channel, in place. */
  function dilateChannel(d, w, h, ch, r) {
    const tmp = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, d[(y * w + k) * 4 + ch]);
        tmp[y * w + x] = m;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let m = 0;
        for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
        d[(y * w + x) * 4 + ch] = m;
      }
    }
  }

  /**
   * Estimates how bright the paper is at every point (the lighting), by
   * shrinking the page and erasing the ink with a max filter.
   * Dividing by this removes shadows and uneven light.
   */
  function estimatePaper(canvas) {
    const w = canvas.width, h = canvas.height;
    const k = Math.max(w, h) / 96;
    const sw = Math.max(8, Math.round(w / k)), sh = Math.max(8, Math.round(h / k));
    // Two-step shrink so the browser averages pixels rather than skipping them.
    const mid = createCanvas(sw * 4, sh * 4);
    const mctx = ctx2d(mid);
    mctx.imageSmoothingQuality = 'high';
    mctx.drawImage(canvas, 0, 0, mid.width, mid.height);
    const small = createCanvas(sw, sh);
    const sctx = ctx2d(small);
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(mid, 0, 0, sw, sh);

    const img = sctx.getImageData(0, 0, sw, sh);
    for (let ch = 0; ch < 3; ch++) dilateChannel(img.data, sw, sh, ch, 2);
    sctx.putImageData(img, 0, 0);

    const big = createCanvas(w, h);
    const bctx = ctx2d(big);
    bctx.imageSmoothingQuality = 'high';
    bctx.filter = 'blur(' + Math.max(2, Math.round(k * 2)) + 'px)';
    bctx.drawImage(small, 0, 0, w, h);
    return bctx.getImageData(0, 0, w, h).data;
  }

  // Maps normalised brightness to output: deepens ink, pushes paper to white.
  const LEVELS = (() => {
    const lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) {
      const t = Math.min(1, Math.max(0, (v - 25) / (235 - 25)));
      lut[v] = Math.round(Math.pow(t, 1.25) * 255);
    }
    return lut;
  })();

  /**
   * @param {'enhanced'|'original'|'gray'|'bw'} filter
   */
  function applyFilter(canvas, filter) {
    if (!filter || filter === 'original') return canvas;
    const w = canvas.width, h = canvas.height;
    const ctx = ctx2d(canvas);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const paper = estimatePaper(canvas);

    for (let i = 0; i < d.length; i += 4) {
      const r = Math.min(255, d[i] * 255 / Math.max(paper[i], 24));
      const g = Math.min(255, d[i + 1] * 255 / Math.max(paper[i + 1], 24));
      const b = Math.min(255, d[i + 2] * 255 / Math.max(paper[i + 2], 24));
      if (filter === 'enhanced') {
        d[i] = LEVELS[r | 0];
        d[i + 1] = LEVELS[g | 0];
        d[i + 2] = LEVELS[b | 0];
      } else {
        const y = (r * 77 + g * 150 + b * 29) >> 8;
        const v = filter === 'bw' ? (y < 200 ? 0 : 255) : LEVELS[y];
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  return {
    createCanvas, ctx2d, orderCorners, fullFrame, polygonArea,
    toGray, meanAbsDiff, sharpness,
    detectQuad, warp, rotate, applyFilter, quadSize, removeFingers
  };
})();
