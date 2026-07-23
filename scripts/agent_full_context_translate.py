#!/usr/bin/env python3
"""
Full-context subtitle translation experiment:
  - Load ASR JSON (start/end/text per cue)
  - Send ALL cues in ONE agent request (or continuation if truncated)
  - Expect JSON array mapped by index i
  - Keep original timeline; only replace text
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def extract_json_array(raw: str) -> list:
    text = raw.strip()
    # strip markdown fences
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
    text = re.sub(r"\s*```$", "", text)
    # direct parse
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and isinstance(data.get("cues"), list):
            return data["cues"]
        if isinstance(data, dict) and isinstance(data.get("translations"), list):
            return data["translations"]
    except json.JSONDecodeError:
        pass
    # find outermost array
    start = text.find("[")
    end = text.rfind("]")
    if start >= 0 and end > start:
        try:
            data = json.loads(text[start : end + 1])
            if isinstance(data, list):
                return data
        except json.JSONDecodeError:
            pass
    raise ValueError("Could not parse JSON array from agent response")


def normalize_items(items: list, expected: int) -> list[str]:
    """Return list[str] length expected from mixed shapes."""
    by_i: dict[int, str] = {}
    ordered: list[str] = []
    for idx, item in enumerate(items):
        if isinstance(item, str):
            ordered.append(item.strip())
            continue
        if isinstance(item, dict):
            text = (
                item.get("text")
                or item.get("vi")
                or item.get("translation")
                or item.get("t")
                or ""
            )
            text = str(text).strip()
            if "i" in item and str(item["i"]).lstrip("-").isdigit():
                by_i[int(item["i"])] = text
            elif "index" in item and str(item["index"]).lstrip("-").isdigit():
                by_i[int(item["index"])] = text
            else:
                ordered.append(text)
    if by_i:
        out = []
        for i in range(expected):
            # support 0-based or 1-based
            out.append(by_i.get(i) or by_i.get(i + 1) or "")
        if sum(1 for x in out if x) >= expected * 0.8:
            return out
    if len(ordered) >= expected:
        return ordered[:expected]
    while len(ordered) < expected:
        ordered.append("")
    return ordered


def call_anthropic(
    base_url: str,
    api_key: str,
    model: str,
    system: str,
    user: str,
    max_tokens: int = 16000,
) -> tuple[str, str | None]:
    """Call Anthropic Messages via curl (avoids Cloudflare 1010 on Python UA)."""
    url = base_url.rstrip("/") + "/v1/messages"
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }
    # ensure_ascii=True avoids Windows/curl codepage mojibake on CJK text.
    body_bytes = json.dumps(body, ensure_ascii=True).encode("ascii")
    tmp_dir = Path(tempfile.gettempdir())
    stamp = str(int(time.time() * 1000))
    body_path = tmp_dir / f"subvid-agent-body-{stamp}.json"
    out_path = tmp_dir / f"subvid-agent-out-{stamp}.json"
    body_path.write_bytes(body_bytes)
    try:
        cmd = [
            "curl.exe",
            "-sS",
            "-X",
            "POST",
            url,
            "-H",
            f"Authorization: Bearer {api_key}",
            "-H",
            f"x-api-key: {api_key}",
            "-H",
            "anthropic-version: 2023-06-01",
            "-H",
            "Content-Type: application/json",
            "-H",
            "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) subvid-agent/1.0",
            "--data-binary",
            f"@{body_path}",
            "-o",
            str(out_path),
            "--max-time",
            "600",
            "-w",
            "%{http_code}",
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        http_code = (proc.stdout or "").strip() or "0"
        raw_out = out_path.read_text(encoding="utf-8", errors="replace")
        if http_code != "200":
            raise RuntimeError(f"HTTP {http_code}: {raw_out[:800]}")
        payload = json.loads(raw_out)
    finally:
        body_path.unlink(missing_ok=True)
        out_path.unlink(missing_ok=True)

    parts = payload.get("content") or []
    # Collect every text-like field (some gateways put long answers in tool/input).
    chunks: list[str] = []
    for p in parts:
        if not isinstance(p, dict):
            continue
        if p.get("type") == "text" and p.get("text"):
            chunks.append(str(p["text"]))
        # tool_use / server_tool partials sometimes carry JSON in input
        inp = p.get("input")
        if isinstance(inp, dict):
            chunks.append(json.dumps(inp, ensure_ascii=False))
        elif isinstance(inp, str) and inp.strip():
            chunks.append(inp)
        if p.get("content"):
            chunks.append(str(p["content"]))
    text = "\n".join(chunks).strip()
    # Fallback: dump whole payload for debugging if still empty-ish
    if len(text) < 50:
        text = json.dumps(payload, ensure_ascii=False)
    stop = payload.get("stop_reason")
    usage = payload.get("usage") or {}
    print(
        f"[agent] model={payload.get('model')} stop={stop} "
        f"in={usage.get('input_tokens')} out={usage.get('output_tokens')} "
        f"parts={len(parts)} text_len={len(text)}",
        file=sys.stderr,
        flush=True,
    )
    # Persist full payload beside caller raw for debugging
    try:
        Path(tempfile.gettempdir()).joinpath("subvid-agent-last-payload.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2)[:2_000_000],
            encoding="utf-8",
        )
    except Exception:
        pass
    return text, stop


def build_prompt(cues: list[dict], source: str, target: str, resume_from: int = 0) -> str:
    lines = []
    for i, c in enumerate(cues):
        if i < resume_from:
            continue
        t0 = float(c["timestamp"][0])
        t1 = float(c["timestamp"][1])
        text = str(c.get("text") or "").replace("\n", " ").strip()
        lines.append(f'{i}|{t0:.2f}-{t1:.2f}|{text}')

    return f"""You are a professional subtitle translator for short-form Chinese video.

