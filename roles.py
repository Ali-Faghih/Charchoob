"""Initial priority: MAIN (green) / SECONDARY (yellow) / INVALID (red).

Classification is face-driven because a pose body box gets jumbled in crowds, and
the merged group box must not wipe out the real people inside it.

Rules (in priority order):
    1. A face cut by the image border -> red
    2. A body that is genuinely a lone border-to-border crop -> red, unless removing it
          would leave fewer than MIN_SURVIVORS subjects (a small scene stays whole).
          A crowd-merged box (>= CROWD_FACES faces inside) is not a real crop; only a face
          that is itself glued to the edge becomes red.
    3. The rest by relative face score: main / secondary
          (score >= MAIN_RATIO * top score -> green)
A face without a matched body is still a subject (estimated box).
"""
import config

MAIN_RATIO = 0.6   # fraction of the top face score to be a "main" person
CROWD_FACES = 3    # >= this many faces in one box => merged crowd box, not a person


def face_near_cut_edge(face, body, image_w, image_h, margin):
    fx1, fy1, fx2, fy2 = face
    bx1, by1, bx2, by2 = body["bbox"]
    tol = max(2, config.EDGE_TOLERANCE * min(image_w, image_h))

    if bx1 <= tol and fx1 <= tol + margin:
        return True
    if bx2 >= image_w - tol and fx2 >= image_w - tol - margin:
        return True
    if by1 <= tol and fy1 <= tol + margin:
        return True
    return False


class RoleClassifier:
    """Assigns an editorial role per face index."""

    def __init__(self, main_ratio=MAIN_RATIO, crowd_faces=CROWD_FACES):
        self.main_ratio = main_ratio
        self.crowd_faces = crowd_faces

    def classify(self, faces, bodies, pairs, analysis, image_w, image_h):
        """Return role per FACE index plus the body index it pairs to."""
        body_idx_of_face = dict(pairs)
        faces_of_body = {}
        for fi, bi in pairs:
            faces_of_body.setdefault(bi, []).append(fi)
        tolerance = max(2, config.EDGE_TOLERANCE * min(image_w, image_h))
        margin = 3 * tolerance
        max_score = max((f["score"] for f in analysis), default=0.0)

        # REAL edge-cuts: a single-person body box that touches the frame edge
        # (a crowd-merged box spanning many faces is NOT a real cut).
        valid_total = sum(1 for f in analysis if not f["truncated"])
        candidates = [
            fi for fi, face in enumerate(analysis)
            if not face["truncated"]
            and body_idx_of_face.get(fi) is not None
            and bodies[body_idx_of_face[fi]]["truncated"]
            and len(faces_of_body.get(body_idx_of_face[fi], [])) < self.crowd_faces
        ]
        # Keep them when killing them would leave too few subjects.
        keep_candidates = (valid_total - len(candidates)) < config.MIN_SURVIVORS

        roles = {}
        for fi, face in enumerate(analysis):
            if face["truncated"]:
                roles[fi] = "invalid"
                continue
            bi = body_idx_of_face.get(fi)
            if bi is not None and bodies[bi]["truncated"]:
                n_in = len(faces_of_body.get(bi, []))
                if n_in < self.crowd_faces:
                    # real edge-cut person: forbidden unless it would empty the scene
                    if not keep_candidates:
                        roles[fi] = "invalid"
                        continue
                else:
                    # crowd merge: only kill a face that itself hugs the cut edge
                    if face_near_cut_edge(
                        face["bbox"], bodies[bi], image_w, image_h, margin
                    ):
                        roles[fi] = "invalid"
                        continue
            ratio = face["score"] / max_score if max_score > 0 else 1.0
            roles[fi] = "main" if ratio >= self.main_ratio else "secondary"
        return roles, body_idx_of_face


def classify_subjects(faces, bodies, pairs, analysis, image_w, image_h):
    """Backward-compatible entry point (default thresholds)."""
    return RoleClassifier().classify(
        faces, bodies, pairs, analysis, image_w, image_h
    )
