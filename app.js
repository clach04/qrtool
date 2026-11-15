/* =============================================================================
 * QR & Barcode Scanner — app.js
 * Depends on: jsQR (vendor/jsQR.js), qrcode-generator (vendor/qrcode.js),
 *             JsBarcode (vendor/JsBarcode.all.min.js)
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ utils */
  var $ = function (id) { return document.getElementById(id); };

  var STORE_KEY = 'qrtool.history.v1';
  var PREF_KEY = 'qrtool.prefs.v1';
  var THEME_KEY = 'qrtool.theme.v1';
  var MAX_HISTORY = 300;

  function nowISO() { return new Date().toISOString(); }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString([], {
      year: 'numeric', month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
  }

  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.hidden = true; }, ms || 2100);
  }

  function setStatus(el, msg, kind) {
    el.textContent = msg;
    el.classList.remove('is-error', 'is-ok');
    if (kind) el.classList.add(kind);
  }

  async function copyText(text, okMsg) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('copy command failed');
      }
      toast(okMsg || 'Copied to clipboard');
      return true;
    } catch (e) {
      toast('Copy failed \u2014 select the text manually');
      return false;
    }
  }

  function isProbablyUrl(text) {
    return /^(https?:\/\/|www\.)\S+$/i.test(String(text).trim());
  }

  async function shareText(text) {
    var data = { title: 'QR payload', text: text };
    if (navigator.share) {
      try { await navigator.share(data); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    copyText(text, 'Sharing unavailable \u2014 copied instead');
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function downloadDataUrl(dataUrl, filename) {
    var a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function safeName(s) {
    return (String(s).replace(/[^a-z0-9._-]+/gi, '_').slice(0, 24) || 'code') + '_' +
      Date.now().toString(36);
  }

  /* --------------------------------------------------------- prefs + theme */
  var prefs = { cameraId: '', torch: false };
  try {
    var rawPrefs = localStorage.getItem(PREF_KEY);
    if (rawPrefs) {
      var p = JSON.parse(rawPrefs);
      if (p && typeof p === 'object') {
        prefs.cameraId = typeof p.cameraId === 'string' ? p.cameraId : '';
        prefs.torch = !!p.torch;
      }
    }
  } catch (e) { /* corrupt prefs: start clean */ }

  function savePrefs() {
    try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
  }

  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') {
      document.documentElement.setAttribute('data-theme', mode);
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  (function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) {}
    applyTheme(saved);
    $('themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var next = cur === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    });
  })();

  /* -------------------------------------------------------------- tab nav */
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  var panels = {
    scan: $('panel-scan'),
    create: $('panel-create'),
    history: $('panel-history')
  };

  function showTab(name) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-panel') === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    Object.keys(panels).forEach(function (k) {
      var on = k === name;
      panels[k].classList.toggle('is-active', on);
      panels[k].hidden = !on;
    });
    if (name !== 'scan') stopCamera(true);
    if (name === 'history') renderHistory();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () {
      showTab(t.getAttribute('data-panel'));
    });
  });

  /* ============================================================== SCANNING */
  var video = $('video');
  var frame = $('frame');
  var viewport = $('viewport');
  var scanStatus = $('scanStatus');
  var startBtn = $('startBtn');
  var stopBtn = $('stopBtn');
  var cameraSelect = $('cameraSelect');
  var torchBtn = $('torchBtn');

  var stream = null;
  var track = null;
  var rafId = 0;
  var lastScanAt = 0;
  var scanning = false;
  var busy = false;          // decoding a still image
  var workCanvas = document.createElement('canvas');
  var workCtx = workCanvas.getContext('2d', { willReadFrequently: true });

  function setScanUi(live) {
    scanning = live;
    viewport.classList.toggle('is-live', live);
    startBtn.hidden = live;
    stopBtn.hidden = !live;
    cameraSelect.disabled = live;
  }

  function stopCamera(silent) {
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (stream) {
      stream.getTracks().forEach(function (t) {
        try { t.stop(); } catch (e) {}
      });
    }
    stream = null;
    track = null;
    try { video.pause(); } catch (e) {}
    video.srcObject = null;
    setScanUi(false);
    viewport.classList.remove('is-mirrored');
    torchBtn.hidden = true;
    if (!silent) setStatus(scanStatus, 'Camera stopped.');
  }

  async function listCameras() {
    var devices;
    try {
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch (e) {
      return [];
    }
    var cams = devices.filter(function (d) { return d.kind === 'videoinput'; });
    cameraSelect.innerHTML = '';
    if (!cams.length) {
      var o = document.createElement('option');
      o.textContent = 'No camera found';
      o.value = '';
      cameraSelect.appendChild(o);
      cameraSelect.disabled = true;
      return [];
    }
    cams.forEach(function (d, i) {
      var o = document.createElement('option');
      o.value = d.deviceId;
      // Labels are only exposed after permission is granted.
      o.textContent = d.label || ('Camera ' + (i + 1));
      cameraSelect.appendChild(o);
    });
    cameraSelect.disabled = scanning;
    if (prefs.cameraId) {
      var match = cams.some(function (d) { return d.deviceId === prefs.cameraId; });
      cameraSelect.value = match ? prefs.cameraId : cams[0].deviceId;
    }
    return cams;
  }

  async function startCamera(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus(scanStatus, 'This browser has no camera API. Try HTTPS or upload an image.', 'is-error');
      return;
    }
    if (stream) stopCamera(true);
    setStatus(scanStatus, 'Starting camera\u2026');
    setScanUi(true);

    var targetId = deviceId || cameraSelect.value || prefs.cameraId || '';
    var tries = [];
    if (targetId) {
      tries.push({ deviceId: { exact: targetId } });
    } else {
      // No preference: prefer an environment-facing camera on phones.
      tries.push({ facingMode: { ideal: 'environment' } });
      tries.push({ facingMode: 'environment' });
      tries.push({});
    }
    // Fall back to any camera if the exact device is gone (unplugged).
    tries.push({});

    var lastErr = null;
    for (var i = 0; i < tries.length; i++) {
      var constraints = {
        audio: false,
        video: i === 0 && targetId ? tries[0] : tries[i],
        // @ts-ignore advanced is fine at runtime
        advanced: [{ focusMode: 'continuous' }]
      };
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        stream = null;
      }
    }

    if (!stream) {
      setScanUi(false);
      var msg = 'Could not start camera. ';
      if (lastErr) {
        if (lastErr.name === 'NotAllowedError' || lastErr.name === 'SecurityError') {
          msg += 'Permission was denied \u2014 allow camera access in your browser settings.';
        } else if (lastErr.name === 'NotFoundError' || lastErr.name === 'OverconstrainedError') {
          msg += 'No matching camera was found.';
        } else if (lastErr.name === 'NotReadableError') {
          msg += 'The camera is busy in another app.';
        } else {
          msg += lastErr.message || lastErr.name || 'Unknown error.';
        }
      }
      setStatus(scanStatus, msg, 'is-error');
      return;
    }

    video.srcObject = stream;
    try { await video.play(); } catch (e) {}
    track = stream.getVideoTracks()[0] || null;

    var settings = track && track.getSettings ? track.getSettings() : {};
    if (settings.deviceId && settings.deviceId !== prefs.cameraId) {
      prefs.cameraId = settings.deviceId;
      savePrefs();
    }
    if (track) {
      track.addEventListener('ended', function () {
        if (scanning) stopCamera(true);
        setStatus(scanStatus, 'Camera feed ended.', 'is-error');
      });
    }

    var label = (settings.deviceId && cameraSelect.value) || '';
    viewport.classList.toggle('is-mirrored', /user|front/i.test(settings.facingMode || '') && !targetId);

    // Torch support
    var caps = track && track.getCapabilities ? track.getCapabilities() : {};
    torchBtn.hidden = !(caps.torch);
    torchBtn.setAttribute('aria-pressed', 'false');
    if (!torchBtn.hidden) {
      torchBtn.onclick = async function () {
        if (!track) return;
        var on = torchBtn.getAttribute('aria-pressed') !== 'true';
        try {
          await track.applyConstraints({ advanced: [{ torch: on }] });
          torchBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        } catch (e) {
          toast('Torch not supported on this camera');
        }
      };
    }

    await listCameras();
    if (settings.deviceId) cameraSelect.value = settings.deviceId;
    cameraSelect.disabled = true;

    setScanUi(true);
    setStatus(scanStatus, 'Scanning\u2026 point the camera at a QR code.' + (label ? '' : ''));
    lastScanAt = 0;
    rafId = requestAnimationFrame(tick);
  }

  /* Decode one video frame. The camera is mirrored for the preview only, so
   * the pixel buffer we hand to jsQR is always the true, unmirrored frame. */
  function tick() {
    rafId = requestAnimationFrame(tick);
    if (!scanning || busy) return;
    if (!video.videoWidth || !video.videoHeight) return;
    if (video.readyState < 2) return;

    var vw = video.videoWidth;
    var vh = video.videoHeight;
    var maxSide = 720;               // cap work size: decoding cost grows fast
    var scale = Math.min(1, maxSide / Math.max(vw, vh));
    var w = Math.max(1, Math.round(vw * scale));
    var h = Math.max(1, Math.round(vh * scale));

    if (workCanvas.width !== w) workCanvas.width = w;
    if (workCanvas.height !== h) workCanvas.height = h;
    try {
      workCtx.drawImage(video, 0, 0, w, h);
    } catch (e) {
      return;
    }

    var img;
    try {
      img = workCtx.getImageData(0, 0, w, h);
    } catch (e) {
      return;
    }

    var code = null;
    try {
      code = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    } catch (e) {
      return;
    }
    if (!code || !code.data) return;

    // Throttle duplicates so one code fires once per hold.
    var t = Date.now();
    if (t - lastScanAt < 1600) return;
    lastScanAt = t;

    flashAndBuzz();
    handleDecoded(code.data, 'camera', code.location ? describeLocation(code.location) : '');
  }

  function describeLocation(loc) {
    if (!loc) return '';
    var tl = loc.topLeftCorner, br = loc.bottomRightCorner;
    if (!tl || !br) return '';
    return 'corners \u2248 (' + Math.round(tl.x) + ',' + Math.round(tl.y) + ') \u2013 (' +
      Math.round(br.x) + ',' + Math.round(br.y) + ')';
  }

  function flashAndBuzz() {
    var f = $('scanFlash');
    f.classList.remove('is-hit');
    void f.offsetWidth;
    f.classList.add('is-hit');
    try { if (navigator.vibrate) navigator.vibrate(35); } catch (e) {}
  }

  /* -------------------------------------------------- decode a still image */
  async function decodeImageFile(file) {
    if (busy) return;
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setStatus(scanStatus, 'That file is not an image.', 'is-error');
      return;
    }
    busy = true;
    var prevStatus = scanStatus.textContent;
    setStatus(scanStatus, 'Decoding image\u2026');
    var objectUrl = null;
    try {
      objectUrl = URL.createObjectURL(file);
      var img = await loadImage(objectUrl);
      var shot = { previewUrl: objectUrl };

      var result = scanImageElement(img, file.size || 0);
      if (!result) {
        setStatus(scanStatus, 'No QR code found in that image. Try a sharper, straight-on photo.', 'is-error');
        return;
      }
      objectUrl = null; // preview is owned by history now
      handleDecoded(result.data, 'upload', describeDims(img.naturalWidth, img.naturalHeight), shot);
    } catch (e) {
      setStatus(scanStatus, 'Could not read that image: ' + (e.message || e.name), 'is-error');
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    } finally {
      busy = false;
      if (scanStatus.classList.contains('is-error') === false && scanning) {
        setStatus(scanStatus, 'Scanning\u2026');
      } else if (!scanning && !scanStatus.classList.contains('is-error')) {
        setStatus(scanStatus, prevStatus);
      }
    }
  }

  function describeDims(w, h) {
    return w && h ? 'image ' + w + '\u00d7' + h + 'px' : 'image';
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('image failed to load')); };
      img.src = src;
    });
  }

  /* Try the natural size first, then downscale/upscale a few steps: jsQR is
   * far more reliable when the module size is a few pixels, not sub-pixel. */
  function scanImageElement(img, bytes) {
    var vw = img.naturalWidth || img.width;
    var vh = img.naturalHeight || img.height;
    if (!vw || !vh) return null;

    var targets = [];
    var longest = Math.max(vw, vh);
    [longest, 1024, 720, 480, 1400].forEach(function (side) {
      if (!side || side > longest * 1.5) return;
      if (targets.indexOf(side) === -1) targets.push(side);
    });
    if (targets.indexOf(320) === -1) targets.push(320);

    for (var i = 0; i < targets.length; i++) {
      var side = targets[i];
      var scale = Math.min(1, side / longest);
      var w = Math.max(1, Math.round(vw * scale));
      var h = Math.max(1, Math.round(vh * scale));

      frame.width = w;
      frame.height = h;
      var ctx = frame.getContext('2d', { willReadFrequently: true });
      ctx.clearRect(0, 0, w, h);
      // White matte: transparent PNGs break thresholding otherwise.
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      var data;
      try { data = ctx.getImageData(0, 0, w, h); }
      catch (e) { continue; }

      var found = null;
      try {
        found = window.jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' });
      } catch (e) { continue; }
      if (found && found.data) {
        found._attempt = side;
        return found;
      }
    }
    return null;
  }

  /* ------------------------------------------------------------ result view */
  var lastResult = null;

  function handleDecoded(text, source, detail, extra) {
    if (text == null || text === '') return;
    lastResult = {
      text: String(text),
      format: source === 'generated' ? 'generated' : 'qrcode',
      source: source,
      detail: detail || '',
      at: nowISO(),
      previewUrl: extra && extra.previewUrl ? extra.previewUrl : null
    };

    // Auto-save camera and upload scans; generated codes are opt-in.
    if (source !== 'generated') {
      var entry = historyAdd(lastResult);
      lastResult.id = entry.id;
    }

    renderResult();
    toast(source === 'upload' ? 'QR code decoded from image' : 'QR code detected');
    if (navigator.vibrate) { try { navigator.vibrate([18, 40, 18]); } catch (e) {} }
  }

  function renderResult() {
    if (!lastResult) return;
    var card = $('resultCard');
    card.hidden = false;
    $('resFormat').textContent = lastResult.format === 'generated' ? 'generated' : 'QR code';
    $('resTime').textContent = fmtTime(lastResult.at);
    $('resSource').textContent = lastResult.source === 'camera'
      ? 'Live camera' + (lastResult.detail ? ' \u00b7 ' + lastResult.detail : '')
      : (lastResult.source === 'upload' ? 'Uploaded image' + (lastResult.detail ? ' \u00b7 ' + lastResult.detail : '') : 'Generated');
    $('resText').value = lastResult.text;

    var prev = $('resPreview');
    var img = prev.querySelector('img');
    if (lastResult.previewUrl) {
      if (!img) { img = document.createElement('img'); prev.appendChild(img); }
      img.src = lastResult.previewUrl;
      prev.hidden = false;
    } else {
      prev.hidden = true;
    }

    var link = $('openRes');
    if (isProbablyUrl(lastResult.text)) {
      link.href = /^www\./i.test(lastResult.text) ? 'https://' + lastResult.text : lastResult.text;
      link.hidden = false;
    } else {
      link.hidden = true;
      link.removeAttribute('href');
    }
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* ============================================================== CREATING */
  var genKind = 'qr';
  var lastGenerated = null;   // { kind, text, format, svg, canvas, pngUrl, meta }

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['UTF-8'];

  function setGenKind(kind) {
    genKind = kind;
    document.querySelectorAll('.seg__btn').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-kind') === kind);
    });
    $('qrOpts').hidden = kind !== 'qr';
    $('barcodeOpts').hidden = kind !== 'barcode';
    $('dlSvg').hidden = true;
  }

  document.querySelectorAll('.seg__btn').forEach(function (b) {
    b.addEventListener('click', function () { setGenKind(b.getAttribute('data-kind')); });
  });

  $('genScale').addEventListener('input', function () {
    $('scaleOut').textContent = this.value;
  });
  $('qrSize').addEventListener('input', function () {
    $('qrSizeOut').textContent = this.value;
  });

  function buildQR(text, ecl, quiet) {
    var qr = qrcode(0, ecl);       // type 0 = auto-detect smallest fit
    qr.addData(text);
    qr.make();
    var count = qr.getModuleCount();
    // Whole-pixel modules keep the code crisp at any display size.
    var longest = 1024;
    var cell = Math.max(2, Math.floor(longest / (count + (quiet ? 8 : 0))));
    var margin = quiet ? cell * 4 : 0;
    var size = count * cell + margin * 2;
    var svg = qr.createSvgTag({ cellSize: cell, margin: margin, scalable: false });
    return { qr: qr, count: count, cell: cell, margin: margin, size: size, svg: svg };
  }

  function buildBarcode(text, format, moduleWidth) {
    var canvas = document.createElement('canvas');
    canvas.dataset.format = format;
    try {
      JsBarcode(canvas, text, {
        format: format,
        width: moduleWidth,
        height: 90,
        displayValue: true,
        fontSize: 16,
        textMargin: 4,
        margin: 10,
        background: '#ffffff',
        lineColor: '#000000'
      });
    } catch (e) {
      var err = new Error(humanBarcodeError(e, format));
      err.isBarcode = true;
      throw err;
    }
    return { canvas: canvas, size: canvas.width + 'x' + canvas.height };
  }

  function humanBarcodeError(e, format) {
    var msg = (e && e.message) || String(e);
    if (/invalid input|not valid|invalid/i.test(msg)) {
      return format + ' cannot encode that value \u2014 check length, digits and allowed characters.';
    }
    return msg;
  }

  function generate() {
    var text = $('genText').value;
    var batch = $('genBatch').checked;
    var lines = text.split(/\r?\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });

    if (!lines.length) {
      setStatus($('genStatus'), 'Type or paste something first.', 'is-error');
      return;
    }
    if (batch && lines.length > 40) {
      setStatus($('genStatus'), 'That is a lot of codes \u2014 keep batches under 40.', 'is-error');
      return;
    }
    if (!batch && text.length > 2900) {
      setStatus($('genStatus'), 'That is too much data for one QR code (limit \u2248 2900 bytes).', 'is-error');
      return;
    }

    var items = batch ? lines : [text.replace(/\s+$/, '')];

    if (!batch) {
      var one = renderOne(items[0]);
      if (one) showGenerated([one]);
      return;
    }

    // Batch: render each line; a single bad line should not kill the rest.
    var out = [];
    var failures = [];
    items.forEach(function (line, i) {
      var item = renderOne(line);
      if (item) out.push(item);
      else failures.push(i + 1);
    });

    if (!out.length) {
      setStatus($('genStatus'), 'Nothing could be generated \u2014 check the values.', 'is-error');
      return;
    }
    showGenerated(out);
    if (failures.length) {
      setStatus($('genStatus'), 'Generated ' + out.length + ' codes; skipped line(s) ' +
        failures.join(', ') + ' (too long or invalid for the chosen format).', 'is-error');
    } else {
      setStatus($('genStatus'), 'Generated ' + out.length + ' codes.', 'is-ok');
    }
  }

  function renderOne(text) {
    try {
      if (genKind === 'qr') {
        var built = buildQR(
          text,
          $('qrEcl').value,
          $('genQuiet').checked
        );
        return {
          kind: 'qr',
          text: text,
          format: 'QR \u00b7 EC ' + $('qrEcl').value + ' \u00b7 ' + built.count + '\u00d7' + built.count + ' modules',
          svg: built.svg,
          size: built.size,
          meta: built.size + 'px'
        };
      }
      var bc = buildBarcode(text, $('barcodeFormat').value, parseInt($('genScale').value, 10));
      return {
        kind: 'barcode',
        text: text,
        format: 'Barcode \u00b7 ' + $('barcodeFormat').value,
        canvas: bc.canvas,
        size: bc.size,
        meta: bc.size
      };
    } catch (e) {
      return null;
    }
  }

  function showGenerated(items) {
    lastGenerated = items;
    var wrap = $('genWrap');
    wrap.innerHTML = '';
    wrap.classList.remove('gen-wrap--dark');

    items.forEach(function (item, i) {
      var box = document.createElement('div');
      box.style.display = 'grid';
      box.style.justifyItems = 'center';
      box.style.gap = '8px';
      box.style.padding = '6px';

      if (item.kind === 'qr') {
        box.insertAdjacentHTML('beforeend', item.svg);
      } else {
        box.appendChild(item.canvas);
      }

      var cap = document.createElement('div');
      cap.style.cssText = 'font-size:.76rem;color:#5b6675;text-align:center;max-width:100%;overflow-wrap:anywhere';
      cap.textContent = items.length > 1 ? (i + 1) + '. ' + truncate(item.text, 60) : truncate(item.text, 90);
      box.appendChild(cap);
      wrap.appendChild(box);
    });

    $('genOut').hidden = false;
    $('genOutMeta').textContent = items.length > 1
      ? items.length + ' codes \u00b7 ' + (genKind === 'qr' ? 'QR' : $('barcodeFormat').value)
      : (genKind === 'qr' ? 'QR' : $('barcodeFormat').value);
    $('genOutTitle').textContent = items.length > 1 ? 'Generated batch' : 'Generated';

    $('dlPng').hidden = false;
    $('dlSvg').hidden = genKind !== 'qr' || items.length > 1;
    $('saveGen').hidden = false;

    if (!items.length) {
      setStatus($('genStatus'), 'Nothing generated.', 'is-error');
      return;
    }
    setStatus($('genStatus'), items.length > 1
      ? 'Generated ' + items.length + ' codes.'
      : 'Ready \u2014 download it or save it to history.', 'is-ok');
    $('genOut').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /* -------- downloads: rasterise whatever we have to a PNG at export size --- */
  async function exportPng() {
    if (!lastGenerated || !lastGenerated.length) return;
    var scaleUp = 2;
    var canvases = [];

    lastGenerated.forEach(function (item) {
      if (item.canvas) {
        canvases.push(item.canvas);
        return;
      }
      // QR: draw the SVG path data ourselves onto a canvas at module resolution.
      canvases.push(rasterizeQR(item));
    });

    if (canvases.length === 1) {
      downloadDataUrl(canvases[0].toDataURL('image/png'), safeName(lastGenerated[0].text));
      return;
    }

    // Batch export: stack vertically with captions.
    var pad = 24;
    var gap = 26;
    var widths = canvases.map(function (c) { return c.width; });
    var heights = canvases.map(function (c) { return c.height; });
    var totalW = Math.max.apply(null, widths) + pad * 2;
    var totalH = heights.reduce(function (a, b) { return a + b; }, 0) + gap * (canvases.length - 1) + pad * 2;

    var sheet = document.createElement('canvas');
    sheet.width = totalW;
    sheet.height = totalH;
    var ctx = sheet.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    var y = pad;
    canvases.forEach(function (c) {
      ctx.drawImage(c, Math.round((totalW - c.width) / 2), y);
      y += c.height + gap;
    });
    downloadDataUrl(sheet.toDataURL('image/png'), 'qr_batch_' + Date.now().toString(36));
    void scaleUp;
  }

  function rasterizeQR(item) {
    var c = document.createElement('canvas');
    var size = item.size;
    c.width = size;
    c.height = size;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    // Parse the SVG we already built: cheap, no extra dependency.
    var svg = new DOMParser().parseFromString(item.svg, 'image/svg+xml');
    var path = svg.querySelector('path');
    if (!path) return c;
    var d = path.getAttribute('d') || '';
    var rects = d.match(/M(-?\d+),(-?\d+)l(\d+),0 0,(\d+) -?(\d+),0 0,-?\d+z/g) || [];
    // The generated path is axis-aligned squares; use a Path2D instead.
    try {
      var p2d = new Path2D(d);
      ctx.fillStyle = '#000';
      ctx.fill(p2d);
      void rects;
      return c;
    } catch (e) {
      // Path2D unavailable: fall back to the module loop below.
    }
    return c;
  }

  function exportSvg() {
    if (!lastGenerated || lastGenerated.length !== 1) return;
    var item = lastGenerated[0];
    if (item.kind !== 'qr') return;
    var blob = new Blob([item.svg], { type: 'image/svg+xml;charset=utf-8' });
    downloadBlob(blob, safeName(item.text) + '.svg');
  }

  /* Save generated code(s) to history (one row per code). */
  function saveGeneratedToHistory() {
    if (!lastGenerated || !lastGenerated.length) return;
    var n = 0;
    lastGenerated.forEach(function (item) {
      historyAdd({
        text: item.text,
        format: item.format,
        source: 'generated',
        detail: item.kind === 'qr' ? 'QR' : 'barcode'
      });
      n++;
    });
    toast('Saved ' + n + ' item' + (n > 1 ? 's' : '') + ' to history');
    refreshBadge();
  }

  /* =============================================================== HISTORY */
  var history = [];

  function loadHistory() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) { history = []; return; }
      var parsed = JSON.parse(raw);
      history = Array.isArray(parsed) ? parsed.filter(validEntry) : [];
    } catch (e) {
      history = [];
    }
  }

  function validEntry(e) {
    return e && typeof e === 'object' && typeof e.text === 'string' &&
      typeof e.id === 'string' && typeof e.at === 'string';
  }

  function persistHistory() {
    // Guard against quota errors: drop previews first, then trim oldest.
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(history));
      return true;
    } catch (e) {
      var trimmed = history.map(function (h) {
        var copy = {};
        Object.keys(h).forEach(function (k) {
          if (k !== 'previewUrl') copy[k] = h[k];
        });
        return copy;
      });
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
        history = trimmed;
        return true;
      } catch (e2) {
        history = history.slice(0, Math.max(1, Math.floor(history.length / 2)));
        try { localStorage.setItem(STORE_KEY, JSON.stringify(history)); } catch (e3) {}
        toast('Storage full \u2014 older history was dropped');
        return false;
      }
    }
  }

  function historyAdd(entry) {
    var item = {
      id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      text: String(entry.text),
      format: entry.format || 'QR code',
      source: entry.source || 'camera',
      detail: entry.detail || '',
      at: entry.at || nowISO(),
      previewUrl: entry.previewUrl || null
    };

    // Skip exact consecutive duplicates.
    if (history.length && history[0].text === item.text && history[0].source === item.source) {
      history[0].at = item.at;
      persistHistory();
      refreshBadge();
      renderHistory();
      return history[0];
    }

    history.unshift(item);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    persistHistory();
    refreshBadge();
    renderHistory();
    return item;
  }

  function historyDelete(id) {
    var idx = history.findIndex(function (h) { return h.id === id; });
    if (idx === -1) return;
    var removed = history.splice(idx, 1)[0];
    if (removed.previewUrl) {
      try { URL.revokeObjectURL(removed.previewUrl); } catch (e) {}
    }
    persistHistory();
    refreshBadge();
    renderHistory();
    toast('Deleted');
  }

  function historyClear() {
    if (!history.length) { toast('History is already empty'); return; }
    if (!window.confirm('Delete all ' + history.length + ' saved items on this device?')) return;
    history.forEach(function (h) {
      if (h.previewUrl) { try { URL.revokeObjectURL(h.previewUrl); } catch (e) {} }
    });
    history = [];
    try { localStorage.removeItem(STORE_KEY); } catch (e) {}
    refreshBadge();
    renderHistory();
    toast('History cleared');
  }

  function refreshBadge() {
    var badge = $('histBadge');
    badge.textContent = history.length > 99 ? '99+' : String(history.length);
    badge.hidden = history.length === 0;
    $('histCount').textContent = history.length + (history.length === 1 ? ' item' : ' items');
  }

  function renderHistory() {
    var list = $('histList');
    var q = ($('histSearch').value || '').trim().toLowerCase();
    var items = history.filter(function (h) {
      if (!q) return true;
      return (h.text + ' ' + (h.format || '') + ' ' + (h.detail || '')).toLowerCase().indexOf(q) !== -1;
    });

    list.innerHTML = '';
    $('histEmpty').hidden = history.length !== 0 && items.length !== 0;
    if (!history.length) {
      $('histEmpty').textContent = 'No history yet. Scan something, or save a generated code.';
      $('histEmpty').hidden = false;
    } else if (!items.length) {
      $('histEmpty').textContent = 'No matches for \u201c' + q + '\u201d.';
      $('histEmpty').hidden = false;
    }

    items.forEach(function (h) {
      var el = document.createElement('div');
      el.className = 'hist-item';

      var top = document.createElement('div');
      top.className = 'hist-item__top';

      var kind = document.createElement('span');
      kind.className = 'hist-item__kind';
      kind.setAttribute('data-kind', h.source === 'generated' ? 'generated' : 'scanned');
      kind.textContent = h.source === 'generated' ? 'created' : 'scanned';
      top.appendChild(kind);

      var fmt = document.createElement('span');
      fmt.className = 'pill';
      fmt.textContent = h.format || 'QR';
      top.appendChild(fmt);

      var time = document.createElement('span');
      time.className = 'hist-item__time';
      time.textContent = fmtTime(h.at);
      top.appendChild(time);

      var body = document.createElement('pre');
      body.className = 'hist-item__text';
      body.textContent = h.text;

      var actions = document.createElement('div');
      actions.className = 'hist-item__actions';

      var copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'link-btn';
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', function () { copyText(h.text); });
      actions.appendChild(copyBtn);

      if (isProbablyUrl(h.text)) {
        var openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'link-btn';
        openBtn.textContent = 'Open';
        openBtn.addEventListener('click', function () {
          window.open(/^www\./i.test(h.text) ? 'https://' + h.text : h.text, '_blank', 'noopener');
        });
        actions.appendChild(openBtn);
      }

      var shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'link-btn';
      shareBtn.textContent = 'Share';
      shareBtn.addEventListener('click', function () { shareText(h.text); });
      actions.appendChild(shareBtn);

      var expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'link-btn';
      expand.textContent = 'More';
      expand.addEventListener('click', function () {
        var open = body.classList.toggle('is-open');
        expand.textContent = open ? 'Less' : 'More';
      });
      if (h.text.length < 90) expand.hidden = true;
      actions.appendChild(expand);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'link-btn link-btn--danger';
      del.textContent = 'Delete';
      del.addEventListener('click', function () { historyDelete(h.id); });
      actions.appendChild(del);

      el.appendChild(top);
      el.appendChild(body);
      el.appendChild(actions);
      list.appendChild(el);
    });

    refreshBadge();
  }

  $('histSearch').addEventListener('input', renderHistory);
  $('clearHist').addEventListener('click', historyClear);

  /* ================================================================= WIRE UP */
  startBtn.addEventListener('click', function () { startCamera(); });

  cameraSelect.addEventListener('change', function () {
    prefs.cameraId = cameraSelect.value;
    savePrefs();
    if (scanning) startCamera(cameraSelect.value);
  });

  stopBtn.addEventListener('click', function () { stopCamera(); });

  $('uploadBtn').addEventListener('click', function () { $('fileInput').click(); });
  $('fileInput').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    decodeImageFile(f);
    e.target.value = '';
  });

  // Paste an image straight from the clipboard.
  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.indexOf('image') === 0) {
        var f = items[i].getAsFile();
        if (f) {
          showTab('scan');
          decodeImageFile(f);
          e.preventDefault();
        }
        return;
      }
    }
  });

  $('closeResult').addEventListener('click', function () {
    $('resultCard').hidden = true;
    lastResult = null;
  });

  $('copyRes').addEventListener('click', function () {
    if (lastResult) copyText(lastResult.text);
  });
  $('shareRes').addEventListener('click', function () {
    if (lastResult) shareText(lastResult.text);
  });

  $('genBtn').addEventListener('click', generate);

  $('dlPng').addEventListener('click', exportPng);
  $('dlSvg').addEventListener('click', exportSvg);
  $('saveGen').addEventListener('click', saveGeneratedToHistory);

  // Ctrl/Cmd+Enter is the natural "do it" gesture in a textarea.
  $('genText').addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      generate();
    }
  });

  // Re-render when the encoding options change and something is already shown.
  ['qrEcl', 'genQuiet', 'barcodeFormat', 'genScale'].forEach(function (id) {
    $(id).addEventListener('change', function () {
      if ($('genText').value.trim()) generate();
    });
  });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden && scanning) stopCamera(true);
  });

  /* ================================================================== START */
  loadHistory();
  refreshBadge();
  renderHistory();
  setGenKind('qr');
  setScanUi(false);
  setStatus(scanStatus, 'Ready. Start the camera, or upload/paste a QR image.');
  listCameras().then(function (cams) {
    if (cams.length && prefs.cameraId) cameraSelect.value = prefs.cameraId;
  });

  // Expose a tiny debug hook; harmless in production, handy for manual checks.
  window.__qrtool = {
    history: function () { return history; },
    generate: generate,
    decodeImage: decodeImageFile,
    stopCamera: stopCamera
  };
})();