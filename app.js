/**
 * LightSlice — AudioSlice for light.
 * Drag a band on the visible spectrum; camera view shows only that slice.
 * RGB bandpass is approximate (teaching demo, not a spectrometer).
 */
(function () {
  "use strict";

  const VIS_MIN = 400;
  const VIS_MAX = 700;
  const MIN_BAND_NM = 1; // full band → 1 nm
  const FULL_WIDTH = VIS_MAX - VIS_MIN; // 300

  // ROYGBIV — unequal named bands (not equal nm).
  // O/Y slightly wider than the tightest textbook cuts: still in-range for
  // those names, enough light for a stable RGB bandpass (less gain/noise).
  const PRESETS = {
    red: { lo: 625, hi: 700 }, // ~75 nm
    orange: { lo: 590, hi: 630 }, // ~40 nm (was 30)
    yellow: { lo: 560, hi: 595 }, // ~35 nm (was 20)
    green: { lo: 495, hi: 565 }, // ~70 nm
    blue: { lo: 450, hi: 495 }, // ~45 nm
    indigo: { lo: 420, hi: 450 }, // ~30 nm
    violet: { lo: 400, hi: 425 }, // ~25 nm
  };

  const EM_SEGMENTS = [
    { id: "radio", label: "Radio", w: 22, color: "#1e3a5f" },
    { id: "micro", label: "μwave", w: 14, color: "#234e70" },
    { id: "ir", label: "IR", w: 16, color: "#7c2d12" },
    { id: "vis", label: "Visible", w: 8, color: null },
    { id: "uv", label: "UV", w: 12, color: "#4c1d95" },
    { id: "xray", label: "X-ray", w: 14, color: "#334155" },
    { id: "gamma", label: "γ", w: 14, color: "#1f2937" },
  ];

  const el = {
    status: document.getElementById("status"),
    hint: document.getElementById("hint"),
    startBtn: document.getElementById("start-btn"),
    flipBtn: document.getElementById("flip-btn"),
    btnFull: document.getElementById("btn-full"),
    colorName: document.getElementById("color-name"),
    swatchChip: document.getElementById("swatch-chip"),
    waveReadout: document.getElementById("wave-readout"),
    bandReadout: document.getElementById("band-readout"),
    emContext: document.getElementById("em-context"),
    visContext: document.getElementById("vis-context"),
    video: document.getElementById("video"),
    view: document.getElementById("view"),
    previewWrap: document.getElementById("preview-wrap"),
    emCanvas: document.getElementById("em-canvas"),
    visCanvas: document.getElementById("vis-canvas"),
    emTrack: document.getElementById("em-track"),
    visTrack: document.getElementById("vis-track"),
    visHit: document.getElementById("vis-hit"),
  };

  const state = {
    running: false,
    stream: null,
    facing: "environment",
    canFlip: false,
    lo: VIS_MIN,
    hi: VIS_MAX,
    frame: 0,
    // work buffer for filter
    work: null,
    workW: 0,
    workH: 0,
    workCtx: null,
    // adaptive process width (JS bandpass is CPU-heavy on older Macs)
    procMaxW: 480,
    frameMsEma: 20,
    // cached band filter params (recomputed only when lo/hi change)
    filtKey: "",
    filt: null,
    // cached preview rect
    wrapW: 0,
    wrapH: 0,
  };

  // drag on visible strip
  // LEFT = long λ (hi, red) · RIGHT = short λ (lo, violet) · middle = slide whole band
  let dragging = null; // 'short' | 'long' | 'band'
  let freezeNm = 0; // frozen edge when resizing
  let dragStartX = 0;
  let dragStartLo = 0;
  let dragStartHi = 0;

  /* ── math / color ─────────────────────────────────────────── */

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function wavelengthToRgb(nm) {
    let r = 0;
    let g = 0;
    let b = 0;
    if (nm >= 380 && nm < 440) {
      // Deep violet/blue — keep red low so left end never reads as “red”
      r = 0.3 * (-(nm - 440) / (440 - 380));
      b = 1;
    } else if (nm >= 440 && nm < 490) {
      g = (nm - 440) / (490 - 440);
      b = 1;
    } else if (nm >= 490 && nm < 510) {
      g = 1;
      b = -(nm - 510) / (510 - 490);
    } else if (nm >= 510 && nm < 580) {
      r = (nm - 510) / (580 - 510);
      g = 1;
    } else if (nm >= 580 && nm < 645) {
      r = 1;
      g = -(nm - 645) / (645 - 580);
    } else if (nm >= 645 && nm <= 780) {
      r = 1;
    }
    let factor = 0;
    if (nm >= 380 && nm < 420) factor = 0.3 + (0.7 * (nm - 380)) / 40;
    else if (nm >= 420 && nm < 701) factor = 1;
    else if (nm >= 701 && nm <= 780) factor = 0.3 + (0.7 * (780 - nm)) / 80;

    const gamma = 0.8;
    const to = (c) => Math.round(255 * Math.pow(clamp(c * factor, 0, 1), gamma));
    return { r: to(r), g: to(g), b: to(b) };
  }

  function colorNameFromBand(lo, hi) {
    const w = hi - lo;
    if (w >= FULL_WIDTH - 1) return "Full";
    const c = Math.round((lo + hi) / 2);
    if (c >= 620) return "Red";
    if (c >= 590) return "Orange";
    if (c >= 570) return "Yellow";
    if (c >= 495) return "Green";
    if (c >= 450) return "Blue";
    if (c >= 420) return "Indigo";
    return "Violet";
  }

  function cssRgb({ r, g, b }) {
    return `rgb(${r | 0},${g | 0},${b | 0})`;
  }

  function isFullBand(lo, hi) {
    return hi - lo >= FULL_WIDTH - 1;
  }

  /**
   * How much each camera primary “passes” the band (coarse RGB≠spectrometer model).
   * Overlap of band with approximate R/G/B sensitivity ranges.
   */
  function primaryPass(lo, hi) {
    function overlap(b0, b1, p0, p1) {
      const a = Math.max(b0, p0);
      const b = Math.min(b1, p1);
      if (b <= a) return 0;
      return (b - a) / Math.max(1, p1 - p0);
    }
    // Approx camera primaries (nm)
    let wr = overlap(lo, hi, 580, 700) + 0.35 * overlap(lo, hi, 560, 580);
    let wg = overlap(lo, hi, 490, 610);
    let wb = overlap(lo, hi, 400, 510) + 0.35 * overlap(lo, hi, 510, 530);
    // Narrow band that misses coarse bins: fall back to center color
    const sum = wr + wg + wb;
    if (sum < 0.04) {
      const c = wavelengthToRgb((lo + hi) / 2);
      wr = c.r / 255;
      wg = c.g / 255;
      wb = c.b / 255;
    }
    return { wr, wg, wb };
  }

  /** Pack filter constants once per band change (hot loop stays allocation-free). */
  function getFilterParams(lo, hi) {
    const key = lo + ":" + hi;
    if (state.filt && state.filtKey === key) return state.filt;

    const center = (lo + hi) / 2;
    const bandRgb = wavelengthToRgb(center);
    const bandFrac = clamp((hi - lo) / FULL_WIDTH, MIN_BAND_NM / FULL_WIDTH, 1);
    const prim = primaryPass(lo, hi);
    const half = Math.max((hi - lo) * 0.5, 6);
    const sigma = half + 28;
    const invTwoSig2 = 1 / (2 * sigma * sigma);
    const gain = 0.88 / Math.max(0.42, Math.pow(bandFrac, 0.38));

    state.filtKey = key;
    state.filt = {
      lo,
      hi,
      bandFrac,
      wr: prim.wr,
      wg: prim.wg,
      wb: prim.wb,
      br: bandRgb.r,
      bg: bandRgb.g,
      bb: bandRgb.b,
      gain,
      invTwoSig2,
    };
    return state.filt;
  }

  /**
   * In-place continuous bandpass on ImageData (no per-pixel allocations).
   * Same model as before — tuned for older CPUs.
   */
  function filterImageData(data, f) {
    const lo = f.lo;
    const hi = f.hi;
    const bandFrac = f.bandFrac;
    const wr = f.wr;
    const wg = f.wg;
    const wb = f.wb;
    const br = f.br;
    const bg = f.bg;
    const bb = f.bb;
    const gain = f.gain;
    const invTwoSig2 = f.invTwoSig2;
    const detail = 0.22;
    const odetail = 1 - detail;

    for (let i = 0, n = data.length; i < n; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b; // 0–255
      if (lum < 0.5) {
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        continue;
      }

      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      const dlt = max - min;
      const s = max === 0 ? 0 : dlt / max;
      const lumN = lum * 0.00392156862745098; // /255

      // hue → nm (only when saturated enough to matter)
      let gate = bandFrac; // default: treat low-chroma as broadband
      if (s >= 0.08) {
        let h = 0;
        if (dlt !== 0) {
          if (max === r) h = ((g - b) / dlt + (g < b ? 6 : 0)) / 6;
          else if (max === g) h = ((b - r) / dlt + 2) / 6;
          else h = ((r - g) / dlt + 4) / 6;
        }
        const hue = h * 360;
        let nm;
        if (hue < 15 || hue >= 345) nm = 665;
        else if (hue < 40) nm = 620 - ((hue - 15) / 25) * 30;
        else if (hue < 55) nm = 590 - ((hue - 40) / 15) * 15;
        else if (hue < 90) nm = 575 - ((hue - 55) / 35) * 35;
        else if (hue < 150) nm = 540 - ((hue - 90) / 60) * 45;
        else if (hue < 200) nm = 495 - ((hue - 150) / 50) * 35;
        else if (hue < 260) nm = 460 - ((hue - 200) / 60) * 40;
        else if (hue < 290) nm = 420 - ((hue - 260) / 30) * 15;
        else nm = 405 + ((hue - 290) / 55) * 260;

        if (nm < VIS_MIN) nm = VIS_MIN;
        else if (nm > VIS_MAX) nm = VIS_MAX;

        if (nm >= lo && nm <= hi) {
          gate = 1;
        } else {
          const dd = nm < lo ? lo - nm : nm - hi;
          gate = Math.exp(-dd * dd * invTwoSig2);
        }
      }

      const eRgb = r * wr + g * wg + b * wb; // still 0–~255 scale
      const eRgbN = eRgb * 0.00392156862745098;
      const eHue = lumN * gate;
      const eWhite = lumN * bandFrac;
      const energy =
        (1 - s) * (0.55 * eWhite + 0.45 * eRgbN) +
        s * (0.5 * eHue + 0.5 * eRgbN);

      let e = energy * gain;
      if (e > 1.25) e = 1.25;
      if (e < 0) e = 0;

      // band color * energy + a little original detail
      let or = e * (br * odetail + r * detail);
      let og = e * (bg * odetail + g * detail);
      let ob = e * (bb * odetail + b * detail);
      if (or > 255) or = 255;
      if (og > 255) og = 255;
      if (ob > 255) ob = 255;

      data[i] = or | 0;
      data[i + 1] = og | 0;
      data[i + 2] = ob | 0;
    }
  }

  /** Cover-fit source into view canvas (CSS pixels already × dpr in out size). */
  function drawCover(octx, source, outW, outH, mirror) {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.fillStyle = "#000";
    octx.fillRect(0, 0, outW, outH);

    const sw = source.videoWidth || source.width;
    const sh = source.videoHeight || source.height;
    if (!sw || !sh) return;

    const scale = Math.max(outW / sw, outH / sh);
    const dw = sw * scale;
    const dh = sh * scale;
    const dx = (outW - dw) / 2;
    const dy = (outH - dh) / 2;
    octx.imageSmoothingEnabled = true;
    if (mirror) {
      octx.translate(outW, 0);
      octx.scale(-1, 1);
      octx.drawImage(source, outW - dx - dw, dy, dw, dh);
      octx.setTransform(1, 0, 0, 1, 0, 0);
    } else {
      octx.drawImage(source, dx, dy, dw, dh);
    }
  }

  /* ── band state ───────────────────────────────────────────── */

  /** Commit band edges. lo = short λ (violet/right), hi = long λ (red/left). */
  function setBand(lo, hi) {
    lo = Math.round(Number(lo));
    hi = Math.round(Number(hi));
    if (hi < lo) {
      const t = lo;
      lo = hi;
      hi = t;
    }
    if (hi - lo < MIN_BAND_NM) {
      hi = Math.min(VIS_MAX, lo + MIN_BAND_NM);
      lo = Math.max(VIS_MIN, hi - MIN_BAND_NM);
    }
    lo = clamp(lo, VIS_MIN, VIS_MAX - MIN_BAND_NM);
    hi = clamp(hi, lo + MIN_BAND_NM, VIS_MAX);

    state.lo = lo;
    state.hi = hi;
    syncBandUI();
  }

  /** Move only the short-λ edge (Band low number). Long-λ is forced frozen. */
  function setShortEdge(shortNm, frozenLong) {
    const hi = clamp(Math.round(frozenLong), VIS_MIN + MIN_BAND_NM, VIS_MAX);
    const lo = clamp(Math.round(shortNm), VIS_MIN, hi - MIN_BAND_NM);
    state.lo = lo;
    state.hi = hi;
    syncBandUI();
  }

  /** Move only the long-λ edge (Band high number). Short-λ is forced frozen. */
  function setLongEdge(longNm, frozenShort) {
    const lo = clamp(Math.round(frozenShort), VIS_MIN, VIS_MAX - MIN_BAND_NM);
    const hi = clamp(Math.round(longNm), lo + MIN_BAND_NM, VIS_MAX);
    state.lo = lo;
    state.hi = hi;
    syncBandUI();
  }

  function syncBandUI() {
    const lo = state.lo;
    const hi = state.hi;
    const center = Math.round((lo + hi) / 2);
    const width = hi - lo;
    el.waveReadout.textContent = `${center} nm`;
    // Display left→right as on the strip: long/red (hi) – short/violet (lo)
    el.bandReadout.textContent =
      width >= FULL_WIDTH ? `${hi} – ${lo} · full` : `${hi} – ${lo} nm`;
    el.visContext.textContent =
      width >= FULL_WIDTH
        ? `${hi} – ${lo} nm · full`
        : `${hi} – ${lo} nm · ${width} nm wide`;
    el.emContext.textContent =
      width >= FULL_WIDTH ? "Full visible window" : "Your slice on the full band";

    const midRgb =
      width >= FULL_WIDTH - 1 ? { r: 240, g: 242, b: 246 } : wavelengthToRgb(center);
    el.swatchChip.style.background = cssRgb(midRgb);
    el.colorName.textContent = colorNameFromBand(lo, hi);

    el.btnFull.setAttribute(
      "aria-pressed",
      width >= FULL_WIDTH - 1 ? "true" : "false"
    );

    drawSpectra();
  }

  /* ── canvases ─────────────────────────────────────────────── */

  function sizeCanvas(canvas, cssW, cssH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: cssW, h: cssH };
  }

  /**
   * Match full EM visible ribbon: left = red ~700 (long) → right = violet ~400 (short).
   */
  function visX(nm, width) {
    return ((VIS_MAX - nm) / FULL_WIDTH) * width;
  }

  function xToNm(x, width) {
    return VIS_MAX - (x / Math.max(1, width)) * FULL_WIDTH;
  }

  /** Screen left/right edges: hi/red on left, lo/violet on right. */
  function bandScreenX(w) {
    const xLeft = visX(state.hi, w); // long λ
    const xRight = visX(state.lo, w); // short λ
    return { xLeft, xRight };
  }

  function drawVisibleSpectrum(ctx, w, h) {
    // LEFT = 700 nm red → RIGHT = 400 nm violet (same as full EM by IR→UV)
    const iw = Math.max(1, Math.ceil(w));
    for (let px = 0; px < iw; px++) {
      const t = iw === 1 ? 0 : px / (iw - 1);
      const nm = VIS_MAX - t * FULL_WIDTH; // 700 … 400 left → right
      const { r, g, b } = wavelengthToRgb(nm);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(px, 0, 1, h);
    }

    const { xLeft: x0, xRight: x1 } = bandScreenX(w);

    // dim outside band
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, 0, x0, h);
    ctx.fillRect(x1, 0, w - x1, h);

    // band fill
    ctx.fillStyle = "rgba(250,204,21,0.12)";
    ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);

    // Handles: left = hi (long/red), right = lo (short/violet)
    const handleW = 5;
    ctx.fillStyle = "rgba(250,204,21,0.95)";
    ctx.fillRect(x0 - handleW / 2, 0, handleW, h);
    ctx.fillRect(x1 - handleW / 2, 0, handleW, h);

    // center line
    const xc = (x0 + x1) / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(xc + 0.5, 2);
    ctx.lineTo(xc + 0.5, h - 2);
    ctx.stroke();

    // grip ticks on handles
    ctx.fillStyle = "rgba(6,16,24,0.7)";
    for (const x of [x0, x1]) {
      ctx.fillRect(x - 0.5, h * 0.3, 1, h * 0.4);
    }

    // Orientation labels — match full EM (red by IR side / left)
    ctx.font = "600 9px IBM Plex Sans, system-ui, sans-serif";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.textAlign = "left";
    ctx.fillText("red 700", 4, h - 3);
    ctx.textAlign = "right";
    ctx.fillText("violet 400", w - 4, h - 3);
  }

  function emLayout(width) {
    const total = EM_SEGMENTS.reduce((s, seg) => s + seg.w, 0);
    let x = 0;
    return EM_SEGMENTS.map((seg) => {
      const sw = (seg.w / total) * width;
      const box = { ...seg, x, w: sw };
      x += sw;
      return box;
    });
  }

  function drawFullEm(ctx, w, h) {
    const layout = emLayout(w);
    ctx.clearRect(0, 0, w, h);

    for (const seg of layout) {
      if (seg.id === "vis") {
        const g = ctx.createLinearGradient(seg.x, 0, seg.x + seg.w, 0);
        for (let i = 0; i <= 16; i++) {
          const t = i / 16;
          // Full EM neighbors: IR | red (~700) → violet (~400) | UV
          const c = wavelengthToRgb(VIS_MAX - t * FULL_WIDTH);
          g.addColorStop(t, `rgb(${c.r},${c.g},${c.b})`);
        }
        ctx.fillStyle = g;
      } else {
        ctx.fillStyle = seg.color;
      }
      ctx.fillRect(seg.x, 0, seg.w + 0.5, h);
    }

    ctx.font = "600 9px IBM Plex Sans, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const seg of layout) {
      if (seg.w < 28) continue;
      ctx.fillStyle =
        seg.id === "vis" ? "rgba(0,0,0,0.75)" : "rgba(232,237,244,0.75)";
      ctx.fillText(seg.label, seg.x + seg.w / 2, h / 2);
    }

    const vis = layout.find((s) => s.id === "vis");
    if (vis) {
      // Marker on EM: long λ (hi/red) toward IR/left, short λ (lo/violet) toward UV/right
      const tLeft = (VIS_MAX - state.hi) / FULL_WIDTH;
      const tRight = (VIS_MAX - state.lo) / FULL_WIDTH;
      const x0 = vis.x + tLeft * vis.w;
      const x1 = vis.x + tRight * vis.w;
      const bw = Math.max(2, x1 - x0);
      ctx.fillStyle = "rgba(250,204,21,0.35)";
      ctx.fillRect(x0, 0, bw, h);
      ctx.strokeStyle = "rgba(250,204,21,0.95)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 0.5, 0.5, bw - 1, h - 1);

      ctx.strokeStyle = "rgba(255,255,255,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(vis.x, 0);
      ctx.lineTo(vis.x, h);
      ctx.moveTo(vis.x + vis.w, 0);
      ctx.lineTo(vis.x + vis.w, h);
      ctx.stroke();
    }
  }

  function drawSpectra() {
    const emRect = el.emTrack.getBoundingClientRect();
    const visRect = el.visTrack.getBoundingClientRect();
    if (emRect.width > 0 && emRect.height > 0) {
      const { ctx, w, h } = sizeCanvas(el.emCanvas, emRect.width, emRect.height);
      drawFullEm(ctx, w, h);
    }
    if (visRect.width > 0 && visRect.height > 0) {
      const { ctx, w, h } = sizeCanvas(el.visCanvas, visRect.width, visRect.height);
      drawVisibleSpectrum(ctx, w, h);
    }
  }

  /* ── band drag (visible strip) ────────────────────────────── */

  function pointerNm(clientX) {
    const rect = el.visTrack.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width);
    return clamp(Math.round(xToNm(x, rect.width || 1)), VIS_MIN, VIS_MAX);
  }

  /**
   * Edge near handles; middle of selection slides whole band (fixed width).
   * LEFT = red/long (hi) · RIGHT = violet/short (lo)
   */
  function hitZone(clientX) {
    const rect = el.visTrack.getBoundingClientRect();
    const x = clamp(clientX - rect.left, 0, rect.width);
    const w = rect.width || 1;
    const xLong = visX(state.hi, w); // LEFT handle
    const xShort = visX(state.lo, w); // RIGHT handle
    const left = Math.min(xLong, xShort);
    const right = Math.max(xLong, xShort);
    const span = right - left;
    const edge = Math.max(16, Math.min(span * 0.3 || 16, w * 0.045));

    if (Math.abs(x - xLong) <= edge) return "long";
    if (Math.abs(x - xShort) <= edge) return "short";
    if (span > 8 && x > left + edge * 0.5 && x < right - edge * 0.5) {
      return "band";
    }
    // Outside or very narrow: nearest edge
    return Math.abs(x - xLong) <= Math.abs(x - xShort) ? "long" : "short";
  }

  function applyDrag(clientX) {
    if (!dragging) return;
    const rect = el.visTrack.getBoundingClientRect();
    const w = rect.width || 1;

    if (dragging === "band") {
      // Slide both edges; axis is reversed (right → lower nm)
      const dxNm = -((clientX - dragStartX) / w) * FULL_WIDTH;
      const widthNm = dragStartHi - dragStartLo;
      let lo = dragStartLo + dxNm;
      let hi = dragStartHi + dxNm;
      if (lo < VIS_MIN) {
        lo = VIS_MIN;
        hi = lo + widthNm;
      }
      if (hi > VIS_MAX) {
        hi = VIS_MAX;
        lo = hi - widthNm;
      }
      setBand(lo, hi);
      return;
    }

    const nm = pointerNm(clientX);
    if (dragging === "short") {
      setShortEdge(nm, freezeNm);
    } else {
      setLongEdge(nm, freezeNm);
    }
  }

  function onVisPointerDown(e) {
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    dragging = hitZone(t.clientX);
    dragStartX = t.clientX;
    dragStartLo = state.lo;
    dragStartHi = state.hi;
    freezeNm = dragging === "short" ? state.hi : state.lo;
    // Edges snap to pointer; band slide only moves on move
    if (dragging !== "band") applyDrag(t.clientX);
    el.visHit.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  function onVisPointerMove(e) {
    if (!dragging) return;
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    applyDrag(t.clientX);
    e.preventDefault();
  }

  function onVisPointerUp(e) {
    dragging = null;
    try {
      el.visHit.releasePointerCapture?.(e.pointerId);
    } catch (_) {}
  }

  el.visHit.addEventListener("pointerdown", onVisPointerDown, { passive: false });
  el.visHit.addEventListener("pointermove", onVisPointerMove, { passive: false });
  el.visHit.addEventListener("pointerup", onVisPointerUp);
  el.visHit.addEventListener("pointercancel", onVisPointerUp);

  /* ── camera filter loop ───────────────────────────────────── */

  function ensureWork(vw, vh) {
    const maxW = state.procMaxW;
    const scale = Math.min(1, maxW / vw);
    const w = Math.max(1, Math.round(vw * scale));
    const h = Math.max(1, Math.round(vh * scale));
    if (!state.work || state.workW !== w || state.workH !== h) {
      state.work = document.createElement("canvas");
      state.work.width = w;
      state.work.height = h;
      state.workW = w;
      state.workH = h;
      state.workCtx = state.work.getContext("2d", {
        willReadFrequently: true,
        alpha: false,
      });
    }
    return state.work;
  }

  function syncViewSize() {
    const wrap = el.previewWrap.getBoundingClientRect();
    state.wrapW = wrap.width;
    state.wrapH = wrap.height;
    if (wrap.width < 2 || wrap.height < 2) return null;

    // Band path: dpr 1 is plenty (work buffer is already soft-scaled)
    const filtered = !isFullBand(state.lo, state.hi);
    const dpr = filtered ? 1 : Math.min(window.devicePixelRatio || 1, 2);
    const outW = Math.max(1, Math.round(wrap.width * dpr));
    const outH = Math.max(1, Math.round(wrap.height * dpr));
    const view = el.view;
    if (view.width !== outW || view.height !== outH) {
      view.width = outW;
      view.height = outH;
    }
    return { outW, outH, octx: view.getContext("2d", { alpha: false }) };
  }

  /** Full band: paint live <video> via CSS; skip pixel loop entirely. */
  function setPreviewMode(filtered) {
    const video = el.video;
    const canvas = el.view;
    if (filtered) {
      video.style.opacity = "0";
      video.style.pointerEvents = "none";
      canvas.style.opacity = "1";
    } else {
      // true live path — compositor-smooth on older Macs
      video.style.opacity = "1";
      video.style.position = "absolute";
      video.style.inset = "0";
      video.style.width = "100%";
      video.style.height = "100%";
      video.style.objectFit = "cover";
      video.style.pointerEvents = "none";
      canvas.style.opacity = "0";
    }
  }

  function processFrame() {
    const v = el.video;
    if (!state.running || !v.videoWidth) return;

    const lo = state.lo;
    const hi = state.hi;
    const mirror = v.classList.contains("mirror");

    // Full visible window = native video element (no JS pixels)
    if (isFullBand(lo, hi)) {
      setPreviewMode(false);
      v.classList.toggle("mirror", mirror);
      return;
    }

    setPreviewMode(true);
    const sized = syncViewSize();
    if (!sized) return;
    const { outW, outH, octx } = sized;

    const t0 = performance.now();

    const work = ensureWork(v.videoWidth, v.videoHeight);
    const wctx = state.workCtx;
    wctx.drawImage(v, 0, 0, work.width, work.height);

    const img = wctx.getImageData(0, 0, work.width, work.height);
    filterImageData(img.data, getFilterParams(lo, hi));
    wctx.putImageData(img, 0, 0);
    drawCover(octx, work, outW, outH, mirror);

    // Adapt process resolution to hit ~real-time on this machine
    const dt = performance.now() - t0;
    state.frameMsEma = state.frameMsEma * 0.88 + dt * 0.12;
    if (state.frameMsEma > 38 && state.procMaxW > 280) {
      state.procMaxW = Math.max(280, state.procMaxW - 40);
      state.work = null; // recreate next frame
    } else if (state.frameMsEma < 20 && state.procMaxW < 640) {
      state.procMaxW = Math.min(640, state.procMaxW + 24);
      state.work = null;
    }
  }

  function loop() {
    state.frame = requestAnimationFrame(loop);
    if (state.running) processFrame();
  }

  /* ── camera ───────────────────────────────────────────────── */

  async function listVideoInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === "videoinput");
  }

  async function openCamera(facing) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Camera API not available");
    }
    const attempts = [
      {
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      },
      { audio: false, video: { facingMode: facing } },
      { audio: false, video: true },
    ];
    let lastErr = null;
    for (const c of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(c);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Could not open camera");
  }

  function stopStream() {
    if (state.stream) {
      for (const t of state.stream.getTracks()) t.stop();
      state.stream = null;
    }
    el.video.srcObject = null;
  }

  function setStatus(text, name) {
    el.status.textContent = text;
    if (name) el.status.dataset.state = name;
    else delete el.status.dataset.state;
  }

  async function startCamera() {
    try {
      setStatus("Requesting…");
      el.hint.textContent = "Allow camera access when prompted";
      const stream = await openCamera(state.facing);
      stopStream();
      state.stream = stream;
      el.video.srcObject = stream;
      el.video.playsInline = true;
      el.video.muted = true;
      await el.video.play().catch(() => {});

      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings?.() || {};
      const isUser =
        settings.facingMode === "user" || state.facing === "user";
      el.video.classList.toggle("mirror", !!isUser);

      const cams = await listVideoInputs();
      state.canFlip = cams.length > 1;
      el.flipBtn.disabled = !state.canFlip;

      state.running = true;
      el.startBtn.dataset.state = "on";
      el.startBtn.textContent = "Stop";
      setStatus(isUser ? "Front cam" : "Rear cam", "live");
      el.hint.innerHTML =
        'Live view through your band · drag the <span class="hint-white">visible strip</span>';
      if (!state.frame) loop();
    } catch (err) {
      console.error(err);
      state.running = false;
      setStatus("No camera", "err");
      el.hint.textContent =
        err?.name === "NotAllowedError"
          ? "Camera permission denied — enable in browser settings"
          : "Camera unavailable on this device/browser";
      el.startBtn.dataset.state = "off";
      el.startBtn.textContent = "Start camera";
      el.flipBtn.disabled = true;
    }
  }

  function stopCamera() {
    state.running = false;
    stopStream();
    el.startBtn.dataset.state = "off";
    el.startBtn.textContent = "Start camera";
    el.flipBtn.disabled = true;
    setStatus("Camera off");
    el.hint.innerHTML =
      'Drag the <span class="hint-white">visible strip</span> · Full or ROYGBIV presets';
    processFrame();
  }

  async function flipCamera() {
    if (!state.running) return;
    state.facing = state.facing === "environment" ? "user" : "environment";
    await startCamera();
  }

  /* ── controls ─────────────────────────────────────────────── */

  el.startBtn.addEventListener("click", () => {
    if (state.running) stopCamera();
    else startCamera();
  });

  el.flipBtn.addEventListener("click", () => flipCamera());

  el.btnFull.addEventListener("click", () => {
    setBand(VIS_MIN, VIS_MAX);
    document.querySelectorAll("[data-preset]").forEach((b) => {
      b.setAttribute("aria-pressed", "false");
    });
  });

  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const p = PRESETS[btn.getAttribute("data-preset")];
      if (!p) return;
      setBand(p.lo, p.hi);
      document.querySelectorAll("[data-preset]").forEach((b) => {
        b.setAttribute("aria-pressed", b === btn ? "true" : "false");
      });
    });
  });

  /* ── fit + boot ───────────────────────────────────────────── */

  const fit = window.FitToScreen.create({
    stage: "fit-stage",
    app: "app",
    phoneMaxWidth: 767,
    wideAppWidth: 720,
    capScaleAtOne: true,
    useScaleForLayout: (layout, availW) => availW > 767,
    onFit: () => {
      drawSpectra();
      if (!state.running) processFrame();
    },
  });

  function onResize() {
    drawSpectra();
  }

  fit.bindViewportListeners();
  fit.bootLayout().then(() => {
    setBand(VIS_MIN, VIS_MAX);
    processFrame();
  });

  window.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("resize", onResize);

  if (!window.isSecureContext) {
    setStatus("Needs HTTPS", "err");
    el.hint.textContent = "Camera requires HTTPS or localhost";
  }
})();
