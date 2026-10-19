"""
Body (person) detection module.

Pairs each face with the body box that likely belongs to it, so the
main pipeline can tell whether a face's body is edge-cut (incomplete)
and should therefore never be treated as a subject.

This module does NOT:
- Select subjects.
- Crop the image.
"""
import threading

import cv2
import numpy as np
from ultralytics import YOLO

import config


def _area(box: tuple) -> float:    return max(1.0, (box[2] - box[0]) * (box[3] - box[1]))


def _intersection_area(a: tuple, b: tuple) -> float:
    ix1 = max(a[0], b[0])
    iy1 = max(a[1], b[1])
    ix2 = min(a[2], b[2])
    iy2 = min(a[3], b[3])
    return max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)


def pair_faces_to_bodies(
    faces: list, bodies: list, image_width: int, image_height: int
) -> list[tuple[int, int]]:
    """
    Return a list of (face_index, body_index) pairings.

    A face is paired with the body that contains its center in the top half
    (BODY_MATCH_MARGIN of the body height), and whose overlap is largest.
    """
    pairs: list[tuple[int, int]] = []
    for fi, face in enumerate(faces):
        x1, y1, x2, y2 = face["bbox"]
        fx, fy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        best_i = -1
        best_score = -1.0
        for bi, body in enumerate(bodies):
            bx1, by1, bx2, by2 = body["bbox"]
            if not (bx1 <= fx <= bx2):
                continue
            if not (by1 <= fy <= by1 + config.BODY_MATCH_MARGIN * (by2 - by1)):
                continue
            # overlap between face box and body box (scaled) as pairing score
            overlap = _intersection_area(face["bbox"], body["bbox"])
            score = overlap / _area(face["bbox"])
            if score > best_score:
                best_score = score
                best_i = bi
        if best_i >= 0:
            pairs.append((fi, best_i))
    return pairs


# ------------------------------------------- body segmentation (person) ---------
# A separate mask per person (largest connected piece of each instance) to build the
# head box and to tell people apart in a crowd. The model is loaded once and kept.

_SEG_MODEL = None
_SEG_LOCK = threading.Lock()


def get_seg_model():
    """Load yolov8n-seg.pt only once and reuse it forever (thread-safe)."""
    global _SEG_MODEL
    if _SEG_MODEL is None:
        with _SEG_LOCK:
            if _SEG_MODEL is None:
                model_path = config.SEG_MODEL_PATH
                if not model_path.exists():
                    raise FileNotFoundError(
                        f"Seg model not found: {model_path}")
                _SEG_MODEL = YOLO(str(model_path))
    return _SEG_MODEL


def seg_person_masks(image: np.ndarray) -> list:
    """Per-instance body masks: a list of binary (h, w) arrays with 255=body.
    Each mask keeps only its largest connected piece so that stray fragments (a
    neighbour hand, for example) cannot widen the boxes. Input: raw BGR image.
    """
    h, w = image.shape[:2]
    result = get_seg_model().predict(
        image,
        conf=config.BODY_CONFIDENCE,
        device=config.DEVICE,
        verbose=False,
    )[0]
    masks = []
    if result.masks is None or result.boxes is None:
        return masks
    for i in range(len(result.boxes)):
        if int(result.boxes.cls[i].item()) != config.PERSON_CLASS_ID:
            continue
        prob = cv2.resize(result.masks.data[i].cpu().numpy(), (w, h))
        m = (prob > 0.5).astype(np.uint8) * 255
        cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)
        if not cnts:
            continue
        main = np.zeros_like(m)
        cv2.drawContours(main, [max(cnts, key=cv2.contourArea)], -1, 255, -1)
        masks.append(main)
    return masks
