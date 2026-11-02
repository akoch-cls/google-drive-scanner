/**
 * Hands: a finger/hand mask from Google's MediaPipe Hand Landmarker
 * (Zhang et al. 2020), a pretrained model that runs in the browser and finds
 * 21 points on each hand. The mask tells page detection which edge pixels to
 * ignore (fingers holding the page) and lets the app hold off capturing while
 * fingers cover the writing.
 *
 * It's optional: if the library or model can't be downloaded (offline, school
 * web filter), status() is 'failed' and the scanner falls back to its
 * skin-colour mask.
 */
const Hands = (() => {
  'use strict';

  const VERSION = '0.10.14';
  const CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VERSION;
  const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

  // Landmark chains: thumb, index, middle, ring, little finger; and the palm outline.
  const FINGERS = [[0, 1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]];
  const PALM = [0, 1, 5, 9, 13, 17];

  let landmarker = null;
  let status = 'off';
  let lastTimestamp = 0;
  let hands = [];
  let maskCanvas = null;

  async function load() {
    if (status !== 'off') return status;
    status = 'loading';
    try {
      const vision = await import(CDN + '/vision_bundle.mjs');
      const files = await vision.FilesetResolver.forVisionTasks(CDN + '/wasm');
      for (const delegate of ['GPU', 'CPU']) {
        try {
          landmarker = await vision.HandLandmarker.createFromOptions(files, {
            baseOptions: { modelAssetPath: MODEL, delegate },
            runningMode: 'VIDEO',
            numHands: 2,
            minHandDetectionConfidence: 0.4,
            minHandPresenceConfidence: 0.4,
            minTrackingConfidence: 0.4
          });
          break;
        } catch (err) {
          landmarker = null;
        }
      }
      status = landmarker ? 'ready' : 'failed';
    } catch (err) {
      console.warn('Hand tracking unavailable, using skin colour instead.', err);
      status = 'failed';
    }
    return status;
  }

  /** Finds hands in a video frame, image or canvas. Returns [[21 × {x, y}]] in 0..1 coordinates. */
  function track(source) {
    if (!landmarker) return [];
    let ts = performance.now();
    if (ts <= lastTimestamp) ts = lastTimestamp + 1;
    lastTimestamp = ts;
    try {
      const result = landmarker.detectForVideo(source, ts);
      hands = (result.landmarks || []).map(points => points.map(p => ({ x: p.x, y: p.y })));
    } catch (err) {
      hands = [];
    }
    return hands;
  }

  /**
   * Rasterises hands into a w × h mask (1 = hand): a thick stroke along each
   * finger (extended a little past the last joint, to cover the fingertip)
   * and the filled palm.
   */
  function mask(handList, w, h) {
    if (!handList || !handList.length) return null;
    if (!maskCanvas) maskCanvas = document.createElement('canvas');
    if (maskCanvas.width !== w || maskCanvas.height !== h) { maskCanvas.width = w; maskCanvas.height = h; }
    const ctx = maskCanvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = ctx.strokeStyle = '#fff';
    ctx.lineCap = ctx.lineJoin = 'round';
    for (const lm of handList) {
      const p = lm.map(q => ({ x: q.x * w, y: q.y * h }));
      const palmWidth = Math.hypot(p[5].x - p[17].x, p[5].y - p[17].y);
      ctx.lineWidth = Math.max(3, palmWidth * 0.42);
      for (const chain of FINGERS) {
        const last = p[chain[chain.length - 1]], prev = p[chain[chain.length - 2]];
        const tip = { x: last.x + (last.x - prev.x) * 0.45, y: last.y + (last.y - prev.y) * 0.45 };
        ctx.beginPath();
        chain.forEach((k, i) => (i ? ctx.lineTo(p[k].x, p[k].y) : ctx.moveTo(p[k].x, p[k].y)));
        ctx.lineTo(tip.x, tip.y);
        ctx.stroke();
      }
      ctx.beginPath();
      PALM.forEach((k, i) => (i ? ctx.lineTo(p[k].x, p[k].y) : ctx.moveTo(p[k].x, p[k].y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    const d = ctx.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3] > 64 ? 1 : 0;
    return out;
  }

  return { load, track, mask, status: () => status };
})();
