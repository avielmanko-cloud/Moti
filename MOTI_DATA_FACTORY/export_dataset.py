"""Exports the approved JSONL dataset to the exact TXT format the brief
specifies:

    משתמש: ...
    MOTI: ...
    משתמש: ...
    MOTI: ...
    <END>

UTF-8, no added special tokens beyond the literal <END> the spec names.
"""
import json
import os

from generator import load_config, resolve_path


def conversation_to_txt(conv):
    lines = []
    for m in conv.get("messages", []):
        speaker = "משתמש" if m.get("role") == "user" else "MOTI"
        content = m.get("content", "").strip()
        lines.append(f"{speaker}: {content}")
    lines.append("<END>")
    return "\n".join(lines)


def export(config, logger=None):
    all_path = os.path.join(resolve_path(config, "approved_dir"), "all.jsonl")
    out_path = resolve_path(config, "output_file")
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    if not os.path.exists(all_path):
        msg = "no approved conversations yet — run --generate or --test first"
        if logger:
            logger.warning(msg)
        else:
            print(msg)
        return 0, out_path

    count = 0
    with open(all_path, "r", encoding="utf-8") as f_in, open(out_path, "w", encoding="utf-8") as f_out:
        for line in f_in:
            line = line.strip()
            if not line:
                continue
            try:
                conv = json.loads(line)
            except json.JSONDecodeError:
                continue
            f_out.write(conversation_to_txt(conv))
            f_out.write("\n\n")
            count += 1

    msg = f"exported {count} conversations to {out_path}"
    if logger:
        logger.info(msg)
    else:
        print(msg)
    return count, out_path


if __name__ == "__main__":
    base_dir = os.path.dirname(os.path.abspath(__file__))
    cfg = load_config(base_dir)
    export(cfg)
