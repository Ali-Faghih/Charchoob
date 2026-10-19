"""FastAPI adapter: the real product contract of the crop service.

The frontend sends raw photo bytes + an aspect ratio, the API runs the full
crop pipeline (face/body detection + level cascade + golden rule) and returns
the cropped JPEG bytes -- nothing is written to disk.

Run locally:
    uvicorn server:app --host 0.0.0.0 --port 8000
"""
import base64
import json

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

import service
from config import MAX_UPLOAD_MB

app = FastAPI(title="Smart Crop API", version="1.0.0")

MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024


def _read_upload(upload: UploadFile) -> bytes:
    """Read an upload in 1MB chunks, enforcing the cap without ever
    buffering an unbounded body (a giant upload must 400, not OOM)."""
    chunks = []
    total = 0
    while True:
        piece = upload.file.read(1024 * 1024)
        if not piece:
            break
        total += len(piece)
        if total > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=400,
                                detail=service.TOO_LARGE_MESSAGE)
        chunks.append(piece)
    return b"".join(chunks)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # local dev only; tighten before production
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok", "service": "smart-crop"}


@app.post("/convert")
def convert(image: UploadFile = File(...)):
    """Any decodable photo (HEIC/HEIF/...) -> JPEG bytes.

    For formats the browser cannot preview: the frontend converts once at
    import, then everything downstream (preview, crop, download) is JPEG.
    """
    image_bytes = _read_upload(image)
    try:
        out = service.convert_bytes(image_bytes)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return Response(content=out, media_type="image/jpeg")


@app.post("/crop")
def crop(
    image: UploadFile = File(...),
    aspect: str = Form(...),
):
    """Accept an uploaded image + aspect spec, return the cropped JPEG.

    `aspect` accepts "4:3", "16:9", "4:5", 16 / 9, 1.3333, ... (w/h ratio).
    """
    image_bytes = _read_upload(image)
    try:
        crop_bytes = service.crop_bytes(image_bytes, aspect)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    media = "image/png" if service.infer_format(image_bytes) == "png" else "image/jpeg"
    return Response(content=crop_bytes, media_type=media)


@app.post("/crop/multi")
def crop_multi(
    image: UploadFile = File(...),
    aspects: list[str] = Form(...),
):
    """One uploaded image + several aspect specs -> every cropped JPEG.

    Detection runs once; all ratios are cropped from the same analysis.
    Returns JSON so the frontend can bundle many results in one response.
    """
    image_bytes = _read_upload(image)
    try:
        results = service.crop_multi(image_bytes, aspects)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    payload = []
    for r in results:
        payload.append({
            "aspect": r["aspect"],
            "ratio": r["ratio"],
            "box": r["box"],
            "width": r["width"],
            "height": r["height"],
            "jpeg": base64.b64encode(r["jpeg"]).decode("ascii"),
            "format": r["format"],
        })
    return {"results": payload}


@app.post("/composite")
def composite(
    image: UploadFile = File(...),
    overlay: UploadFile = File(...),
    params: str = Form(...),
):
    """Composite a logo/frame PNG over a (cropped) photo at full resolution.

    `image`: the base crop bytes (JPEG or PNG, e.g. one /crop/multi tile).
    `overlay`: the logo/frame file — MUST be PNG (alpha is honoured).
    `params`: JSON object, same normalized contract as the frontend editor:
        {"mode": "logo", "scale": 25, "opacity": 80, "position": 8,
         "offsetX": 0.0, "offsetY": 0.0}
        {"mode": "frame", "placement": "under"|"over", "photo_scale": 100,
         "position": 4, "offsetX": 0.0, "offsetY": 0.0, "photo_opacity": 100}

    Returns the composited image bytes (same format family as the base).
    """
    try:
        spec = json.loads(params)
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(status_code=400, detail="params must be valid JSON")
    image_bytes = _read_upload(image)
    overlay_bytes = _read_upload(overlay)
    try:
        out_bytes, fmt, w, h = service.composite(
            image_bytes, overlay_bytes, spec
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    media = "image/png" if fmt == "png" else "image/jpeg"
    return Response(content=out_bytes, media_type=media,
                    headers={"X-Width": str(w), "X-Height": str(h)})