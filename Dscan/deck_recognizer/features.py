"""DCT pHash (256 bits), HSV histogram, spatial Lab color, Gaussian-window SSIM."""
import cv2
import numpy as np

SIZE = (96, 136)
FEATURE_VERSION = 1


def phash(gray):
    small = cv2.resize(gray, (64, 64), interpolation=cv2.INTER_AREA)
    block = cv2.dct(small.astype(np.float32))[:16, :16].ravel()
    bits = block > np.median(block[1:])
    bits[0] = False  # Ignore DC; brightness should not determine the hash.
    return bits.astype(np.uint8)


def extract(image):
    thumb = cv2.resize(image, SIZE, interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(thumb, cv2.COLOR_BGR2GRAY)
    core = thumb[3:-3, 2:-2]
    hsv = cv2.cvtColor(core, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1], None, [16, 8], [0, 180, 0, 256]).ravel()
    hist = np.sqrt(hist / max(float(hist.sum()), 1.0)).astype(np.float32)
    spatial = cv2.resize(cv2.cvtColor(core, cv2.COLOR_BGR2LAB), (8, 8),
                         interpolation=cv2.INTER_AREA).astype(np.float32).ravel() / 255
    return {"hashes": phash(gray[3:-3, 2:-2]),
            "art_hashes": phash(gray[18:82, 4:-4]),
            "histograms": hist, "spatial": spatial, "grays": gray}


def ssim(first, second):
    # Standard local SSIM equation, 11x11 Gaussian (sigma=1.5), L=255.
    # Compare below the usual screenshot resolution. This avoids penalizing a
    # high-resolution reference for retaining details lost by browser downsampling.
    first = cv2.resize(first, (64, 90), interpolation=cv2.INTER_AREA)
    second = cv2.resize(second, (64, 90), interpolation=cv2.INTER_AREA)
    # Exclude exterior 3 pixels and window border to reduce thumbnail frame noise.
    a = first[3:-3, 3:-3].astype(np.float32)
    b = second[3:-3, 3:-3].astype(np.float32)
    blur = lambda x: cv2.GaussianBlur(x, (11, 11), 1.5)
    ma, mb = blur(a), blur(b)
    va = np.maximum(blur(a * a) - ma * ma, 0)
    vb = np.maximum(blur(b * b) - mb * mb, 0)
    cov = blur(a * b) - ma * mb
    value = ((2 * ma * mb + 6.5025) * (2 * cov + 58.5225) /
             ((ma * ma + mb * mb + 6.5025) * (va + vb + 58.5225)))
    return float(np.clip(value[5:-5, 5:-5].mean(), -1, 1))


def query_variants(image):
    # Small gutter/border errors are frequent in screenshots; no camera transforms.
    yield extract(image)
    h, w = image.shape[:2]
    for fraction in (0.015, 0.03):
        dx, dy = max(1, round(w * fraction)), max(1, round(h * fraction))
        if h > 2 * dy + 12 and w > 2 * dx + 12:
            yield extract(image[dy:h-dy, dx:w-dx])
