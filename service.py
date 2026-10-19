"""In-memory cropping service for the frontend.

The file-based input/output folders are just for algorithm testing. The real
product contract is: give us raw photo bytes + an aspect ratio, get a fully
processed CROPPED image back -- no files, no folders, no temp dirs.

Public API
----------
    get_models() -> (pose_model, face_detector)      # lazily cached, thread-safe
    parse_aspect(spec) -> float                     # "4:3" | 16/9 | 1.3333 ...
    crop_ndarray(image, aspect_spec) -> (crop, box) # BGR image in, BGR crop out
    crop_bytes(image_bytes, aspect_spec) -> bytes   # encoded in, JPEG/PNG out
    infer_format(image_bytes) -> "jpg" | "png"     # sniff PNG vs JPEG
    composite(base_bytes, overlay_png, params)     # logo/frame at full res

Run a quick local check:
    python -m service <image> <aspect> [--out result.jpg] [--device cpu]
"""
import threading
from pathlib import Path

import cv2
import numpy as np

import config
from debug_pose import load_pose_model
from face import FaceDetector
from multi_ratio import build_subjects
from persons import criterion_crop

try:
    import pillow_heif  # registers HEIC/HEIF with Pillow below

    pillow_heif.register_heif_opener()
except ImportError:  # without it, HEIC uploads are simply rejected
    pass


# ------------------------------------------------------------------ models --

_LOCK = threading.Lock()
_LOADED = None


def get_models():
    """Load (pose_model, face_detector) once, reuse forever. Thread-safe so
    the future HTTP layer can serve concurrent requests without reloading."""
    global _LOADED
    if _LOADED is None:
        with _LOCK:
            if _LOADED is None:
                pose_model = load_pose_model()
                face_detector = FaceDetector(
                    model_path=str(config.FACE_MODEL_PATH),
                    confidence_threshold=config.CONFIDENCE_THRESHOLD,
                    device=config.DEVICE,
                )
                _LOADED = (pose_model, face_detector)
    return _LOADED


# --------------------------------------------------------------- aspect ---

def parse_aspect(spec):
    """Accept "4:3", "16:9", 16 / 9 (float/int) -> width/height ratio."""
    if isinstance(spec, (int, float)):
        ratio = float(spec)
    else:
        text = str(spec).strip()
        if ":" in text:
            a, b = text.split(":", 1)
            ratio = float(a) / float(b)
        else:
            ratio = float(text)
    if ratio <= 0:
        raise ValueError(f"Invalid aspect ratio: {spec!r}")
    return ratio


# ----------------------------------------------------------------- encode --

_PNG_HEADER = b"\x89PNG\r\n\x1a\n"
_JPEG_HEADER = b"\xff\xd8\xff"
_JPEG_444 = cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444
# scanned best-first so the first quality that fits the source budget wins
_SOURCE_MATCH_QUALITIES = tuple(range(100, 73, -1))


def infer_format(image_bytes):
    """Return "png" if the payload is a PNG, else "jpg" (best-effort)."""
    if image_bytes.startswith(_PNG_HEADER):
        return "png"
    return "jpg"


#: Upload larger than the product cap (user-facing message).
TOO_LARGE_MESSAGE = "حجم فایل بیشتر از ۲۰ مگابایت است"


