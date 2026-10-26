"""Synthetic PDFs only: never reads statements or other external inputs."""

from pathlib import Path
import pymupdf

ROOT = Path(__file__).parent


def text(p, x, y, value, bold=False, size=10):
    p.insert_text((x, y), value, fontname="hebo" if bold else "helv", fontsize=size)


def right(p, x, y, value, size=10):
    text(p, x - pymupdf.get_text_length(value, fontsize=size), y, value, size=size)


def page(doc):
    return doc.new_page(width=612, height=792)


def card_header(p, n):
    text(p, 60, 45, "12/15/2025 - 01/14/2026")
    text(p, 60, 60, "ALEX SAMPLE")
    text(p, 430, 60, f"Page {n} of 4")
    text(p, 60, 80, "Cardmember Service")


def card_columns(p, y):
    for x, label in [
        (64.8, "Post Date"),
        (100.8, "Trans Date"),
        (136.8, "Ref #"),
        (172.8, "Transaction Description"),
        (480, "Amount"),
    ]:
        text(p, x, y, label, size=7)


def card_row(p, y, post, trans, desc, value, extra=(), ref="1234"):
    for x, label in [(64.8, post), (100.8, trans), (136.8, ref), (172.8, desc)]:
        if label:
            text(p, x, y, label)
    right(p, 520, y, value)
    for index, label in enumerate(extra):
        text(p, 172.8, y + 10.4 * (index + 1), label, size=8)


def total(p, y, value):
    text(p, 352, y, "TOTAL THIS PERIOD")
    right(p, 520, y, value)


def card(inconsistent=False):
    doc = pymupdf.open()
    p = page(doc)
    text(p, 40, 35, "U.S. Bank Altitude Reserve Visa Infinite Card", True)
    text(p, 40, 55, "Open Date: 12/15/2025 | Closing Date: 01/14/2026")
    text(p, 40, 75, "Account Ending in: #### #### #### 1234")
    text(p, 307, 110, "Activity Summary", True)
    rows = [
        ("Previous Balance", "+", "100.00"),
        ("Payments", "-", "50.00"),
        ("Other Credits", "-", "10.00"),
        ("Purchases", "+", "75.00"),
        ("Balance Transfers", "+", "0.00"),
        ("Advances", "+", "0.00"),
        ("Other Debits", "+", "0.00"),
        ("Fees Charged", "+", "2.00"),
        ("Interest Charged", "+", "1.00"),
        ("New Balance", "=", "119.00" if inconsistent else "118.00"),
        ("Past Due", "", "0.00"),
        ("Minimum Payment Due", "", "25.00"),
    ]
    for index, (label, sign, value) in enumerate(rows):
        y = 130 + index * 16
        text(p, 307, y, label, size=9)
        text(p, 427, y, sign, size=9)
        right(p, 513, y, "$" + value, size=9)
        if label in ("Payments", "Other Credits"):
            text(p, 518, y, "CR", size=6)
    text(p, 30, 200, "Payment Due Date 02/09/2026")
    text(p, 30, 400, "Earned This Statement* 1,870")
    text(p, 30, 420, "Total as of 01/14/2026** 8,000")
    text(p, 30, 650, "ALEX SAMPLE - 123 EXAMPLE LANE")
    text(p, 30, 670, "9999999999999999")
    text(p, 30, 750, "U.S. Bank")
    p = page(doc)
    card_header(p, 2)
    text(p, 60, 110, "Transactions", True)
    text(p, 60, 130, "Payments and Other Credits", True)
    card_columns(p, 150)
    card_row(p, 175, "12/20", "12/19", "ONLINE PAYMENT - THANK YOU", "$50.00")
    card_row(p, 200, "12/22", "", "EXAMPLE SHOP", "$10.00", ["MERCHANDISE/SERVICE RETURN"], "")
    total(p, 240, "$60.00")
    text(p, 60, 275, "Purchases and Other Debits", True)
    card_columns(p, 295)
    card_row(p, 320, "12/28", "12/27", "EXAMPLE CAFE", "$20.00")
    card_row(p, 350, "12/28", "12/27", "EXAMPLE CAFE", "$20.00")
    text(p, 60, 720, "Continued on Next Page")
    p = page(doc)
    card_header(p, 3)
    text(p, 60, 130, "Purchases and Other Debits", True)
    card_columns(p, 150)
    card_row(
        p,
        175,
        "01/03",
        "01/02",
        "EXAMPLE TRAVEL",
        "$35.00",
        ["PASSENGER/ALEX SAMPLE 01/02/26", "ORIGIN TO DEST", "RENTL: DEMO"],
    )
    total(p, 230, "$75.00")
    for y, title, value, date in [
        (265, "Fees", "$2.00", "01/10"),
        (375, "Interest Charged", "$1.00", "01/14"),
    ]:
        text(p, 60, y, title, True)
        card_columns(p, y + 20)
        card_row(p, y + 45, date, date, "EXAMPLE " + title.upper(), value)
        total(p, y + 75, value)
    p = page(doc)
    card_header(p, 4)
    text(p, 30, 110, "Important Messages", True)
    text(p, 30, 130, "No transaction data on this legal and information page.", size=8)
    text(p, 30, 150, "Points Rewards Summary", size=8)
    return doc


