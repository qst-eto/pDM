import csv
import json
import os
import sqlite3
from pathlib import Path
from urllib.parse import unquote, urlparse
from .images import IMAGE_EXTENSIONS


def has_images(path):
    path = Path(path)
    return path.is_dir() and any(p.is_file() and p.suffix.lower() in IMAGE_EXTENSIONS
                                for p in path.rglob("*"))


def discover_data(explicit=None, project=None):
    if explicit:
        path = Path(explicit).expanduser().resolve()
        if not has_images(path):
            raise ValueError("No reference images in --data: {}".format(path))
        return path
    env = os.environ.get("DM_DATA_DIR")
    if env:
        return discover_data(env, project)
    project = Path(project or ".").resolve()
    # Prefer the caller's own catalog; do not silently select between several catalogs.
    for path in (Path.cwd() / "dm_data", project / "dm_data"):
        if has_images(path):
            return path.resolve()
    found = set()
    search_roots = [project.parent, Path.home() / "Desktop", Path.home() / "Documents",
                    Path.home() / "Downloads"]
    for root in search_roots:
        if not root.is_dir():
            continue
        for current, dirs, _ in os.walk(str(root)):
            rel = Path(current).relative_to(root)
            dirs[:] = [d for d in dirs if not d.startswith(".") and
                       d not in {"node_modules", "cache", "runs", "work", "AppData"}]
            if Path(current).name.lower() == "dm_data":
                if has_images(current):
                    found.add(Path(current).resolve())
                dirs[:] = []
            elif len(rel.parts) >= 3:
                dirs[:] = []
    if len(found) == 1:
        return next(iter(found))
    if len(found) > 1:
        raise ValueError("Several dm_data folders found; choose --data:\n" +
                         "\n".join(str(p) for p in sorted(found)))
    raise ValueError("dm_data was not found. Place reference images in {}/dm_data "
                     "or specify --data /path/to/dm_data".format(project))


def load_metadata(root):
    """Optional metadata; DB is strictly read-only and never required for matching."""
    root = Path(root)
    names = {}
    warnings = []
    database = root / "Duelmasters.db"
    if database.is_file():
        try:
            with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as conn:
                columns = {row[1] for row in conn.execute("PRAGMA table_info(cardlist)")}
                image_expr = "imagefile" if "imagefile" in columns else "NULL"
                rows = conn.execute("SELECT cardname, picturl, " + image_expr + " FROM cardlist")
                for name, url, raw in rows:
                    try:
                        files = json.loads(raw) if raw else []
                    except (TypeError, ValueError):
                        files = [raw]
                    if not isinstance(files, list):
                        files = [raw]
                    if url:
                        files.append(unquote(Path(urlparse(url).path).name))
                    for filename in files:
                        if filename and name:
                            key = Path(str(filename).replace("\\", "/")).name
                            names.setdefault(key, set()).add(name.strip())
        except sqlite3.Error as exc:
            warnings.append("Metadata DB could not be read: {}".format(exc))
    metadata = {key: {"card_name": " / ".join(sorted(value))}
                for key, value in names.items()}
    custom = root / "metadata.csv"
    if custom.is_file():
        with custom.open(encoding="utf-8-sig", newline="") as stream:
            for row in csv.DictReader(stream):
                if row.get("file"):
                    metadata[row["file"].replace("\\", "/")] = {
                        key: row[key] for key in ("card_id", "card_name", "identity_id")
                        if row.get(key)}
    return metadata, warnings
