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
import subprocess
import time


class ClaudeCallError(Exception):
    def __init__(self, message, stdout="", stderr="", returncode=None):
        super().__init__(message)
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode


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
    """Retries with exponential backoff per config['max_retries_per_batch']."""
    max_retries = config["max_retries_per_batch"]
    base = config["retry_backoff_base_sec"]
    last_err = None
    for attempt in range(1, max_retries + 1):
        try:
            return call_claude(prompt, system_prompt, json_schema, config, extra_args=extra_args)
        except ClaudeCallError as e:
            last_err = e
            if logger:
                logger.warning("claude call failed (attempt %d/%d): %s", attempt, max_retries, e)
            if attempt < max_retries:
                time.sleep(base * (2 ** (attempt - 1)))
    raise last_err
