'use strict';

// Square photo cropper. The user pans (drag) and zooms (pinch, wheel, slider) an
// image of any size behind a square frame; the framed part becomes the dish photo.
const PhotoCropper = (() => {
  const OUT_PX = 800;           // output edge: sharp on phone screens, small enough to sync
  const MAX_BYTES = 150 * 1024; // lower JPEG quality until the photo fits
  const MAX_ZOOM = 6;           // relative to the smallest zoom that still fills the frame

  // Resolves with a square JPEG data URL, or null if cancelled.
  function open(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => run(img, resolve);
      img.onerror = () => reject(new Error('image'));
      img.src = src;
    });
  }

  function run(img, resolve) {
    const W = img.naturalWidth;
    const H = img.naturalHeight;
    const root = document.createElement('div');
    root.className = 'cropper';
    root.innerHTML = `
      <div class="cropper-bar">
        <button class="btn" type="button" data-crop="cancel">${t('cancel')}</button>
        <strong>${t('cropTitle')}</strong>
        <button class="btn primary" type="button" data-crop="use">${t('usePhoto')}</button>
      </div>
      <div class="crop-stage"><div class="crop-box"></div></div>
      <div class="crop-zoom">
        <span>－</span><input type="range" min="1" max="${MAX_ZOOM}" step="0.01" value="1" aria-label="zoom"><span>＋</span>
      </div>
      <p class="crop-hint">${t('cropHint')}</p>`;
    const stage = root.querySelector('.crop-stage');
    const boxEl = root.querySelector('.crop-box');
    const slider = root.querySelector('input');
    img.className = 'crop-img';
    img.style.width = W + 'px';
    img.style.height = H + 'px';
    img.draggable = false;
    boxEl.appendChild(img);
    document.body.appendChild(root);

    // View state in image pixels: (cx, cy) is the image point at the frame centre,
    // z the zoom over the "cover" scale. Everything on screen is derived from it.
    let box, base, z = 1, cx = W / 2, cy = H / 2;

    const measure = () => {
      box = boxEl.clientWidth;
      base = box / Math.min(W, H);
    };
    const draw = () => {
      z = Math.min(MAX_ZOOM, Math.max(1, z));
      const s = base * z;
      const half = box / (2 * s);
      cx = Math.min(W - half, Math.max(half, cx));
      cy = Math.min(H - half, Math.max(half, cy));
      img.style.transform = `translate(${box / 2 - cx * s}px, ${box / 2 - cy * s}px) scale(${s})`;
      slider.value = z;
    };
    // Zoom keeping the image point under (px, py) (frame coordinates) in place.
    const zoomAt = (newZ, px, py) => {
      const s = base * z;
      const ix = cx + (px - box / 2) / s;
      const iy = cy + (py - box / 2) / s;
      z = Math.min(MAX_ZOOM, Math.max(1, newZ));
      const ns = base * z;
      cx = ix - (px - box / 2) / ns;
      cy = iy - (py - box / 2) / ns;
      draw();
    };
    const pan = (dx, dy) => {
      const s = base * z;
      cx -= dx / s;
      cy -= dy / s;
      draw();
    };

    // Pointer gestures: one finger pans, two fingers pinch-zoom and pan.
    const pts = new Map();
    let last = null;
    const snapshot = () => {
      const p = [...pts.values()];
      if (!p.length) return null;
      return {
        n: p.length,
        x: p.reduce((a, q) => a + q.x, 0) / p.length,
        y: p.reduce((a, q) => a + q.y, 0) / p.length,
        d: p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) : 0,
      };
    };
    stage.addEventListener('pointerdown', e => {
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      last = snapshot();
    });
    stage.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const cur = snapshot();
      if (last && cur.n === last.n) {
        if (cur.n > 1 && last.d) {
          const r = boxEl.getBoundingClientRect();
          zoomAt(z * cur.d / last.d, cur.x - r.left, cur.y - r.top);
        }
        pan(cur.x - last.x, cur.y - last.y);
      }
      last = cur;
    });
    const lift = e => { pts.delete(e.pointerId); last = snapshot(); };
    stage.addEventListener('pointerup', lift);
    stage.addEventListener('pointercancel', lift);
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      const r = boxEl.getBoundingClientRect();
      zoomAt(z * Math.exp(-e.deltaY * 0.002), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    slider.addEventListener('input', () => zoomAt(+slider.value, box / 2, box / 2));

    const onResize = () => { measure(); draw(); };
    const onKey = e => { if (e.key === 'Escape') finish(null); };
    window.addEventListener('resize', onResize);
    document.addEventListener('keydown', onKey);

    function finish(result) {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKey);
      root.remove();
      resolve(result);
    }
    root.querySelector('[data-crop="cancel"]').onclick = () => finish(null);
    root.querySelector('[data-crop="use"]').onclick = () => {
      const side = box / (base * z);
      finish(render(img, cx - side / 2, cy - side / 2, side));
    };

    measure();
    draw();
  }

  // Draws the square (sx, sy, side) of img to an OUT_PX JPEG, halving in steps
  // so large downscales stay sharp.
  function render(img, sx, sy, side) {
    const out = Math.max(1, Math.min(OUT_PX, Math.round(side)));
    let src = img, sSide = side;
    while (sSide / out > 2) {
      const half = Math.round(sSide / 2);
      const c = canvas(half);
      c.getContext('2d').drawImage(src, sx, sy, sSide, sSide, 0, 0, half, half);
      src = c; sx = 0; sy = 0; sSide = half;
    }
    const c = canvas(out);
    const g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, sx, sy, sSide, sSide, 0, 0, out, out);
    let q = 0.85, url;
    do {
      url = c.toDataURL('image/jpeg', q);
      q -= 0.1;
    } while (url.length * 0.75 > MAX_BYTES && q > 0.4);
    return url;
  }

  function canvas(size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }

  return { open };
})();
