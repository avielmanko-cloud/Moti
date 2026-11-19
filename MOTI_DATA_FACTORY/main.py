#!/usr/bin/env python3
"""MOTI Data Factory — CLI entry point.

    python main.py --setup
    python main.py --test
    python main.py --generate
    python main.py --generate --limit 100
    python main.py --stats
    python main.py --export
    python main.py --validate

See README.md (Hebrew) for the full walkthrough.
"""
import argparse
import json
import os
import shutil
import sys
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

import export_dataset
import generator
import quality_check
import statistics as stats_mod

REQUIRED_DIRS = [
    "data/raw", "data/approved", "data/rejected", "output", "logs", "state",
]


def cmd_setup(config):
    print("[setup] יוצר תיקיות...")
    for d in REQUIRED_DIRS:
        os.makedirs(os.path.join(BASE_DIR, d), exist_ok=True)
        print(f"  ✓ {d}")

    print("[setup] בודק שה-CLI של Claude זמין...")
    cli_path = shutil.which(config["claude_cli_path"]) or config["claude_cli_path"]
    if not shutil.which(config["claude_cli_path"]):
        print(f"  ✗ לא נמצא '{config['claude_cli_path']}' ב-PATH. ודא ש-Claude Code מותקן.")
        return 1
    print(f"  ✓ נמצא: {cli_path}")

    for required_file in [
        "prompts/personality.txt", "prompts/generation_rules.txt",
        "prompts/categories.txt", "prompts/quality_evaluation.txt",
    ]:
        full = os.path.join(BASE_DIR, required_file)
        status = "✓" if os.path.exists(full) else "✗ חסר"
        print(f"  {status} {required_file}")

    for key in ["progress_file", "category_progress_file"]:
        path = generator.resolve_path(config, key)
        if not os.path.exists(path):
            if "category" in key:
                generator.save_category_progress(config, generator.load_category_progress(config))
            else:
                generator.save_progress(config, generator.load_progress(config))
            print(f"  ✓ אותחל {config[key]}")
        else:
            print(f"  ✓ קיים כבר {config[key]}")

    print("\n[setup] הושלם. השלב הבא: python main.py --test")
    return 0


