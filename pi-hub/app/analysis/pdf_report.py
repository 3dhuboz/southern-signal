from __future__ import annotations

from pathlib import Path
from typing import Any

from app.analysis.report import build_evidence_report
from app.store import InvestigationStore


PAGE_WIDTH = 612
PAGE_HEIGHT = 792
MARGIN_LEFT = 54
MARGIN_RIGHT = 54
MARGIN_TOP = 54
MARGIN_BOTTOM = 54
TITLE_SIZE = 18
HEADING_SIZE = 13
BODY_SIZE = 10
LINE_HEIGHT = 14
USABLE_WIDTH = PAGE_WIDTH - MARGIN_LEFT - MARGIN_RIGHT
TOP_Y = PAGE_HEIGHT - MARGIN_TOP
BOTTOM_Y = MARGIN_BOTTOM


def build_evidence_pdf(
    store: InvestigationStore,
    investigation_id: str,
    output_dir: Path | None = None,
) -> Path:
    report = build_evidence_report(store, investigation_id)
    pdf_bytes = render_pdf_bytes(report)
    target_dir = Path(output_dir) if output_dir is not None else store.session_dir(investigation_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    target_path = (target_dir / "evidence_report.pdf").resolve()
    target_path.write_bytes(pdf_bytes)
    return target_path


def render_pdf_bytes(report: dict[str, Any]) -> bytes:
    lines = _compose_lines(report)
    pages = _paginate(lines)
    return _serialize_pdf(pages)


def _compose_lines(report: dict[str, Any]) -> list[tuple[str, str]]:
    """Return a flat list of (style, text) lines for the report."""
    investigation = report.get("investigation") or {}
    counts = report.get("counts") or {}
    confidence = report.get("confidence") or {}
    anomalies = report.get("anomalies") or []
    review_windows = report.get("review_windows") or []
    next_steps = report.get("review_next_steps") or []

    title = str(investigation.get("title") or "Evidence Report")
    investigation_id = str(investigation.get("id") or "")

    lines: list[tuple[str, str]] = []
    lines.append(("title", f"Evidence Report: {title}"))
    if investigation_id:
        lines.append(("body", f"Investigation ID: {investigation_id}"))
    location = investigation.get("location_name")
    if location:
        lines.append(("body", f"Location: {location}"))
    status = investigation.get("status")
    if status:
        lines.append(("body", f"Status: {status}"))
    started_at = investigation.get("started_at")
    if started_at:
        lines.append(("body", f"Started: {started_at}"))
    ended_at = investigation.get("ended_at")
    if ended_at:
        lines.append(("body", f"Ended: {ended_at}"))
    notes = investigation.get("notes")
    if notes:
        lines.append(("body", f"Notes: {notes}"))

    lines.append(("space", ""))
    lines.append(("heading", "Counts"))
    lines.append(("body", f"Sensor samples: {counts.get('samples', 0)}"))
    lines.append(("body", f"Events: {counts.get('events', 0)}"))
    lines.append(("body", f"Media assets: {counts.get('media', 0)}"))
    lines.append(("body", f"Anomalies: {counts.get('anomalies', 0)}"))

    lines.append(("space", ""))
    lines.append(("heading", "Confidence"))
    label = str(confidence.get("label") or "unknown")
    score = confidence.get("score")
    score_text = f"{score}" if isinstance(score, (int, float)) else "n/a"
    lines.append(("body", f"Label: {label}    Score: {score_text}"))
    for reason in confidence.get("reasons", []) or []:
        lines.append(("body", f"- {reason}"))

    lines.append(("space", ""))
    lines.append(("heading", "Top Anomalies"))
    if anomalies:
        for anomaly in anomalies[:10]:
            lines.append(
                (
                    "body",
                    "- {timestamp} | {sensor} | severity={severity} | value={value} {unit}".format(
                        timestamp=anomaly.get("timestamp", "n/a"),
                        sensor=anomaly.get("sensor_type", "unknown"),
                        severity=anomaly.get("severity", "n/a"),
                        value=_fmt_number(anomaly.get("value")),
                        unit=anomaly.get("unit") or "",
                    ).rstrip(),
                )
            )
            reason = anomaly.get("reason")
            if reason:
                lines.append(("body", f"    {reason}"))
    else:
        lines.append(("body", "No anomalies recorded."))

    lines.append(("space", ""))
    lines.append(("heading", "Review Windows"))
    if review_windows:
        for window in review_windows[:10]:
            lines.append(
                (
                    "body",
                    "- {title} ({start} -> {end}, severity={severity})".format(
                        title=window.get("title", "review window"),
                        start=window.get("start", "n/a"),
                        end=window.get("end", "n/a"),
                        severity=window.get("severity", "n/a"),
                    ),
                )
            )
            reason = window.get("reason")
            if reason:
                lines.append(("body", f"    {reason}"))
    else:
        lines.append(("body", "No review windows generated."))

    lines.append(("space", ""))
    lines.append(("heading", "Review Next Steps"))
    if next_steps:
        for step in next_steps:
            lines.append(("body", f"- {step}"))
    else:
        lines.append(("body", "No follow-up steps suggested."))

    return lines


def _fmt_number(value: Any) -> str:
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, (int, float)):
        return f"{value:.3f}".rstrip("0").rstrip(".") or "0"
    if value is None:
        return ""
    return str(value)


