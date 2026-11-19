"""Dataset statistics and a plain-ASCII terminal progress bar (no extra deps)."""
import json
import os

from generator import load_config, load_progress, load_category_progress, resolve_path


def render_bar(current, total, width=36):
    total = max(total, 1)
    frac = min(1.0, current / total)
    filled = int(width * frac)
    bar = "#" * filled + "-" * (width - filled)
    return f"[{bar}] {frac * 100:5.1f}%"


def _scan_rejected_reasons(config):
    dup_count = 0
    total_rejected_lines = 0
    rejected_dir = resolve_path(config, "rejected_dir")
    if not os.path.isdir(rejected_dir):
        return 0, 0
    for fname in os.listdir(rejected_dir):
        if not fname.endswith(".jsonl"):
            continue
        with open(os.path.join(rejected_dir, fname), "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                total_rejected_lines += 1
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if str(rec.get("rejection_reason", "")).startswith("duplicate"):
                    dup_count += 1
    return dup_count, total_rejected_lines


def _scan_approved_for_averages(config):
    all_path = os.path.join(resolve_path(config, "approved_dir"), "all.jsonl")
    if not os.path.exists(all_path):
        return 0.0, 0.0
    total_messages = 0
    total_chars = 0
    count = 0
    with open(all_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            msgs = rec.get("messages", [])
            total_messages += len(msgs)
            total_chars += sum(len(m.get("content", "")) for m in msgs)
            count += 1
    if count == 0:
        return 0.0, 0.0
    return total_messages / count, total_chars / count


def compute_stats(config):
    progress = load_progress(config)
    category_progress = load_category_progress(config)
    dup_count, total_rejected_lines = _scan_rejected_reasons(config)
    avg_messages, avg_chars = _scan_approved_for_averages(config)

    target_total = config["target_total"]
    total_approved = progress.get("total_approved", 0)
    remaining = max(0, target_total - total_approved)
    total_batches = progress.get("total_batches", 0)
    avg_approved_per_batch = (total_approved / total_batches) if total_batches else (
        (config["batch_size_min"] + config["batch_size_max"]) / 2 * 0.6
    )
    estimated_remaining_batches = (remaining / avg_approved_per_batch) if avg_approved_per_batch else None

    return {
        "target_total": target_total,
        "total_generated": progress.get("total_generated", 0),
        "total_approved": total_approved,
        "total_rejected": progress.get("total_rejected", 0),
        "total_errors": progress.get("total_errors", 0),
        "total_cost_usd": progress.get("total_cost_usd", 0.0),
        "total_batches": total_batches,
        "remaining": remaining,
        "progress_pct": (total_approved / target_total * 100) if target_total else 0.0,
        "duplicate_count": dup_count,
        "total_rejected_lines_on_disk": total_rejected_lines,
        "avg_messages_per_conversation": avg_messages,
        "avg_chars_per_conversation": avg_chars,
        "estimated_remaining_batches": estimated_remaining_batches,
        "category_progress": category_progress,
        "category_targets": {slug: meta["target"] for slug, meta in config["categories"].items()},
        "category_names_he": {slug: meta["name_he"] for slug, meta in config["categories"].items()},
        "last_updated": progress.get("last_updated"),
    }


def print_stats(config):
    s = compute_stats(config)
    print("=" * 64)
    print("MOTI DATA FACTORY — סטטיסטיקה")
    print("=" * 64)
    print(f"סה\"כ נוצרו (raw):      {s['total_generated']}")
    print(f"סה\"כ אושרו:            {s['total_approved']} / {s['target_total']}")
    print(f"סה\"כ נדחו:             {s['total_rejected']}  (מתוכן כפילויות: {s['duplicate_count']})")
    print(f"שגיאות:                {s['total_errors']}")
    print(f"עלות מצטברת (הערכה):   ${s['total_cost_usd']:.2f}")
    print(f"נותרו עד ליעד:         {s['remaining']}")
    print(f"עדכון אחרון:           {s['last_updated']}")
    print()
    print("התקדמות כוללת:")
    print(" ", render_bar(s["total_approved"], s["target_total"]))
    print()
    print("ממוצעים:")
    print(f"  הודעות לשיחה: {s['avg_messages_per_conversation']:.1f}")
    print(f"  תווים עבריים לשיחה (מוערך): {s['avg_chars_per_conversation']:.0f}")
    if s["estimated_remaining_batches"] is not None:
        print(f"  הערכת באטצ'ים נותרים: {s['estimated_remaining_batches']:.0f}")
    print()
    print("התקדמות לפי קטגוריה:")
    for slug, target in s["category_targets"].items():
        approved = s["category_progress"].get(slug, {}).get("approved", 0)
        name = s["category_names_he"][slug]
        print(f"  {name:28s} {render_bar(approved, target, width=24)}  {approved}/{target}")
    print("=" * 64)


if __name__ == "__main__":
    import sys
    base_dir = os.path.dirname(os.path.abspath(__file__))
    print_stats(load_config(base_dir))
