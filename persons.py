"""Backward-compatible facade for the crop pipeline.

The implementation now lives in focused modules (max OOP):
  geometry  - Subject, box helpers, Second/Person frames
  roles     - RoleClassifier (green / yellow / red)
  window    - WindowFitter (candidate search)
  margins   - MarginBalancer (left/right equalization)
  ranking   - CropRanker (soft scoring)
  engine    - CropEngine (L1 / L1.5 / L2 / L3 / fallback cascade)
  visualize - CropVisualizer (debug overlay)
  pipeline  - Pipeline (detect -> classify -> crop -> draw)

`python -m persons` and `from persons import ...` keep working unchanged.
"""
from engine import CropEngine, criterion_crop
from geometry import (
    Subject,
    as_subject,
    clamp_box,
    fit_ratio_window,
    least_important_index,
    person_box_for_face,
    ref_frame_of,
    second_frame_for,
    similar_faces,
    top_face_height,
)
from margins import MarginBalancer
from pipeline import Pipeline, main, process_one
from ranking import CropRanker, make_rec, rank_crop
from roles import (
    CROWD_FACES,
    MAIN_RATIO,
    RoleClassifier,
    classify_subjects,
    face_near_cut_edge,
)
from visualize import (
    DESIRED,
    FACE,
    INVALID,
    MAIN,
    ROLE_COLOR,
    SECOND,
    SECONDARY,
    TEST,
    CropVisualizer,
    draw_dashed_rect,
)
from window import WindowFitter

__all__ = [
    "CropEngine", "criterion_crop",
    "Subject", "as_subject", "clamp_box", "fit_ratio_window",
    "least_important_index", "person_box_for_face", "ref_frame_of",
    "second_frame_for", "similar_faces", "top_face_height",
    "MarginBalancer",
    "Pipeline", "main", "process_one",
    "CropRanker", "make_rec", "rank_crop",
    "CROWD_FACES", "MAIN_RATIO", "RoleClassifier", "classify_subjects",
    "face_near_cut_edge",
    "DESIRED", "FACE", "INVALID", "MAIN", "ROLE_COLOR", "SECOND",
    "SECONDARY", "TEST", "CropVisualizer", "draw_dashed_rect",
    "WindowFitter",
]


if __name__ == "__main__":
    main()
