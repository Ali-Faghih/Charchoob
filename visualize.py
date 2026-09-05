"""Debug visualization: palette + drawing of boxes, labels, arrows, legend."""
import cv2

import config
from debug_pose import manual_crop_box

MAIN = (0, 200, 0)
SECONDARY = (0, 220, 255)
INVALID = (0, 0, 255)
FACE = (255, 255, 0)
DESIRED = (255, 255, 255)
SECOND = (255, 255, 0)  # magenta-ish purple
TEST = (0, 0, 255)  # red dashed: the working 12-criteria crop
BROWN = (42, 42, 165)  # margin arrows

ROLE_COLOR = {"main": MAIN, "secondary": SECONDARY, "invalid": INVALID}


def draw_dashed_rect(img, box, color, thickness=2, dash=16, gap=9):
    x1, y1, x2, y2 = [int(round(v)) for v in box]

    def dashes(p1, p2):
        length = abs(p2[0] - p1[0]) + abs(p2[1] - p1[1])
        t = 0.0
        while t < length:
            t2 = min(length, t + dash)
            a = (p1[0] + int((p2[0] - p1[0]) * t / length),
                 p1[1] + int((p2[1] - p1[1]) * t / length))
            b = (p1[0] + int((p2[0] - p1[0]) * t2 / length),
                 p1[1] + int((p2[1] - p1[1]) * t2 / length))
            cv2.line(img, a, b, color, thickness)
            t = t2 + gap

    dashes((x1, y1), (x2, y1))
    dashes((x2, y1), (x2, y2))
    dashes((x2, y2), (x1, y2))
    dashes((x1, y2), (x1, y1))


class CropVisualizer:
    """Draws the debug overlay (persons + test crop + desired) on an image."""

    def __init__(self, image):
        self.image = image

    def draw_person(self, pbox, role):
        cv2.rectangle(self.image, (pbox[0], pbox[1]), (pbox[2], pbox[3]),
                      ROLE_COLOR[role], 3)

    def draw_second(self, sbox):
        cv2.rectangle(self.image, (sbox[0], sbox[1]), (sbox[2], sbox[3]),
                      SECOND, 2)

    def label_face(self, gray, fbox, area, focus):
        label = f"face={area} focus={focus:.0f}"
        tx = fbox[0]
        ty = max(18, fbox[1] - 6)
        cv2.putText(self.image, label, (tx, ty),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)

    def draw_test_crop(self, test_box):
        draw_dashed_rect(self.image, test_box, TEST, thickness=3)
        cv2.putText(self.image, "test-crop",
                    (test_box[0] + 4, max(24, test_box[1] + 20)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, TEST, 2)

    def draw_margin_arrows(self, test_box, subjects):
        """Brown arrows: left/right margins between crop edges and the
        leftmost/rightmost kept (green) Person Frames."""
        if not subjects:
            return
        tx1, ty1, tx2, ty2 = test_box
        # margins measured from the ACTUAL Person Frames (not the replaced
        # second frame) so the arrow shows distance person->wall
        left_ref = min(s.person[0] for s in subjects)
        right_ref = max(s.person[2] for s in subjects)
        bar_y = (ty1 + ty2) // 2
        # left margin arrow: crop_left -> leftmost frame
        if tx1 <= left_ref:
            cv2.arrowedLine(self.image, (tx1, bar_y), (left_ref, bar_y),
                            BROWN, 4, line_type=cv2.LINE_AA, tipLength=0.25)
            ml = left_ref - tx1
            cv2.putText(self.image, str(ml),
                        (max(4, tx1), max(16, bar_y - 10)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, BROWN, 3)
        # right margin arrow: rightmost frame -> crop_right
        if right_ref <= tx2:
            cv2.arrowedLine(self.image, (right_ref, bar_y), (tx2, bar_y),
                            BROWN, 4, line_type=cv2.LINE_AA, tipLength=0.25)
            mr = tx2 - right_ref
            cv2.putText(self.image, str(mr),
                        (max(4, right_ref + 6), max(16, bar_y - 10)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, BROWN, 3)

    def draw_faces(self, analysis):
        # every detected face on top (thin cyan) so pairing errors are visible
        for face in analysis:
            fx1, fy1, fx2, fy2 = face["bbox"]
            cv2.rectangle(self.image, (fx1, fy1), (fx2, fy2), FACE, 2)

    def draw_desired(self, image_path):
        """Desired (manual/human) crop box, thick white + legend. Returns
        True when the human crop exists (legend includes DESIRED)."""
        c_path = (config.INPUT_DIR
                  / (image_path.stem.replace("a ", "c ") + image_path.suffix))
        items = [("MAIN", MAIN), ("SECONDARY", SECONDARY),
                 ("INVALID", INVALID), ("FACE", FACE),
                 ("SECOND-FRAME", SECOND), ("TEST-CROP", TEST)]
        has = c_path.exists()
        if has:
            dx1, dy1, dx2, dy2 = manual_crop_box(image_path, c_path)
            items.append(("DESIRED", DESIRED))
        x, y = 10, 25
        for label, color in items:
            cv2.rectangle(self.image, (x, y - 14), (x + 18, y - 4), color, 2)
            cv2.putText(self.image, label, (x + 24, y),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)
            y += 22
        if has:
            cv2.rectangle(self.image, (dx1, dy1), (dx2, dy2), DESIRED, 3)
            cv2.putText(self.image, "desired", (dx1 + 4, max(22, dy1 + 18)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.55, DESIRED, 2)
        return has
