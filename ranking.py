"""Soft ranking of validated crop candidates. Lower score is better.

Hard constraints (strict ratio, never cutting a REF frame, main-subject
rules) are enforced BEFORE ranking, so here we only order valid candidates
by the soft requirements:

  1. keep MAIN subjects full inside (guaranteed before ranking)
  5. position of the subject within the crop
  6. symmetry when the loop enabled it (multi_sym)
  7. margin quality
  8. avoid an unnecessarily tight / lopsided edge proximity
  9. keep yellow/red OUT when a candidate without them exists
  10. keep the subject from staying too small

The nominal "ideal" margin is MIN_PAD; we compare how far the two actual
margins drift from a good padding while also rewarding fidelity (scale).
"""


class CropRanker:
    """Scores one validated crop candidate (O(1), cheap)."""

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


def make_rec(box, scale, avoid_hits, ml, mr, ideal_margin, multi_sym,
             desired_head, top_margin, center_dist=0.0, single=False):
    """Backward-compatible entry point."""
    return CropRanker().make_rec(
        box, scale, avoid_hits, ml, mr, ideal_margin, multi_sym,
        desired_head, top_margin, center_dist, single,
    )


def rank_crop(rec):
    """Backward-compatible entry point."""
    return CropRanker().score(rec)
