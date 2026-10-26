from . import generic, usbank_checking, usbank_credit_card
from ..document import Document

ADAPTERS = (usbank_credit_card, usbank_checking, generic)


def parse_document(doc: Document):
    adapter = max(ADAPTERS, key=lambda item: item.detect(doc))
    return adapter.parse(doc)
