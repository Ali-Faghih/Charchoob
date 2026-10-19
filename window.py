"""Crop window selection: search + margin balancing + ranking (one cohesive module).

Three stages, run in this order for every candidate:
    1) WindowFitter   : collect valid candidates (hard-inside boxes, no half cuts)
    2) MarginBalancer : balance the left/right margins (hard equalisation via force_sym)
    3) CropRanker     : soft scoring and pick the best one (lowest score wins)
"""
from geometry import fit_ratio_window, top_face_height


# --------------------------------------------------- 1) search --------
class WindowFitter:
    """Fits an aspect window around hard boxes for one image."""

    MAX_TOTAL = 14  # cap collected candidates (soft ranking, not brute force)

    def __init__(self, image_w, image_h, aspect_ratio,
                 balancer=None, ranker=None):
        self.image_w = image_w
        self.image_h = image_h
        self.aspect_ratio = aspect_ratio
        max_w, max_h = fit_ratio_window(image_w, image_h, aspect_ratio)
        self.max_w = max_w
        self.max_h = max_h
        self.balancer = balancer or MarginBalancer(
            image_w, image_h, aspect_ratio, max_w, max_h)
        self.ranker = ranker or CropRanker()

    def fit(self, boxes, avoid, single, multi_sym, scales, zoom_floor,
            margin_boxes=None, face_keep=None, min_face_pad=0,
            no_cut_faces=None, red_faces=None):
        """Try, for each scale, to place an aspect-ratio window so that every
        box is fully inside AND no 'avoid' box is inside when a window without
        them exists. Returns the best crop or None."""
        image_w, image_h = self.image_w, self.image_h
        aspect_ratio, max_w, max_h = self.aspect_ratio, self.max_w, self.max_h
        if not boxes:
            return None

        avoid = [b for b in (avoid or [])]
        faces = [f for f in (face_keep or [])] if face_keep else []
        ncf = [f for f in (no_cut_faces or [])] if no_cut_faces else []
        reds = [f for f in (red_faces or [])] if red_faces else []

        # Effective hard span is the union of refs and green faces (with pad).
        def pbox(b, pad):
            return (b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad)

        full_hard = list(boxes)
        if faces:
            full_hard += [pbox(f, min_face_pad) for f in faces]
        fx_min = min(b[0] for b in full_hard)
        fx_max = max(b[2] for b in full_hard)
        fy_min = min(b[1] for b in full_hard)
        fy_max = max(b[3] for b in full_hard)

        span = fx_max - fx_min

        # Bend 10: desired headroom is based on the TOPMOST GREEN FACE (not
        # the ref/body frame which can be much taller).
        _face_boxes = faces if faces else boxes
        top_face_h = top_face_height(_face_boxes)
        desired_head = 0.5 * top_face_h

        # A window is invalid if it PARTIALLY clips any face (green or yellow).
        def face_clip(wx1, wy1, wx2, wy2):
            for f in ncf:
                fx1, fy1, fx2, fy2 = f
                inside = (wx1 <= fx1 and wx2 >= fx2 and wy1 <= fy1 and wy2 >= fy2)
                outside = (wx2 <= fx1 or wx1 >= fx2 or wy2 <= fy1 or wy1 >= fy2)
                if not inside and not outside:
                    return True
            return False

        # limited candidate collection: stop scanning early once we have
        # enough valid candidates (soft ranking, not brute force).
        found_green = []
        found_any = []

        def avoids(wx1, wy1, wx2, wy2):
            for a in avoid:
                if not (a[2] <= wx1 or a[0] >= wx2 or a[3] <= wy1 or a[1] >= wy2):
                    return True
            return False

        for scale in scales:
            w = int(round(max_w * scale))
            h = int(round(w / aspect_ratio))
            if h > max_h:
                h = max_h
                w = int(round(h * aspect_ratio))
            if scale < zoom_floor:
                break
            if w < span:
                continue

            # ---- vertical: window must hold all hard boxes; headroom ----
            top_low = int(fy_max) - h          # top edge can't be below this
            top_high = int(fy_min)             # top edge can't be above this
            if top_low > top_high:
                continue
            top = int(fy_min - desired_head)
            top = min(max(top, top_low), top_high)
            top = min(max(top, 0), image_h - h)
            bottom = top + h
            if top > fy_min or bottom < fy_max:
                continue

            # ---- horizontal: center, then slide to avoid yellow/red ----
            center = (fx_min + fx_max) / 2.0
            rx1 = int(round(center - w / 2))

            def aligns(sx1):
                # symmetry / photographer-side adjustments
                if not single and multi_sym:
                    shift = int(round(((fx_min - sx1) - (sx1 + w - fx_max)) / 2.0))
                    sx1 += shift
                elif single:
                    sx1 -= int(round(center - (center / image_w) * w))
                return sx1

            candidates = [aligns(rx1)]
            # image-center candidate: when the subject span is off-center, the
            # span-centered crop may never explore the true image center.
            img_center_rx1 = int(round((image_w - w) / 2.0))
            if img_center_rx1 != candidates[0]:
                candidates.append(img_center_rx1)
            # extra slide candidates to find a green-only window
            for slide in range(-int(w * 0.3), int(w * 0.3) + 1, 6):
                candidates.append(rx1 + slide)

            for sx1 in candidates:
                sx1 = max(0, min(sx1, image_w - w))
                sx2 = sx1 + w
                if not (sx1 <= fx_min and sx2 >= fx_max):
                    continue
                if face_clip(sx1, top, sx2, bottom):
                    continue
                # red faces stay fully outside: any overlap kills the window.
                if any(not (sx2 <= r[0] or sx1 >= r[2]
                            or bottom <= r[1] or top >= r[3]) for r in reds):
                    continue
                if avoids(sx1, top, sx2, bottom):
                    # bend 6: a GREEN-ONLY window is preferred, but when none
                    # exists a green+ (yellow/red containing) window is still
                    # usable. Collect these separately so we only fall back to
                    # them if NO green-only candidate exists.
                    if len(found_any) < self.MAX_TOTAL:
                        found_any.append((sx1, top, sx2, bottom))
                    continue
                found_green.append((sx1, top, sx2, bottom))
                if len(found_green) >= self.MAX_TOTAL:
                    break
            if len(found_green) >= self.MAX_TOTAL:
                break

        found = found_green if found_green else found_any
        if not found:
            return None

        # hard-valid candidates collected -> run each through the balancer
        # (it may re-zoom/shift for margins), then pick the best by ranking.
        mb = margin_boxes if margin_boxes else boxes
        mx_min = min(b[0] for b in mb)
        mx_max = max(b[2] for b in mb)
        MIN_PAD = 50
        ideal = MIN_PAD
        best = None
        for win in found:
            balanced = self.balancer.balance(
                win, boxes, avoid,
                margin_boxes=margin_boxes,
                force_sym=multi_sym,
                face_keep=faces, min_face_pad=min_face_pad,
                no_cut_faces=ncf, red_faces=reds)
            bbx1, bby1, bbx2, bby2 = balanced
            # measure margins from the actual person frames (if given)
            if mb:
                ml = mx_min - bbx1
                mr = bbx2 - mx_max
            else:
                ml = min(b[0] for b in boxes) - bbx1
                mr = bbx2 - max(b[2] for b in boxes)
            # count yellow/red that ended up inside the balanced crop
            def collides(bb):
                return not (bb[2] <= bbx1 or bb[0] >= bbx2 or bb[3] <= bby1 or bb[1] >= bby2)
            ah = sum(1 for a in avoid if collides(a))
            scale_now = (bbx2 - bbx1) / float(max_w) if max_w else 1.0
            # Bend 10: measure headroom from the topmost GREEN FACE, not from
            # the topmost ref/body box which can be much higher.
            if faces:
                top_margin = min(f[1] for f in faces) - bby1
            else:
                top_margin = min(b[1] for b in boxes) - bby1
            rec = self.ranker.make_rec(
                balanced, scale_now, ah, ml, mr, ideal, multi_sym,
                desired_head, top_margin,
                abs((bbx1 + bbx2) / 2.0 - image_w / 2.0) / float(image_w),
                single)
            sc = self.ranker.score(rec)
            if best is None or sc < best[0]:
                best = (sc, balanced, rec)
        if best is None:
            return None
        return best[1]


