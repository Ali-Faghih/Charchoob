from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent

INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"
MODELS_DIR = BASE_DIR / "models"

FACE_MODEL_PATH = MODELS_DIR / "yolov8n-face.pt"
SEG_MODEL_PATH = MODELS_DIR / "yolov8n-seg.pt"
PERSON_CLASS_ID = 0  # COCO 'person'

CONFIDENCE_THRESHOLD = 0.40
BODY_CONFIDENCE = 0.40
DEVICE = "cpu"

# --- Face analysis / subject selection -------------------------------------

EDGE_TOLERANCE = 0.02  # fraction of the smaller image dimension
W_SIZE = 0.4
W_CENTRALITY = 0.3
W_CONFIDENCE = 0.3

# Body (person) logic. A subject whose body is edge-cut is never a subject.
BODY_EDGE_TOLERANCE = 0.02  # fraction of image dim for body edge detection
BODY_MATCH_MARGIN = 0.5     # face-center must be in top half of body's height
BODY_PAIR_IOU = 0.05        # min face/body overlap to consider a pairing
# A body-edge-cut face is only forbidden if at least MIN_SURVIVORS valid
# subjects would remain after purging it; otherwise it is kept (small scenes
# like image 11 must keep a lone person who merely stands at the frame edge).
MIN_SURVIVORS = 3

# --- Upload limits (product contract, mirrored in the frontend) ----------

# Photos travel one per API request, so the batch count cap (20) is enforced
# where batches exist (frontend picker); the size cap is enforced here too.
MAX_UPLOAD_PHOTOS = 20
MAX_UPLOAD_MB = 20


# --- Crop -------------------------------------------------------------------

DEFAULT_ASPECT_RATIO = 4 / 3  # width / height

# Reserved (not wired yet): penalty for empty crop area, so a loose
# full-body window loses to a tighter one at the same level.
KAPPA_COMPACTNESS = 1.0
