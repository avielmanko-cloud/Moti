"""Exact + near-duplicate detection for MOTI conversations.

Exact duplicates are caught globally and cheaply (a set of SHA-256 hashes of
normalized conversation text — 50k hashes is a trivial amount of memory).

Near-duplicates are caught with word-shingle Jaccard similarity, but only
"where practical" (per spec): comparing every new conversation against all
prior ones is O(n^2) and pointless at 50k scale, so each category keeps a
bounded rolling window (config: near_duplicate_window_per_category) of recent
shingle sets to compare against. This catches the realistic failure mode —
the generator producing near-identical conversations in nearby batches —
without pretending to be an exhaustive global near-dup search.
"""
import hashlib
import json
import os
import re
from collections import deque

_WS_RE = re.compile(r"\s+")
_PUNCT_RE = re.compile(r"[^\w\s]", re.UNICODE)


def normalize_text(text):
    text = text.strip()
    text = _PUNCT_RE.sub(" ", text)
    text = _WS_RE.sub(" ", text)
    return text.strip().lower()


def conversation_text(conv):
    return " ".join(m.get("content", "") for m in conv.get("messages", []))


def conversation_hash(conv):
    norm = normalize_text(conversation_text(conv))
    return hashlib.sha256(norm.encode("utf-8")).hexdigest()


def opening_signature(conv, n_words=5):
    messages = conv.get("messages", [])
    if not messages:
        return ""
    first_user = next((m["content"] for m in messages if m.get("role") == "user"), "")
    words = normalize_text(first_user).split()
    return " ".join(words[:n_words])


def word_shingles(text, k=3):
    words = normalize_text(text).split()
    if len(words) < k:
        return {tuple(words)} if words else set()
    return {tuple(words[i:i + k]) for i in range(len(words) - k + 1)}


def jaccard(a, b):
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


class DedupIndex:
    def __init__(self, window_per_category=400):
        self.window_per_category = window_per_category
        self.exact_hashes = set()
        self.opening_signatures = set()
        self._near_windows = {}  # category -> deque[shingle_set]

    def _window(self, category):
        if category not in self._near_windows:
            self._near_windows[category] = deque(maxlen=self.window_per_category)
        return self._near_windows[category]

    def load_from_approved(self, approved_dir, category_slugs):
        """Rebuilds state from disk so dedup survives a resumed run."""
        for slug in category_slugs:
            path = os.path.join(approved_dir, f"{slug}.jsonl")
            if not os.path.exists(path):
                continue
            window = self._window(slug)
            with open(path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        conv = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    self.exact_hashes.add(conversation_hash(conv))
                    self.opening_signatures.add(opening_signature(conv))
                    window.append(word_shingles(conversation_text(conv)))

    def is_exact_duplicate(self, conv):
        return conversation_hash(conv) in self.exact_hashes

    def is_repetitive_opening(self, conv):
        sig = opening_signature(conv)
        return bool(sig) and sig in self.opening_signatures

    def near_duplicate_match(self, conv, category, threshold):
        shingles = word_shingles(conversation_text(conv))
        for other in self._window(category):
            if jaccard(shingles, other) >= threshold:
                return True
        return False

    def register(self, conv, category):
        """Call only after a conversation is approved."""
        self.exact_hashes.add(conversation_hash(conv))
        self.opening_signatures.add(opening_signature(conv))
        self._window(category).append(word_shingles(conversation_text(conv)))
