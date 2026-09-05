# Smart Group-Photo Cropper

Automatic crop / framing of group photos following professional photographer
rules: golden-rule (no face ever half-cut), left/right symmetry, headroom,
centering, and a color/person priority system (green / yellow / red) with a
cascade of fallback levels (L1..L3).

## Pipeline

1. Face detection (YOLO) + body/pose inference (`face.py`, `bodies.py`).
2. Person classification into roles (`roles.py`) and subject model
   (`geometry.py`, `subjects.py`).
3. Level cascade (`engine.py`) — from full bodies down to demoted subjects —
   searching an aspect-ratio window (`window.py`) and equalizing margins
   (`margins.py`).
4. Debug / final visuals via `visualize.py` + `pipeline.py`.

## Usage

```bash
pip install -r requirements.txt

# Crop every photo at the default ratio (4:3) and write debug visuals
python -m persons

# Export all supported ratios (4:3, 5:4, 16:9, 1:1)
python -m multi_ratio
```

## Structure

- `geometry.py`  — Subject model, frames, ratio window math
- `roles.py`     — color/priority classification (green/yellow/red)
- `ranking.py`   — crop scoring
- `margins.py`   — left/right margin balancing (symmetry)
- `window.py`    — aspect-window search
- `engine.py`    — L1..L3 level cascade, golden rule, headroom
- `pipeline.py`  — end-to-end runner and visual output
- `persons.py`   — thin facade (CLI: `python -m persons`)
- `multi_ratio.py` — per-ratio export (CLI: `python -m multi_ratio`)