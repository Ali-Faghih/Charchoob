# Model weights (not in version control — ~20 MB total)

Place the following three Ultralytics YOLOv8n weight files in this folder
before running the backend. Filenames must match exactly:

| File                 | ~Size | Used for                    |
|----------------------|-------|-----------------------------|
| `yolov8n-face.pt`    | 6 MB  | face detection (`face.py`)  |
| `yolov8n-pose.pt`    | 7 MB  | bodies + keypoints (`debug_pose.py`) |
| `yolov8n-seg.pt`     | 7 MB  | person masks (`bodies.py`)  |

(`yolov8n.pt`, the plain person detector, is no longer used — person boxes
come from the pose model — so it is not required.)

Missing weights raise `FileNotFoundError` on the first inference call, naming
the expected path.
