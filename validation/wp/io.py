"""Range-read access to SPHEREx Level 2 files on the public S3 bucket, and cutout caching.

Cutout file contract (validation/data/cutouts/<field>/<OBSID>_D<det>.fits):
  [0] empty primary with OBSID, DETECTOR, RELEASE, S3KEY, MJD-AVG, DATE-AVG, MJD-BEG, MJD-END,
      PSF_FWHM, X0, Y0 (0-based detector pixel of cutout pixel [0,0]), FIELD, VISIT
  [1] IMAGE f4, [2] FLAGS i4 (plain), [3] VARIANCE f4, [4] ZODI f4, [5] WCS-WAVE (unmodified table).
  Extensions 1-4 carry the IMAGE spatial WCS (SIP) with CRPIX1 -= X0, CRPIX2 -= Y0; alternate
  WCS keys (A, W) are dropped.  The WCS-WAVE table is in detector coordinates.
"""
import base64
import io as _io
import json
import math
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import requests
from astropy.io import fits
from astropy.wcs import WCS

from .config import DATA, S3_HTTPS, USER_AGENT

HEADER_DIR = DATA / "headers"
CUTOUT_DIR = DATA / "cutouts"
NPIX = 2040
BLOCK = 2880

# ---------------------------------------------------------------- HTTP ----------------
_local = threading.local()
_bytes_lock = threading.Lock()
_bytes_total = 0


def bytes_downloaded():
    return _bytes_total


def _session():
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers["User-Agent"] = USER_AGENT
        _local.s = s
    return s


def range_get(key, start, length, retries=6):
    """GET bytes [start, start+length) of an S3 object. Returns (bytes, total_size)."""
    global _bytes_total
    url = f"{S3_HTTPS}/{key}"
    hdr = {"Range": f"bytes={start}-{start + length - 1}"}
    err = None
    for i in range(retries):
        try:
            r = _session().get(url, headers=hdr, timeout=60)
            if r.status_code in (200, 206):
                content = r.content
                if r.status_code == 200:      # server ignored Range (should not happen)
                    content = content[start:start + length]
                with _bytes_lock:
                    _bytes_total += len(r.content)
                m = re.search(r"/(\d+)$", r.headers.get("Content-Range", ""))
                total = int(m.group(1)) if m else None
                if len(content) != length and total is not None and start + length <= total:
                    raise IOError(f"short read {len(content)} != {length}")
                return content, total
            if r.status_code == 416:
                return b"", None
            err = IOError(f"HTTP {r.status_code}")
        except (requests.RequestException, IOError) as e:
            err = e
        time.sleep(min(30, 1.5 ** i + 0.3 * i))
    raise IOError(f"range_get failed for {key} @ {start}: {err}")


# ---------------------------------------------------------------- headers -------------
def _read_header_at(key, off, chunk=32768):
    """Read one FITS header starting at byte `off`. Returns (Header, header_len_bytes, total)."""
    buf, total = range_get(key, off, chunk)
    while True:
        # look for END card on an 80-byte boundary
        n = len(buf)
        found = None
        for blk in range(0, n - BLOCK + 1, BLOCK):
            b = buf[blk:blk + BLOCK]
            for c in range(0, BLOCK, 80):
                if b[c:c + 8] == b"END     ":
                    found = blk + BLOCK
                    break
            if found:
                break
        if found:
            hdr = fits.Header.fromstring(buf[:found].decode("ascii"))
            return hdr, found, total
        more, _ = range_get(key, off + n, chunk)
        if not more:
            raise IOError("no END card found")
        buf += more


def _data_size(hdr):
    naxis = hdr.get("NAXIS", 0)
    if naxis == 0:
        n = 0
    else:
        n = 1
        for i in range(1, naxis + 1):
            n *= hdr[f"NAXIS{i}"]
    return abs(hdr["BITPIX"]) // 8 * hdr.get("GCOUNT", 1) * (hdr.get("PCOUNT", 0) + n)


def _padded(n):
    return int(math.ceil(n / BLOCK) * BLOCK)


def _hdr_cache_path(key, ext):
    return HEADER_DIR / (os.path.basename(key) + ext)


def get_layout(key):
    """Offsets and header text of every HDU (cached as headers/<basename>.layout.json).

    Also caches the raw bytes of small HDUs (<= 8 KB data, i.e. WCS-WAVE) as base64.
    """
    p = _hdr_cache_path(key, ".layout.json")
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    HEADER_DIR.mkdir(parents=True, exist_ok=True)
    hdus = []
    off = 0
    total = None
    while True:
        hdr, hlen, tot = _read_header_at(key, off)
        total = total or tot
        dsize = _data_size(hdr)
        rec = dict(name=hdr.get("EXTNAME", "PRIMARY"), hdr_off=off, data_off=off + hlen,
                   data_size=dsize, header=hdr.tostring(endcard=True, padding=False))
        if 0 < dsize <= 8192 and hdr.get("XTENSION") == "BINTABLE":
            raw, _ = range_get(key, off, hlen + _padded(dsize))
            rec["raw_b64"] = base64.b64encode(raw).decode()
        hdus.append(rec)
        off = off + hlen + _padded(dsize)
        if total is not None and off >= total:
            break
    lay = dict(size=total, hdus=hdus)
    tmp = p.with_suffix(".tmp%d" % threading.get_ident())
    tmp.write_text(json.dumps(lay))
    tmp.replace(p)
    return lay


