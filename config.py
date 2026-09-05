from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent

INPUT_DIR = BASE_DIR / "input"
OUTPUT_DIR = BASE_DIR / "output"
MODELS_DIR = BASE_DIR / "models"

FACE_MODEL_PATH = MODELS_DIR / "yolov8n-face.pt"
BODY_MODEL_PATH = MODELS_DIR / "yolov8n.pt"
PERSON_CLASS_ID = 0  # COCO 'person'

CONFIDENCE_THRESHOLD = 0.40
BODY_CONFIDENCE = 0.40
DEVICE = "cpu"

# --- Face analysis / subject selection -------------------------------------

EDGE_TOLERANCE = 0.02  # fraction of the smaller image dimension
W_SIZE = 0.4
W_CENTRALITY = 0.3
W_CONFIDENCE = 0.3
DOMINANT_GAP = 0.25

# Body (person) logic. A subject whose body is edge-cut is never a subject.
BODY_EDGE_TOLERANCE = 0.02  # fraction of image dim for body edge detection
BODY_MATCH_MARGIN = 0.5     # face-center must be in top half of body's height
BODY_PAIR_IOU = 0.05        # min face/body overlap to consider a pairing
# A body-edge-cut face is only forbidden if at least MIN_SURVIVORS valid
# subjects would remain after purging it; otherwise it is kept (small scenes
# like image 11 must keep a lone person who merely stands at the frame edge).
MIN_SURVIVORS = 3

# --- Crop -------------------------------------------------------------------

DEFAULT_ASPECT_RATIO = 4 / 3  # width / height
MIN_SCALE = 0.75
PAD_FRACTION = 0.05
ALPHA_FIDELITY = 1.0
BETA_COVERAGE = 1.0
ZETA_PROMINENCE = 0.0  # 0 = strict fidelity; >0 zooms subject fill toward target
PROMINENCE_TARGET = 0.15  # fraction of crop area a face should ideally fill
GAMMA_POSITION = 0.1

# Group symmetry: prefer crops where a row of subjects is balanced.
ETA_SYMMETRY = 1.0
SYMMETRY_TARGET = 1.0  # ideal fraction of the group (left..right) balanced around center

# Compactness: reward crops tightly wrapping the subject region (zooms for
# small subjects instead of always returning the full frame).
KAPPA_COMPACTNESS = 1.0
