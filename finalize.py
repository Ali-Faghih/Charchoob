"""Final frame tuning: once the cascade returns its winner, these last two steps run:
    1) headroom above the head (if it is short, the frame keeps its size and only moves up)
    2) if no level fits, the largest possible window
"""
from geometry import fit_ratio_window


def largest_window(image_w, image_h, aspect_ratio):
    """The largest window with the requested ratio that fits in the image (last resort)."""
    max_w, max_h = fit_ratio_window(image_w, image_h, aspect_ratio)
    return (0, 0, max_w, max_h)


def apply_headroom(crop, image_w, image_h, keep_faces, no_cut_faces,
                   avoid_persons, red_faces=None):
    """Fix the head margin (final step): if the space above the topmost green face is less
    than half that face height, the frame moves straight up at the same size.
    Guardrails: no green face leaves the frame, no face is cut in half, and no new red/yellow
    person enters. It never zooms and never changes the width.
    """
    cx1, cy1, cx2, cy2 = crop
    ch = cy2 - cy1
    if not keep_faces:
        return crop
    top_face = min(keep_faces, key=lambda f: f[1])
    tf_y1, tf_y2 = top_face[1], top_face[3]
    desired = 0.5 * (tf_y2 - tf_y1)
    have = tf_y1 - cy1
    if have >= desired - 0.5:
        return crop
    need = int(round(desired - have))
    max_shift = min(need, cy1)  # never shift past the top of the image
    # faces flagged keep (green) that are already inside must stay inside
    for f in keep_faces:
        if cx1 <= f[0] and cx2 >= f[2] and cy1 <= f[1] and cy2 >= f[3]:
            max_shift = min(max_shift, cy2 - f[3])
    if max_shift <= 0:
        return crop
    shift = max_shift
    while shift > 0:
        ny1 = cy1 - shift
        ny2 = ny1 + ch
        ok = True
        for f in keep_faces:  # keep-faces must end up fully inside
            if not (cx1 <= f[0] and cx2 >= f[2] and ny1 <= f[1] and ny2 >= f[3]):
                ok = False
                break
        if ok:
            for f in no_cut_faces:  # golden rule: never cut a face in half
                inside = (cx1 <= f[0] and cx2 >= f[2] and ny1 <= f[1] and ny2 >= f[3])
                outside = (cx2 <= f[0] or cx1 >= f[2] or ny2 <= f[1] or ny1 >= f[3])
                if not inside and not outside:
                    ok = False
                    break
        if ok:
            for a in avoid_persons:  # red/yellow faces must not newly enter the crop
                was_out = (a[2] <= cx1 or a[0] >= cx2 or a[3] <= cy1 or a[1] >= cy2)
                now_hit = not (a[2] <= cx1 or a[0] >= cx2 or a[3] <= ny1 or a[1] >= ny2)
                if was_out and now_hit:
                    ok = False
                    break
        if ok:
            for f in (red_faces or []):  # red faces must stay fully outside
                now_hit = not (cx2 <= f[0] or cx1 >= f[2]
                               or ny2 <= f[1] or ny1 >= f[3])
                if now_hit:
                    ok = False
                    break
        if ok:
            return (cx1, ny1, cx2, ny2)
        shift -= 5 if shift > 5 else 1
    return crop