def read_image_header(key):
    """Primary + IMAGE header (HDU 1) as astropy Header, cached on disk as headers/<basename>.hdr."""
    p = _hdr_cache_path(key, ".hdr")
    if p.exists():
        return fits.Header.fromstring(p.read_text())
    HEADER_DIR.mkdir(parents=True, exist_ok=True)
    lay = _hdr_cache_path(key, ".layout.json")
    if lay.exists():
        text = json.loads(lay.read_text())["hdus"][1]["header"]
        hdr = fits.Header.fromstring(text)
    else:
        h0, l0, _ = _read_header_at(key, 0)
        off1 = l0 + _padded(_data_size(h0))
        hdr, _, _ = _read_header_at(key, off1)
    tmp = p.with_suffix(".tmp%d" % threading.get_ident())
    tmp.write_text(hdr.tostring(endcard=True, padding=False))
    tmp.replace(p)
    return hdr


# ---------------------------------------------------------------- WCS -----------------
_ALT_RE = re.compile(r"^(WCSAXES|CRPIX\d|CRVAL\d|CDELT\d|CUNIT\d|CTYPE\d|CNAME\d|CD\d_\d|PC\d_\d|"
                     r"PV\d_\d+|PS\d_\d+|LONPOLE|LATPOLE|WCSNAME|RADESYS|EQUINOX|MJDREF)[AW]$")
_SPATIAL_RE = re.compile(r"^(WCSAXES|CRPIX\d|CRVAL\d|CDELT\d|CUNIT\d|CTYPE\d|CD\d_\d|PC\d_\d|"
                         r"LONPOLE|LATPOLE|RADESYS|EQUINOX|A_.*|B_.*|AP_.*|BP_.*)$")


def spatial_header(hdr):
    """Copy of header without alternate-WCS (A/W) keys (avoids the astropy key-W crash)."""
    h = hdr.copy()
    for k in list(h.keys()):
        if _ALT_RE.match(k):
            del h[k]
    return h


def spatial_wcs(hdr):
    return WCS(spatial_header(hdr))


def target_pixel(header, ra, dec):
    """0-based detector pixel (x, y) of (ra, dec) using the SIP spatial WCS; on_detector flag."""
    w = spatial_wcs(header)
    x, y = w.all_world2pix(ra, dec, 0)
    x, y = float(x), float(y)
    on = bool(0 <= x <= NPIX - 1 and 0 <= y <= NPIX - 1)
    return x, y, on


# ---------------------------------------------------------------- cutouts -------------
def _read_rows(key, hdu, y0, y1):
    """float32 rows y0..y1 (full width) of an uncompressed 2040x2040 float32 HDU."""
    raw, _ = range_get(key, hdu["data_off"] + y0 * NPIX * 4, (y1 - y0) * NPIX * 4)
    return np.frombuffer(raw, dtype=">f4").reshape(y1 - y0, NPIX).astype(np.float32)


def _read_flag_rows(key, hdu, y0, y1):
    """Decode FLAGS (RICE_1, one tile per row) rows y0..y1 via an in-memory mini FITS file.

    Returns (int32 array (y1-y0, 2040), header of the decompressed image)."""
    th = fits.Header.fromstring(hdu["header"])
    rowlen, nrows = th["NAXIS1"], th["NAXIS2"]
    assert rowlen == 8 and th["ZTILE1"] == NPIX and th["ZTILE2"] == 1 and "THEAP" not in th
    n = y1 - y0
    desc_raw, _ = range_get(key, hdu["data_off"] + y0 * rowlen, n * rowlen)
    desc = np.frombuffer(desc_raw, dtype=">i4").reshape(n, 2).astype(np.int64)
    counts, offs = desc[:, 0], desc[:, 1]
    lo = int(offs.min())
    hi = int((offs + counts).max())
    heap_start = hdu["data_off"] + rowlen * nrows
    heap, _ = range_get(key, heap_start + lo, hi - lo)
    newdesc = np.stack([counts, offs - lo], axis=1).astype(">i4").tobytes()
    h = th.copy()
    h["NAXIS2"] = n
    h["ZNAXIS2"] = n
    h["PCOUNT"] = len(heap)
    body = newdesc + heap
    body += b"\0" * (_padded(len(body)) - len(body))
    prim = fits.PrimaryHDU().header.tostring(endcard=True, padding=True).encode("ascii")
    ht = h.tostring(endcard=True, padding=True).encode("ascii")
    with fits.open(_io.BytesIO(prim + ht + body)) as hl:
        data = np.array(hl[1].data, dtype=np.int32)
        hdr = hl[1].header.copy()
    return data, hdr