def _paginate(lines: list[tuple[str, str]]) -> list[list[tuple[str, str, int]]]:
    """Wrap and paginate. Returns pages of (style, text, font_size) entries."""
    available = TOP_Y - BOTTOM_Y
    pages: list[list[tuple[str, str, int]]] = []
    current: list[tuple[str, str, int]] = []
    used = 0.0

    def flush() -> None:
        nonlocal current, used
        if current:
            pages.append(current)
        current = []
        used = 0.0

    for style, text in lines:
        size = _size_for(style)
        if style == "space":
            entries = [(style, "", size)]
            advance = LINE_HEIGHT * 0.6
        else:
            wrapped = _wrap(text, size)
            entries = [(style, segment, size) for segment in wrapped]
            advance = LINE_HEIGHT * len(wrapped) if style == "body" else (LINE_HEIGHT + 4) * len(wrapped)
            if style == "title":
                advance += 6

        if used + advance > available and current:
            flush()

        for entry in entries:
            current.append(entry)
        used += advance

    flush()
    if not pages:
        pages.append([])
    return pages


def _size_for(style: str) -> int:
    if style == "title":
        return TITLE_SIZE
    if style == "heading":
        return HEADING_SIZE
    return BODY_SIZE


def _wrap(text: str, font_size: int) -> list[str]:
    if not text:
        return [""]
    average_char_width = font_size * 0.52
    if average_char_width <= 0:
        return [text]
    max_chars = max(20, int(USABLE_WIDTH // average_char_width))
    words = text.split(" ")
    lines: list[str] = []
    current = ""
    for word in words:
        if not current:
            candidate = word
        else:
            candidate = current + " " + word
        if len(candidate) <= max_chars:
            current = candidate
            continue
        if current:
            lines.append(current)
        if len(word) <= max_chars:
            current = word
        else:
            for chunk in _hard_break(word, max_chars):
                lines.append(chunk)
            current = ""
    if current:
        lines.append(current)
    return lines or [""]


def _hard_break(word: str, max_chars: int) -> list[str]:
    return [word[i : i + max_chars] for i in range(0, len(word), max_chars)]


def _escape_pdf_text(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("(", "\\(")
        .replace(")", "\\)")
    )


def _build_content_stream(entries: list[tuple[str, str, int]]) -> bytes:
    parts: list[str] = ["BT"]
    parts.append(f"1 0 0 1 {MARGIN_LEFT} {TOP_Y} Tm")
    first = True
    for style, text, size in entries:
        if first:
            parts.append(f"/F1 {size} Tf")
            parts.append(f"{LINE_HEIGHT} TL")
            first = False
        else:
            parts.append(f"/F1 {size} Tf")
            if style == "title":
                parts.append(f"{TITLE_SIZE + 4} TL")
            elif style == "heading":
                parts.append(f"{HEADING_SIZE + 4} TL")
            elif style == "space":
                parts.append(f"{int(LINE_HEIGHT * 0.6)} TL")
            else:
                parts.append(f"{LINE_HEIGHT} TL")
        parts.append(f"({_escape_pdf_text(text)}) Tj")
        parts.append("T*")
    parts.append("ET")
    return ("\n".join(parts) + "\n").encode("latin-1", errors="replace")


def _serialize_pdf(pages: list[list[tuple[str, str, int]]]) -> bytes:
    objects: list[bytes] = []

    def add_object(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    page_count = max(1, len(pages))

    catalog_id = 1
    pages_id = 2
    font_id = 3

    objects.append(b"")  # placeholder for catalog (1)
    objects.append(b"")  # placeholder for pages (2)
    objects.append(b"")  # placeholder for font (3)

    page_object_ids: list[int] = []
    content_object_ids: list[int] = []
    for entries in pages:
        content_stream = _build_content_stream(entries)
        content_obj_body = (
            f"<< /Length {len(content_stream)} >>\nstream\n".encode("latin-1")
            + content_stream
            + b"endstream\n"
        )
        content_id = add_object(content_obj_body)
        content_object_ids.append(content_id)

    for content_id in content_object_ids:
        page_body = (
            f"<< /Type /Page /Parent {pages_id} 0 R "
            f"/MediaBox [0 0 {PAGE_WIDTH} {PAGE_HEIGHT}] "
            f"/Contents {content_id} 0 R "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
            f">>\n"
        ).encode("latin-1")
        page_id = add_object(page_body)
        page_object_ids.append(page_id)

    kids = " ".join(f"{pid} 0 R" for pid in page_object_ids)
    pages_body = (
        f"<< /Type /Pages /Kids [{kids}] /Count {page_count} >>\n"
    ).encode("latin-1")
    objects[pages_id - 1] = pages_body

    catalog_body = f"<< /Type /Catalog /Pages {pages_id} 0 R >>\n".encode("latin-1")
    objects[catalog_id - 1] = catalog_body

    font_body = (
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n"
    )
    objects[font_id - 1] = font_body

    output = bytearray()
    output += b"%PDF-1.4\n"
    output += b"%\xe2\xe3\xcf\xd3\n"

    offsets: list[int] = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output += f"{index} 0 obj\n".encode("latin-1")
        output += body
        output += b"endobj\n"

    xref_offset = len(output)
    total_objects = len(objects) + 1
    output += f"xref\n0 {total_objects}\n".encode("latin-1")
    output += b"0000000000 65535 f \n"
    for offset in offsets:
        output += f"{offset:010d} 00000 n \n".encode("latin-1")

    output += b"trailer\n"
    output += f"<< /Size {total_objects} /Root {catalog_id} 0 R >>\n".encode("latin-1")
    output += f"startxref\n{xref_offset}\n%%EOF\n".encode("latin-1")
    return bytes(output)
