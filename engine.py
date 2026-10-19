"""Crop engine: the recursive cascade (L1 / L1.5 / L2 + demotion loop).

Pattern per round (first succeeding level wins):
  L1   : every kept green's full frame fully inside -- Persons for ALL,
         or Seconds for ALL when EVERY green's person is wider than 1.5x
         its second (never mixed across the photo) -- with EQUAL
         left/right margins of the outer frames.
  L1.5 : same check with every green's Second Frame (head-centered).
  L2   : same check with every green's HEAD frame.
  L2.5 : faces fully inside; HEAD frames may stick out but SYMMETRICALLY
         (equal cut left/right) and no head keeps less than half its area.
  Then: the weakest kept subject (lowest editorial score) is demoted
  GREEN -> YELLOW
  (face+second stay hard inside, body released) and the round restarts from
  L1; a yellow that still blocks is demoted YELLOW -> RED (fully out) and
  the round restarts again. Demotion + zoom guarantee termination.

Rules applied:
  4   : keep as close as possible to the original frame (max-scale first).
  5   : every GREEN/YELLOW reference frame stays fully inside the crop.
  7   : single subject, frontal -> preserve the photographer's side
        placement (left / center / right) instead of center-pulling.
  10  : top margin (> top face) must exceed 0.5 x that face's height
        (enforced as the LAST step: shift the crop straight up).

`avoid` = list of boxes (red/yellow persons) that should stay OUT of the
crop where possible: a window without them is preferred; a window
containing them is only used when no clean window exists.
"""
from finalize import apply_headroom, largest_window
from geometry import (
    SECOND_SUBSTITUTION_RATIO,
    as_subject,
    clamp_box,
    fit_ratio_window,
    least_important_index,
)
from window import WindowFitter


