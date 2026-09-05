"""Pose backbone for the crop pipeline (slim).

Only what the current pipeline uses:
  - load_pose_model(): load yolov8n-pose.pt
  - detect_pose(): bodies + 17 COCO keypoints per image
  - manual_crop_box(): locate the human crop `c (n).JPG` inside `a (n).JPG`
"""
import cv2
import numpy as np
from ultralytics import YOLO

import config

POSE_MODEL_PATH = config.MODELS_DIR / "yolov8n-pose.pt"

KPT = [
    "nose", "l_eye", "r_eye", "l_ear", "r_ear",
    "l_sho", "r_sho", "l_elb", "r_elb", "l_wri", "r_wri",
    "l_hip", "r_hip", "l_knee", "r_knee", "l_ank", "r_ank",
]


# ---------------------------------------------------------------- pose -----

def load_pose_model():
    if not POSE_MODEL_PATH.exists():
        raise FileNotFoundError(f"Pose model not found: {POSE_MODEL_PATH}")
    return YOLO(str(POSE_MODEL_PATH))


def detect_pose(model, image_path):
    source = image_path if isinstance(image_path, np.ndarray) else str(image_path)
    result = model.predict(
        source,
        conf=config.BODY_CONFIDENCE,
        device=config.DEVICE,
        verbose=False,
    )[0]
    people = []
    if result.boxes is None:
        return people
    if isinstance(image_path, np.ndarray):
        image = image_path
    else:
        image = cv2.imread(str(image_path))
    image_h, image_w = image.shape[:2] if image is not None else (0, 0)
    tolerance = config.BODY_EDGE_TOLERANCE * min(image_w, image_h)

    for i in range(len(result.boxes)):
        x1, y1, x2, y2 = [int(v) for v in result.boxes.xyxy[i].tolist()]
        conf = float(result.boxes.conf[i].item())
        truncated = (x1 <= tolerance or x2 >= image_w - tolerance or y1 <= tolerance)

        kp = []
        kp_xy = result.keypoints.xy[i].cpu().numpy() if result.keypoints is not None else None
        kp_ok = result.keypoints.conf[i].cpu().numpy() if (
            result.keypoints is not None and result.keypoints.conf is not None
        ) else None
        for j in range(17):
            x = y = 0.0
            vis = False
            if kp_xy is not None:
                x, y = float(kp_xy[j][0]), float(kp_xy[j][1])
                ok = kp_ok[j] if kp_ok is not None else 1.0
                vis = float(ok) >= 0.30 and (x != 0.0 or y != 0.0)
            kp.append({"name": KPT[j], "x": x, "y": y, "vis": vis})

        people.append({
            "bbox": (x1, y1, x2, y2),
            "confidence": conf,
            "truncated": truncated,
            "kp": kp,
        })
    return people


def manual_crop_box(image_a_path, image_c_path):
    a = cv2.imread(str(image_a_path))
    c = cv2.imread(str(image_c_path))
    match = cv2.matchTemplate(a, c, cv2.TM_CCOEFF_NORMED)
    _, _, _, max_loc = cv2.minMaxLoc(match)
    x, y = max_loc
    return (x, y, x + c.shape[1], y + c.shape[0])