# ------------------------------------------------- 2) margin balancing --------
class MarginBalancer:
    """Balances margins by re-sizing (zoom) and/or shifting the window.

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
      - If max(margin_left, margin_right) <= SMALL_DIFF (100): the difference
        is small -> equalize both margins to their average.
      - Else (big difference): only lift the smaller side up to MIN_PAD (50);
        the bigger side is left untouched.
      - Exception: if both sides already hug the edge, leave as is.

    Implemented by re-sizing the window (zoom) and/or shifting so that both
    margins equal (target_left, target_right). Never cuts a kept frame; never
    pulls a forbidden (avoid) box inside.
    """

    SMALL_DIFF = 100
    MIN_PAD = 50

    def __init__(self, image_w, image_h, aspect_ratio, max_w, max_h):
        self.image_w = image_w
        self.image_h = image_h
        self.aspect_ratio = aspect_ratio
        self.max_w = max_w
        self.max_h = max_h

    def balance(self, win, boxes, avoid, margin_boxes=None, force_sym=False,
                face_keep=None, min_face_pad=0, no_cut_faces=None,
                red_faces=None):
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
        reds = [f for f in (red_faces or [])] if red_faces else []

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
            for r in reds:  # red faces stay fully outside
                if not (r[2] <= cx1 or r[0] >= cx2 or r[3] <= cy1 or r[1] >= cy2):
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


