"""Shared paths and field definitions."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # validation/
REPO = ROOT.parent
DATA = ROOT / "data"                                  # gitignored cache
DOCS = REPO / "docs"
FIGURES = DOCS / "figures"
RESULTS_JSON = DOCS / "results.json"

USER_AGENT = "wp-validation/0.1"
S3_BUCKET = "nasa-irsa-spherex"
S3_HTTPS = "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com"

# Field centres (ICRS deg, J2000 epoch catalog positions). Refined by scripts from SIMBAD/Gaia where stated.
FIELDS = {
    "epsindi": {"name": "Eps Indi", "ra": 330.840, "dec": -56.786},
    "barnard": {"name": "Barnard's Star", "ra": 269.452, "dec": 4.6934},
}
