# Scan & Create

A single-page, offline-first QR and barcode app for mobile browsers.

- **Scan** QR codes with the camera you pick (rear/front), or **upload** a still
  image of a code from your photo library or the file picker.
- **Create** one QR code or one 1D barcode from a single multiline text field,
  and export it as PNG or SVG.
- **History** of everything you scan and generate is kept in `localStorage`
  (last 300 items).

No build step, no npm, no bundler, no network requests at runtime. Open
`index.html` and it works — including from `file://`.

## Install as an app (PWA)

`index.html` is a PWA: it ships a web app manifest (`manifest.webmanifest`), a
service worker (`sw.js`) that precaches the full app shell, and an app icon
(`icons/icon-maskable.svg`). Served over **https** or **localhost**, the browser
offers an "Install" button in the app bar; the app then launches in its own
standalone window with no browser chrome, and works fully offline.

Service workers and the install prompt require a secure origin, so `file://`
and plain `http://` on a LAN address silently skip registration — the app still
runs, just not installably. Test locally with `python3 -m http.server` and open
`http://localhost:8000`.

Bump `APP_VERSION` in `sw.js` when you change a precached file, otherwise
installed clients keep the cached shell.

## Vendored libraries

These are committed under `vendor/` so the app runs fully offline. Each file is
byte-for-byte identical to the upstream release listed, except where noted.

| File | Library | Version | License | Upstream |
| --- | --- | --- | --- | --- |
| `vendor/jsQR.js` | [jsQR](https://github.com/cozmo/jsQR) | 1.4.0 | Apache-2.0 | https://github.com/cozmo/jsQR (npm `jsqr@1.4.0`) |
| `vendor/qrcode.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 1.4.4 | MIT | https://github.com/kazuhikoarase/qrcode-generator/tree/js1.4.4 |
| `vendor/JsBarcode.all.min.js` | [JsBarcode](https://github.com/lindell/JsBarcode) | 3.11.5 | MIT | https://github.com/lindell/JsBarcode/tree/v3.11.5 |

### Download URLs

Pinned, versioned CDN URLs — these resolve to exactly the files checked in:

- jsQR 1.4.0 — https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js
- qrcode-generator 1.4.4 — https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js
- JsBarcode 3.11.5 — https://cdn.jsdelivr.net/npm/jsbarcode@3.11.5/dist/JsBarcode.all.min.js

npm registry tarballs, if you prefer those:

- https://registry.npmjs.org/jsqr/-/jsqr-1.4.0.tgz
- https://registry.npmjs.org/qrcode-generator/-/qrcode-generator-1.4.4.tgz
- https://registry.npmjs.org/jsbarcode/-/jsbarcode-3.11.5.tgz

Upstream release pages. Note that jsQR publishes no git tags or GitHub releases
at all — pin it through npm instead.

- qrcode-generator 1.4.4 — https://github.com/kazuhikoarase/qrcode-generator/releases/tag/js1.4.4
- JsBarcode 3.11.5 — https://github.com/lindell/JsBarcode/releases/tag/v3.11.5

### Verification

All three vendored files are byte-for-byte identical to the upstream release
listed (verified with `cmp` / `diff` against the pinned npm tarballs and
jsDelivr).

### Versioning caveat

`qrcode.js` declares no version anywhere in its source, so the version above was
established by hashing the file against every published release rather than by
reading a banner. It matches 1.4.4 exactly and differs from every 2.0.x release
(2.0.0+ dropped `renderTo2dContext`, which 1.4.4 still ships). The `fillRect`
call in `renderTo2dContext` reads `row * cellSize, col * cellSize` in 1.4.4; the
2.0.4 `dist/qrcode.js` transposes those two terms. This app never calls
`renderTo2dContext` — it renders through `createSvgTag` (`app.js`, `buildQR`) —
so the distinction has no effect here, but it is the reason 1.4.4 and 2.0.4 are
not interchangeable.

The other two files carry their versions in a banner
(`/*! JsBarcode v3.11.5 ... */`) or are distributed only as a built `dist/`
bundle (jsQR), and were confirmed by hash match.

## Credits

The QR Code and barcode standards are trademarks of their respective owners;
"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

You might also be interested in https://github.com/six-two/qr.html