# -------------------------------------------------- 3) ranking --------
class CropRanker:
    """Scores one validated crop candidate (O(1), cheap).

    Lower score is better. Hard constraints are enforced BEFORE ranking, so
    here valid candidates are only ordered by soft requirements: no
    yellow/red inside, fidelity (largest scale), margin quality + symmetry,
    image-center tie-break, headroom.
    """

    AVOID_HIT = 10.0    # (9) strongest soft signal: no yellow/red inside
    FIDELITY = 4.0      # (4) closest (largest) scale wins; avoid dominates
    HEADROOM = 2.0      # (8, 10) penalty when headroom is violated
    CENTER = 0.3        # image-center preference: tie-breaker only, never
                        # overrides scale fidelity, avoid, headroom, symmetry

    def make_rec(self, box, scale, avoid_hits, ml, mr, ideal_margin,
                 multi_sym, desired_head, top_margin,
                 center_dist=0.0, single=False):
        return {
            "box": box,
            "scale": scale,
            "avoid_hits": avoid_hits,
            "ml": ml,
            "mr": mr,
            "ideal_margin": ideal_margin,
            "multi_sym": multi_sym,
            "desired_head": desired_head,
            "top_margin": top_margin,
            "center_dist": center_dist,
            "single": single,
        }

    def score(self, rec):
        s = 0.0
        # (9) strongest soft signal: prefer a crop with NO yellow/red inside.
        if rec["avoid_hits"] > 0:
            s += self.AVOID_HIT * rec["avoid_hits"]
        # (4) fidelity to the original framing: the closest (largest) scale
        # wins. Normalized so avoid penalty dominates.
        s += (1.0 - rec["scale"]) * self.FIDELITY
        # (7, 8) margin quality: penalize margins that hug the edge relative
        # to the ideal padding, and asymmetry when symmetry wanted.
        ml, mr = rec["ml"], rec["mr"]
        ideal = rec["ideal_margin"]
        small = min(ml, mr)
        if small < ideal:
            s += (ideal - small) / 100.0
        if rec["multi_sym"]:
            s += abs(ml - mr) / 100.0
        # (image-center) soft preference for the INITIAL frame: among
        # otherwise-equal valid crops the one centered on the IMAGE wins over
        # one hugging the left/right edge. Later stages (_balance_margins,
        # headroom shift) may still move the crop afterwards. Fidelity to the
        # photographer's frame means cropping equally from both sides.
        s += rec.get("center_dist", 0.0) * self.CENTER
        # (8, 10) subject/face keep a reasonable headroom from the top edge
        # and the faces stay reasonably large (scale proxies size).
        if rec["desired_head"] is not None and rec["top_margin"] < rec["desired_head"]:
            s += self.HEADROOM
        return s
