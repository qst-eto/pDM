import hashlib
import json
from pathlib import Path
import time
import zipfile
import numpy as np
from .catalog import load_metadata
from .features import extract, FEATURE_VERSION
from .images import image_files, read_image

FEATURE_KEYS = ("hashes", "art_hashes", "histograms", "spatial", "grays")


def build_index(root, cache_dir, rebuild=False):
    root = Path(root).resolve()
    files = image_files(root)
    if not files:
        raise ValueError("Reference directory is empty: {}".format(root))
    manifest = [(p.relative_to(root).as_posix(), p.stat().st_size, p.stat().st_mtime_ns)
                for p in files]
    for filename in ("Duelmasters.db", "Duelmasters.db-wal", "metadata.csv"):
        path = root / filename
        if path.is_file():
            manifest.append((filename, path.stat().st_size, path.stat().st_mtime_ns))
    fingerprint = hashlib.sha256(json.dumps(
        [str(root), FEATURE_VERSION, manifest], ensure_ascii=False).encode("utf-8")).hexdigest()
    cache_dir = Path(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / ("index_" + fingerprint[:20] + ".npz")
    started = time.perf_counter()
    if cache_path.is_file() and not rebuild:
        try:
            with np.load(str(cache_path), allow_pickle=False) as cached:
                meta = json.loads(str(cached["metadata"]))
                result = {key: cached[key] for key in FEATURE_KEYS}
                if meta["fingerprint"] != fingerprint or any(
                        len(result[k]) != len(meta["entries"]) for k in FEATURE_KEYS):
                    raise ValueError("Cache shape/fingerprint mismatch")
                result.update(meta)
            result.update(cache_hit=True, index_seconds=time.perf_counter() - started)
            return result
        except (ValueError, OSError, KeyError, EOFError, zipfile.BadZipFile):
            print("Cache could not be loaded; rebuilding it.", flush=True)
    metadata, warnings = load_metadata(root)
    entries, skipped = [], []
    features = {key: [] for key in FEATURE_KEYS}
    for number, path in enumerate(files, 1):
        relative = path.relative_to(root).as_posix()
        try:
            image = read_image(path)
            if min(image.shape[:2]) < 16:
                raise ValueError("Reference is smaller than 16 pixels")
            values = extract(image)
        except (ValueError, OSError) as exc:
            skipped.append({"file": relative, "reason": str(exc)})
            continue
        for key in FEATURE_KEYS:
            features[key].append(values[key])
        extra = metadata.get(relative, metadata.get(path.name, {}))
        card_id = extra.get("card_id", Path(relative).with_suffix("").as_posix())
        name = extra.get("card_name", "")
        entries.append({"card_id": card_id, "file": relative, "card_name": name,
                        "identity_id": extra.get("identity_id", "name:" + name if name else card_id)})
        if number % 500 == 0:
            print("Index: {}/{} images".format(number, len(files)), flush=True)
    if not entries:
        raise ValueError("All reference images failed to decode.")
    result = {key: np.stack(value) for key, value in features.items()}
    meta = {"fingerprint": fingerprint, "reference_root": str(root), "entries": entries,
            "skipped_files": skipped, "warnings": warnings, "feature_version": FEATURE_VERSION}
    temporary = cache_path.with_suffix(".tmp")
    with temporary.open("wb") as stream:
        np.savez_compressed(stream, metadata=np.array(json.dumps(meta, ensure_ascii=False)), **result)
    temporary.replace(cache_path)
    result.update(meta)
    result.update(cache_hit=False, index_seconds=time.perf_counter() - started)
    return result
