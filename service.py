"""In-memory cropping service for the frontend.

The file-based input/output folders are just for algorithm testing. The real
product contract is: give us raw photo bytes + an aspect ratio, get a fully
processed CROPPED image back -- no files, no folders, no temp dirs.

Public API
----------
    get_models() -> (pose_model, face_detector)      # lazily cached, thread-safe
    parse_aspect(spec) -> float                     # "4:3" | 16/9 | 1.3333 ...
    crop_ndarray(image, aspect_spec) -> (crop, box) # BGR image in, BGR crop out
    crop_bytes(image_bytes, aspect_spec) -> bytes   # encoded in, JPEG out

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


# ---------------------------------------------------------------- cropping --

def crop_ndarray(image, aspect_spec):
    """Crop an already-decoded BGR image at the requested ratio.

    Returns (crop_image, box) where box = (x1, y1, x2, y2) of the region
    that was cut from the source.
    """
    pose_model, face_detector = get_models()
    h, w = image.shape[:2]
    aspect = parse_aspect(aspect_spec)
    subjects, avoid = build_subjects(pose_model, face_detector, image)[2:]
    x1, y1, x2, y2 = criterion_crop(w, h, aspect, subjects, avoid=avoid)
    box = (int(round(x1)), int(round(y1)), int(round(x2)), int(round(y2)))
    return image[y1:y2, x1:x2], box


def crop_bytes(image_bytes, aspect_spec, quality=95):
    """Encoded photo bytes in, JPEG crop out. `aspect_spec` = "4:3", 1.0, ...

    Raises ValueError if the payload is not a decodable image.
    """
    data = np.frombuffer(image_bytes, dtype=np.uint8)
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Could not decode the provided image bytes")
    crop, _box = crop_ndarray(image, aspect_spec)
    ok, buf = cv2.imencode(
        ".jpg", crop, (cv2.IMWRITE_JPEG_QUALITY, int(quality))
    )
    if not ok:
        raise ValueError("Could not encode the cropped image")
    return buf.tobytes()


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