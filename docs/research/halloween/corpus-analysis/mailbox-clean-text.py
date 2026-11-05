#!/usr/bin/env python3
"""Small, conservative signature trim for already-cleaned mailbox packets."""

import re


SIGNATURE = re.compile(
    r'(?im)^[ \t]*(?:(?:(?:kind(?:est)?|warm(?:est)?|best|with kind)[ \t]+)?regards'
    r'|yours[ \t]+sincerely|sincerely|--|sent from my (?:iphone|android|mobile))'
    r'[ \t]*[,!.\-]*[ \t]*$'
)
FORWARDED_OR_ACTIONABLE = re.compile(
    r'(?ims)^[ \t]*(?:>[ \t]*)?\*?(?:from|de|von|van|da|sent|enviado(?:[ \t]+el)?|'
    r'gesendet|envoyé|date|fecha|datum|to|para|aan|subject|asunto|objet|betreff)\*?:\*?'
    r'|^[ \t]*(?:>[ \t]*)?on[ \t].{5,240}?\bwrote:[ \t]*$'
    r'|^[ \t]*(?:[-_ ]{4,}forwarded|[-_ ]{4,}original message)'
    r'|\b(?:please|kindly)[ \t]+(?:book|quote|cancel|amend|change)\b'
    r'|\b(?:booking|reservation|quote)[ \t]+request\b'
)


def trim_signature(text):
    if not isinstance(text, str):
        return text, False
    match = SIGNATURE.search(text)
    if not match or len(text[:match.start()].strip()) < 30:
        return text, False
    # A forwarded request can follow the sender's sign-off. Keep the whole
    # text when the tail still looks like a message or a reservation request.
    if FORWARDED_OR_ACTIONABLE.search(text[match.end():]):
        return text, False
    return text[:match.start()].rstrip(), True


def clean_packet(packet):
    """Return a new packet; retain the original source and reply identities."""
    result = dict(packet)
    inbound = dict(packet['inbound'])
    inbound['message'], inbound_trimmed = trim_signature(inbound.get('message'))
    result['inbound'] = inbound
    replies = []
    reply_trimmed = 0
    for reply in packet.get('candidate_replies') or []:
        candidate = dict(reply)
        candidate['body'], trimmed = trim_signature(candidate.get('body'))
        reply_trimmed += int(trimmed)
        replies.append(candidate)
    result['candidate_replies'] = replies
    return result, {'inbound_trimmed': inbound_trimmed, 'replies_trimmed': reply_trimmed}
