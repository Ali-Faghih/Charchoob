"""Left/right margin balancing around the kept (green) frames.

Soft priority (not a hard rule): left & right margins around the kept
(green) frames should not be lopsided and frames should not hug the crop
edge.

  margin_left  = leftmost_kept_x1  - crop_left
  margin_right = crop_right        - rightmost_kept_x2

Note (user "tabse"):
  - `boxes`  = the reference frames actually fitted (may be the narrower
               Second Frame after substitution) -> used ONLY to validate
               that the crop never cuts a kept frame.
  - `margin_boxes` = the ACTUAL Person Frames (defaults to boxes) -> used
               to measure the left/right distance to the crop edge, so a
               second-substituted wide person still measures vs the wall.

Rule (from user):
  - If max(margin_left, margin_right) <= SMALL_DIFF (100): the difference is
    small -> equalize both margins to their average.
  - Else (big difference): only lift the smaller side up to MIN_PAD (50);
    the bigger side is left untouched.
  - Exception: if both sides already hug the edge, leave as is.

Implemented by re-sizing the window (zoom) and/or shifting so that both
margins equal (target_left, target_right). Never cuts a kept frame; never
pulls a forbidden (avoid) box inside.
"""


class MarginBalancer:
    """Balances margins by re-sizing (zoom) and/or shifting the window."""

    SMALL_DIFF = 100
    MIN_PAD = 50

    def __init__(self, image_w, image_h, aspect_ratio, max_w, max_h):
        self.image_w = image_w
        self.image_h = image_h
        self.aspect_ratio = aspect_ratio
        self.max_w = max_w
        self.max_h = max_h

    def balance(self, win, boxes, avoid, margin_boxes=None, force_sym=False,
                face_keep=None, min_face_pad=0, no_cut_faces=None):
        image_w, image_h = self.image_w, self.image_h
        aspect_ratio, max_w, max_h = self.aspect_ratio, self.max_w, self.max_h
        x1, y1, x2, y2 = win
        w = x2 - x1
        h = y2 - y1
        if not boxes:
            return win

        fx_min = min(b[0] for b in boxes)
        fx_max = max(b[2] for b in boxes)
        fy_min = min(b[1] for b in boxes)
        fy_max = max(b[3] for b in boxes)
        span = fx_max - fx_min

        mb = margin_boxes if margin_boxes else boxes
        mx_min = min(b[0] for b in mb)
        mx_max = max(b[2] for b in mb)
        mspan = mx_max - mx_min

        # GOLDEN RULE enforcement while balancing: every face (green +
        # yellow) must still be fully inside (with at least min_face_pad from
        # the wall) or fully outside -- never partially clipped.
        faces = [f for f in (face_keep or [])] if face_keep else []
        ncf = [f for f in (no_cut_faces or [])] if no_cut_faces else []

        def pbox(b, pad):
            return (b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad)

        def face_clip(cand):
            cx1, cy1, cx2, cy2 = cand
            for f in ncf:
                inside = (cx1 <= f[0] and cx2 >= f[2] and cy1 <= f[1] and cy2 >= f[3])
                outside = (cx2 <= f[0] or cx1 >= f[2] or cy2 <= f[1] or cy1 >= f[3])
                if not inside and not outside:
                    return True
            return False

        def valid(cand):
            cx1, cy1, cx2, cy2 = cand
            # top must not cut a kept frame; bottom may be cut (like the human
            # crop does for full-body people) as long as the person appears
            if cx1 > fx_min or cx2 < fx_max or cy1 > fy_min:
                return False
            # golden rule: enabled faces must stay fully inside (no pad clip)
            for f in faces:
                pf = pbox(f, min_face_pad)
                if cx1 > pf[0] or cx2 < pf[2] or cy1 > pf[1] or cy2 < pf[3]:
                    return False
            # golden rule: no face (incl. yellow/red) may be partially clipped
            if face_clip(cand):
                return False
            for a in avoid:
                if not (a[2] <= cx1 or a[0] >= cx2 or a[3] <= cy1 or a[1] >= cy2):
                    return False
            return True

        def placed(nw):
            """Build an aspect-ratio window of width nw so the margins are as
            close to (t_left, t_right) as possible, while kept ref frames stay
            fully inside. For force_sym the window is centered on the person
            span, which guarantees BOTH margins are identical."""
            nh = int(round(nw / aspect_ratio))
            if nh > max_h:
                nh = max_h
                nw = int(round(nh * aspect_ratio))
            # must fit both the ref span and the person margin span
            if nw < max(span, mspan):
                return None
            # vertical: the window must keep every kept REF frame
            # (fy_min..fy_max) fully inside vertically. Only the feet of a
            # full-body person are allowed to be cut (bend-adapted from the
            # human crop), so when the height is roomy we keep the top where
            # the caller placed it; when we zoom (shrink) we anchor so the
            # bottom still covers fy_max.
            max_top = min(y1, fy_min)  # can't push the window below the top ref
            if nh < (fy_max - 0):
                # shrink keeps the bottom hugging fy_max so refs stay inside
                ty1 = int(fy_max - nh)
            else:
                ty1 = y1
            ty1 = max(0, min(ty1, image_h - nh))
            if ty1 > fy_min or ty1 + nh < fy_max:
                return None
            if force_sym:
                # centered on the person span -> both margins are identical m
                center = (mx_min + mx_max) / 2.0
                m = (nw - mspan) / 2.0
                nx1 = int(round(center - nw / 2))
                # clamp may break equality near the image edges; reject if so
                if nx1 < 0 or nx1 > image_w - nw:
                    return None
                nx2 = nx1 + nw
                # actual margins must match (both == m within tolerance)
                ml_act = mx_min - nx1
                mr_act = nx2 - mx_max
                if abs(ml_act - mr_act) > max(2, round(m * 0.1)):
                    return None
            else:
                nx1 = mx_min - t_left
                nx1 = max(0, min(nx1, image_w - nw))
                nx2 = nx1 + nw
            if nx1 <= fx_min and nx2 >= fx_max and nx1 <= mx_min and nx2 >= mx_max:
                c = (nx1, ty1, nx2, ty1 + nh)
                if valid(c):
                    return c
            return None

        ml = mx_min - x1
        mr = x2 - mx_max
        if ml <= 0 or mr <= 0:
            return win  # would otherwise cut a kept frame; leave as is

        big = max(ml, mr)
        # decide target margins
        if force_sym:
            # multi-subject symmetry: always equalize both margins (bend 9/13)
            t_left = t_right = round((ml + mr) / 2.0)
        elif big <= self.SMALL_DIFF:
            t_left = t_right = round((ml + mr) / 2.0)
        else:
            t_left, t_right = ml, mr
            if ml < mr and ml < self.MIN_PAD:
                t_left = self.MIN_PAD
            elif mr < ml and mr < self.MIN_PAD:
                t_right = self.MIN_PAD

        if force_sym:
            # centered placement gives equal margins only when we can center
            # around the person span. The achievable margin is capped by the
            # near edge:
            #   left edge: nx1 = pmin - m >= 0  -> m <= pmin
            #   right edge: nx2 = pmax + m <= image_w -> m <= image_w - pmax
            # and by staying <= max_w. Prefer the widest window (least zoom).
            max_m = min((max_w - mspan) / 2.0, mx_min - 0, image_w - mx_max)
            max_m = max(0, int(max_m))
            # try from the largest margin downward until placement succeeds
            for m in range(max_m, -1, -20):
                nw = int(round(mspan + 2 * m))
                c = placed(nw)
                if c is not None:
                    return c
            return win

        # width needed so the fitted ref-frames sit with the target margins
        # (measured vs the actual person frames: mx_min/mx_max)
        want_w = mspan + t_left + t_right
        # but must stay wide enough to fit ref frames fully
        want_w = max(want_w, span)
        cand = placed(min(want_w, max_w))
        if cand is not None:
            return cand

        # fallback: try keeping the current width but shift to the targets
        nx1 = mx_min - t_left
        nx1 = max(0, min(nx1, image_w - w))
        c = (nx1, y1, nx1 + w, y2)
        if valid(c) and nx1 <= mx_min and c[2] >= mx_max:
            return c

        return win
