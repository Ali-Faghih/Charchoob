"""
Body (person) detection module.

Pairs each face with the body box that likely belongs to it, so the
main pipeline can tell whether a face's body is edge-cut (incomplete)
and should therefore never be treated as a subject.

This module does NOT:
- Select subjects.
- Crop the image.
"""
from pathlib import Path
from typing import TypedDict

import cv2
from ultralytics import YOLO

import config


class BodyDetection(TypedDict):
    bbox: tuple[int, int, int, int]
    confidence: float
    truncated: bool


class BodyDetector:
    """Run person detection and compute per-body metadata."""

    def __init__(
        self,
        model_path: str = None,
        confidence: float = 0.40,
        device: str = "cpu",
        person_class_id: int = 0,
    ):
        model_path = Path(model_path or config.BODY_MODEL_PATH)
        self.confidence = confidence
        self.device = device
        self.person_class_id = person_class_id

        if not model_path.exists():
            raise FileNotFoundError(f"Body model not found: {model_path}")
        self.model = YOLO(str(model_path))

    def detect(self, image_path: str) -> list[BodyDetection]:
        """Return person boxes (person class only) in (x1, y1, x2, y2)."""
        result = self.model.predict(
            str(image_path),
            conf=self.confidence,
            device=self.device,
            verbose=False,
        )[0]
        boxes = result.boxes
        detections: list[BodyDetection] = []
        if boxes is None or len(boxes) == 0:
            return detections

        image_h, image_w = (0, 0)  # filled below
        image = cv2.imread(str(image_path))
        if image is not None:
            image_h, image_w = image.shape[:2]
        tolerance = config.BODY_EDGE_TOLERANCE * min(image_w, image_h)

        for i in range(len(boxes)):
            if int(boxes.cls[i].item()) != self.person_class_id:
                continue
            x1, y1, x2, y2 = [int(v) for v in boxes.xyxy[i].tolist()]
            # A body is "edge-cut" (and therefore its face never a subject)
            # when it is cut on a SIDE (left/right) or TOP of the frame.
            # A body reaching the bottom edge is normal for standing people
            # and is NOT treated as a cut (feet at floor / frame bottom).
            truncated = (
                x1 <= tolerance
                or x2 >= image_w - tolerance
                or y1 <= tolerance
            )
            detections.append(
                {
                    "bbox": (x1, y1, x2, y2),
                    "confidence": float(boxes.conf[i].item()),
                    "truncated": truncated,
                }
            )
        return detections


def _area(box: tuple) -> float:
    return max(1.0, (box[2] - box[0]) * (box[3] - box[1]))


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
