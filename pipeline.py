"""End-to-end pipeline: detect -> classify -> crop -> debug overlay."""
from pathlib import Path

import cv2

import config
from bodies import pair_faces_to_bodies
from debug_pose import load_pose_model, detect_pose
from engine import CropEngine
from face import FaceDetector
from geometry import Subject, person_box_for_face, second_frame_for
from roles import RoleClassifier
from subjects import analyze_faces, score_faces
from visualize import CropVisualizer


class Pipeline:
    """Runs the full persons pipeline (shared by `persons` and tools)."""

    def __init__(self, pose_model=None, face_detector=None,
                 classifier=None):
        self.pose_model = pose_model or load_pose_model()
        self.face_detector = face_detector or FaceDetector(
            model_path=str(config.FACE_MODEL_PATH),
            confidence_threshold=config.CONFIDENCE_THRESHOLD,
            device=config.DEVICE,
        )
        self.classifier = classifier or RoleClassifier()

    def analyze(self, image_path):
        """Detect + classify. Returns (image, gray, w, h, analysis, roles,
        body_idx_of_face)."""
        image = cv2.imread(str(image_path))
        h, w = image.shape[:2]
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        faces = self.face_detector.detect(str(image_path))
        bodies = detect_pose(self.pose_model, str(image_path))
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
        roles, body_idx_of_face = self.classifier.classify(
            faces, bodies, pairs, analysis, w, h
        )
        return image, gray, w, h, analysis, roles, body_idx_of_face, bodies

    def collect_subjects(self, analysis, roles, body_idx_of_face, bodies,
                         w, h, visual=None, gray=None):
        """Draw once per person; split GREEN subjects vs yellow/red avoid."""
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

        counts = {"main": 0, "secondary": 0, "invalid": 0}
        subjects, avoid = [], []
        for pbox, fbox, role in entries:
            counts[role] += 1
            if visual is not None:
                visual.draw_person(pbox, role)
            # Second Frame: person box shrunk so the face is centered
            sbox = second_frame_for(fbox, pbox, w)
            if visual is not None:
                visual.draw_second(sbox)
            if role == "main":
                subjects.append(Subject(face=fbox, person=pbox, second=sbox))
                if visual is not None and gray is not None:
                    fw = fbox[2] - fbox[0]
                    fh = fbox[3] - fbox[1]
                    area = int(round(fw * fh))
                    roi = gray[fbox[1]:fbox[3], fbox[0]:fbox[2]]
                    focus = float(cv2.Laplacian(roi, cv2.CV_64F).var()) \
                        if roi.size else 0.0
                    visual.label_face(gray, fbox, area, focus)
            else:
                # keep the face too: the golden rule requires every
                # yellow/red face to stay fully inside, even though its body
                # should stay out.
                avoid.append({"person": pbox, "face": fbox, "role": role})
        return subjects, avoid, counts

    def process_one(self, image_path: Path, out_path: Path):
        image, gray, w, h, analysis, roles, body_idx_of_face, bodies = \
            self.analyze(image_path)
        visual = CropVisualizer(image)
        subjects, avoid, counts = self.collect_subjects(
            analysis, roles, body_idx_of_face, bodies, w, h,
            visual=visual, gray=gray)
        # 12-criteria test crop driven by the GREEN subjects
        test_box = CropEngine(w, h, config.DEFAULT_ASPECT_RATIO,
                              subjects, avoid=avoid).run()
        visual.draw_test_crop(test_box)
        visual.draw_margin_arrows(test_box, subjects)
        visual.draw_faces(analysis)
        visual.draw_desired(image_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(out_path), image)
        return counts

    def run_all(self, out_subdir="persons"):
        image_paths = sorted(
            (p for p in config.INPUT_DIR.glob("*.jp*")
             if not p.name.startswith("c ")),
            key=lambda p: p.name,
        )
        out_dir = config.OUTPUT_DIR / out_subdir
        out_dir.mkdir(parents=True, exist_ok=True)
        grand = {"main": 0, "secondary": 0, "invalid": 0}
        for image_path in image_paths:
            out_path = out_dir / f"{image_path.stem}_persons.jpg"
            counts = self.process_one(image_path, out_path)
            for k in grand:
                grand[k] += counts[k]
            print(f"{image_path.name}: main={counts['main']} "
                  f"secondary={counts['secondary']} invalid={counts['invalid']}"
                  f"  -> {out_path.name}")
        print(f"\nTOTAL -> {grand}")
        return grand


def process_one(pose_model, face_detector, image_path: Path, out_path: Path):
    """Backward-compatible entry point."""
    return Pipeline(pose_model=pose_model,
                    face_detector=face_detector).process_one(image_path,
                                                             out_path)


def main() -> None:
    """Backward-compatible entry point (`python -m persons`)."""
    Pipeline().run_all()
