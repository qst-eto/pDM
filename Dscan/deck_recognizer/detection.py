"""Axis-aligned website thumbnails: connected-component grid, then contours.

No page-specific coordinates, expected card count or 8x5 assumption is used.
Bounding boxes are [x, y, width, height] in the ORIGINAL image, end exclusive.
"""
import cv2
import numpy as np


def _valid(w, h, min_width, aspect):
    return w >= min_width and h >= min_width and aspect[0] <= w / h <= aspect[1]


def _clusters(values, tolerance):
    groups = []
    for value in sorted(values):
        if not groups or value - np.mean(groups[-1]) > tolerance:
            groups.append([value])
        else:
            groups[-1].append(value)
    return [float(np.median(group)) for group in groups]


def _size_groups(boxes):
    groups = []
    for box in sorted(boxes, key=lambda b: b[2] * b[3], reverse=True):
        for group in groups:
            _, _, w, h = group[0]
            if abs(box[2] / w - 1) < .13 and abs(box[3] / h - 1) < .13:
                group.append(box)
                break
        else:
            groups.append([box])
    return groups


def _has_content(image, box):
    x, y, w, h = box
    crop = image[y:y+h, x:x+w]
    if crop.size == 0:
        return False
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    return float(gray.std()) > 12 and np.mean(cv2.Canny(gray, 50, 130) > 0) > .025


def _grid_from_components(image, boxes):
    proposals = []
    for group in _size_groups(boxes):
        if len(group) < 4:
            continue
        mw, mh = np.median(np.array(group)[:, 2:], axis=0)
        xs = _clusters([x for x, y, w, h in group], mw * .12)
        ys = _clusters([y for x, y, w, h in group], mh * .12)
        if len(xs) < 2 or len(ys) < 2:
            continue
        dx, dy = np.diff(xs), np.diff(ys)
        # Reject scattered logos and internal artwork rectangles. Allow empty cells.
        if (np.std(dx) / np.mean(dx) > .08 or np.std(dy) / np.mean(dy) > .08 or
                not .94 * mw <= np.median(dx) <= 1.7 * mw or
                not .94 * mh <= np.median(dy) <= 1.8 * mh):
            continue
        occupied = {(int(np.argmin(np.abs(np.array(xs) - b[0]))),
                     int(np.argmin(np.abs(np.array(ys) - b[1])))) for b in group}
        if len(occupied) / (len(xs) * len(ys)) < .65:
            continue
        cells = []
        for row, y in enumerate(ys):
            for col, x in enumerate(xs):
                box = tuple(int(round(v)) for v in (x, y, mw, mh))
                # Never create a blank last-row card just to fill the grid.
                if _has_content(image, box):
                    cells.append(box)
        proposals.append((cells, {"rows": len(ys), "columns": len(xs),
                                 "component_cells": len(occupied),
                                 "grid_cells": len(xs) * len(ys)}))
    return max(proposals, key=lambda item: len(item[0]), default=([], {}))


