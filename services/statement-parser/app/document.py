import os
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
import pymupdf
from .models import Diagnostic

MONEY = re.compile(r"\(?[-+]?\$?\s*(?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2}\)?-?")


def masked(text: str) -> str:
    return re.sub(r"\d{6,}", lambda match: "*" * (len(match[0]) - 4) + match[0][-4:], text)


def money(text: str) -> Decimal:
    negative = text.strip().endswith("-") or "(" in text or text.strip().startswith("-")
    value = Decimal(re.sub(r"[^\d.]", "", text))
    return -value if negative else value


def amount(value: Decimal) -> str:
    return format(value.quantize(Decimal("0.0001")), "f")


@dataclass
class Span:
    x: float
    right: float
    text: str
    flags: int


@dataclass
class Line:
    page: int
    y: float
    spans: list[Span]

    @property
    def text(self) -> str:
        return " ".join(span.text.strip() for span in self.spans if span.text.strip())

    def between(self, left: float, right: float) -> str:
        return " ".join(span.text.strip() for span in self.spans if left <= span.x < right).strip()

    def right_amount(self, left: float = 400) -> str | None:
        text = " ".join(span.text for span in self.spans if span.x >= left or span.right >= 490)
        matches = list(MONEY.finditer(text))
        return matches[-1][0] if matches else None


@dataclass
class Document:
    pages: list[list[Line]]
    diagnostics: list[Diagnostic]

    @property
    def lines(self) -> list[Line]:
        return [line for page in self.pages for line in page]

    @property
    def text(self) -> str:
        return "\n".join(line.text for line in self.lines)


def extract(doc: pymupdf.Document) -> Document:
    pages = []
    diagnostics = []
    for number, page in enumerate(doc, 1):
        textpage = None
        if len(page.get_text().strip()) < 20 and page.get_images():
            try:
                textpage = page.get_textpage_ocr(language="eng", dpi=150, full=True)
                diagnostics.append(Diagnostic(kind="ocr_low_confidence", page=number))
            except (RuntimeError, ValueError):
                diagnostics.append(Diagnostic(kind="ocr_unavailable", page=number))
        blocks = page.get_text("dict", textpage=textpage)["blocks"]
        positioned = []
        for block in blocks:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    positioned.append(
                        (
                            span["origin"][1],
                            Span(span["bbox"][0], span["bbox"][2], span["text"], span["flags"]),
                        )
                    )
        grouped: list[Line] = []
        for y, span in sorted(positioned, key=lambda value: (value[0], value[1].x)):
            if grouped and abs(grouped[-1].y - y) < 2.6:
                grouped[-1].spans.append(span)
            else:
                grouped.append(Line(number, y, [span]))
        for line in grouped:
            line.spans.sort(key=lambda span: span.x)
        pages.append(grouped)
    return Document(pages, diagnostics)


def infer_date(month_day: str, start: str | None, end: str | None) -> str | None:
    if not start or not end:
        return None
    first = date.fromisoformat(start) - timedelta(days=10)
    last = date.fromisoformat(end) + timedelta(days=10)
    month, day = (int(part) for part in month_day.split("/"))
    for year in range(first.year, last.year + 1):
        try:
            candidate = date(year, month, day)
        except ValueError:
            continue
        if first <= candidate <= last:
            return candidate.isoformat()
    return None


def month_day(text: str, start: str | None, end: str | None) -> str | None:
    match = re.search(r"([A-Za-z]{3})\s+(\d{1,2})", text)
    if not match:
        return None
    try:
        month = datetime.strptime(match[1], "%b").month
    except ValueError:
        return None
    return infer_date(f"{month}/{match[2]}", start, end)


def full_date(text: str) -> str | None:
    for pattern in ("%m/%d/%Y", "%b %d, %Y", "%B %d, %Y", "%m/%d/%y"):
        try:
            return datetime.strptime(text.strip(), pattern).date().isoformat()
        except ValueError:
            continue
    return None


def limit_mb() -> int:
    return max(1, min(100, int(os.environ.get("MAX_UPLOAD_MB", "20"))))
