from pathlib import Path
from decimal import Decimal
import shutil
import pytest
from fastapi.testclient import TestClient
from app.main import app

FIXTURES = Path(__file__).parent / "fixtures"
client = TestClient(app)


def request(name, endpoint="/parse", **data):
    return client.post(
        endpoint,
        files={"file": ("synthetic.pdf", (FIXTURES / name).read_bytes(), "application/pdf")},
        data=data,
    )


def test_card_layout_and_continuation():
    response = request("usbank-card.pdf")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["parser"] == "usbank_credit_card"
    assert result["account_last4"] == "1234"
    assert (result["statement_start"], result["statement_end"]) == ("2025-12-15", "2026-01-14")
    rows = result["entries"]
    assert len(rows) == 7
    assert [row["amount"] for row in rows] == [
        "50.0000",
        "10.0000",
        "-20.0000",
        "-20.0000",
        "-35.0000",
        "-2.0000",
        "-1.0000",
    ]
    assert rows[1]["direction"] == "refund"
    assert rows[1]["transaction_date"] == "2025-12-22"
    assert rows[4]["transaction_date"] == "2026-01-02"
    assert rows[4]["source_page"] == 3
    assert "RENTL: DEMO" in rows[4]["description_raw"]
    assert rows[2]["description_raw"] == rows[3]["description_raw"]
    assert all(check["matches"] for check in result["summary"]["checks"])
    assert result["summary"]["ending_balance"] == "-118.0000"
    assert result["summary"]["rewards"]["earned"] == "1870"
    assert "EXAMPLE LANE" not in str(result["transaction_lines"])
    assert "9999999999999999" not in str(result)


def test_summary_mismatch_warns():
    result = request("usbank-card-inconsistent.pdf").json()
    assert any(row["kind"] == "summary_math_mismatch" for row in result["diagnostics"])


def test_checking_spans_dates_masking_and_daily_replay():
    response = request("usbank-checking.pdf")
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["parser"] == "usbank_checking"
    assert result["account_last4"] == "5678"
    rows = result["entries"]
    assert len(rows) == 3
    assert [row["amount"] for row in rows] == ["500.0000", "-50.0000", "-100.0000"]
    assert rows[2]["transaction_date"] == "2026-01-02"
    assert rows[2]["provider_transaction_id"] == "DEMO-OUT-002"
    assert "1234567890" not in str(result)
    assert "******7890" in rows[0]["source_row_text"]
    assert all(check["matches"] for check in result["summary"]["checks"]), result["summary"]
    assert len(result["summary"]["daily_balances"]) == 2
    kinds = [item["kind"] for item in result["summary"]["checks"]]
    assert "summary_math" in kinds
    for balance in result["summary"]["daily_balances"]:
        assert "daily_balance_" + balance["date"] in kinds
    assert result["summary"]["deposits"] == "500.0000"
    assert result["summary"]["withdrawals"] == "150.0000"
    assert Decimal(result["summary"]["ending_balance"]) == Decimal("1350")


def test_encrypted_password_never_retained_and_unlock():
    assert request("encrypted.pdf").json()["detail"] == "needs_password"
    assert request("encrypted.pdf", "/unlock", password="incorrect").json()["detail"] == "needs_password"
    decrypted = request("encrypted.pdf", "/unlock", password="synthetic-password")
    assert decrypted.status_code == 200
    response = client.post("/parse", files={"file": ("unlocked.pdf", decrypted.content)})
    assert response.status_code == 200
    assert len(response.json()["entries"]) == 7


def test_unknown_empty_invalid_size_pages_and_render(monkeypatch):
    result = request("no-transactions.pdf").json()
    assert result["parser"] == "generic_lines"
    assert result["entries"] == []
    assert request("invalid.pdf").status_code == 422
    rendered = request("usbank-card.pdf", "/render", page="2", dpi="72")
    assert rendered.status_code == 200
    assert rendered.content.startswith(b"\x89PNG")
    assert request("usbank-card.pdf", "/render", page="99").status_code == 422
    monkeypatch.setenv("MAX_PDF_PAGES", "1")
    assert request("usbank-card.pdf").json()["detail"] == "page_limit"
    monkeypatch.setenv("MAX_UPLOAD_MB", "1")
    oversized = client.post("/parse", files={"file": ("huge.pdf", b"%PDF-" + b"0" * 1024 * 1024)})
    assert oversized.status_code == 413


@pytest.mark.skipif(not shutil.which("tesseract"), reason="Local tesseract absent; Docker includes it")
def test_scanned_pdf_uses_low_confidence_ocr():
    response = request("scanned.pdf")
    assert response.status_code == 200, response.text
    result = response.json()
    assert any(row["kind"] == "ocr_low_confidence" for row in result["diagnostics"])
    assert len(result["entries"]) == 1
    assert Decimal(result["entries"][0]["confidence"]) <= Decimal("0.55")
