"""Batch generation orchestration for MOTI Data Factory.

One call to generate_one_batch() = one Claude CLI invocation producing ~20-30
conversations for a single category, run through structural + dedup checks,
then (selectively) a semantic check, with survivors appended to disk
immediately. Progress is persisted after every batch so a run can be killed
and resumed at any point without losing or re-doing completed work.
"""
import json
import logging
import os
import random
import time
import uuid
from datetime import datetime, timezone

import claude_client
import quality_check
from deduplication import DedupIndex

GENERATION_SCHEMA = {
    "type": "object",
    "properties": {
        "conversations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "messages": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "role": {"type": "string", "enum": ["user", "assistant"]},
                                "content": {"type": "string"},
                            },
                            "required": ["role", "content"],
                        },
                    }
                },
                "required": ["messages"],
            },
        }
    },
    "required": ["conversations"],
}


def load_config(base_dir):
    with open(os.path.join(base_dir, "config.json"), "r", encoding="utf-8") as f:
        config = json.load(f)
    config["_base_dir"] = base_dir
    return config


def resolve_path(config, key):
    return os.path.join(config["_base_dir"], config[key])


def setup_logging(config):
    logger = logging.getLogger("moti_factory")
    logger.setLevel(logging.DEBUG)
    logger.handlers.clear()

    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")

    gen_handler = logging.FileHandler(resolve_path(config, "generation_log"), encoding="utf-8")
    gen_handler.setLevel(logging.INFO)
    gen_handler.setFormatter(fmt)
    logger.addHandler(gen_handler)

    err_handler = logging.FileHandler(resolve_path(config, "error_log"), encoding="utf-8")
    err_handler.setLevel(logging.WARNING)
    err_handler.setFormatter(fmt)
    logger.addHandler(err_handler)

    console = logging.StreamHandler()
    console.setLevel(logging.INFO)
    console.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(console)

    return logger


def load_prompt(config, name):
    with open(os.path.join(config["_base_dir"], "prompts", name), "r", encoding="utf-8") as f:
        return f.read()


def build_system_prompt(config):
    return load_prompt(config, "personality.txt") + "\n\n" + load_prompt(config, "generation_rules.txt")


def load_category_descriptions(config):
    text = load_prompt(config, "categories.txt")
    blocks = {}
    current = None
    for line in text.splitlines():
        if line.startswith("### "):
            current = line[4:].strip()
            blocks[current] = []
        elif current:
            blocks[current].append(line)
    return {slug: "\n".join(lines).strip() for slug, lines in blocks.items()}


# ── State persistence (atomic: write temp file, then replace) ───────────────

def _atomic_write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_progress(config):
    path = resolve_path(config, "progress_file")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    return {
        "total_generated": 0, "total_approved": 0, "total_rejected": 0,
        "total_errors": 0, "total_cost_usd": 0.0, "total_batches": 0,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "last_updated": None,
    }


def save_progress(config, progress):
    progress["last_updated"] = datetime.now(timezone.utc).isoformat()
    _atomic_write_json(resolve_path(config, "progress_file"), progress)


def load_category_progress(config):
    path = resolve_path(config, "category_progress_file")
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = {}
    for slug in config["categories"]:
        data.setdefault(slug, {"approved": 0, "generated": 0, "rejected": 0})
    return data


def save_category_progress(config, category_progress):
    _atomic_write_json(resolve_path(config, "category_progress_file"), category_progress)


def build_dedup_index(config):
    index = DedupIndex(window_per_category=config["near_duplicate_window_per_category"])
    index.load_from_approved(resolve_path(config, "approved_dir"), list(config["categories"].keys()))
    return index


# ── Category selection ───────────────────────────────────────────────────────

def pick_next_category(config, category_progress):
    """Most-behind-proportionally category that hasn't hit its target yet."""
    candidates = []
    for slug, meta in config["categories"].items():
        approved = category_progress[slug]["approved"]
        target = meta["target"]
        if approved >= target:
            continue
        ratio = approved / target if target else 1.0
        candidates.append((ratio, slug))
    if not candidates:
        return None
    candidates.sort(key=lambda x: (x[0], x[1]))
    return candidates[0][1]


# ── Persisting conversations ────────────────────────────────────────────────