def cmd_test(config):
    print("[test] מריץ באטצ' בדיקה של 20 שיחות מאושרות...")
    logger = generator.setup_logging(config)
    result = generator.run_generation(config, logger, limit=20, max_batches=6)

    approved = result["approved_this_run"]
    print(f"\n[test] שיחות שאושרו בהרצה הזו: {approved}")
    print(f"[test] באטצ'ים שהורצו: {result['batches_run']}  |  שגיאות: {result['errors_this_run']}")

    if approved == 0:
        print("[test] נכשל — אף שיחה לא אושרה. בדוק logs/errors.log.")
        return 1

    # structural re-validation of everything just written, as an extra gate
    all_path = os.path.join(generator.resolve_path(config, "approved_dir"), "all.jsonl")
    ok_count, bad_count = 0, 0
    if os.path.exists(all_path):
        with open(all_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                conv = json.loads(line)
                ok, _ = quality_check.structural_check(conv, config)
                ok_count += 1 if ok else 0
                bad_count += 0 if ok else 1
    print(f"[test] אימות מבני חוזר על כל הדאטה המאושר עד כה: תקין={ok_count} פגום={bad_count}")

    if approved < 20:
        print(f"[test] אושרו רק {approved}/20 — ייתכן ששיעור הדחייה גבוה. בדוק data/rejected/ ו-logs/.")

    if bad_count > 0:
        print("[test] נכשל — נמצאו שיחות לא תקינות בדאטה המאושר.")
        return 1

    marker = {
        "passed_at": datetime.now(timezone.utc).isoformat(),
        "approved_in_test": approved,
        "batches_run": result["batches_run"],
    }
    with open(generator.resolve_path(config, "test_marker_file"), "w", encoding="utf-8") as f:
        json.dump(marker, f, ensure_ascii=False, indent=2)

    print("[test] עבר בהצלחה ✓  — עכשיו אפשר להריץ: python main.py --generate")
    return 0


def cmd_generate(config, limit):
    marker_path = generator.resolve_path(config, "test_marker_file")
    if not os.path.exists(marker_path):
        print("[generate] עדיין לא עבר בדיקה מוצלחת (--test). מריצים קודם:")
        print("  python main.py --test")
        return 1

    logger = generator.setup_logging(config)
    label = f"עד {limit} שיחות מאושרות נוספות" if limit else "עד 50,000 שיחות מאושרות (היעד המלא)"
    print(f"[generate] מתחיל ריצה: {label}")
    print("[generate] אפשר לעצור בכל רגע (Ctrl+C) ולהמשיך אח\"כ עם אותה פקודה — ההתקדמות נשמרת.")

    try:
        result = generator.run_generation(config, logger, limit=limit)
    except KeyboardInterrupt:
        print("\n[generate] הופסק ע\"י המשתמש. ההתקדמות נשמרה, אפשר להמשיך באותה פקודה.")
        return 130

    print(f"\n[generate] הושלם. אושרו בהרצה זו: {result['approved_this_run']}  "
          f"באטצ'ים: {result['batches_run']}  שגיאות: {result['errors_this_run']}")
    stats_mod.print_stats(config)
    return 0


def cmd_stats(config):
    stats_mod.print_stats(config)
    return 0


def cmd_export(config):
    logger = generator.setup_logging(config)
    count, out_path = export_dataset.export(config, logger=logger)
    print(f"[export] {count} שיחות יוצאו אל {out_path}")
    return 0 if count > 0 else 1


def cmd_validate(config):
    print("[validate] בודק את כל הדאטה המאושר...")
    approved_dir = generator.resolve_path(config, "approved_dir")
    total, ok, bad = 0, 0, 0
    bad_examples = []
    seen_hashes = set()
    dup_in_file = 0
    from deduplication import conversation_hash

    all_path = os.path.join(approved_dir, "all.jsonl")
    if not os.path.exists(all_path):
        print("[validate] אין עדיין דאטה מאושר (data/approved/all.jsonl לא קיים).")
        return 1

    with open(all_path, "r", encoding="utf-8") as f:
        for i, line in enumerate(f):
            line = line.strip()
            if not line:
                continue
            total += 1
            try:
                conv = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                bad_examples.append((i, "invalid JSON"))
                continue
            valid, reason = quality_check.structural_check(conv, config)
            if valid:
                ok += 1
                h = conversation_hash(conv)
                if h in seen_hashes:
                    dup_in_file += 1
                seen_hashes.add(h)
            else:
                bad += 1
                bad_examples.append((i, reason))

    print(f"[validate] סה\"כ נבדקו: {total}")
    print(f"[validate] תקינים:      {ok}")
    print(f"[validate] פגומים:      {bad}")
    print(f"[validate] כפילויות שנמצאו בתוך הקובץ המאושר: {dup_in_file}")
    if bad_examples:
        print("[validate] דוגמאות לבעיות (עד 10):")
        for i, reason in bad_examples[:10]:
            print(f"  שורה {i}: {reason}")
    return 0 if bad == 0 and dup_in_file == 0 else 1


def main():
    parser = argparse.ArgumentParser(description="MOTI Data Factory")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--setup", action="store_true")
    group.add_argument("--test", action="store_true")
    group.add_argument("--generate", action="store_true")
    group.add_argument("--stats", action="store_true")
    group.add_argument("--export", action="store_true")
    group.add_argument("--validate", action="store_true")
    parser.add_argument("--limit", type=int, default=None,
                         help="Cap the number of newly approved conversations this run produces (used with --generate)")
    args = parser.parse_args()

    config = generator.load_config(BASE_DIR)

    if args.setup:
        return cmd_setup(config)
    if args.test:
        return cmd_test(config)
    if args.generate:
        return cmd_generate(config, args.limit)
    if args.stats:
        return cmd_stats(config)
    if args.export:
        return cmd_export(config)
    if args.validate:
        return cmd_validate(config)
    return 1


if __name__ == "__main__":
    sys.exit(main())
