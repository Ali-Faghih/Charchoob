from typing import TypedDict

from face import FaceDetection
from frames import person_box_for_face


class FaceAnalysis(TypedDict):
    bbox: tuple[int, int, int, int]
    confidence: float
    truncated: bool
    body_bbox: tuple[int, int, int, int] | None
    body_truncated: bool
    body_confidence: float | None
    area: float
    area_fraction: float
    center_x: float
    center_y: float
    centrality: float
    score: float


def analyze_faces(
    detections: list[FaceDetection],
    image_width: int,
    image_height: int,
    edge_tolerance: float = 0.02,
    body_detections: list = None,
    pairs: list[tuple[int, int]] = None,
) -> list[FaceAnalysis]:
    """
    Classify each detection and compute raw signals.

    - truncated: bounding box touches (or nearly touches) the image border.
      Such faces are never subjects and must not appear in the crop.
    - centrality: 0.0 at image center, 1.0 at the farthest corner.
    - area_fraction: face area as a fraction of the whole image.
    - body_*: if a body was found for this face, whether that body is
      edge-cut. A face whose body is edge-cut is also never a subject.
    """

    tolerance = max(2, edge_tolerance * min(image_width, image_height))
    image_area = image_width * image_height

    body_by_face: dict[int, dict] = {}
    if body_detections and pairs:
        for fi, bi in pairs:
            body_by_face[fi] = body_detections[bi]

    analysis: list[FaceAnalysis] = []

    for idx, detection in enumerate(detections):
        x1, y1, x2, y2 = detection["bbox"]
        width = x2 - x1
        height = y2 - y1

        truncated = (
            x1 <= tolerance
            or y1 <= tolerance
            or x2 >= image_width - tolerance
            or y2 >= image_height - tolerance
        )

        body = body_by_face.get(idx)
        body_truncated = bool(body["truncated"]) if body is not None else False

        center_x = (x1 + x2) / 2.0 / image_width
        center_y = (y1 + y2) / 2.0 / image_height

        centrality = (
            ((center_x - 0.5) ** 2 + (center_y - 0.5) ** 2) ** 0.5
            / (0.5 * 2 ** 0.5)
        )

        analysis.append(
            {
                "bbox": (x1, y1, x2, y2),
                "confidence": detection["confidence"],
                "truncated": truncated,
                "body_bbox": body["bbox"] if body is not None else None,
                "body_truncated": body_truncated,
                "body_confidence": body["confidence"] if body is not None else None,
                "area": float(width * height),
                "area_fraction": (width * height) / image_area,
                "center_x": center_x,
                "center_y": center_y,
                "centrality": centrality,
                "score": 0.0,
            }
        )

    return analysis


def _max_normalize(values: list[float]) -> list[float]:
    """Normalize by the MAXIMUM, preserving each value's magnitude relative to
    the largest -- unlike min-max normalization, which reduces to rank only.

    Used for face SIZE: min-max made two different images (one with a 3x gap,
    one with a ~1.05x gap between faces) both score {1.0, 0.0}, wiping out the
    real size difference. Max-normal keeps 'biggest = 1.0' but lets a face that
    is only 60% as big as the largest stay at 0.6.
    """
    if not values:
        return []
    high = max(values)
    if high < 1e-9:
        return [0.0] * len(values)
    return [value / high for value in values]


def score_faces(
    analysis: list[FaceAnalysis],
    weight_size: float = 0.4,
    weight_centrality: float = 0.3,
    weight_confidence: float = 0.3,
) -> list[FaceAnalysis]:
    """
    Assign a subject-importance score to every non-truncated face.

    Every signal is MAX-normalized (magnitude-preserving) before the weighted
    sum, so the weights are comparable regardless of image scale AND two
    nearly-identical faces keep nearly-identical scores. Min-max was rejected
    for centrality/confidence because it is rank-based: when two faces are
    almost equal it awards 1.0 to one and 0.0 to the other, turning a
    visually equal pair of subjects into a lopsided hierarchy.
    """

    valid = [face for face in analysis if not face["truncated"]]
    if not valid:
        return analysis

    sizes = _max_normalize([face["area_fraction"] for face in valid])
    centralities = _max_normalize([1.0 - face["centrality"] for face in valid])
    confidences = _max_normalize([face["confidence"] for face in valid])

    for face, size, centrality, confidence in zip(
        valid, sizes, centralities, confidences
    ):
        face["score"] = (
            weight_size * size
            + weight_centrality * centrality
            + weight_confidence * confidence
        )

    return analysis


# Priority is face-driven: every body gets exactly one subject slot and spends it on
# its best face (green first, then the higher score); the body order stays the detector
# order. Body-less faces (crowds: a face but no body) each stay separate.
_ROLE_RANK = {"main": 0, "secondary": 1, "invalid": 2}


def pick_body_subjects(analysis, roles, body_idx_of_face, bodies, w, h):
    """Return [(fi, person_box, face_box, role)]: one entry per body won by
    its best face; body-less faces each get their own entry."""
    entries = []
    slot_of_body = {}
    slot_key = {}
    for fi, face in enumerate(analysis):
        role = roles.get(fi, "invalid")
        bi = body_idx_of_face.get(fi)
        fbox = face["bbox"]
        if bi is not None and 0 <= bi < len(bodies):
            pbox = bodies[bi]["bbox"]
            key = (_ROLE_RANK.get(role, 2), -(face.get("score") or 0.0))
            if bi in slot_of_body:
                if key < slot_key[bi]:
                    entries[slot_of_body[bi]] = (fi, pbox, fbox, role)
                    slot_key[bi] = key
            else:
                slot_of_body[bi] = len(entries)
                slot_key[bi] = key
                entries.append((fi, pbox, fbox, role))
        else:
            entries.append((fi, person_box_for_face(fbox, w, h), fbox, role))
    return entries


def lost_face_boxes(analysis, roles, entries):
    """Faces that won no body slot (two faces, one body: only the best
    gets the entry). No detected face may be silently dropped: losers get
    face-only protection (never half-cut) even though they drive nothing.
    Returns [(face_box, role)].
    """
    used = set(fi for fi, _pbox, _fbox, _role in entries)
    return [(face["bbox"], roles.get(fi, "invalid"))
            for fi, face in enumerate(analysis) if fi not in used]