class CropEngine:
    """Runs the level cascade for one image + subject set."""

    MIN_FACE_PAD = 20
    SCALES = (1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6)

    def __init__(self, image_w, image_h, aspect_ratio, subjects, avoid=None,
                 fitter=None):
        if aspect_ratio <= 0:
            raise ValueError(f"Invalid aspect ratio: {aspect_ratio!r}")
        self.image_w = image_w
        self.image_h = image_h
        self.aspect_ratio = aspect_ratio
        self.subjects = [as_subject(s) for s in subjects]
        self.max_w, self.max_h = fit_ratio_window(
            image_w, image_h, aspect_ratio)

        av_objs = [a for a in (avoid or [])]
        # normalize each avoid entry to {"person","face"}; a face-only
        # entry (slot-loser face: protected from half-cuts, drives
        # nothing) carries person=None so it never counts as prefer-out.
        ys = []
        for a in av_objs:
            if isinstance(a, dict):
                ys.append({"person": self.box(a.get("person")),
                           "face": self.box(a.get("face", a.get("person"))),
                           "role": a.get("role")})
            else:
                b = self.box(a)
                ys.append({"person": b, "face": b, "role": None})
        self.avoid_persons = [y["person"] for y in ys
                              if y["person"] is not None]
        self.avoid_faces = [y["face"] for y in ys
                            if y["face"] is not None]
        # red faces stay fully OUTSIDE the crop (initial invalids; demoted
        # reds join at runtime via _red_out).
        self.red_faces = [y["face"] for y in ys
                          if y.get("role") == "invalid"
                          and y["face"] is not None]

        self.single = len(self.subjects) == 1

        # Golden rule: no face (green/yellow/red) is ever cut in half; every
        # face is either fully inside or fully outside. Green/yellow are always inside.
        # Demotion state (recursive loop): greens live in self.subjects; yellow: face+second
        # hard inside while the body is free; red: fully outside (preferably).
        self.yellows = []
        self.reds = []

        # bend 12: persons far too small -> zoom in (bias toward tiny scale)
        sizes = [max(1.0, (s.face[3] - s.face[1])) for s in self.subjects]
        if sizes:
            avg_h = (min(sizes) + max(sizes)) / 2.0
            zoom_too_small = avg_h / image_h < 0.05   # ~ 5% => zoom in
        else:
            zoom_too_small = False
        self.scales = self.SCALES
        self.zoom_floor = 0.6 if not zoom_too_small else 0.85

        self.fitter = fitter or WindowFitter(image_w, image_h, aspect_ratio)

    # -- helpers ------------------------------------------------------
    def box(self, b):
        return clamp_box(b, self.image_w, self.image_h)

    def head_of(self, subject):
        """HEAD frame of a subject (face box when no head was built)."""
        if subject.head is not None:
            return self.box(subject.head)
        return self.box(subject.face)

    def _triggers_second(self, subject):
        """True when this green's person is wider than 1.5x its second."""
        if subject.second is None:
            return False
        p_w = subject.person[2] - subject.person[0]
        s_w = subject.second[2] - subject.second[0]
        return s_w >= 2 and p_w > SECOND_SUBSTITUTION_RATIO * s_w

    def _full_refs(self):
        """L1 frames, all-or-nothing: seconds for ALL greens only when EVERY
        green triggers the 1.5x rule; otherwise persons for ALL (a lone
        substituted subject must never mix frame types across the photo)."""
        if self.subjects and all(self._triggers_second(s)
                                 for s in self.subjects):
            return [self.second_of(s) for s in self.subjects]
        return [self.box(s.person) for s in self.subjects]

    def second_of(self, subject):
        """Second frame, falling back to the person box when missing."""
        return self.box(subject.second) or self.box(subject.person)

    def _state_sets(self):
        """Hard/avoid sets for the current green/yellow/red state.

        Greens carry the level frames; yellows always carry face+second
        hard (body released to prefer-out); reds are prefer-out entirely.
        """
        green_faces = [self.box(s.face) for s in self.subjects]
        yellow_faces = [self.box(s.face) for s in self.yellows]
        yellow_seconds = [self.second_of(s) for s in self.yellows]
        yellow_persons = [self.box(s.person) for s in self.yellows]
        red_persons = [self.box(s.person) for s in self.reds]
        red_faces = [self.box(s.face) for s in self.reds]
        keep_faces = green_faces + yellow_faces
        avoid = self.avoid_persons + yellow_persons + red_persons
        no_cut = keep_faces + red_faces + self.avoid_faces
        return keep_faces, avoid, no_cut, yellow_seconds

    def _red_out(self):
        """Faces that must stay fully outside the crop: initial invalids
        plus fully-demoted reds."""
        return self.red_faces + [self.box(s.face) for s in self.reds]

    def _attempt(self, level):
        """One fit attempt at level 'full' | 'second' | 'head' over the
        current demotion state. Equal left/right margins for every
        multi-subject scene (single keeps the photographer side).
        Returns the best crop or None."""
        keep_faces, avoid, no_cut, yellow_seconds = self._state_sets()
        if level == "full":
            refs = self._full_refs()
            mb = [self.box(s.person) for s in self.subjects]
        elif level == "second":
            refs = [self.second_of(s) for s in self.subjects]
            mb = [self.second_of(s) for s in self.subjects]
        else:  # head
            refs = [self.head_of(s) for s in self.subjects]
            mb = [self.head_of(s) for s in self.subjects]
        if not self.subjects and not self.yellows:
            return None
        hard = keep_faces + refs + yellow_seconds
        single_win = (len(self.subjects) + len(self.yellows) == 1)
        return self.fitter.fit(
            hard, avoid, single_win, not single_win, self.scales,
            self.zoom_floor, margin_boxes=mb + yellow_seconds,
            face_keep=keep_faces, min_face_pad=self.MIN_FACE_PAD,
            no_cut_faces=no_cut, red_faces=self._red_out())

    # -- levels ----------------------------------------------------------
    def level1_full_bodies(self):
        """Level 1: full frames of all greens fully inside."""
        return self._attempt("full")

    def level1b_all_seconds(self):
        """Level 1.5: retry with the second frame of all greens (narrower; often the one
        that fits where the body does not). Returns None when identical to L1."""
        seconds = [self.second_of(s) for s in self.subjects]
        if seconds == self._full_refs():
            return None
        return self._attempt("second")

    def level2_heads(self):
        """Level 2: heads of all greens fully inside."""
        return self._attempt("head")

    def level25_face_cut(self):
        """Level 2.5: faces fully inside; heads may stick out but must stay symmetric
        (left cut == right cut, 1px tolerance) and no head may keep less than half its
        area inside; otherwise the round burns and demotion comes first. Largest scale
        first (rule 4)."""
        keep_faces, avoid, no_cut, yellow_seconds = self._state_sets()
        if not self.subjects and not self.yellows:
            return None
        reds = self._red_out()
        heads = [self.head_of(s) for s in self.subjects]
        if not heads:
            return None
        hx_min = min(b[0] for b in heads)
        hx_max = max(b[2] for b in heads)
        cx = (hx_min + hx_max) / 2.0
        vspan = keep_faces + heads + yellow_seconds
        fy_min = min(b[1] for b in vspan)
        fy_max = max(b[3] for b in vspan)
        top_face_h = 0.0
        if keep_faces:
            tf = min(keep_faces, key=lambda f: f[1])
            top_face_h = max(1.0, float(tf[3] - tf[1]))
        desired_head = 0.5 * top_face_h
        W, H = self.image_w, self.image_h
        max_w, max_h = self.max_w, self.max_h
        aspect = self.aspect_ratio

        def inside(b, wx1, wy1, wx2, wy2):
            return (wx1 <= b[0] and wx2 >= b[2]
                    and wy1 <= b[1] and wy2 >= b[3])

        def half_cut(b, wx1, wy1, wx2, wy2):
            inn = inside(b, wx1, wy1, wx2, wy2)
            out = (wx2 <= b[0] or wx1 >= b[2]
                   or wy2 <= b[1] or wy1 >= b[3])
            return not inn and not out

        def head_kept(hb, wx1, wy1, wx2, wy2):
            ix = max(0, min(hb[2], wx2) - max(hb[0], wx1))
            iy = max(0, min(hb[3], wy2) - max(hb[1], wy1))
            area = max(1.0, (hb[2] - hb[0]) * (hb[3] - hb[1]))
            return (ix * iy) / area >= 0.5

        def hits_avoid(wx1, wy1, wx2, wy2):
            for a in avoid:
                if not (a[2] <= wx1 or a[0] >= wx2
                        or a[3] <= wy1 or a[1] >= wy2):
                    return True
            return False

        for require_clean in (True, False):
            for scale in self.scales:
                w = int(round(max_w * scale))
                h = int(round(w / aspect))
                if h > max_h:
                    h = max_h
                    w = int(round(h * aspect))
                if scale < self.zoom_floor:
                    break
                # horizontal: centered on the head union (symmetric cut by
                # construction); wall clamping that breaks symmetry rejects.
                x1 = int(round(cx - w / 2.0))
                x1 = max(0, min(x1, W - w))
                x2 = x1 + w
                if abs((hx_min - x1) - (x2 - hx_max)) > 1:
                    continue
                # vertical: must hold faces+heads; headroom like the fitter.
                top_low, top_high = fy_max - h, fy_min
                if top_low > top_high:
                    continue
                top = int(fy_min - desired_head)
                top = min(max(top, top_low), top_high)
                top = min(max(top, 0), H - h)
                y1, y2 = top, top + h
                if any(not inside(f, x1, y1, x2, y2) for f in keep_faces):
                    continue
                if any(f[1] < y1 or f[3] > y2 for f in heads):
                    continue
                if any(not inside(s, x1, y1, x2, y2)
                       for s in yellow_seconds):
                    continue
                if any(not head_kept(hb, x1, y1, x2, y2) for hb in heads):
                    continue
                if any(half_cut(f, x1, y1, x2, y2) for f in no_cut):
                    continue
                if require_clean and hits_avoid(x1, y1, x2, y2):
                    continue
                if any(not (x2 <= r[0] or x1 >= r[2]
                            or y2 <= r[1] or y1 >= r[3]) for r in reds):
                    continue
                return (x1, y1, x2, y2)
        return None

    def _demote_one(self):
        """Demote the weakest kept subject one step: green -> yellow -> red
        (lowest score first, one at a time). False when nobody is left."""
        cands = [(s, False) for s in self.subjects]
        cands += [(s, True) for s in self.yellows]
        if not cands:
            return False
        pick = least_important_index([s for s, _ in cands])
        subject, is_yellow = cands[pick]
        if is_yellow:
            self.yellows.remove(subject)
            self.reds.append(subject)
        else:
            self.subjects.remove(subject)
            self.yellows.append(subject)
        return True

    # -- run (the recursive crop function) ---------------------------------
    def run(self):
        """Recursive cascade: every round L1 <- L1.5 <- L2 <- L2.5; on total failure
        the weakest subject is demoted (green -> yellow -> red) and it restarts at L1.
        Final frame tuning happens last on the winning window."""
        if not self.subjects:
            return largest_window(self.image_w, self.image_h,
                                  self.aspect_ratio)
        # starting sets (used by the last-resort path)
        keep0 = [self.box(s.face) for s in self.subjects]
        avoid0 = list(self.avoid_persons)
        no_cut0 = keep0 + self.avoid_faces
        while True:
            win = (self.level1_full_bodies()
                   or self.level1b_all_seconds()
                   or self.level2_heads()
                   or self.level25_face_cut())
            if win is not None:
                keep_faces, avoid, no_cut, _ys = self._state_sets()
                return apply_headroom(win, self.image_w, self.image_h,
                                      keep_faces, no_cut, avoid,
                                      self._red_out())
            if not self._demote_one():
                return apply_headroom(
                    largest_window(self.image_w, self.image_h,
                                   self.aspect_ratio),
                    self.image_w, self.image_h, keep0, no_cut0, avoid0,
                    self._red_out())


def criterion_crop(image_w, image_h, aspect_ratio, subjects, avoid=None):
    """Backward-compatible entry point: 12-criteria crop EXCEPT bend 8
    (profile/two-thirds look direction)."""
    return CropEngine(image_w, image_h, aspect_ratio, subjects,
                      avoid=avoid).run()