def _decode_image(image_bytes):
    """Decode photo bytes to BGR.

    OpenCV first (JPEG/PNG); then Pillow (+pillow-heif) for HEIC/HEIF,
    BMP, TIFF, WebP and friends. Returns None when undecodable.
    """
    data = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is not None:
        return image
    try:
        import io

        from PIL import Image

        with Image.open(io.BytesIO(bytes(image_bytes))) as pil:
            rgb = pil.convert("RGB")
        return cv2.cvtColor(np.asarray(rgb), cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def _decode_overlay(overlay_bytes):
    """Decode a logo/frame overlay keeping alpha: OpenCV first (PNG/JPEG),
    Pillow fallback for the rest. Returns None when undecodable."""
    data = np.frombuffer(overlay_bytes, dtype=np.uint8)
    overlay = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if overlay is not None:
        return overlay
    bgr = _decode_image(overlay_bytes)
    return bgr  # may be None; 3-channel (no alpha) at most


def _encode_crop(crop, image_bytes, source_size, src_h, src_w, quality=None):
    """Encode a crop keeping the output as close to the source as possible.

    JPEG in -> JPEG out, with the quality chosen so the crop's per-pixel size
    stays near the source's per-pixel size. That is the smallest size
    reduction possible for a crop: only the trimmed-away pixels are dropped,
    there is no extra re-compression loss.

    PNG in -> PNG out (lossless), so there is zero quality loss either.

    If `quality` (0-100) is given explicitly, it is honoured instead of the
    auto match. Returns (bytes, format) where format is "jpg" or "png".
    """
    crop_h, crop_w = crop.shape[:2]
    if infer_format(image_bytes) == "png":
        ok, buf = cv2.imencode(".png", crop)
        if not ok:
            raise ValueError("Could not encode the cropped image (PNG)")
        return buf.tobytes(), "png"
    if quality is not None:
        ok, buf = cv2.imencode(
            ".jpg", crop,
            (cv2.IMWRITE_JPEG_QUALITY, int(quality), cv2.IMWRITE_JPEG_SAMPLING_FACTOR, _JPEG_444),
        )
        if not ok:
            raise ValueError("Could not encode the cropped image")
        return buf.tobytes(), "jpg"
    budget = source_size * (crop_w * crop_h) / (src_w * src_h)
    for q in _SOURCE_MATCH_QUALITIES:
        ok, buf = cv2.imencode(
            ".jpg", crop,
            (cv2.IMWRITE_JPEG_QUALITY, q, cv2.IMWRITE_JPEG_SAMPLING_FACTOR, _JPEG_444),
        )
        if not ok:
            raise ValueError("Could not encode the cropped image")
        if len(buf) <= budget:
            break
    return buf.tobytes(), "jpg"


# ---------------------------------------------------------------- cropping --

#: With no reliable face, face-aware cropping is impossible (user-facing message).
NO_FACE_MESSAGE = "برش بر اساس چهره برای این عکس ممکن نیست"

#: The cascade produced an empty box (e.g. an extreme aspect ratio).
EMPTY_BOX_MESSAGE = "برش با این نسبت برای این عکس ممکن نیست"


def _require_subjects(subjects):
    if not subjects:
        raise ValueError(NO_FACE_MESSAGE)
    return subjects


def _require_box(box):
    x1, y1, x2, y2 = box
    if x2 <= x1 or y2 <= y1:
        raise ValueError(EMPTY_BOX_MESSAGE)
    return box


def crop_ndarray(image, aspect_spec):
    """Crop an already-decoded BGR image at the requested ratio.

    Returns (crop_image, box) where box = (x1, y1, x2, y2) of the region
    that was cut from the source.
    """
    pose_model, face_detector = get_models()
    h, w = image.shape[:2]
    aspect = parse_aspect(aspect_spec)
    subjects, avoid = build_subjects(pose_model, face_detector, image)[2:]
    _require_subjects(subjects)
    x1, y1, x2, y2 = criterion_crop(w, h, aspect, subjects, avoid=avoid)
    box = (int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2)))
    _require_box(box)
    return image[box[1]:box[3], box[0]:box[2]], box


def convert_bytes(image_bytes, quality=92):
    """Any decodable photo (HEIC/HEIF/BMP/TIFF/WebP/...) -> JPEG bytes.

    Used at import time for formats the browser cannot preview: the JPEG
    comes back, previews everywhere, and all later crop calls send JPEG.
    Raises ValueError if the payload is not a decodable image.
    """
    image = _decode_image(image_bytes)
    if image is None:
        raise ValueError("Could not decode the provided image bytes")
    ok, buf = cv2.imencode(
        ".jpg", image,
        (cv2.IMWRITE_JPEG_QUALITY, int(quality),
         cv2.IMWRITE_JPEG_SAMPLING_FACTOR, _JPEG_444),
    )
    if not ok:
        raise ValueError("Could not encode the converted image")
    return buf.tobytes()


def crop_bytes(image_bytes, aspect_spec, quality=None):
    """Encoded photo bytes in, cropped image out (JPEG or PNG, matching
    the source format). `aspect_spec` = "4:3", 1.0, ...

    Without `quality`, the output keeps the source's per-pixel size (smallest
    possible size reduction for the crop). With an explicit `quality`
    (0-100), that fixed value is used instead.

    Raises ValueError if the payload is not a decodable image.
    """
    image = _decode_image(image_bytes)
    if image is None:
        raise ValueError("Could not decode the provided image bytes")
    crop, _box = crop_ndarray(image, aspect_spec)
    h, w = image.shape[:2]
    crop_bytes_out, _fmt = _encode_crop(crop, image_bytes, len(image_bytes), h, w, quality=quality)
    return crop_bytes_out