def _append_jsonl(path, records):
    if not records:
        return
    with open(path, "a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def persist_approved(config, category_slug, conversations):
    _append_jsonl(os.path.join(resolve_path(config, "approved_dir"), f"{category_slug}.jsonl"), conversations)
    _append_jsonl(os.path.join(resolve_path(config, "approved_dir"), "all.jsonl"), conversations)


def persist_rejected(config, category_slug, rejected_pairs):
    records = [{**conv, "rejection_reason": reason} for conv, reason in rejected_pairs]
    _append_jsonl(os.path.join(resolve_path(config, "rejected_dir"), f"{category_slug}.jsonl"), records)


def persist_raw(config, category_slug, conversations):
    _append_jsonl(os.path.join(resolve_path(config, "raw_dir"), f"{category_slug}.jsonl"), conversations)


# ── Prompt building ──────────────────────────────────────────────────────────

def build_batch_prompt(category_slug, category_desc, batch_size, seeds, recent_openings):
    lines = [
        f"קטגוריה: {category_desc}",
        "",
        f"כתוב בדיוק {batch_size} שיחות שונות לגמרי זו מזו עבור הקטגוריה הזו.",
        "",
        "זרעי תרחישים להשראה (לא חובה להשתמש בכולם, ולא חובה להיצמד מילולית — גוון עוד יותר):",
    ]
    for s in seeds:
        lines.append(f"- {s}")
    if recent_openings:
        lines.append("")
        lines.append("אל תפתח שיחה חדשה באופן דומה לפתיחות האלה שכבר נוצרו:")
        for o in recent_openings:
            lines.append(f"- {o}")
    return "\n".join(lines)


# ── One batch ─────────────────────────────────────────────────────────────────

def generate_one_batch(config, logger, system_prompt, category_descriptions,
                        dedup_index, category_progress, category_slug, rng=None):
    import scenarios

    rng = rng or random
    meta = config["categories"][category_slug]
    remaining = max(0, meta["target"] - category_progress[category_slug]["approved"])
    batch_size = rng.randint(config["batch_size_min"], config["batch_size_max"])
    batch_size = max(1, min(batch_size, remaining)) if remaining else batch_size

    seeds = scenarios.sample_scenario_seeds(category_slug, config["scenario_seeds_per_batch"], rng=rng)
    recent_openings = rng.sample(
        list(dedup_index.opening_signatures), k=min(10, len(dedup_index.opening_signatures))
    ) if dedup_index.opening_signatures else []

    prompt = build_batch_prompt(category_slug, category_descriptions.get(category_slug, category_slug),
                                 batch_size, seeds, recent_openings)

    summary = {
        "category": category_slug, "requested": batch_size, "generated": 0,
        "structurally_rejected": 0, "semantically_rejected": 0, "approved": 0,
        "cost_usd": 0.0, "error": None,
    }

    try:
        result = claude_client.call_claude_with_retries(
            prompt, system_prompt, GENERATION_SCHEMA, config, logger=logger
        )
    except claude_client.ClaudeCallError as e:
        logger.error("batch generation failed for %s: %s", category_slug, e)
        summary["error"] = str(e)
        return summary

    summary["cost_usd"] += result.cost_usd
    raw_conversations = result.data.get("conversations", []) if isinstance(result.data, dict) else []
    summary["generated"] = len(raw_conversations)

    now = datetime.now(timezone.utc).isoformat()
    conversations = []
    for raw in raw_conversations:
        if not isinstance(raw, dict) or "messages" not in raw:
            continue
        conversations.append({
            "id": str(uuid.uuid4()),
            "category": category_slug,
            "messages": raw["messages"],
            "created_at": now,
        })

    persist_raw(config, category_slug, conversations)

    structurally_approved, structurally_rejected = quality_check.deterministic_pass(
        conversations, config, dedup_index
    )
    summary["structurally_rejected"] = len(structurally_rejected)

    final_approved = []
    semantically_rejected = []
    if config.get("semantic_check_enabled") and structurally_approved:
        eval_system_prompt = system_prompt + "\n\n" + load_prompt(config, "quality_evaluation.txt")
        chunk_size = config["semantic_check_batch_size"]
        for i in range(0, len(structurally_approved), chunk_size):
            chunk = structurally_approved[i:i + chunk_size]
            verdicts = quality_check.semantic_check_batch(chunk, eval_system_prompt, config, logger=logger)
            for conv in chunk:
                approved, reason = verdicts.get(conv["id"], (True, "no verdict"))
                if approved:
                    final_approved.append(conv)
                else:
                    semantically_rejected.append((conv, f"semantic: {reason}"))
    else:
        final_approved = structurally_approved

    summary["semantically_rejected"] = len(semantically_rejected)
    summary["approved"] = len(final_approved)

    persist_approved(config, category_slug, final_approved)
    persist_rejected(config, category_slug, structurally_rejected + semantically_rejected)
    for conv in final_approved:
        dedup_index.register(conv, category_slug)

    cp = category_progress[category_slug]
    cp["approved"] += len(final_approved)
    cp["generated"] += summary["generated"]
    cp["rejected"] += summary["structurally_rejected"] + summary["semantically_rejected"]

    logger.info(
        "[%s] requested=%d generated=%d approved=%d rejected(struct=%d, semantic=%d) cost=$%.4f",
        category_slug, batch_size, summary["generated"], summary["approved"],
        summary["structurally_rejected"], summary["semantically_rejected"], summary["cost_usd"],
    )
    return summary


# ── Full run loop ────────────────────────────────────────────────────────────

def run_generation(config, logger, limit=None, max_batches=None):
    """Generates until every category hits its target, or `limit` additional
    approved conversations have been produced (used by --test and --limit),
    or `max_batches` batches have run (safety valve). Returns a run summary.
    """
    system_prompt = build_system_prompt(config)
    category_descriptions = load_category_descriptions(config)
    dedup_index = build_dedup_index(config)
    progress = load_progress(config)
    category_progress = load_category_progress(config)
    rng = random.Random()

    approved_this_run = 0
    batches_run = 0
    errors_this_run = 0

    while True:
        if limit is not None and approved_this_run >= limit:
            break
        if max_batches is not None and batches_run >= max_batches:
            break
        category_slug = pick_next_category(config, category_progress)
        if category_slug is None:
            logger.info("all category targets reached — generation complete")
            break

        summary = generate_one_batch(
            config, logger, system_prompt, category_descriptions,
            dedup_index, category_progress, category_slug, rng=rng
        )
        batches_run += 1

        if summary["error"]:
            errors_this_run += 1
            progress["total_errors"] += 1
        else:
            progress["total_generated"] += summary["generated"]
            progress["total_approved"] += summary["approved"]
            progress["total_rejected"] += summary["structurally_rejected"] + summary["semantically_rejected"]
            progress["total_cost_usd"] += summary["cost_usd"]
            progress["total_batches"] += 1
            approved_this_run += summary["approved"]

        save_progress(config, progress)
        save_category_progress(config, category_progress)

    return {
        "approved_this_run": approved_this_run,
        "batches_run": batches_run,
        "errors_this_run": errors_this_run,
        "progress": progress,
        "category_progress": category_progress,
    }
