from pathlib import Path
from typing import TypedDict

import cv2
import numpy as np
from ultralytics import YOLO


class FaceDetection(TypedDict):
    bbox: tuple[int, int, int, int]
    confidence: float


class FaceDetector:
    """
    Face detection module.

    Responsibilities:
    - Load the YOLO face detection model.
    - Run inference on an image.
    - Return normalized face detections.

    This module does NOT:
    - Select the main face.
    - Crop the image.
    - Apply templates.
    """

    def __init__(
        self,
        model_path: str = "models/yolov8n-face.pt",
        confidence_threshold: float = 0.40,
        device: str = "cpu",
    ):
        self.model_path = Path(model_path)
        self.confidence_threshold = confidence_threshold
        self.device = device

        if not self.model_path.exists():
            raise FileNotFoundError(
                f"Face model not found: {self.model_path}"
            )

        self.model = YOLO(str(self.model_path))

    def detect(self, image_path) -> list[FaceDetection]:
        """
        Detect all faces in an image.

        Args:
            image_path: Path to input image OR a decoded BGR numpy array.

        Returns:
            List of detected faces containing:
            - bbox: (x1, y1, x2, y2)
            - confidence: detection confidence
        """

        if isinstance(image_path, np.ndarray):
            image = image_path
        else:
            image = cv2.imread(str(image_path))

        if image is None:
            raise ValueError(
                f"Could not read image: {image_path}"
            )

        results = self.model.predict(
            source=image,
            conf=self.confidence_threshold,
            device=self.device,
            verbose=False,
        )

        detections: list[FaceDetection] = []

        if not results:
            return detections

        result = results[0]

        if result.boxes is None:
            return detections

        for box in result.boxes:
            coordinates = box.xyxy[0].cpu().tolist()
            confidence = float(box.conf[0].cpu().item())

            x1, y1, x2, y2 = map(int, coordinates)

            detections.append(
                {
                    "bbox": (x1, y1, x2, y2),
                    "confidence": confidence,
                }
            )

        return detections