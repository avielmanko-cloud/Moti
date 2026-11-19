"""Quality control: deterministic structural checks (fast, Python-only) plus a
selective Claude-based semantic pass for personality/naturalness, which no
amount of regex can verify. Passing the structural check is necessary but not
sufficient for approval — see generator.py for how the two are combined.

These automated checks catch structural and statistical problems; they do not
guarantee literary-quality Hebrew. The semantic pass is a second LLM's
judgment, not a ground truth — both are explicitly a best-effort gate, which
is why rejected samples are kept (with reasons) rather than silently dropped.
"""
import re

import claude_client
from deduplication import normalize_text

HEBREW_RE = re.compile(r"[֐-׿]")
LATIN_RE = re.compile(r"[A-Za-z]")
LETTER_RE = re.compile(r"[^\W\d_]", re.UNICODE)


def hebrew_letter_ratio(text):
    letters = LETTER_RE.findall(text)
    if not letters:
        return 0.0
    hebrew = sum(1 for c in letters if HEBREW_RE.match(c))
    return hebrew / len(letters)


def latin_letter_ratio(text):
    letters = LETTER_RE.findall(text)
    if not letters:
        return 0.0
    latin = sum(1 for c in letters if LATIN_RE.match(c))
    return latin / len(letters)


def structural_check(conv, config):
    """Returns (ok, reason). reason is None when ok."""
    messages = conv.get("messages")
    if not isinstance(messages, list) or not messages:
        return False, "no messages"

    n = len(messages)
    if n < config["min_messages_per_conversation"] or n > config["max_messages_per_conversation"]:
        return False, f"message count {n} out of range"

    if messages[0].get("role") != "user":
        return False, "conversation does not start with user"
    if messages[-1].get("role") != "assistant":
        return False, "conversation does not end with assistant"

    expected_role = "user"
    seen_text = []
    for i, m in enumerate(messages):
        role = m.get("role")
        content = m.get("content")
        if role not in ("user", "assistant"):
            return False, f"invalid role at index {i}: {role!r}"
        if role != expected_role:
            return False, f"roles not strictly alternating at index {i}"
        expected_role = "assistant" if expected_role == "user" else "user"

        if not isinstance(content, str) or not content.strip():
            return False, f"empty message at index {i}"
        if re.fullmatch(r"[\W_]+", content.strip(), flags=re.UNICODE):
            return False, f"punctuation-only message at index {i}"
        if len(content) > config["max_message_chars"]:
            return False, f"message at index {i} exceeds {config['max_message_chars']} chars"

        heb_ratio = hebrew_letter_ratio(content)
        if heb_ratio < config["min_hebrew_letter_ratio"] and LETTER_RE.search(content):
            return False, f"message at index {i} is not sufficiently Hebrew ({heb_ratio:.0%})"
        lat_ratio = latin_letter_ratio(content)
        if lat_ratio > config["max_latin_letter_ratio"]:
            return False, f"message at index {i} has too much Latin text ({lat_ratio:.0%})"

        seen_text.append(normalize_text(content))

    # excessive repetition: two messages in the same conversation nearly identical
    for i in range(len(seen_text)):
        for j in range(i + 1, len(seen_text)):
            if seen_text[i] and seen_text[i] == seen_text[j]:
                return False, f"messages {i} and {j} are duplicates within the conversation"

    return True, None


def deterministic_pass(conversations, config, dedup_index):
    """Runs structural + dedup checks. Returns (approved, rejected) lists of
    (conversation, reason) for rejected — approved items are bare conversations
    ready for the semantic pass. Does NOT register approvals in dedup_index;
    the caller does that only after the semantic pass (and persistence) too,
    via dedup_index.register(), to keep this function side-effect-light."""
    approved, rejected = [], []
    for conv in conversations:
        ok, reason = structural_check(conv, config)
        if not ok:
            rejected.append((conv, f"structural: {reason}"))
            continue
        if dedup_index.is_exact_duplicate(conv):
            rejected.append((conv, "duplicate: exact match of an existing conversation"))
            continue
        category = conv.get("category")
        if dedup_index.near_duplicate_match(conv, category, config["near_duplicate_jaccard_threshold"]):
            rejected.append((conv, "duplicate: near-duplicate of a recent conversation in this category"))
            continue
        if dedup_index.is_repetitive_opening(conv):
            rejected.append((conv, "repetitive opening phrase already seen"))
            continue
        approved.append(conv)
    return approved, rejected


SEMANTIC_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "conversation_id": {"type": "string"},
                    "approved": {"type": "boolean"},
                    "reason": {"type": "string"},
                },
                "required": ["conversation_id", "approved", "reason"],
            },
        }
    },
    "required": ["results"],
}


def semantic_check_batch(conversations, system_prompt, config, logger=None):
    """Sends a sub-batch of structurally-valid conversations to Claude for a
    personality/naturalness judgment. Returns {conversation_id: (approved, reason)}.
    On any CLI failure, fails open per-item as approved=True with a note — a
    semantic-check outage should not block the whole pipeline, since the
    deterministic checks already ran; generator.py logs this clearly."""
    payload_conversations = [
        {"conversation_id": c["id"], "messages": c["messages"]} for c in conversations
    ]
    prompt = (
        "בדוק את השיחות הבאות ותן פסיקה לכל אחת לפי הסכמה. "
        "שיחות (JSON): " + __import__("json").dumps(payload_conversations, ensure_ascii=False)
    )
    try:
        result = claude_client.call_claude_with_retries(
            prompt, system_prompt, SEMANTIC_SCHEMA, config, logger=logger
        )
    except claude_client.ClaudeCallError as e:
        if logger:
            logger.error("semantic check batch failed, failing open: %s", e)
        return {c["id"]: (True, "semantic check unavailable — approved by default") for c in conversations}

    verdicts = {}
    for r in result.data.get("results", []):
        cid = r.get("conversation_id")
        if cid:
            verdicts[cid] = (bool(r.get("approved")), r.get("reason", ""))
    # anything the model didn't return a verdict for: fail open, logged
    for c in conversations:
        if c["id"] not in verdicts:
            verdicts[c["id"]] = (True, "no semantic verdict returned — approved by default")
    return verdicts
