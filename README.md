# چارچوب (Charchoob) — Smart News-Photo Cropper

Automatic cropping and framing of news/group photos following professional
photographer rules — face-first subject selection, golden-rule composition,
symmetry and headroom — with source-matched output quality, plus full-resolution
logo/watermark and frame compositing.

A **FastAPI backend** (Python: YOLO detection + crop engine) and a
**React + Vite frontend** (RTL, Persian UI, custom CSS kit) work together
through a small HTTP contract. Everything runs **in memory**: raw photo bytes
in, finished image bytes out — no temp files on disk.

---

## Features

- **Smart crop** — YOLOv8n face + pose bodies + segmentation masks, role
  priority (green main / yellow secondary / red edge-cut), L1 → L1.5 → L2 →
  L2.5 cascade with green→yellow→red demotion, aspect-ratio window search,
  margin equalization. No face is ever half-cut — not even faces that lost
  their body slot — and red faces stay fully outside the crop.
- **Multi-aspect batch** — one upload, one detection pass, crops at every
  requested ratio (`1:1`, `4:3`, `5:4`, `16:9`, portrait flips, custom `w:h`).
- **Wide format support** — JPEG, PNG, WebP, BMP, TIFF and HEIC/HEIF
  (via `pillow-heif`). Anything the browser cannot preview (e.g. HEIC) is
  converted to JPEG once at import, so the whole flow stays visual.
- **Source-matched quality** — JPEG crops scan quality 100→74 (4:4:4 chroma)
  until the crop's per-pixel byte size stays near the source's, so output
  size and quality track the input adaptively; PNG stays lossless. (JPEG
  decode → crop → encode inherently re-compresses — the scan only keeps it
  as close to the source as possible.)
- **Logo compositing** — PNG-only, one or many logos per photo: 1–1000%
  scale, 0–100% opacity, 9-point grid + free drag, hard clamped inside the
  photo. Layer list order is the truth (top = topmost) and reorders by drag.
- **Frame compositing** — PNG or JPEG template, `under` (photo scaled
  1–100% inside) or `over` (template on top); the frame itself is a
  draggable layer in the same stack.
- **Dual-format download** — every finished tile downloads as PNG or JPG
  via a shared switch (bulk follows the switch); re-encode happens
  client-side on the finished pixels.
- **Review + custom crop** — full-size review modal with an "on original"
  view (dimmed cut-away parts, Charchoob mark on the crop box), and a custom
  crop modal whose frame is the Charchoob mark with four-side resize.
- **Product limits** — 20 photos per batch, 20 MB per file, enforced in
  both frontend and backend (chunked reads, Persian 400 messages).

---

## Architecture

```text
┌──────────────┐   raw bytes + aspects    ┌─────────────────────────────┐
│  React SPA   │ ───────────────────────▶ │  FastAPI (server.py :8000)  │
│  Vite :8443  │ ◀─────────────────────── │  service.py (in-memory)     │
└──────────────┘   crops (base64) / bytes └──────────────┬──────────────┘
                                                         │
                               ┌─────────────────────────┼─────────────────────────┐
                               │                         │                         │
                          face.py (YOLOv8n-face)  debug_pose (YOLOv8n-pose)  bodies (YOLOv8n-seg)
                               │                         │                         │
                               └─────────────┬───────────┴───────────┬─────────────┘
                                             ▼                       ▼
                                    roles.py (green/yellow/red) + subjects.py
                                             ▼
                                    engine.py (L1→L2.5 + demotion, golden rule)
                                    window.py (search + margins + ranking)
                                    finalize.py (headroom + fallback)
```

---

## Project structure