def crop_multi(image_bytes, aspect_specs, quality=None):
    """One detection pass, then crop at every requested ratio.

    Returns a list of dicts:
        {"aspect": spec, "ratio": w/h float, "box": (x1,y1,x2,y2),
         "width": int, "height": int, "jpeg": bytes, "format": "jpg"|"png"}
    For the batch flow: detection runs once per image, all ratios reuse it.
    Output encoding matches the source quality/size (see _encode_crop).
    """
    image = _decode_image(image_bytes)
    if image is None:
        raise ValueError("Could not decode the provided image bytes")
    pose_model, face_detector = get_models()
    h, w = image.shape[:2]
    subjects, avoid = build_subjects(pose_model, face_detector, image)[2:]
    _require_subjects(subjects)
    results = []
    for spec in aspect_specs:
        aspect = parse_aspect(spec)
        x1, y1, x2, y2 = criterion_crop(w, h, aspect, subjects, avoid=avoid)
        box = (int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2)))
        _require_box(box)
        crop = image[box[1]:box[3], box[0]:box[2]]
        encoded, fmt = _encode_crop(crop, image_bytes, len(image_bytes), h, w, quality=quality)
        results.append({
            "aspect": spec,
            "ratio": aspect,
            "box": box,
            "width": int(round(x2 - x1)),
            "height": int(round(y2 - y1)),
            "jpeg": encoded,
            "format": fmt,
        })
    return results


def _match_base_quality(image, image_bytes):
    """Largest JPEG quality that reproduces `image_bytes` from the decoded
    BGR `image` at 4:4:4. Re-encoding something that only ADDS content (like
    the logo in composite) at this same quality keeps the original photo
    blocks pixel-identical — zero visible quality loss on the photo region.

    Returns None for non-JPEG sources (PNG output is lossless anyway).
    """
    if infer_format(image_bytes) != "jpg":
        return None
    target = len(image_bytes)
    for q in _SOURCE_MATCH_QUALITIES:
        ok, buf = cv2.imencode(
            ".jpg", image,
            (cv2.IMWRITE_JPEG_QUALITY, q, cv2.IMWRITE_JPEG_SAMPLING_FACTOR, _JPEG_444),
        )
        if ok and len(buf) <= target:
            return q
    return 74


# ---------------------------------------------------------------- overlay --

# Anchor inset as a fraction of the photo size. MUST stay identical to the
# frontend OverlayEditor anchor() — both sides implement the same geometry
# so the preview and the final render match pixel-for-pixel (up to rounding).
_LOGO_ANCHOR_MARGIN = 0.04


def _logo_anchor(index):
    """Anchor point (fractions of photo) for a 9-grid preset, physical order:
    0=TL 1=TC 2=TR 3=ML 4=C 5=MR 6=BL 7=BC 8=BR."""
    index = min(max(int(index), 0), 8)
    col, row = index % 3, index // 3
    m = _LOGO_ANCHOR_MARGIN
    return (m + col * (1 - 2 * m) / 2, m + row * (1 - 2 * m) / 2)


def _logo_box_px(scale, position, offset_x, offset_y,
                 logo_w, logo_h, photo_w, photo_h):
    """Logo box in pixels, mirroring the frontend logoBox() exactly.

    - scale: logo width as % of the photo width (slider: 5-1000).
    - the box is fit-capped to the photo frame first, then hard-clamped
      inside it, so the logo can NEVER leave the photo — even at 1000% it
      is capped to the frame instead of overflowing.
    Returns (x, y, w, h) ints.
    """
    scale = max(float(scale), 1.0)
    lw = scale / 100.0 * photo_w
    lh = lw * (logo_h / logo_w) if logo_w > 0 else 0.0
    if lw > photo_w:
        lw = float(photo_w)
        lh = lw * (logo_h / logo_w) if logo_w > 0 else 0.0
    if lh > photo_h:
        lh = float(photo_h)
        lw = lh * (logo_w / logo_h) if logo_h > 0 else 0.0
    ax, ay = _logo_anchor(position)
    x = (ax + float(offset_x)) * photo_w - lw / 2
    y = (ay + float(offset_y)) * photo_h - lh / 2
    x = min(max(x, 0.0), photo_w - lw)
    y = min(max(y, 0.0), photo_h - lh)
    return int(round(x)), int(round(y)), int(round(lw)), int(round(lh))