def bank_header(p, n):
    text(p, 20, 35, "U.S. Bank Uni-Statement", True)
    for y, label in [
        (55, "Account Number:"),
        (70, "1 999 8888 5678"),
        (90, "Statement Period:"),
        (105, "Dec 15, 2025"),
        (120, "through"),
        (135, "Jan 14, 2026"),
        (155, f"Page {n} of 2"),
    ]:
        text(p, 430, y, label)
    text(p, 20, 175, "U.S. BANK SMARTLY CHECKING", True, 12)
    text(p, 400, 190, "Account Number 1-999-8888-5678", size=8)


def bank_columns(p, y):
    for x, label in [(20, "Date"), (56, "Description of Transaction"), (400, "Ref Number"), (490, "Amount")]:
        text(p, x, y, label, size=8)


def bank_row(p, y, mon, day, desc, value, actual, provider, split=True):
    if split:
        for x, label in [(20.1, mon), (43.9, day), (56.2, desc)]:
            text(p, x, y, label)
    else:
        text(p, 20.1, y, f"{mon} {day} {desc}")
    text(p, 207, y, "From Account 1234567890", size=8)
    right(p, 550, y, value)
    text(p, 70.6, y + 12, "On " + actual, size=8)
    text(p, 400, y + 12, "PMT ID=" + provider, size=8)


def checking():
    doc = pymupdf.open()
    p = page(doc)
    bank_header(p, 1)
    text(p, 20, 220, "Account Summary", True)
    for index, (label, value) in enumerate(
        [
            ("Beginning Balance on Dec 15", "1000.00"),
            ("Deposits / Credits", "500.00"),
            ("Other Withdrawals", "150.00-"),
            ("Ending Balance on Jan 14, 2026", "1350.00"),
        ]
    ):
        y = 245 + index * 17
        text(p, 20, y, label, index == 3, 9)
        text(p, 220, y, "$")
        right(p, 300, y, value)
    text(p, 315, 245 - 1.1, "Number of Days in Statement Period", size=8)
    text(p, 550, 245 - 1.1, "31", size=8)
    text(p, 20, 355, "Deposits / Credits ", True)
    bank_columns(p, 375)
    bank_row(p, 400, "Dec", "20", "EXAMPLE PAYROLL", "$500.00", "12/19/25", "DEMO-IN-001")
    text(p, 20, 440, "Total Deposits / Credits")
    right(p, 550, 440, "$500.00")
    text(p, 20, 480, "Other Withdrawals ", True)
    bank_columns(p, 500)
    bank_row(p, 525, "Dec", "20", "CARD PAYMENT", "$50.00-", "12/19/25", "DEMO-OUT-001", False)
    p = page(doc)
    bank_header(p, 2)
    text(p, 20, 220, "Other Withdrawals ", True)
    bank_columns(p, 240)
    bank_row(p, 265, "Jan", "03", "EXAMPLE RENT", "100.00-", "01/02/26", "DEMO-OUT-002")
    text(p, 20, 310, "Total Other Withdrawals")
    right(p, 550, 310, "$150.00")
    text(p, 20, 350, "Balance Summary", True)
    for x, label in [(20, "Date"), (115, "Ending Balance"), (207, "Date"), (302, "Ending Balance")]:
        text(p, x, 375, label, size=8)
    text(p, 20, 400, "Dec 20")
    right(p, 170, 400, "1450.00")
    text(p, 207, 400, "Jan 03")
    right(p, 357, 400, "1350.00")
    text(p, 20, 430, "Balances only appear for days reflecting change.")
    return doc


def generate():
    for name, doc in [
        ("usbank-card.pdf", card()),
        ("usbank-card-inconsistent.pdf", card(True)),
        ("usbank-checking.pdf", checking()),
    ]:
        doc.save(ROOT / name)
        doc.close()
    with card() as doc:
        doc.save(
            ROOT / "encrypted.pdf",
            encryption=pymupdf.PDF_ENCRYPT_AES_256,
            owner_pw="synthetic-owner-password",
            user_pw="synthetic-password",
        )
    with pymupdf.open() as doc:
        text(page(doc), 40, 80, "Example informational document. No transaction activity.")
        doc.save(ROOT / "no-transactions.pdf")
    with pymupdf.open() as source:
        p = page(source)
        text(p, 40, 70, "Transactions", size=16)
        text(p, 40, 110, "01/02/2026 EXAMPLE SHOP $12.00", size=14)
        with pymupdf.open() as doc:
            page(doc).insert_image(p.rect, stream=p.get_pixmap(dpi=150).tobytes("png"))
            doc.save(ROOT / "scanned.pdf")
    (ROOT / "invalid.pdf").write_bytes(b"not a PDF - synthetic malformed fixture")


if __name__ == "__main__":
    generate()