```text
imne/
├── server.py            # FastAPI: /health, /convert, /crop, /crop/multi, /composite
├── service.py           # In-memory product API: crop_bytes, crop_multi, composite,
│                        #   convert_bytes, source-matched encoder, logo/frame compositing, CLI
├── engine.py            # L1/L1.5/L2/L2.5 cascade + demotion + red hard-out
├── window.py            # Aspect-window search, margin balancing, ranking
├── finalize.py          # Headroom tuning + largest-window fallback
├── roles.py             # Priority classification (green/yellow/red)
├── subjects.py          # Face analysis, scoring, body slots, lost-face tracking
├── geometry.py          # Subject record, box math
├── frames.py            # Person/second/head frame builders (+ seg owners)
├── face.py              # YOLOv8n face detection (models/yolov8n-face.pt)
├── bodies.py            # Pose pairing + person segmentation (pose/seg models)
├── debug_pose.py        # Pose model loader + keypoints
├── persons.py           # Thin facade (CropEngine, criterion_crop, Subject, …)
├── multi_ratio.py       # Per-ratio export CLI: python -m multi_ratio
├── config.py            # Tunables + upload caps (thresholds, weights, paths)
├── requirements.txt     # Python deps (incl. pillow + pillow-heif)
├── models/              # YOLO weights (face, pose, seg — see below)
├── input/  output/      # File-based folders for algorithm testing only
├── tools/
│   ├── pipeline.py      # End-to-end pipeline (persons overlays)
│   ├── visualize.py     # Debug drawing helpers
│   └── __init__.py
├── src/
│   ├── App.tsx          # Everything UI: wizard, studio, modals (≈4800 lines)
│   ├── api.ts           # Backend contract + Persian error mapping
│   ├── index.css        # Design-system CSS (tokens, kit, responsive)
│   └── components/
│       └── icons.tsx    # Lucide icon set
├── index.html           # HTML shell (Persian, RTL)
├── vite.config.ts       # Vite + React + `@` alias; dev server :8443 (strict)
├── package.json         # npm scripts: dev / build / preview / format
├── public/  hero.jpg     # Hero image (also referenced by products)
├── start_all.bat        # Backend :8000 + frontend :8443 in one go
└── اضافات/              # Kept out of the product: report-figure scripts,
                         #   debug artifacts, old outputs, unused weights/build
```

