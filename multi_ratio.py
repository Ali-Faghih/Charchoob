"""Draw the criterion crop for 4 landscape aspect ratios on each raw photo.

For every input/a (n).JPG the subjects/avoid classification is computed once
(aspect-independent), then criterion_crop() is run for each of:
    16:9 (blue), 4:3 (red), 5:4 (green), 1:1 (yellow)
and the 4 resulting boxes are drawn as colored frames on the ORIGINAL image.

Output: output/multi_ratio/<stem>_ratios.jpg
"""
from pathlib import Path

import cv2

import numpy as np

import config
from bodies import pair_faces_to_bodies
from debug_pose import load_pose_model, detect_pose
from face import FaceDetector
from persons import (
    Subject,
    classify_subjects,
    criterion_crop,
    person_box_for_face,
    second_frame_for,
)
from subjects import analyze_faces, score_faces

# (label, aspect w/h, BGR color) — drawn largest-area first so all stay visible
RATIOS = [
    ("16:9", 16.0 / 9.0, (255, 0, 0)),      # blue
    ("4:3", 4.0 / 3.0, (0, 0, 255)),        # red
    ("5:4", 5.0 / 4.0, (0, 255, 0)),        # green
    ("1:1", 1.0, (0, 255, 255)),            # yellow
]


def build_subjects(pose_model, face_detector, image_src):
    """Detect + classify once. Returns (w, h, subjects, avoid).

    `image_src` is either a path (str/Path) or a decoded BGR numpy array.
    """
    if isinstance(image_src, np.ndarray):
        image = image_src
    else:
        image = cv2.imread(str(image_src))
    h, w = image.shape[:2]
    faces = face_detector.detect(image)
    bodies = detect_pose(pose_model, image)
    pairs = pair_faces_to_bodies(faces, bodies, w, h)
    analysis = analyze_faces(
        faces, w, h, config.EDGE_TOLERANCE,
        body_detections=bodies, pairs=pairs,
    )
    analysis = score_faces(
        analysis,
        weight_size=config.W_SIZE,
        weight_centrality=config.W_CENTRALITY,
        weight_confidence=config.W_CONFIDENCE,
    )
    roles, body_idx_of_face = classify_subjects(
        faces, bodies, pairs, analysis, w, h
    )
    drawn_bodies = set()
    entries = []
    for fi, face in enumerate(analysis):
        role = roles.get(fi, "invalid")
        bi = body_idx_of_face.get(fi)
        if bi is not None:
            if bi in drawn_bodies:
                continue
            drawn_bodies.add(bi)
            box = bodies[bi]["bbox"]
        else:
            box = person_box_for_face(face["bbox"], w, h)
        entries.append((box, face["bbox"], role))
    subjects, avoid = [], []
    for pbox, fbox, role in entries:
        if role == "main":
            subjects.append(
                Subject(face=fbox, person=pbox,
                        second=second_frame_for(fbox, pbox, w))
            )
        else:
            avoid.append({"person": pbox, "face": fbox, "role": role})
    return w, h, subjects, avoid


def main() -> None:
    pose_model = load_pose_model()
    face_detector = FaceDetector(
        model_path=str(config.FACE_MODEL_PATH),
        confidence_threshold=config.CONFIDENCE_THRESHOLD,
        device=config.DEVICE,
    )
    out_dir = config.OUTPUT_DIR / "multi_ratio"
    out_dir.mkdir(parents=True, exist_ok=True)
    image_paths = sorted(
        config.INPUT_DIR.glob("a (*).JPG"),
        key=lambda p: p.name,
    )
    for image_path in image_paths:
        image = cv2.imread(str(image_path))
        w, h, subjects, avoid = build_subjects(
            pose_model, face_detector, image_path
        )
        boxes = []
        for label, aspect, color in RATIOS:
            box = criterion_crop(w, h, aspect, subjects, avoid=avoid)
            x1, y1, x2, y2 = box
            got = (x2 - x1) / float(y2 - y1) if y2 > y1 else 0.0
            ok = abs(got - aspect) < 0.01
            print(f"{image_path.name} {label}: crop={box} "
                  f"aspect={got:.4f} {'OK' if ok else 'RATIO-MISMATCH'}")
            boxes.append((label, aspect, color, box))
        # largest area first so smaller frames stay visible on top
        boxes.sort(key=lambda b: -((b[3][2] - b[3][0]) * (b[3][3] - b[3][1])))
        for label, aspect, color, box in boxes:
            x1, y1, x2, y2 = [int(round(v)) for v in box]
            cv2.rectangle(image, (x1, y1), (x2, y2), color, 3)
            cv2.putText(image, label, (x1 + 6, max(22, y1 + 22)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
        # legend
        x, y = 10, 25
        for label, _aspect, color in RATIOS:
            cv2.rectangle(image, (x, y - 14), (x + 18, y - 4), color, 2)
            cv2.putText(image, label, (x + 24, y),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
            y += 22
        out_path = out_dir / f"{image_path.stem}_ratios.jpg"
        cv2.imwrite(str(out_path), image)
        print(f"  -> {out_path.name}")


if __name__ == "__main__":
    main()
