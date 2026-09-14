import numpy as np
from .features import query_variants, ssim


def match_card(image, index, top_k=5, shortlist=30, min_score=.76, min_margin=.025):
    variants = list(query_variants(image))
    quick = []
    components = []
    for query in variants:
        hdist = np.count_nonzero(index["hashes"] != query["hashes"], axis=1) / 255.0
        adist = np.count_nonzero(index["art_hashes"] != query["art_hashes"], axis=1) / 255.0
        hash_score = 1 - (.8 * hdist + .2 * adist)
        histogram = np.clip(index["histograms"] @ query["histograms"], 0, 1)
        color = np.clip(1 - 3 * np.mean(np.abs(index["spatial"] - query["spatial"]), axis=1), 0, 1)
        quick.append(.65 * hash_score + .15 * histogram + .20 * color)
        components.append((hash_score, histogram, color, hdist))
    rank = np.max(quick, axis=0)
    count = min(len(rank), max(shortlist, top_k, 2))
    selected = np.argsort(-rank, kind="stable")[:count]
    candidates = []
    for i in selected:
        best = None
        for v, query in enumerate(variants):
            hash_score, histogram, color, hdist = components[v]
            structural = max(0, ssim(query["grays"], index["grays"][i]))
            score = .30*hash_score[i] + .10*histogram[i] + .15*color[i] + .45*structural
            item = dict(index["entries"][int(i)], score=float(score),
                        phash_distance=int(round(hdist[i] * 255)),
                        hash_similarity=float(hash_score[i]), color_similarity=float(color[i]),
                        histogram_similarity=float(histogram[i]), ssim=structural,
                        query_variant=v)
            if best is None or item["score"] > best["score"]:
                best = item
        candidates.append(best)
    candidates.sort(key=lambda c: (-c["score"], c["file"]))
    first = candidates[0]
    margin = first["score"] - candidates[1]["score"] if len(candidates) > 1 else None
    other_identity = next((c for c in candidates[1:] if c["identity_id"] != first["identity_id"]), None)
    identity_margin = first["score"] - other_identity["score"] if other_identity else None
    if first["score"] < min_score:
        status = "unknown"
    elif margin is not None and margin < min_margin:
        status = "ambiguous"
    else:
        status = "matched"
    identity_status = "unknown" if first["score"] < min_score else (
        "ambiguous" if identity_margin is not None and identity_margin < min_margin else "matched")
    for candidate in candidates:
        for key, value in list(candidate.items()):
            if isinstance(value, float):
                candidate[key] = round(value, 6)
    return {"status": status, "identity_status": identity_status,
            "final_card_id": first["card_id"] if status == "matched" else None,
            "final_file": first["file"] if status == "matched" else None,
            "final_identity_id": first["identity_id"] if identity_status == "matched" else None,
            "final_card_name": first["card_name"] if identity_status == "matched" else None,
            "best_score": first["score"], "margin": None if margin is None else round(margin, 6),
            "identity_margin": None if identity_margin is None else round(identity_margin, 6),
            "candidates": candidates[:top_k]}