def _blend_over(dst_bgr, src_bgra):
    """Alpha-composite an RGB(A) image over a BGR canvas of the same size."""
    h, w = dst_bgr.shape[:2]
    if src_bgra.ndim == 3 and src_bgra.shape[2] == 4:
        alpha = src_bgra[:, :, 3:4].astype(np.float32) / 255.0
        src = src_bgra[:, :, :3].astype(np.float32)
    else:
        alpha = np.ones((h, w, 1), dtype=np.float32)
        src = src_bgra[:, :, :3].astype(np.float32)
    dst = dst_bgr.astype(np.float32)
    return (src * alpha + dst * (1 - alpha)).round().astype(np.uint8)


def _apply_logo(base, overlay, params):
    oh, ow = overlay.shape[:2]
    H, W = base.shape[:2]
    opacity = min(max(float(params.get("opacity", 80)), 0.0), 100.0)
    x, y, lw, lh = _logo_box_px(
        params.get("scale", 25), params.get("position", 8),
        float(params.get("offsetX", 0.0)), float(params.get("offsetY", 0.0)),
        ow, oh, W, H,
    )
    if lw <= 0 or lh <= 0:
        return base
    interp = cv2.INTER_AREA if (lw < ow or lh < oh) else cv2.INTER_LINEAR
    logo = cv2.resize(overlay, (lw, lh), interpolation=interp)
    if logo.ndim == 3 and logo.shape[2] == 4:
        alpha = logo[:, :, 3].astype(np.float32) / 255.0 * (opacity / 100.0)
        rgb = logo[:, :, :3].astype(np.float32)
    else:
        alpha = np.full((lh, lw), opacity / 100.0, dtype=np.float32)
        rgb = logo[:, :, :3].astype(np.float32)
    roi = base[y:y + lh, x:x + lw].astype(np.float32)
    a = alpha[:, :, None]
    base[y:y + lh, x:x + lw] = (rgb * a + roi * (1 - a)).round().astype(np.uint8)
    return base


def _photo_box_px(photo_scale, position, offset_x, offset_y, photo_w, photo_h):
    """Photo box (pixels) inside a fixed frame canvas, mirroring the
    frontend frame editor exactly: uniform scale (10-100% of the canvas),
    9-grid anchor + drag offsets, hard-clamped inside the canvas.
    Returns (x, y, w, h) ints."""
    s = min(max(float(photo_scale), 1.0), 100.0) / 100.0
    pw = max(int(round(s * photo_w)), 1)
    ph = max(int(round(s * photo_h)), 1)
    ax, ay = _logo_anchor(position)
    x = (ax + float(offset_x)) * photo_w - pw / 2
    y = (ay + float(offset_y)) * photo_h - ph / 2
    x = min(max(x, 0.0), photo_w - pw)
    y = min(max(y, 0.0), photo_h - ph)
    return int(round(x)), int(round(y)), pw, ph


def _paste_photo(canvas, photo, x, y, pw, ph, opacity):
    """Paste a resized-into-(pw, ph) photo onto canvas at (x, y) with
    0-100 opacity. Returns the canvas."""
    if pw == photo.shape[1] and ph == photo.shape[0]:
        small = photo
    else:
        small = cv2.resize(photo, (pw, ph), interpolation=cv2.INTER_AREA)
    a = min(max(float(opacity), 0.0), 100.0) / 100.0
    roi = canvas[y:y + ph, x:x + pw].astype(np.float32)
    canvas[y:y + ph, x:x + pw] = (
        small.astype(np.float32) * a + roi * (1 - a)).round().astype(np.uint8)
    return canvas