def _masks(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # A lower threshold avoids connecting cards through light gray HTML cell borders.
    for threshold in (200, 160, 235):
        yield "dark_{}".format(threshold), (gray < threshold).astype(np.uint8)
    yield "light_45", (gray > 45).astype(np.uint8)
    # A frequent flat page color also handles colored gutters.
    sample = image[::4, ::4].reshape(-1, 3).astype(np.int32)
    bins = sample // 16
    keys = bins[:, 0] * 256 + bins[:, 1] * 16 + bins[:, 2]
    common = np.bincount(keys, minlength=4096).argmax()
    background = np.median(sample[keys == common], axis=0)
    distance = np.max(np.abs(image.astype(np.float32) - background), axis=2)
    yield "page_color", (distance > 36).astype(np.uint8)


def _components(mask, min_width, aspect):
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    return [tuple(int(v) for v in (x, y, w, h)) for x, y, w, h, area in stats[1:]
            if _valid(w, h, min_width, aspect) and area / (w * h) > .35]


def _overlap(first, second):
    x, y, w, h = first
    xx, yy, ww, hh = second
    inter = max(0, min(x+w, xx+ww)-max(x, xx)) * max(0, min(y+h, yy+hh)-max(y, yy))
    return inter / max(1, min(w*h, ww*hh))


def _deduplicate(boxes):
    kept = []
    for box in sorted(boxes, key=lambda b: b[2] * b[3], reverse=True):
        if not any(_overlap(box, other) > .65 for other in kept):
            kept.append(box)
    return kept


def _reading_order(boxes):
    if not boxes:
        return []
    tolerance = np.median([b[3] for b in boxes]) * .35
    rows = []
    for box in sorted(boxes, key=lambda b: b[1]):
        if not rows or abs(box[1] - np.median([b[1] for b in rows[-1]])) > tolerance:
            rows.append([box])
        else:
            rows[-1].append(box)
    return [b for row in rows for b in sorted(row, key=lambda b: b[0])]


def detect(image, mode="auto", roi=None, grid=None, gap=(0, 0), min_width=24,
           aspect=(.58, .82), max_size=1800):
    height, width = image.shape[:2]
    ox, oy, rw, rh = roi or (0, 0, width, height)
    if ox < 0 or oy < 0 or rw <= 0 or rh <= 0 or ox+rw > width or oy+rh > height:
        raise ValueError("ROI must be a positive box within the input image.")
    region = image[oy:oy+rh, ox:ox+rw]
    if grid:
        rows, cols = grid
        gx, gy = gap
        if min(rows, cols) < 1:
            raise ValueError("Grid rows and columns must be positive.")
        cw, ch = (rw - (cols-1)*gx) / cols, (rh - (rows-1)*gy) / rows
        if min(rows, cols) < 1 or min(gx, gy) < 0 or min(cw, ch) < 8:
            raise ValueError("Invalid grid dimensions or gaps.")
        boxes = []
        for row in range(rows):
            for col in range(cols):
                x, y = round(col*(cw+gx)), round(row*(ch+gy))
                x2, y2 = round(col*(cw+gx)+cw), round(row*(ch+gy)+ch)
                box = (x, y, x2-x, y2-y)
                if _has_content(region, box):
                    boxes.append((x+ox, y+oy, x2-x, y2-y))
        return boxes, {"method": "manual_grid", "rows": rows, "columns": cols,
                       "roi": [ox, oy, rw, rh]}
    scale = min(1.0, max_size / max(rw, rh))
    small = cv2.resize(region, (round(rw*scale), round(rh*scale))) if scale < 1 else region
    masks = list(_masks(small))
    candidates = []
    if mode != "contours":
        for mask_name, mask in masks:
            boxes = _components(mask, max(12, round(min_width*scale)), aspect)
            cells, info = _grid_from_components(small, boxes)
            if cells:
                candidates.append((cells, dict(info, mask=mask_name)))
    if candidates:
        boxes, info = max(candidates, key=lambda item: len(item[0]))
        info["method"] = "auto_grid"
    else:
        if mode == "grid":
            raise ValueError("No regular grid found; use auto/contours or --grid with --roi.")
        boxes = []
        edges = cv2.Canny(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 45, 140)
        edge_masks = [edges, cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))]
        for mask in [m for _, m in masks] + edge_masks:
            contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
            for contour in contours:
                x, y, w, h = cv2.boundingRect(contour)
                if (_valid(w, h, max(12, round(min_width*scale)), aspect) and
                        cv2.contourArea(contour) / (w*h) > .68):
                    boxes.append((x, y, w, h))
        boxes = _deduplicate(boxes)
        boxes = [b for b in boxes if _has_content(small, b)]
        # Retain repeated sizes; for single-card images keep the largest rectangle.
        groups = _size_groups(boxes)
        repeated = [b for group in groups if len(group) >= 2 for b in group]
        boxes = repeated if repeated else sorted(boxes, key=lambda b: b[2]*b[3], reverse=True)[:1]
        info = {"method": "contours", "fallback_used": mode == "auto"}
    mapped = []
    for x, y, w, h in boxes:
        x1, y1 = max(0, round(x/scale)), max(0, round(y/scale))
        x2, y2 = min(rw, round((x+w)/scale)), min(rh, round((y+h)/scale))
        mapped.append((x1+ox, y1+oy, x2-x1, y2-y1))
    info.update(roi=[ox, oy, rw, rh], detection_scale=scale)
    return _reading_order(mapped), info
