import os
from typing import Annotated
import pymupdf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from .adapters import parse_document
from .document import extract, limit_mb

app = FastAPI(title="Asset Ledger Parser", docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.1"}


async def read_pdf(file: UploadFile) -> bytes:
    chunks = []
    size = 0
    while chunk := await file.read(65536):
        size += len(chunk)
        if size > limit_mb() * 1024 * 1024:
            raise HTTPException(413, "file_too_large")
        chunks.append(chunk)
    data = b"".join(chunks)
    if not data.startswith(b"%PDF-"):
        raise HTTPException(422, "invalid_pdf")
    return data


def open_pdf(data: bytes, password: str | None = None) -> pymupdf.Document:
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except (RuntimeError, ValueError):
        raise HTTPException(422, "invalid_pdf") from None
    if doc.needs_pass and (not password or not doc.authenticate(password)):
        doc.close()
        raise HTTPException(422, "needs_password")
    if not 0 < len(doc) <= max(1, min(500, int(os.environ.get("MAX_PDF_PAGES", "60")))):
        doc.close()
        raise HTTPException(422, "page_limit")
    return doc


@app.post("/parse")
async def parse(file: Annotated[UploadFile, File()]):
    data = await read_pdf(file)
    with open_pdf(data) as doc:
        try:
            return parse_document(extract(doc)).model_dump(mode="json", exclude_none=True)
        except (RuntimeError, ValueError, ArithmeticError):
            raise HTTPException(422, "parse_failed") from None


@app.post("/unlock")
async def unlock(file: Annotated[UploadFile, File()], password: Annotated[str, Form()] = ""):
    data = await read_pdf(file)
    with open_pdf(data, password) as doc:
        decrypted = doc.tobytes(encryption=pymupdf.PDF_ENCRYPT_NONE, garbage=3, deflate=True)
        if len(decrypted) > limit_mb() * 1024 * 1024:
            raise HTTPException(413, "file_too_large")
        return Response(decrypted, media_type="application/pdf", headers={"X-Page-Count": str(len(doc))})


@app.post("/render")
async def render(
    file: Annotated[UploadFile, File()], page: Annotated[int, Form()] = 1, dpi: Annotated[int, Form()] = 120
):
    data = await read_pdf(file)
    with open_pdf(data) as doc:
        if not 1 <= page <= len(doc) or not 72 <= dpi <= 150:
            raise HTTPException(422, "render_bounds")
        current = doc[page - 1]
        if current.rect.width * current.rect.height * (dpi / 72) ** 2 > 12_000_000:
            raise HTTPException(422, "render_bounds")
        return Response(current.get_pixmap(dpi=dpi, alpha=False).tobytes("png"), media_type="image/png")
