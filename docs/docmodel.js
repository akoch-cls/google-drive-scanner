/**
 * DocModel: page-corner detection with a pretrained neural network.
 *
 * The model is DocAligner (DocsaidLab, https://github.com/DocsaidLab/DocAligner),
 * LCNet-100 heatmap variant (4.8 MB), trained on hand-held document photos and
 * video (SmartDoc 2015, MIDV). It looks at a 256×256 copy of the frame and
 * outputs four 128×128 heatmaps, one per corner; the peak of each is the
 * corner, and its height is the model's confidence. Because it has learned
 * what a page looks like, it isn't fooled by walls, ceiling lights or faces,
 * and it still places a corner that a thumb is covering.
 *
 * It runs in the browser with ONNX Runtime Web (WebAssembly). Everything is
 * optional: if the runtime or model can't load, status() is 'failed' and the
 * scanner uses its hand-tuned detector instead.
 */
const DocModel = (() => {
  'use strict';

  const ORT_VERSION = '1.20.1';
  const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/';
  const MODEL_URL = 'models/docaligner-lcnet100.onnx';
  const SIZE = 256;   // model input
  const HEAT = 128;   // heatmap size
  const MIN_CONFIDENCE = 0.1;

  let ort = null;
  let session = null;
  let status = 'off';
  let busy = false;
  let canvas = null;
  let channels = 'bgr'; // DocAligner was trained on OpenCV images (BGR), scaled to 0–1

  /**
   * @param opts.ortBase  where ort.wasm.min.mjs and its .wasm files live (default: jsDelivr)
   * @param opts.modelUrl the .onnx file (default: docs/models/)
   * @param opts.channels 'bgr' (default) or 'rgb'
   */
  async function load(opts = {}) {
    if (status !== 'off') return status;
    if (opts.channels) channels = opts.channels;
    status = 'loading';
    try {
      const base = opts.ortBase || ORT_BASE;
      ort = await import(base + 'ort.wasm.min.mjs');
      ort.env.wasm.wasmPaths = base;
      // Threads need cross-origin isolation, which GitHub Pages doesn't provide.
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      session = await ort.InferenceSession.create(opts.modelUrl || MODEL_URL, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
      status = 'ready';
    } catch (err) {
      console.warn('Page-detection model unavailable, using the built-in detector instead.', err);
      status = 'failed';
    }
    return status;
  }

  /** Copies the source into the model's input tensor (BGR, 0–1, channels first, stretched to 256×256), as DocAligner's own preprocess() does. */
  function preprocess(source) {
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = canvas.height = SIZE;
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, SIZE, SIZE);
    const d = ctx.getImageData(0, 0, SIZE, SIZE).data;
    const n = SIZE * SIZE;
    const t = new Float32Array(3 * n);
    const r = channels === 'bgr' ? 2 : 0, b = 2 - r;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      t[i] = d[j + r] / 255;
      t[i + n] = d[j + 1] / 255;
      t[i + 2 * n] = d[j + b] / 255;
    }
    return t;
  }

  /** Peak of each heatmap, refined to sub-pixel by a weighted average around it. */
  function decode(heat, w, h) {
    const sx = w / HEAT, sy = h / HEAT, out = [];
    for (let c = 0; c < 4; c++) {
      const off = c * HEAT * HEAT;
      let peak = -Infinity, at = 0;
      for (let i = 0; i < HEAT * HEAT; i++) if (heat[off + i] > peak) { peak = heat[off + i]; at = i; }
      const px = at % HEAT, py = (at - px) / HEAT;
      let sum = 0, mx = 0, my = 0;
      for (let y = Math.max(0, py - 4); y <= Math.min(HEAT - 1, py + 4); y++) {
        for (let x = Math.max(0, px - 4); x <= Math.min(HEAT - 1, px + 4); x++) {
          const v = heat[off + y * HEAT + x];
          if (v >= 0.3 * peak) { sum += v; mx += v * x; my += v * y; }
        }
      }
      const cx = sum > 0 ? mx / sum : px, cy = sum > 0 ? my / sum : py;
      out.push({ x: (cx + 0.5) * sx, y: (cy + 0.5) * sy, confidence: peak });
    }
    return out;
  }

  /**
   * Finds the page in an image, video frame or canvas.
   * @returns {Promise<{corners: Array<{x, y, confidence}>, confidence: number} | null>}
   *   corners in the source's pixels (model order), or null if there's no page
   *   (or the model is busy with the previous frame).
   */
  async function detect(source) {
    if (status !== 'ready' || busy) return null;
    const w = source.videoWidth || source.width, h = source.videoHeight || source.height;
    if (!w || !h) return null;
    busy = true;
    try {
      const input = new ort.Tensor('float32', preprocess(source), [1, 3, SIZE, SIZE]);
      const result = await session.run({ img: input });
      const heat = result.heatmap.data;
      const corners = decode(heat, w, h);
      const confidence = Math.min(...corners.map(c => c.confidence));
      return { corners, confidence, found: confidence >= MIN_CONFIDENCE };
    } finally {
      busy = false;
    }
  }

  return { load, detect, status: () => status, isBusy: () => busy, MIN_CONFIDENCE };
})();
