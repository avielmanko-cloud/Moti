"""Thin, robust wrapper around the Claude Code CLI's non-interactive mode.

Verified against the installed CLI (claude 2.1.328) before writing this:
  claude -p "<prompt>" --system-prompt "<text>" --output-format json \
    --json-schema '<inline JSON schema, NOT a file path>' \
    --model sonnet --tools "" --no-session-persistence

With --json-schema, the JSON object printed on stdout carries:
  - is_error (bool), subtype ("success" on success)
  - result: the model's raw text (a JSON string, since we asked for JSON)
  - structured_output: that same JSON already parsed into an object — prefer this
  - total_cost_usd, duration_ms, session_id

Auth is inherited from the existing `claude` login (OAuth/subscription — no
ANTHROPIC_API_KEY on this machine), so --bare is deliberately never used: it
forces API-key-only auth and would break this. stdin is always redirected
from DEVNULL — without it the CLI waits ~3s for stdin and prints a stray
warning line.
"""
import json
import re
import subprocess
import time


class ClaudeCallError(Exception):
    def __init__(self, message, stdout="", stderr="", returncode=None):
        super().__init__(message)
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


# Claude Pro/Max (unlike a metered API key) has a usage window that resets
# every few hours, not per-request billing. Heavy generation will hit it —
# that is expected, not a bug — so those errors need a long pause-and-resume,
# not the short exponential backoff meant for transient network hiccups.
_RATE_LIMIT_PATTERNS = re.compile(
    r"usage limit|rate limit|rate.?limited|quota|try again later|"
    r"too many requests|429|resets? at|upgrade to continue",
    re.IGNORECASE,
)


def is_rate_limit_error(message):
    return bool(_RATE_LIMIT_PATTERNS.search(message or ""))


class ClaudeResult:
    def __init__(self, data, cost_usd, duration_ms, session_id, raw):
        self.data = data
        self.cost_usd = cost_usd
        self.duration_ms = duration_ms
        self.session_id = session_id
        self.raw = raw


def _extract_json_object(text):
    """Best-effort recovery if stdout has stray text around the JSON object."""
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise ValueError("no JSON object found in output")
    return json.loads(text[start:end + 1])


def call_claude(prompt, system_prompt, json_schema, config, extra_args=None):
    """Runs one non-interactive Claude CLI call and returns a ClaudeResult.

    Raises ClaudeCallError on any failure (non-zero exit, timeout, is_error,
    unparseable output) — callers are expected to retry with backoff.
    """
    cmd = [
        config["claude_cli_path"], "-p", prompt,
        "--system-prompt", system_prompt,
        "--output-format", "json",
        "--json-schema", json.dumps(json_schema, ensure_ascii=False),
        "--model", config["model"],
        "--tools", "",
        "--no-session-persistence",
    ]
    if extra_args:
        cmd.extend(extra_args)

    try:
        proc = subprocess.run(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=config["subprocess_timeout_sec"],
            text=True,
            encoding="utf-8",
        )
    except subprocess.TimeoutExpired as e:
        raise ClaudeCallError(f"timed out after {config['subprocess_timeout_sec']}s", stderr=str(e))

    stdout, stderr = proc.stdout, proc.stderr

    if proc.returncode != 0:
        raise ClaudeCallError(
            f"claude exited with code {proc.returncode}: {stderr.strip() or stdout.strip()}",
            stdout=stdout, stderr=stderr, returncode=proc.returncode,
        )

    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError:
        try:
            payload = _extract_json_object(stdout)
        except (ValueError, json.JSONDecodeError) as e:
            raise ClaudeCallError(f"could not parse CLI output as JSON: {e}", stdout=stdout, stderr=stderr)

    if payload.get("is_error"):
        raise ClaudeCallError(f"claude reported an error: {payload.get('result')}", stdout=stdout, stderr=stderr)

    structured = payload.get("structured_output")
    if structured is None:
        raw_result = payload.get("result")
        if not isinstance(raw_result, str):
            raise ClaudeCallError("no structured_output and result is not a string", stdout=stdout, stderr=stderr)
        try:
            structured = json.loads(raw_result)
        except json.JSONDecodeError as e:
            raise ClaudeCallError(f"result was not valid JSON: {e}", stdout=stdout, stderr=stderr)

    return ClaudeResult(
        data=structured,
        cost_usd=payload.get("total_cost_usd", 0.0),
        duration_ms=payload.get("duration_ms", 0),
        session_id=payload.get("session_id"),
        raw=payload,
    )


def call_claude_with_retries(prompt, system_prompt, json_schema, config, logger=None, extra_args=None):
    """Retries with exponential backoff for transient failures. A usage-limit
    error (Pro/Max's periodic reset, not a metered API) instead waits the
    long, configured pause and keeps retrying up to rate_limit_max_retries —
    short backoff is pointless against a multi-hour reset window."""
    max_retries = config["max_retries_per_batch"]
    base = config["retry_backoff_base_sec"]
    rate_limit_wait = config.get("rate_limit_wait_sec", 1800)
    rate_limit_max_retries = config.get("rate_limit_max_retries", 10)

    last_err = None
    rate_limit_attempts = 0
    attempt = 0
    while True:
        attempt += 1
        try:
            return call_claude(prompt, system_prompt, json_schema, config, extra_args=extra_args)
        except ClaudeCallError as e:
            last_err = e
            if is_rate_limit_error(str(e)):
                rate_limit_attempts += 1
                if rate_limit_attempts > rate_limit_max_retries:
                    if logger:
                        logger.error("usage limit still not clear after %d waits — giving up for now: %s",
                                     rate_limit_max_retries, e)
                    raise last_err
                msg = (f"usage limit reached — pausing {rate_limit_wait // 60} min before retrying "
                       f"(wait {rate_limit_attempts}/{rate_limit_max_retries}): {e}")
                if logger:
                    logger.warning(msg)
                else:
                    print(msg)
                time.sleep(rate_limit_wait)
                continue

            if logger:
                logger.warning("claude call failed (attempt %d/%d): %s", attempt, max_retries, e)
            if attempt >= max_retries:
                raise last_err
            time.sleep(base * (2 ** (attempt - 1)))