def _apply_frame(base, overlay, params):
    H, W = base.shape[:2]
    placement = params.get("placement", "under")
    # legacy path (kept for old callers): thickness-driven EXPANDED canvas,
    # only when the new photo_scale contract is absent.
    if "photo_scale" not in params and placement == "under" \
            and "thickness" in params:
        thickness = min(max(float(params.get("thickness", 10)), 0.0), 50.0)
        s = thickness / 100.0
        Fw, Fh = int(round(W * (1 + s))), int(round(H * (1 + s)))
        shrink = Fw < overlay.shape[1] or Fh < overlay.shape[0]
        tmpl = cv2.resize(overlay, (Fw, Fh),
                          interpolation=cv2.INTER_AREA if shrink else cv2.INTER_LINEAR)
        if tmpl.ndim == 3 and tmpl.shape[2] == 4:
            canvas = _blend_over(np.full((Fh, Fw, 3), 255, np.uint8), tmpl)
        else:
            canvas = tmpl[:, :, :3]
        ox, oy = (Fw - W) // 2, (Fh - H) // 2
        canvas[oy:oy + H, ox:ox + W] = base
        return canvas, H, W
    # current contract: the frame canvas is FIXED at the photo size; the
    # photo itself scales (10-100%), positions (9-grid + offsets) and fades
    # (opacity) inside it -- for both under and over placements.
    shrink = overlay.shape[1] > W or overlay.shape[0] > H
    tmpl = cv2.resize(overlay, (W, H),
                      interpolation=cv2.INTER_AREA if shrink else cv2.INTER_LINEAR)
    x, y, pw, ph = _photo_box_px(
        params.get("photo_scale", 100), params.get("position", 4),
        float(params.get("offsetX", 0.0)), float(params.get("offsetY", 0.0)),
        W, H,
    )
    white = np.full((H, W, 3), 255, np.uint8)
    if placement == "over":
        canvas = _paste_photo(white, base, x, y, pw, ph,
                              params.get("photo_opacity", 100))
        return _blend_over(canvas, tmpl), H, W
    canvas = _blend_over(white, tmpl)
    return _paste_photo(canvas, base, x, y, pw, ph,
                        params.get("photo_opacity", 100)), H, W


def composite(base_bytes, overlay_bytes, params):
    """Composite a logo/frame PNG over a (cropped) photo at full resolution.

    `base_bytes`: the crop to draw on (JPEG or PNG).
    `overlay_bytes`: the logo/frame file — logo MUST be PNG (alpha is
    honoured); frame accepts PNG or JPEG.
    `params`: {"mode": "logo", scale, opacity, position, offsetX, offsetY}
              or {"mode": "frame", placement ("under"|"over"), photo_scale
              (10-100), position, offsetX, offsetY, photo_opacity}.
              (Legacy: {"mode": "frame", placement "under", thickness} still
              renders the old thickness-expanded canvas.)

    Geometry mirrors the frontend OverlayEditor exactly (normalized
    coordinates), so the live preview and this render agree.

    Returns (bytes, format, width, height). Raises ValueError on bad input.
    """
    if not isinstance(params, dict):
        raise ValueError("params must be a JSON object")
    mode = params.get("mode")
    if mode == "logo" and not overlay_bytes.startswith(_PNG_HEADER):
        raise ValueError("overlay input must be PNG")
    if mode == "frame" and not (
        overlay_bytes.startswith(_PNG_HEADER)
        or overlay_bytes.startswith(_JPEG_HEADER)
    ):
        raise ValueError("overlay input must be PNG or JPEG")
    base = _decode_image(base_bytes)
    if base is None:
        raise ValueError("could not decode the base image")
    overlay = _decode_overlay(overlay_bytes)
    if overlay is None:
        raise ValueError("could not decode the overlay PNG")
    if overlay.ndim == 2:
        overlay = cv2.cvtColor(overlay, cv2.COLOR_GRAY2BGR)
    H, W = base.shape[:2]
    if mode == "logo":
        canvas, pre_h, pre_w = _apply_logo(base, overlay, params), H, W
    elif mode == "frame":
        canvas, pre_h, pre_w = _apply_frame(base, overlay, params)
    else:
        raise ValueError("params.mode must be 'logo' or 'frame'")
    # keep the photo LOOKING identical: re-encode at the exact quality the
    # base was stored at (blocks outside the overlay stay bit-identical,
    # the overlay just adds its own blocks — no visible quality loss).
    q_base = _match_base_quality(base, base_bytes)
    encoded, fmt = _encode_crop(canvas, base_bytes, len(base_bytes), pre_h, pre_w,
                                quality=q_base)
    oh, ow = canvas.shape[:2]
    return encoded, fmt, ow, oh


# ------------------------------------------------------------------ config --

def _parse_args(argv):
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", help="path to a photo (local test only)")
    parser.add_argument("aspect", help='aspect ratio, e.g. "4:3" or 1.0')
    parser.add_argument("--out", default=None,
                        help="write the crop to this path (optional)")
    return parser.parse_args(argv)


def _main(argv=None):
    args = _parse_args(argv if argv is not None else None)
    image_bytes = Path(args.image).read_bytes()
    crop = crop_bytes(image_bytes, args.aspect)
    print(f"input : {args.image} ({len(image_bytes)} bytes)")
    print(f"aspect: {parse_aspect(args.aspect):.4f}")
    if args.out:
        Path(args.out).write_bytes(crop)
        print(f"crop  : {args.out} ({len(crop)} bytes)")
    else:
        print(f"crop  : {len(crop)} bytes (pass --out to write it)")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())