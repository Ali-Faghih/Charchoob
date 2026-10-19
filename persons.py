"""Backward-compatible facade for the crop pipeline.

Only the names the rest of the repo actually uses are re-exported:
  engine    - CropEngine, criterion_crop (the recursive crop function)
  geometry  - Subject (the kept-person record)
  roles     - classify_subjects (green/yellow/red initial priority)
  tools/    - Pipeline, main, process_one (`python -m persons` entry)
"""
from engine import CropEngine, criterion_crop
from geometry import Subject
from roles import classify_subjects
from tools.pipeline import Pipeline, main, process_one

__all__ = [
    "CropEngine", "criterion_crop",
    "Subject",
    "classify_subjects",
    "Pipeline", "main", "process_one",
]


if __name__ == "__main__":
    main()
