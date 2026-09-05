from typing import TypedDict

from face import FaceDetection


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


def resolve_truncation(
    analysis: list[FaceAnalysis],
    min_survivors: int = 3,
) -> list[FaceAnalysis]:
    """
    Decide which faces are truly forbidden (edge-cut).

    A face whose own box touches the border is always forbidden. A face whose
    body touches the border is forbidden too -- BUT only if enough subjects
    survive the purge. If dropping all body-cut faces would leave fewer than
    ``min_survivors``, we keep them instead, because a lone person merely
    standing at the frame edge (with a fully visible body, e.g. image 11) is a
    genuine subject and must not be dropped. This mirrors a human editor: a
    small group is kept whole, a large group can shed edge stragglers.
    """
    face_cut = [f for f in analysis if f["truncated"]]
    body_cut = [f for f in analysis if not f["truncated"] and f["body_truncated"]]

    if not body_cut:
        return analysis

    n_survivors = len(analysis) - len(face_cut) - len(body_cut)
    if n_survivors < min_survivors:
        # keep body-cut faces so the scene does not collapse
        for face in body_cut:
            face["truncated"] = False
    else:
        for face in body_cut:
            face["truncated"] = True

    return analysis


def _normalize(values: list[float]) -> list[float]:
    if not values:
        return []
    low = min(values)
    high = max(values)
    if high - low < 1e-9:
        return [1.0] * len(values)
    return [(value - low) / (high - low) for value in values]


def _max_normalize(values: list[float]) -> list[float]:
    """Normalize by the MAXIMUM, preserving each value's magnitude relative to
    the largest -- unlike min-max (_normalize), which reduces to rank only.

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


def zoom_policy(
    analysis: list[FaceAnalysis],
    image_height: int,
    threshold: float = 0.30,
) -> dict:
    """Decide whether to zoom toward the subject (upper-body crop).

    Rule: only when the largest / closest face is big relative to the frame
    (relative height >= threshold) -- a "near subject". Then the crop should
    zoom to frame the subject tighter instead of keeping the whole frame.
    This mirrors the photographer: for a big/near subject take an upper-body
    crop (65% confidence), for a distant/small subject keep the full frame.
    """
    valid = [face for face in analysis if not face["truncated"]]
    if not valid:
        return {"zoom": False, "zeta": 0.0, "alpha_fidelity": 1.0,
                "kappa_compactness": 1.0, "min_scale": 0.75}
    lar = max(valid, key=lambda f: (f["bbox"][2] - f["bbox"][0]) * (f["bbox"][3] - f["bbox"][1]))
    lar_h = (lar["bbox"][3] - lar["bbox"][1]) / max(1, image_height)
    if lar_h >= threshold:
        return {"zoom": True, "zeta": 8.0, "alpha_fidelity": 0.9,
                "kappa_compactness": 1.25, "min_scale": 0.65}
    return {"zoom": False, "zeta": 0.0, "alpha_fidelity": 1.0,
            "kappa_compactness": 1.0, "min_scale": 0.75}


def decide_subjects(
    analysis: list[FaceAnalysis],
    dominance_gap: float = 0.25,
) -> dict:
    """
    Decide whether the scene has one dominant subject or a group.

    Returns:
        mode: "single" when one face clearly dominates, "group" otherwise,
              "none" when there are no valid faces.
    """

    valid = [face for face in analysis if not face["truncated"]]
    if not valid:
        return {"mode": "none", "faces": [], "dominant": None}

    ranked = sorted(valid, key=lambda face: face["score"], reverse=True)
    dominant = ranked[0]
    is_single = (
        len(ranked) == 1
        or dominant["score"] - ranked[1]["score"] >= dominance_gap
    )

    return {
        "mode": "single" if is_single else "group",
        "faces": ranked,
        "dominant": dominant,
    }
