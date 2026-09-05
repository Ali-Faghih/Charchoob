"""Crop engine: the 5-level cascade (L1 / L1.5 / L2 / L3 / fallback).

Rules applied:
  1+2 : Second Frame substitutes a Person Frame when PersonWidth is more
        than 1.5x its SecondWidth.
  4   : keep as close as possible to the original frame (max-scale first).
  5   : every GREEN reference frame stays fully inside the crop.
  7   : single subject, frontal -> preserve the photographer's side
        placement (left / center / right) instead of center-pulling.
  9,13: multi-subject with similar faces -> equal left/right margins.
  10  : top margin (> top face) must exceed 0.5 x that face's height
        (enforced as the LAST step: shift the crop straight up).
  11  : if a green ref frame cannot fit -> try Second Frames -> then reduce
        the least-important (smallest face, farthest) green to face-only ->
        then demote it to yellow and re-fit -> finally shrink and drop it.
  12  : if the ref frames are far too small vs the frame, zoom in toward a
        minimum-standard size (avg of min/max ref heights).

`avoid` = list of boxes (red/yellow persons) that must stay OUT of the
crop where possible (bend 6): a green-only window is preferred; a window
containing yellow/red is only used when no green-only window exists.
"""
from dataclasses import replace

from geometry import (
    Subject,
    as_subject,
    clamp_box,
    fit_ratio_window,
    least_important_index,
    ref_frame_of,
    similar_faces,
)
from window import WindowFitter