Everything under **اضافات/** is auxiliary material kept alongside the project
(figures generated for the report, annotated debug runs, previous test
outputs, an unused detector weight, editor config). None of it is imported
by the server or the UI and deleting the folder changes nothing about how
the product runs.

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Python | 3.10+ | backend |
| pip / venv | — | `.venv` recommended |
| Node.js | 20.19+ (or 22.12+) | frontend (Vite 8 requirement) |
| npm | 9+ | frontend |
| OS | Windows / Linux / macOS | developed on Windows; paths are portable |

Model weights must exist in `models/`:

- `models/yolov8n-face.pt` — face detection
- `models/yolov8n-pose.pt` — bodies + keypoints
- `models/yolov8n-seg.pt` — person masks

(Person boxes come from the pose model; no plain-detector weight is needed.)

---

## Quickstart (install & run on a fresh machine)

```bash
cd imne
start_all.bat        # backend :8000 + frontend :8443 (Windows)
```

or manually:

### 1. Backend (port 8000)

```bash
cd imne
python -m venv .venv
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# Linux/macOS:
# source .venv/bin/activate

pip install -r requirements.txt
python -m uvicorn server:app --host 0.0.0.0 --port 8000
```

Health check: `GET http://localhost:8000/health` → `{"status":"ok","service":"smart-crop"}`

### 2. Frontend (port 8443, separate terminal)

```bash
cd imne
npm install
npm run dev        # → http://localhost:8443 (hot reload, strict port)
```

Open **`http://localhost:8443`** in the browser.

### or: backend + frontend in ONE terminal

`python` must resolve to the venv one (activate step 1 first); on Windows the
`start_all.bat` handles venv activation automatically:

```bash
cd imne
npm run dev:all    # starts api (:8000) + web (:8443) together, kill-all on exit
```

### 3. Production build

```bash
npm run build      # outputs dist/ (generated — not stored in the delivery)
npm run preview    # serve the production build (port 8443)
```

Point API traffic at the backend with the build-time variable:

```bash
VITE_API_BASE_URL=http://your-host:8000 npm run build
```

Default when unset: `http://localhost:8000`.

---

## API reference

Base URL: `http://localhost:8000` (dev). Uploads are capped at 20 MB per file
(chunked reads — oversized bodies get HTTP 400, never OOM).

### `GET /health`

```json
{ "status": "ok", "service": "smart-crop" }
```

### `POST /convert` — any format → JPEG

| Field | Type | Description |
|-------|------|-------------|
| `image` | file | photo bytes (HEIC/HEIF/BMP/TIFF/WebP/JPEG/PNG…) |

**Returns** JPEG bytes (`image/jpeg`, quality 92). Used at import for formats
the browser cannot preview.

### `POST /crop` — single crop

Multipart form:

| Field | Type | Description |
|-------|------|-------------|
| `image` | file | raw photo bytes |
| `aspect` | string | `"4:3"`, `"16:9"`, `"9:16"`, `1.3333`, … (w/h ratio) |

**Returns** the cropped image bytes. `Content-Type` matches the source family
(`image/jpeg` or `image/png`).

```bash
curl -X POST http://localhost:8000/crop \
  -F "image=@photo.jpg" -F "aspect=16:9" \
  --output crop.jpg
```

### `POST /crop/multi` — one image, many ratios

Detection runs **once**; all ratios are cropped from the same analysis.

| Field | Type | Description |
|-------|------|-------------|
| `image` | file | raw photo bytes |
| `aspects` | string (repeatable) | one `aspect` value per requested ratio |

**Returns** JSON:

```json
{
  "results": [
    {
      "aspect": "16:9",
      "ratio": 1.7777,
      "box": [x1, y1, x2, y2],
      "width": 3840,
      "height": 2160,
      "format": "jpg",
      "jpeg": "<base64-encoded image bytes>"
    }
  ]
}
```

```bash
curl -X POST http://localhost:8000/crop/multi \
  -F "image=@photo.jpg" -F "aspects=4:3" -F "aspects=1:1" -F "aspects=16:9"
```

### `POST /composite` — logo/frame at full resolution

| Field | Type | Description |
|-------|------|-------------|
| `image` | file | base crop bytes (JPEG or PNG, e.g. a `/crop/multi` tile) |
| `overlay` | file | logo → **PNG only**; frame → **PNG or JPEG** |
| `params` | string (JSON) | normalized editor contract (see below) |

**Returns** the composited image bytes (same format family as the base) with
`X-Width` / `X-Height` response headers.

**`params` contract** (identical in the frontend editor and the backend):

```json
{ "mode": "logo", "scale": 25, "opacity": 80,
  "position": 2, "offsetX": 0.0, "offsetY": 0.0 }
```

```json
{ "mode": "frame", "placement": "under", "photo_scale": 95,
  "position": 4, "offsetX": 0.0, "offsetY": 0.0, "photo_opacity": 100 }
```

| Key | Range / values | Meaning |
|-----|----------------|---------|
| `mode` | `"logo"` \| `"frame"` | overlay on photo / frame-background |
| `scale` | 1–1000 | logo width as % of photo width |
| `opacity` | 0–100 | logo alpha % |
| `position` | 0–8 | 9-grid anchor, physical order (0=TL … 8=BR; the frontend mirrors RTL) |
| `offsetX`, `offsetY` | free | free-drag offset, fraction of photo size |
| `placement` | `"under"` \| `"over"` | photo scaled inside the frame / template on top |
| `photo_scale` | 1–100 | photo size inside the frame (% of canvas) |
| `photo_opacity` | 0–100 | photo alpha inside the frame |

```bash
curl -X POST http://localhost:8000/composite \
  -F "image=@crop.jpg" -F "overlay=@logo.png" \
  -F "params=<params.json" \
  --output final.jpg
```

> PowerShell tip: quote-stripping breaks inline JSON for native `curl.exe`.
> Pass JSON from a file instead: `-F "params=<params.json"`.

Error bodies are `{detail: string}`; Persian UI messages for the known cases
live in `src/api.ts` (`DETAIL_FA`), everything else falls back to a generic
sentence. Non-`ValueError` failures surface as HTTP 500.

---

## How it works

### Crop pipeline (`service.crop_bytes` / `crop_multi`)

1. **Decode** bytes → BGR array: OpenCV first, Pillow (+`pillow-heif`) for
   HEIC/HEIF/BMP/TIFF/WebP (`_decode_image`).
2. **Detect once** — YOLOv8n faces + pose bodies + seg masks, one body slot
   per body won by its best face (`subjects.py`, `bodies.py`).
3. **Roles** — green main / yellow secondary / red edge-cut (`roles.py`);
   faces that lost their body slot stay tracked with face-only protection
   (`lost_face_boxes`) so no detected face is ever silently dropped.
4. **Level cascade L1 → L1.5 → L2 → L2.5** (`engine.py`) with green→yellow→red
   demotion; aspect window search + margin equalization + soft ranking
   (`window.py`); headroom tuning + largest-window fallback (`finalize.py`).
5. **Golden rule** — no face is ever half-cut; red faces stay fully outside
   the crop at every stage (search, balance, headroom shift); only the
   last-resort full-frame fallback may still contain them.
6. **Crop + source-matched encode** (`_encode_crop`): JPEG scans quality
   100→74 with 4:4:4 sampling until `len(buf) ≤ src_size × crop_area/src_area`;
   PNG encodes losslessly.

### Composite pipeline (`service.composite`)

1. Decode base + overlay (logo enforces PNG; frame accepts PNG/JPEG).
2. Layers apply bottom-to-top in list order (frame wherever it sits).
3. **Logo** (`_apply_logo`): scale → fit-cap to frame → 9-grid anchor + offset →
   **hard clamp inside the photo** → alpha blend with opacity.
4. **Frame** (`_apply_frame`): `under` blends the template fullscreen then
   pastes the (already composited) photo scaled inside; `over` blends the
   template on top.
5. **Quality match** (`_match_base_quality`): re-encode at the exact quality the
   base was stored at, so photo blocks stay effectively identical.

### Frontend flow (`App` wizard)

1. **Upload + ratios** (`takeOriginals`) — up to 20 photos, 20 MB each;
   HEIC converts server-side to JPEG at import; no ratio is preselected.
2. **Crop** (`cropImage` → `POST /crop/multi`) — parallel per image.
3. **Studio** — per-photo frame/logo stack with drag-reorder (top = topmost),
   live monitor preview, review modal ("on original" view), custom-crop
   modal (Charchoob-mark frame, four-side resize, coordinate-locked to the
   rendered photo).
4. **Outputs** — finished tiles download as PNG or JPG via a shared switch
   (bulk follows the switch); downloads always come from the backend
   composite (or an explicit client-side re-encode), never from the preview.

---

## Configuration

Backend tunables live in `config.py`:

| Key | Default | Effect |
|-----|---------|--------|
| `CONFIDENCE_THRESHOLD` | 0.40 | face detection confidence |
| `BODY_CONFIDENCE` | 0.40 | pose/seg detection confidence |
| `DEVICE` | `"cpu"` | inference device (`"cpu"` / `"cuda:0"`) |
| `DEFAULT_ASPECT_RATIO` | 4/3 | CLI default |
| `W_SIZE / W_CENTRALITY / W_CONFIDENCE` | 0.4 / 0.3 / 0.3 | subject-selection weights |
| `MAX_UPLOAD_PHOTOS` | 20 | batch count cap (frontend picker) |
| `MAX_UPLOAD_MB` | 20 | per-file cap, enforced chunked server-side |
| `KAPPA_COMPACTNESS` | 1.0 | reserved (not wired yet): tightness scoring |
| `FACE_MODEL_PATH`, `SEG_MODEL_PATH` | `models/…` | weight locations |

Frontend config:

| Variable | Default | Effect |
|----------|---------|--------|
| `VITE_API_BASE_URL` | `http://localhost:8000` | backend base URL (build/dev time) |
| Vite `server.port` | `8443` (strict) | dev server port (`vite.config.ts`) |

---

## CLI tools (algorithm development)

```bash
# Crop every photo in input/ at the default ratio + debug visuals
python -m persons

# Export all supported ratios (4:3, 5:4, 16:9, 1:1)
python -m multi_ratio

# One-off service check: crop a single file
python -m service photo.jpg 16:9 --out result.jpg
```

`input/` and `output/` are only for algorithm testing — the product API
(`service.*`, `server.py`) never touches the disk. (The algorithm-trace and
report-figure scripts live in `اضافات/report_tools/`.)

---

## Verification

- **Trace-based regression** — annotated trace runs (kept in `اضافات/debug_output/`):
  every crop decision (box + winning level) is diffed old-vs-new; the lost-face
  and red hard-out changes moved 0 boxes on the 20-image reference set.
- **Overlay validation** — the layer stack paints identically in monitor
  (z-order) and backend (sequential composite).
- **Format matrix** — JPEG/PNG/BMP/TIFF/WebP/HEIC decode; oversize → Persian
  400; undecodable → Persian 400; extreme ratios → Persian 400 (never 500).
- **Logo containment** — hard clamp keeps every overlay inside the photo.
- **Frontend** — `npx tsc --noEmit` + `npm run build` green; strict-port dev
  server with hot reload on `:8443`.

---

## Deployment notes

- Serve the backend with Uvicorn (single worker is fine for CPU inference;
  scale workers with `--workers N` behind a reverse proxy for throughput).
- Serve `dist/` statically (Nginx, or mount `StaticFiles` in `server.py`).
- Set `VITE_API_BASE_URL` at frontend **build** time to the public API origin.
- Tighten `CORSMiddleware.allow_origins` before exposing the API publicly
  (currently `["*"]` for local development).
- Weights (`models/*.pt`) must be present on the inference host; keep them out
  of git or use Git LFS.
- No auth / rate limiting yet — add before any public exposure.

Example (Nginx sketch): `/api/* → 127.0.0.1:8000`, `/ → dist/`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `حجم فایل بیشتر از ۲۰ مگابایت است` (400) | file over the 20 MB cap (both sides enforce it) |
| `برش بر اساس چهره برای این عکس ممکن نیست` (400) | no usable face/subject — remove the photo or pick another |
| `برش با این نسبت برای این عکس ممکن نیست` (400) | degenerate ratio (e.g. `99999:1`) — use a sane `w:h` |
| HEIC has no preview | expected in Chrome/Edge — it converts at import; cropping works |
| Downloads lack the logo | tile was never composited — finish the overlay and let auto-render run |
| `params must be valid JSON` (400) | malformed `params` form field on `/composite` |
| Overlay rejected (400) | logo must be PNG; frame PNG or JPEG |
| `address already in use` (:8000/:8443) | a previous dev server is still running — reuse it or kill the listener |
| `FileNotFoundError: models/…` | missing YOLO weights — face, pose and seg `.pt` files in `models/` |
| Slow first request | models load lazily on first inference — warm up with one call |

---

## Roadmap

- Wire `KAPPA_COMPACTNESS` (tightness scoring for loose full-body windows)
- Head-box from the head region only (fixes narrow-ratio fallbacks at the root)
- Back-facing people as yellow subjects (cone prototype exists, parked)
- `pytest` smoke suite (engine-only, no models) + CI (lint, typecheck, build)
- Containerization; request auth/rate-limiting; GPU device option
