"""Box geometry - pure functions, no state.

Central object: Subject (a kept green person) with face/person/second/head boxes.
Frame builders live in frames.py.
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
    head: tuple = None
    score: float = None  # editorial importance (size+centrality+confidence)


def as_subject(s):
    """Accept a Subject or a legacy {"face","person","second"} dict."""
    if isinstance(s, Subject):
        return s
    return Subject(face=s["face"], person=s["person"],
                   second=s.get("second"), head=s.get("head"),
                   score=s.get("score"))


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


# Frame builders (person/scene/head + owner matching) moved to frames.py.
def top_face_height(frames):
    """Height of the top-most (smallest y1) frame."""
    if not frames:
        return 0.0
    top = min(frames, key=lambda f: f[1])
    return float(top[3] - top[1])


def least_important_index(subjects):
    """Index of the least-important subject: weakest editorial score first
    (the same score that decides main vs secondary); smallest face area as
    the fallback when scores are missing, i.e. perspective => farthest."""
    if subjects and all(getattr(s, "score", None) is not None
                        for s in subjects):
        return min(range(len(subjects)), key=lambda i: subjects[i].score)
    return min(
        range(len(subjects)),
        key=lambda i: (subjects[i].face[2] - subjects[i].face[0])
        * (subjects[i].face[3] - subjects[i].face[1]),
    )
