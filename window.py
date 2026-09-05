"""Aspect-ratio window fitting: collect hard-valid candidates, balance each,
rank, return the best.

Hard constraints (checked before ranking):
  * `boxes`   -- the reference frames being fitted, all kept fully inside.
  * `face_keep` -- every GREEN face box that must stay fully inside (the
                   golden rule). When `min_face_pad>0` faces keep at least
                   this many px from the wall.
  * `no_cut_faces` -- every face (green + yellow/red) that must never be
                   PARTIALLY clipped: each is either fully inside or fully
                   outside the window. A half-cut face invalidates a window.
`avoid` is the flat list of yellow/red PERSON boxes that should stay out
where possible (a green-only window is preferred, else a green+ window).

Instead of returning the first valid window, a LIMITED number of valid
candidates are collected and the best one (by soft ranking) is returned.
"""
from geometry import fit_ratio_window, top_face_height
from margins import MarginBalancer
from ranking import CropRanker


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
            no_cut_faces=None):
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
                no_cut_faces=ncf)
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
