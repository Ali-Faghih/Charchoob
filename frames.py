"""Frame builders: face / person / second / head (+ owner matching).

Every subject has four boxes (all in image pixels):
    1) face   : comes from the face detector (not built here, it is an input)
    2) person : full body (from pose, or estimated around the face)
    3) second : same height as person, but symmetric about the centre (head first, else face)
    4) head   : bottom=chin, top=person top, left/right=segment tangents of that person
"""
import numpy as np

from geometry import clamp_box


# ------------------------------------------------------- 2) person -------
def person_box_for_face(bbox, image_w, image_h):
    """Estimate the body region when there is no pose box (head + torso)."""
    x1, y1, x2, y2 = bbox
    fw = max(1.0, x2 - x1)
    fh = max(1.0, y2 - y1)
    return (
        max(0, int(x1 - 0.3 * fw)),
        max(0, int(y1 - 0.4 * fh)),
        min(image_w, int(x2 + 0.3 * fw)),
        min(image_h, int(y1 + 4.2 * fh)),
    )


# ------------------------------------------------------- 3) second -------
def second_frame_for(face_bbox, person_bbox, image_w, head_bbox=None):
    """Second frame: only the width changes so the centre (head, else face) sits
    exactly in the middle; the height stays identical to the person."""
    center_bbox = head_bbox if head_bbox is not None else face_bbox
    cx1, _, cx2, _ = center_bbox
    px1, py1, px2, py2 = person_bbox
    fc = (cx1 + cx2) / 2.0
    # slack on both sides of the centre inside the person box; the tighter side is the base
    left = fc - px1
    right = px2 - fc
    half = min(left, right)
    # both sides symmetric about the centre, clipped to the person box
    sx1 = max(px1, fc - half)
    sx2 = min(px2, fc + half)
    if sx2 - sx1 < 2:
        sx1, sx2 = px1, px2
    return (int(round(sx1)), int(round(py1)), int(round(sx2)), int(round(py2)))


# ------------------------------------------------- segment owner match ------
def owner_mask_index(face_center, seg_masks):
    """Face owner: the smallest mask containing the face centre (tells people apart).
    Input: list of binary masks (h, w) with 255=body. Output: index or None.
    """
    fx, fy = int(face_center[0]), int(face_center[1])
    owner, owner_area = None, None
    for j, m in enumerate(seg_masks):
        if not (0 <= fy < m.shape[0] and 0 <= fx < m.shape[1]):
            continue
        if m[fy, fx] == 0:
            continue
        area = int((m > 0).sum())
        if owner is None or area < owner_area:
            owner, owner_area = j, area
    return owner


# ---------------------------------------------------------- 4) head --------
def head_box_for(face_bbox, person_bbox, owner_mask, image_w, image_h):
    """Head box using the pure tangent rule: bottom=chin, top=person top;
    left/right = leftmost/rightmost segment point of that person scanning bottom to top.
    Without an owner -> the same horizontal span as the face.
    """
    fx1, _fy1, fx2, fy2 = [int(v) for v in face_bbox]
    _px1, py1, _px2, _py2 = [int(v) for v in person_bbox]
    top, bottom = py1, fy2
    hb = None
    if owner_mask is not None and bottom > top:
        lx, rx = None, None
        for y in range(bottom - 1, top - 1, -1):
            xs = np.where(owner_mask[y, :] > 0)[0]
            if len(xs) == 0:
                continue
            vmin, vmax = int(xs.min()), int(xs.max())
            lx = vmin if lx is None else min(lx, vmin)
            rx = vmax if rx is None else max(rx, vmax)
        if lx is not None:
            hb = (lx, top, rx, bottom)
    if hb is None:  # no owner or no row -> fall back to the face span
        hb = (fx1, top, fx2, bottom)
    return clamp_box(hb, image_w, image_h)