Task: Translate every cue from {source} to natural spoken {target}.

CRITICAL RULES:
1. Keep the SAME number of cues and the SAME order (index i is authoritative).
2. Do NOT merge, split, skip, or reorder cues.
3. Keep names/terms consistent across the whole video (same person = same translation).
4. Preserve informal spoken tone suitable for Douyin/TikTok narration.
5. Timeline is already fixed — only translate text. Do not invent new timestamps.
6. Output ONLY valid JSON (no markdown fences, no commentary):

{{
  "cues": [
    {{"i": 0, "text": "..."}},
    {{"i": 1, "text": "..."}}
  ]
}}

You must include every index from {resume_from} to {len(cues) - 1} inclusive ({len(cues) - resume_from} items).

Source cues (format: index|start-end|text):
""" + "\n".join(lines)


def srt_time(sec: float) -> str:
    if sec < 0:
        sec = 0
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(path: Path, cues: list[dict], texts: list[str]) -> None:
    blocks = []
    n = 0
    for i, c in enumerate(cues):
        text = (texts[i] if i < len(texts) else "").strip() or str(c.get("text") or "").strip()
        if not text:
            continue
        n += 1
        t0 = float(c["timestamp"][0])
        t1 = float(c["timestamp"][1])
        blocks.append(f"{n}\n{srt_time(t0)} --> {srt_time(t1)}\n{text}")
    path.write_text("\n\n".join(blocks) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="ASR JSON from local_whisper_asr.py")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--source", default="zh")
    ap.add_argument("--target", default="vi")
    ap.add_argument("--model", default="")
    ap.add_argument("--max-tokens", type=int, default=16000)
    args = ap.parse_args()

    env = load_env(Path("C:/AI/subvid.app/.env"))
    base = env.get("CUSTOM_TRANSLATE_BASE_URL", "https://api.freemodel.dev")
    key = env.get("CUSTOM_TRANSLATE_API_KEY", "")
    model = args.model or env.get("CUSTOM_TRANSLATE_MODEL") or "claude-sonnet-4-6"
    if not key:
        print("Missing CUSTOM_TRANSLATE_API_KEY", file=sys.stderr)
        return 2

    asr = json.loads(Path(args.input).read_text(encoding="utf-8"))
    cues = asr.get("chunks") or []
    if not cues:
        print("No chunks in ASR JSON", file=sys.stderr)
        return 2

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Also dump plain source transcript for inspection
    src_lines = [
        f"{i}\t{float(c['timestamp'][0]):.2f}\t{float(c['timestamp'][1]):.2f}\t{c.get('text','')}"
        for i, c in enumerate(cues)
    ]
    (out_dir / "source-cues.tsv").write_text("\n".join(src_lines) + "\n", encoding="utf-8")
    (out_dir / "source-full.txt").write_text(
        "\n".join(str(c.get("text") or "").strip() for c in cues) + "\n",
        encoding="utf-8",
    )

    system = (
        "You translate subtitles with full-document context awareness. "
        "Return only JSON as specified. Never omit cues."
    )

    all_texts = [""] * len(cues)
    resume = 0
    raw_parts: list[str] = []
    started = time.time()
    pass_no = 0

    while resume < len(cues) and pass_no < 8:
        pass_no += 1
        remaining = len(cues) - resume
        print(
            f"[agent] pass={pass_no} resume={resume} remaining={remaining} model={model}",
            file=sys.stderr,
            flush=True,
        )
        user = build_prompt(cues, args.source, args.target, resume_from=resume)
        # Prefer sonnet for full-context quality if default haiku struggles with long JSON
        try:
            raw, stop = call_anthropic(
                base, key, model, system, user, max_tokens=args.max_tokens
            )
        except Exception as e:
            print(f"[agent] error: {e}", file=sys.stderr)
            # one retry with haiku if sonnet fails or vice versa
            fallback = (
                "claude-haiku-4-5-20251001"
                if "sonnet" in model or "opus" in model
                else "claude-sonnet-4-6"
            )
            if fallback == model:
                raise
            print(f"[agent] retry with {fallback}", file=sys.stderr, flush=True)
            raw, stop = call_anthropic(
                base, key, fallback, system, user, max_tokens=args.max_tokens
            )
            model = fallback

        raw_parts.append(raw)
        (out_dir / f"agent-raw-pass{pass_no}.txt").write_text(raw, encoding="utf-8")

        try:
            items = extract_json_array(raw)
            texts = normalize_items(items, len(cues) - resume)
        except Exception as e:
            print(f"[agent] parse failed pass {pass_no}: {e}", file=sys.stderr)
            # try numbered fallback
            texts = []
            for line in raw.splitlines():
                m = re.match(r"^\s*(\d+)\s*[|.:、\-\)]\s*(.*)$", line)
                if m:
                    texts.append(m.group(2).strip())
            if len(texts) < max(1, int((len(cues) - resume) * 0.5)):
                raise

        # map into all_texts
        filled = 0
        for j, t in enumerate(texts):
            idx = resume + j
            if idx >= len(cues):
                break
            if t:
                all_texts[idx] = t
                filled += 1

        print(
            f"[agent] pass={pass_no} filled={filled} stop={stop}",
            file=sys.stderr,
            flush=True,
        )

        # advance resume to first missing
        next_resume = resume
        while next_resume < len(cues) and all_texts[next_resume]:
            next_resume += 1
        if next_resume == resume:
            # no progress
            print("[agent] no progress; stopping", file=sys.stderr)
            break
        resume = next_resume
        if stop != "max_tokens" and resume >= len(cues):
            break
        if stop != "max_tokens" and filled >= remaining * 0.95:
            # likely complete enough
            if all(all_texts[i] for i in range(len(cues))):
                break

    filled_total = sum(1 for t in all_texts if t)
    result = {
        "ok": filled_total == len(cues),
        "model": model,
        "source": args.source,
        "target": args.target,
        "cue_count": len(cues),
        "filled": filled_total,
        "missing": [i for i, t in enumerate(all_texts) if not t],
        "elapsed_sec": round(time.time() - started, 1),
        "passes": pass_no,
        "cues": [
            {
                "i": i,
                "start": float(cues[i]["timestamp"][0]),
                "end": float(cues[i]["timestamp"][1]),
                "source": cues[i].get("text") or "",
                "text": all_texts[i] or cues[i].get("text") or "",
            }
            for i in range(len(cues))
        ],
    }
    (out_dir / "agent-translated.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    write_srt(out_dir / "agent-vi.srt", cues, all_texts)
    write_srt(
        out_dir / "source-zh.srt",
        cues,
        [str(c.get("text") or "") for c in cues],
    )

    # side-by-side sample
    samples = []
    for i in list(range(0, min(8, len(cues)))) + list(range(max(0, len(cues) - 5), len(cues))):
        samples.append(
            {
                "i": i,
                "t": f"{float(cues[i]['timestamp'][0]):.1f}-{float(cues[i]['timestamp'][1]):.1f}",
                "zh": cues[i].get("text"),
                "vi": all_texts[i],
            }
        )
    (out_dir / "sample-compare.json").write_text(
        json.dumps(samples, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(
        json.dumps(
            {
                "ok": result["ok"],
                "filled": filled_total,
                "total": len(cues),
                "missing_count": len(result["missing"]),
                "elapsed_sec": result["elapsed_sec"],
                "passes": pass_no,
                "model": model,
                "out_dir": str(out_dir),
            },
            ensure_ascii=False,
        )
    )
    return 0 if filled_total >= len(cues) * 0.9 else 1


if __name__ == "__main__":
    raise SystemExit(main())