class CropEngine:
    """Runs the level cascade for one image + subject set."""

    MIN_FACE_PAD = 20
    SCALES = (1.0, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6)

    def __init__(self, image_w, image_h, aspect_ratio, subjects, avoid=None,
                 fitter=None):
        self.image_w = image_w
        self.image_h = image_h
        self.aspect_ratio = aspect_ratio
        self.subjects = [as_subject(s) for s in subjects]
        self.max_w, self.max_h = fit_ratio_window(
            image_w, image_h, aspect_ratio)

        av_objs = [a for a in (avoid or [])]
        # normalize each avoid entry to {"person","face"}
        ys = []
        for a in av_objs:
            if isinstance(a, dict):
                ys.append({"person": self.box(a["person"]),
                           "face": self.box(a.get("face", a["person"]))})
            else:
                b = self.box(a)
                ys.append({"person": b, "face": b})
        self.avoid_persons = [y["person"] for y in ys]
        self.avoid_faces = [y["face"] for y in ys]

        self.single = len(self.subjects) == 1
        self.multi_sym = ((not self.single)
                          and (len(self.subjects) < 4
                               or similar_faces(self.subjects)))

        # GOLDEN RULE: a face (green OR yellow/red) must never be PARTIALLY
        # cut by the crop -- every face is either fully inside or fully
        # outside the frame. Green faces must always stay fully inside (kept
        # subjects); yellow/red faces are optional (prefer them out) but a
        # crop that would clip one halfway is invalid. So:
        self.green_faces = [self.box(s.face) for s in self.subjects]
        self.keep_faces = self.green_faces      # hard: always fully inside
        self.no_cut_faces = self.green_faces + self.avoid_faces
        # per-level active sets: L3 (demotion) may shrink them
        self.active_keep_faces = self.keep_faces
        self.active_avoid = self.avoid_persons

        # bend 12: persons far too small -> zoom in (bias toward tiny scale)
        sizes = [max(1.0, (s.face[3] - s.face[1])) for s in self.subjects]
        avg_h = (min(sizes) + max(sizes)) / 2.0
        zoom_too_small = avg_h / image_h < 0.05   # ~ 5% => zoom in
        self.scales = self.SCALES
        self.zoom_floor = 0.6 if not zoom_too_small else 0.85

        self.fitter = fitter or WindowFitter(image_w, image_h, aspect_ratio)

    # -- helpers ------------------------------------------------------
    def box(self, b):
        return clamp_box(b, self.image_w, self.image_h)

    def ref_of(self, subject, level):
        return ref_frame_of(subject, level, self.image_w, self.image_h)

    def fit_for(self, hard_boxes, mb, single_win, m_sym):
        """Place an aspect window keeping every hard box fully inside while
        keeping yellow/red bodies out where possible. Best crop or None."""
        return self.fitter.fit(
            hard_boxes, self.avoid_persons, single_win, m_sym, self.scales,
            self.zoom_floor, margin_boxes=mb, face_keep=self.keep_faces,
            no_cut_faces=self.no_cut_faces)

    def fix_headroom(self, crop):
        """Bend 10 post-fix (LAST step): if the top margin above the topmost
        GREEN face is below desired_head, shift the crop straight up (same
        size) — never zooms, never changes width. Guards: every green face
        must stay fully inside, no face may become partially cut, and no new
        avoid-person may be pulled inside."""
        cx1, cy1, cx2, cy2 = crop
        ch = cy2 - cy1
        if not self.active_keep_faces:
            return crop
        top_face = min(self.active_keep_faces, key=lambda f: f[1])
        tf_y1, tf_y2 = top_face[1], top_face[3]
        desired = 0.5 * (tf_y2 - tf_y1)
        have = tf_y1 - cy1
        if have >= desired - 0.5:
            return crop
        need = int(round(desired - have))
        max_shift = min(need, cy1)  # can't go above image top
        # green faces inside now must stay inside: new_y2 >= f3
        for f in self.active_keep_faces:
            if cx1 <= f[0] and cx2 >= f[2] and cy1 <= f[1] and cy2 >= f[3]:
                max_shift = min(max_shift, cy2 - f[3])
        if max_shift <= 0:
            return crop
        shift = max_shift
        while shift > 0:
            ny1 = cy1 - shift
            ny2 = ny1 + ch
            ok = True
            for f in self.active_keep_faces:  # greens stay fully inside
                if not (cx1 <= f[0] and cx2 >= f[2] and ny1 <= f[1] and ny2 >= f[3]):
                    ok = False
                    break
            if ok:
                for f in self.no_cut_faces:  # golden rule: never half-cut
                    inside = (cx1 <= f[0] and cx2 >= f[2] and ny1 <= f[1] and ny2 >= f[3])
                    outside = (cx2 <= f[0] or cx1 >= f[2] or ny2 <= f[1] or ny1 >= f[3])
                    if not inside and not outside:
                        ok = False
                        break
            if ok:
                for a in self.active_avoid:  # don't pull a new yellow/red in
                    was_out = (a[2] <= cx1 or a[0] >= cx2 or a[3] <= cy1 or a[1] >= cy2)
                    now_hit = not (a[2] <= cx1 or a[0] >= cx2 or a[3] <= ny1 or a[1] >= ny2)
                    if was_out and now_hit:
                        ok = False
                        break
            if ok:
                return (cx1, ny1, cx2, ny2)
            shift -= 5 if shift > 5 else 1
            # keep trying smaller shifts; the loop ends with shift<=0 -> crop
        return crop

    # -- levels --------------------------------------------------------
    def level1_full_bodies(self):
        """LEVEL 1: every green body (its full ref frame) fully inside."""
        hard1 = self.keep_faces + [self.ref_of(s, "full") for s in self.subjects]
        return self.fit_for(
            hard1, [self.box(s.person) for s in self.subjects],
            self.single, self.multi_sym)

    def level1b_all_seconds(self):
        """LEVEL 1.5: retry with every green's Second Frame (narrower; often
        fits a window that the bodies do not). None when identical to L1."""
        seconds = [self.box(s.second) or self.box(s.person)
                   for s in self.subjects]
        if seconds == [self.ref_of(s, "full") for s in self.subjects]:
            return None
        return self.fit_for(
            self.keep_faces + seconds,
            [self.box(s.person) for s in self.subjects],
            self.single, self.multi_sym)

    def level2_face_only(self):
        """LEVEL 2: progressively reduce the least-fundamental (smallest
        face) green from its full body to face-only (with a >= MIN_FACE_PAD
        gap from the crop wall) until a window fits."""
        def try_level(work, pad):
            hard = self.keep_faces + [self.ref_of(s, "full") for s in work]
            return self.fitter.fit(
                hard, self.avoid_persons, len(work) == 1, self.multi_sym,
                self.scales, self.zoom_floor,
                margin_boxes=[self.box(s.person) for s in work],
                face_keep=self.keep_faces, min_face_pad=pad,
                no_cut_faces=self.no_cut_faces)

        fail_yet = []          # indices of greens already reduced to face-only
        work = [replace(s) for s in self.subjects]
        # try with the current set, then shrink one more green per iteration
        # so the all-face-only endpoint is also reached.
        while True:
            win = try_level(work, self.MIN_FACE_PAD)
            if win is not None:
                return win
            # pick the smallest green that still has a full body and reduce it
            full_idx = [i for i in range(len(work)) if i not in fail_yet]
            if not full_idx:
                break
            cands = [work[i] for i in full_idx]
            real_idx = full_idx[least_important_index(cands)]
            fail_yet.append(real_idx)
            f = work[real_idx].face
            work[real_idx].person = f
            work[real_idx].second = None
        return None

    def level3_demote(self):
        """LEVEL 3 (yellow/red demotion). Keeping every green face hard-inside
        (L1..L2) defaulted, so the least-important green(s) are demoted:
          * FIRST to YELLOW: their body may be cut, their SECOND Frame stays
            fully inside -- the whole kept set now sits at its Second Frames.
          * if the frame STILL won't fit, the subject becomes fully RED: out
            of the frame (face released too), treated exactly like the
            detected red/yellow (avoid) set.
        Who gets demoted: faces similar in size -> the person nearest the
        LEFT edge AND the person nearest the RIGHT edge (both); otherwise ->
        the SMALLEST face. When BOTH edge persons end up demoted, the final
        symmetry is measured from the Second Frames' distance to the wall;
        otherwise the old Person-Frame pattern is used."""
        similar = similar_faces(self.subjects)
        kept = [s for s in self.subjects]     # must stay in frame (at seconds)
        red = []                              # fully demoted (out, like avoid)
        while True:
            hard = [self.box(s.second) or self.box(s.person) for s in kept]
            face_keep = [self.box(s.face) for s in kept]
            no_cut = (face_keep
                      + [self.box(s.face) for s in red]
                      + self.avoid_faces)
            avoid = self.avoid_persons + [self.box(s.person) for s in red]
            mb, m_sym = self._yellow_margin_policy(kept, red, similar)
            win = self.fitter.fit(
                hard, avoid, False, m_sym,
                self.scales, self.zoom_floor,
                margin_boxes=mb, face_keep=face_keep, min_face_pad=0,
                no_cut_faces=no_cut)
            if win is not None:
                self.active_keep_faces = face_keep
                self.active_avoid = avoid
                self.yellowed = list(red)   # debug info: fully-demoted subjects
                return win
            if not kept:
                return None
            picks = self._pick_yellows([s for s in kept], similar)
            if not picks:
                return None
            for p in sorted(set(picks), reverse=True):
                red.append(kept.pop(p))
        return None

    # -- yellow-level helpers ------------------------------------------
    def _pick_yellows(self, greens, similar):
        """Positions (into `greens`) of the subject(s) to demote this round.

        Case 1 (faces similar in size): the nearest person to the left edge
        and the nearest person to the right edge, together.
        Case 2 (face sizes differ a lot): the person with the smallest face.
        """
        if len(greens) == 1:
            return [0]
        if similar:
            left = min(range(len(greens)),
                       key=lambda i: (greens[i].person[0], greens[i].person[2]))
            right = max(range(len(greens)),
                        key=lambda i: (greens[i].person[2], greens[i].person[0]))
            return sorted({left, right})
        return [least_important_index(greens)]

    def _both_edges_demoted(self, red):
        """True when the leftmost AND rightmost subjects are both demoted."""
        if len(self.subjects) < 2:
            return False
        left = min(range(len(self.subjects)),
                   key=lambda i: self.subjects[i].person[0])
        right = max(range(len(self.subjects)),
                    key=lambda i: self.subjects[i].person[2])
        rs = frozenset(id(s) for s in red)
        return id(self.subjects[left]) in rs and id(self.subjects[right]) in rs

    def _yellow_margin_policy(self, kept, red, similar):
        """(margin_boxes, force_sym) for the yellow level.

        Case 1 with BOTH edge persons demoted -> the remaining frames bound
        the crop by their SECOND frames: measure the margins there and force
        symmetry (force_sym=True).
        Otherwise the OLD pattern: Person Frames + the group's symmetry flag.
        """
        if similar and red and self._both_edges_demoted(red):
            mb = [self.box(s.second) or self.box(s.person) for s in kept]
            return mb, True
        mb = [self.box(s.person) for s in kept]
        return mb, self.multi_sym

    # -- run ------------------------------------------------------------
    def run(self):
        """First succeeding level wins; headroom fix applied last."""
        if not self.subjects:
            return (0, 0, self.max_w, self.max_h)
        self.active_keep_faces = self.keep_faces
        self.active_avoid = self.avoid_persons
        win = self.level1_full_bodies()
        if win is not None:
            return self.fix_headroom(win)
        win = self.level1b_all_seconds()
        if win is not None:
            return self.fix_headroom(win)
        win = self.level2_face_only()
        if win is not None:
            return self.fix_headroom(win)
        win = self.level3_demote()
        if win is not None:
            return self.fix_headroom(win)
        # ---- absolute fallback: largest faithful window --------------------
        return self.fix_headroom((0, 0, self.max_w, self.max_h))


def criterion_crop(image_w, image_h, aspect_ratio, subjects, avoid=None):
    """Backward-compatible entry point: 12-criteria crop EXCEPT bend 8
    (profile/two-thirds look direction)."""
    return CropEngine(image_w, image_h, aspect_ratio, subjects,
                      avoid=avoid).run()