def _build_ext_header(own_hdr, img_hdr, x0, y0):
    """Own header minus alt-WCS and structural keys, with IMAGE spatial WCS and shifted CRPIX."""
    h = spatial_header(own_hdr)
    for k in list(h.keys()):
        if _SPATIAL_RE.match(k) and k in h:
            del h[k]
    for k in ("ZIMAGE", "ZTENSION", "ZBITPIX", "ZNAXIS", "ZNAXIS1", "ZNAXIS2", "ZPCOUNT", "ZGCOUNT",
              "ZTILE1", "ZTILE2", "ZCMPTYPE", "ZNAME1", "ZVAL1", "ZNAME2", "ZVAL2", "TFIELDS",
              "TTYPE1", "TFORM1"):
        if k in h:
            del h[k]
    sp = spatial_header(img_hdr)
    for card in sp.cards:
        if _SPATIAL_RE.match(card.keyword):
            h[card.keyword] = (card.value, card.comment)
    h["CRPIX1"] = (sp["CRPIX1"] - x0, sp.comments["CRPIX1"])
    h["CRPIX2"] = (sp["CRPIX2"] - y0, sp.comments["CRPIX2"])
    return h


def fetch_cutout(s3_key, x_c, y_c, half=160, out_path=None, meta=None):
    """Write a cutout FITS (see module docstring). Returns bytes downloaded (0 if cached)."""
    out_path = Path(out_path)
    if out_path.exists():
        return 0
    meta = meta or {}
    b0 = None
    lay = get_layout(s3_key)
    hd = {h["name"]: h for h in lay["hdus"]}
    img_hdr = read_image_header(s3_key)
    xi, yi = int(round(x_c)), int(round(y_c))
    x0, x1 = max(0, xi - half), min(NPIX, xi + half)
    y0, y1 = max(0, yi - half), min(NPIX, yi + half)
    sl = (slice(None), slice(x0, x1))
    image = _read_rows(s3_key, hd["IMAGE"], y0, y1)[sl]
    flags, fhdr = _read_flag_rows(s3_key, hd["FLAGS"], y0, y1)
    flags = flags[sl]
    var = _read_rows(s3_key, hd["VARIANCE"], y0, y1)[sl]
    zodi = _read_rows(s3_key, hd["ZODI"], y0, y1)[sl]

    prim = fits.PrimaryHDU()
    ph = prim.header
    ph["OBSID"] = img_hdr["OBSID"]
    ph["DETECTOR"] = int(img_hdr["DETECTOR"])
    ph["RELEASE"] = meta.get("release", "")
    ph["S3KEY"] = s3_key
    ph["MJD-AVG"] = img_hdr["MJD-AVG"]
    ph["DATE-AVG"] = img_hdr["DATE-AVG"]
    ph["MJD-BEG"] = img_hdr["MJD-BEG"]
    ph["MJD-END"] = img_hdr["MJD-END"]
    ph["PSF_FWHM"] = img_hdr["PSF_FWHM"]
    ph["X0"] = (x0, "0-based detector x of cutout pixel [0,0]")
    ph["Y0"] = (y0, "0-based detector y of cutout pixel [0,0]")
    ph["FIELD"] = meta.get("field", "")
    ph["VISIT"] = int(meta.get("visit", -1))

    def mk(data, own, name):
        h = _build_ext_header(own, img_hdr, x0, y0)
        hdu = fits.ImageHDU(np.ascontiguousarray(data), header=h, name=name)
        return hdu

    own_img = fits.Header.fromstring(hd["IMAGE"]["header"])
    hdus = [prim,
            mk(image, own_img, "IMAGE"),
            mk(flags, fhdr, "FLAGS"),
            mk(var, fits.Header.fromstring(hd["VARIANCE"]["header"]), "VARIANCE"),
            mk(zodi, fits.Header.fromstring(hd["ZODI"]["header"]), "ZODI")]
    raw = base64.b64decode(hd["WCS-WAVE"]["raw_b64"])
    with fits.open(_io.BytesIO(prim_bytes() + raw)) as hl:
        hdus.append(hl[1].copy())
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_name(out_path.name + ".tmp%d" % threading.get_ident())
    fits.HDUList(hdus).writeto(tmp, overwrite=True, output_verify="silentfix")
    tmp.replace(out_path)
    return 1


def prim_bytes():
    return fits.PrimaryHDU().header.tostring(endcard=True, padding=True).encode("ascii")


def fetch_many(jobs, workers=12, progress=None):
    """jobs: list of dict(s3_key, x_c, y_c, out_path, meta). Returns list of (job, err_or_None)."""
    results = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fetch_cutout, j["s3_key"], j["x_c"], j["y_c"], j.get("half", 160),
                          j["out_path"], j.get("meta")): j for j in jobs}
        for i, f in enumerate(as_completed(futs), 1):
            try:
                f.result()
                results.append((futs[f], None))
            except Exception as e:  # noqa: BLE001
                results.append((futs[f], repr(e)))
            if progress:
                progress(i, len(jobs))
    return results
