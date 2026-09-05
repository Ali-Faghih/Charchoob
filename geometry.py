"""Box geometry for the crop engine — pure functions, no state.

Central data object: Subject (green kept person) with face / person / second
boxes as (x1, y1, x2, y2) tuples in image pixels.
"""
from dataclasses import dataclass

#: PersonWidth above this multiple of its SecondWidth -> Second is legitimate.
SECOND_SUBSTITUTION_RATIO = 1.5


@dataclass
class Subject:
    """One kept (green) subject driving the crop."""
    face: tuple
    person: tuple
    second: tuple = None


def as_subject(s):
    """Accept a Subject or a legacy {"face","person","second"} dict."""
    if isinstance(s, Subject):
        return s
    return Subject(face=s["face"], person=s["person"], second=s.get("second"))


def clamp_box(b, image_w, image_h):
    """Clamp a box to the image frame (None stays None)."""
    if b is None:
        return None
    return (max(0, b[0]), max(0, b[1]), min(image_w, b[2]), min(image_h, b[3]))


def fit_ratio_window(width, height, aspect_ratio):
    """Largest (width, height) window of the given ratio that fits in the frame."""
    if width / height >= aspect_ratio:
        return (int(round(aspect_ratio * height)), height)
    return (width, int(round(width / aspect_ratio)))


def second_frame_for(face_bbox, person_bbox, image_w):
    """Build a Second Frame from a Person Frame.

    Only the horizontal extent changes: the box is shrunk from the side that
    has more distance so that the FACE lands exactly in the center. Height is
    kept identical to the Person Frame.
    """
    fx1, fy1, fx2, fy2 = face_bbox
    px1, py1, px2, py2 = person_bbox
    fc = (fx1 + fx2) / 2.0
    # horizontal room on each side of the face inside the person box
    left = fc - px1
    right = px2 - fc
    half = min(left, right)
    # keep both sides symmetric around the face center, clamped to person
    sx1 = max(px1, fc - half)
    sx2 = min(px2, fc + half)
    if sx2 - sx1 < 2:
        sx1, sx2 = px1, px2
    return (int(round(sx1)), int(round(py1)), int(round(sx2)), int(round(py2)))


def person_box_for_face(bbox, image_w, image_h):
    """Estimated person region when no body box exists (head + torso)."""
    x1, y1, x2, y2 = bbox
    fw = max(1.0, x2 - x1)
    fh = max(1.0, y2 - y1)
    return (
        max(0, int(x1 - 0.3 * fw)),
        max(0, int(y1 - 0.4 * fh)),
        min(image_w, int(x2 + 0.3 * fw)),
        min(image_h, int(y1 + 4.2 * fh)),
    )


def ref_frame_of(subject, level, image_w, image_h):
    """Reference frame of a subject by level.

    level "full" -> Person (or legitimate Second per 1.5x rule).
    level "face" -> only the face box (level 2: keep just the head).
    """
    if level == "face":
        return clamp_box(subject.face, image_w, image_h)
    person = clamp_box(subject.person, image_w, image_h)
    second = clamp_box(subject.second, image_w, image_h)
    if second is not None:
        p_w = person[2] - person[0]
        s_w = second[2] - second[0]
        if s_w >= 2 and p_w > SECOND_SUBSTITUTION_RATIO * s_w:
            return second
    return person


def top_face_height(frames):
    """Height of the top-most (smallest y1) frame."""
    if not frames:
        return 0.0
    top = min(frames, key=lambda f: f[1])
    return float(top[3] - top[1])


def least_important_index(subjects):
    """Index of the least-important green (bend 11): smallest face area, i.e.
    perspective => farthest from camera."""
    return min(
        range(len(subjects)),
        key=lambda i: (subjects[i].face[2] - subjects[i].face[0])
        * (subjects[i].face[3] - subjects[i].face[1]),
    )


def similar_faces(subjects):
    """Bend 9+13: faces have comparable size -> a multi-person group /
    front-row (photographer stood facing them). Ratio smallest/largest >= 0.6.
    """
    sizes = [
        max(1.0, (s.face[2] - s.face[0]) * (s.face[3] - s.face[1]))
        for s in subjects
    ]
    lo, hi = min(sizes), max(sizes)
    return (lo / hi) >= 0.6
