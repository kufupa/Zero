#!/usr/bin/env python3
"""Aggregate the historical Centurion booking and outbound-mail corpus.

Usage: analyze-centurion-memory.py BOOKINGS_JSON PDF_RECORDS_JSONL MAIL_CORPUS_JSONL NEW_OUTPUT_JSON
The result includes recipient domains and must stay in an owner-only directory.
BOOKINGS_JSON must include sourcePdfEvidence links, as produced by
merge-centurion-confirmation-corpus.py, rather than an unmerged batch snapshot.
Its booking slice is PMS Source of Business = E-Mail; outbound recipients are
not evidence of who sent the original inbound request.
"""

import argparse
import json
import os
import re
from collections import Counter, defaultdict
from datetime import datetime
from decimal import Decimal, InvalidOperation
from email.utils import getaddresses
from itertools import groupby
from pathlib import Path


def norm(value):
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def addresses(values):
    return {address.strip().casefold() for _, address in getaddresses(values or [])
            if re.fullmatch(r"[^\s@]+@[^\s@]+", address)}


def date(value):
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None


def fields(row):
    return {field["name"]: field.get("value") for field in row["recordView"]["details"]["fields"]
            if field.get("name")}


def available(value):
    return bool(str(value or "").strip())


def guest_grid_count(row):
    return sum(len(grid.get("rows") or []) for grid in row["guestDetails"]["details"]["gridContents"])


def guest_form_field(row, name):
    return next((field.get("value") for field in row["guestDetails"]["details"]["fields"]
                 if field.get("name") == name), None)


def recipient_history(timeline, key_index):
    """Rank current-snapshot party tuples by earlier outbound recipient observations."""
    history = defaultdict(Counter)
    evaluated = correct = top_three = 0
    correct_fields = [0, 0, 0]
    for _, same_time in groupby(sorted(timeline, key=lambda row: row[0]), key=lambda row: row[0]):
        batch = list(same_time)
        for row in batch:
            votes = Counter()
            for key in row[key_index]:
                votes.update(history[key])
            if not votes:
                continue
            choices = sorted(votes, key=lambda party: (-votes[party], party))
            actual = row[3]
            evaluated += 1
            correct += choices[0] == actual
            top_three += actual in choices[:3]
            for index in range(3):
                correct_fields[index] += choices[0][index] == actual[index]
        # Messages with the same timestamp cannot train each other.
        for row in batch:
            for key in row[key_index]:
                history[key][row[3]] += 1
    return {"eligible": len(timeline), "with_prior_history": evaluated,
            "top_choice_matches": correct, "top_three_contains_match": top_three,
            "correct_by_field": dict(zip(("booking_agency", "organization", "ar_account"), correct_fields))}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("bookings", type=Path)
    parser.add_argument("pdf_records", type=Path)
    parser.add_argument("mail_corpus", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    document = json.loads(args.bookings.read_text())
    source = [json.loads(line) for line in args.pdf_records.open()]
    records = {row["source"]["attachmentId"]: row for row in source}
    if len(records) != len(source):
        raise ValueError("Duplicate PDF attachment ID")
    if any(row["qualification"]["transportId"] != "transport-centurion" or
           row["qualification"]["direction"] != "outbound" for row in source):
        raise ValueError("Unexpected PDF source")
    all_rows = document["results"]
    if any(not isinstance(row.get("sourcePdfEvidence"), dict) or
           not isinstance(row["sourcePdfEvidence"].get("pdfAttachmentIds"), list) for row in all_rows):
        raise ValueError("Bookings must include the PDF links from the merged corpus")
    references = [attachment for row in all_rows for attachment in row["sourcePdfEvidence"]["pdfAttachmentIds"]]
    if len(references) != len(set(references)) or set(references) != set(records):
        raise ValueError("PDF source and booking evidence do not match")
    successes = [row for row in all_rows if row.get("ok") is True]
    email_rows = [row for row in successes if norm(fields(row).get("sourceofbusinessdesc")) == "e-mail"]
    email_fields = [fields(row) for row in email_rows]
    source_values = Counter(str(fields(row).get("sourceofbusinessdesc") or "").strip() for row in successes)
    rate_values = Counter(str(field.get("rateplan") or "").strip() for field in email_fields)
    status_values = Counter(str(field.get("status") or "").strip() for field in email_fields)
    guarantee_values = Counter(str(field.get("guaranteetype") or "").strip() for field in email_fields)
    cms_values = Counter(str(field.get("udfchar09") or "").strip() for field in email_fields)
    combination = Counter()
    cms_by_combination = defaultdict(Counter)
    for field in email_fields:
        key = "".join("1" if available(field.get(name)) else "0" for name in ("ta1", "company", "araccountname"))
        combination[key] += 1
        cms_by_combination[key][str(field.get("udfchar09") or "").strip()] += 1

    profiles = Counter(str(field["guestid"]).strip() for field in email_fields if available(field.get("guestid")))
    profiles_all = Counter(str(fields(row)["guestid"]).strip() for row in successes
                           if available(fields(row).get("guestid")))
    email_profiles, names = defaultdict(set), defaultdict(set)
    for field in email_fields:
        profile = str(field.get("guestid") or "").strip()
        if not profile:
            continue
        guest_email = addresses([str(field.get("emailaddress") or "")])
        for address in guest_email:
            email_profiles[address].add(profile)
        name = (norm(field.get("firstname")), norm(field.get("lastname")))
        if all(name):
            names[name].add(profile)
    shared_email_sets = [group for group in email_profiles.values() if len(group) > 1]

    domain_groups, address_groups = defaultdict(list), defaultdict(list)
    coverage = Counter()
    thread_ids = set()
    docs_per_booking = []
    timeline = []
    for row in email_rows:
        field = fields(row)
        docs = [records[attachment] for attachment in row["sourcePdfEvidence"]["pdfAttachmentIds"]]
        docs_per_booking.append(len(docs))
        to = set().union(*(addresses(doc["parentMessage"]["to"]) for doc in docs))
        cc = set().union(*(addresses(doc["parentMessage"]["cc"]) for doc in docs))
        domains = {address.rsplit("@", 1)[1] for address in to}
        coverage["with_to"] += bool(to)
        coverage["multiple_to_domains"] += len(domains) > 1
        coverage["with_cc"] += bool(cc)
        guest_email = addresses([str(field.get("emailaddress") or "")])
        coverage["with_guest_email"] += bool(guest_email)
        coverage["guest_email_matches_any_to"] += bool(guest_email & to)
        party = tuple(norm(field.get(name)) for name in ("ta1", "company", "araccountname"))
        dated_docs = [(date(doc["parentMessage"].get("sentAt")), doc) for doc in docs]
        dated_docs = [(when, doc) for when, doc in dated_docs if when]
        if dated_docs:
            first_sent = min(when for when, _ in dated_docs)
            first_to = set().union(*(addresses(doc["parentMessage"]["to"])
                                     for when, doc in dated_docs if when == first_sent))
            first_domains = {address.rsplit("@", 1)[1] for address in first_to}
            timeline.append((first_sent, first_to, first_domains, party))
        for address in to:
            address_groups[address].append(party)
        for domain in domains:
            domain_groups[domain].append((party, str(field.get("rateplan") or "").strip()))
        thread_ids.update(doc["parentMessage"]["threadId"] for doc in docs
                          if doc["parentMessage"].get("threadId"))

    threads = {}
    for line in args.mail_corpus.open():
        thread = json.loads(line)
        if thread.get("recordType") != "thread" or thread.get("threadId") not in thread_ids:
            continue
        events = []
        for message in thread.get("messages", []):
            for source_row in message.get("sourceRows", []):
                private = source_row.get("privateMessage") or {}
                if norm(private.get("direction")) != "inbound":
                    continue
                when = date(private.get("sentAt") or source_row.get("receivedAt") or message.get("timestamp"))
                sender = addresses((private.get("addresses") or {}).get("from"))
                events.append((when, bool(sender)))
        threads[thread["threadId"]] = events
    thread_coverage = Counter()
    for row in email_rows:
        flags = set()
        for attachment in row["sourcePdfEvidence"]["pdfAttachmentIds"]:
            parent = records[attachment]["parentMessage"]
            events = threads.get(parent["threadId"])
            when = date(parent.get("sentAt"))
            if events is None:
                continue
            flags.add("linked_thread_found")
            if events:
                flags.add("thread_contains_inbound")
            if when and any(event_time and event_time <= when and sender for event_time, sender in events):
                flags.add("prior_inbound_with_sender")
        thread_coverage.update(flags)

    domains = []
    for domain, values in sorted(domain_groups.items(), key=lambda item: (-len(item[1]), item[0])):
        parties = Counter(party for party, _ in values)
        rates = Counter(rate for _, rate in values)
        domains.append({"domain": domain, "confirmations": len(values), "party_combinations": len(parties),
                        "largest_party_combination": parties.most_common(1)[0][1], "rate_codes": len(rates)})
    repeated_addresses = {str(threshold): {"addresses": len(groups),
                           "with_multiple_party_combinations": sum(len(set(group)) > 1 for group in groups)}
                          for threshold in (2, 3, 5)
                          for groups in [[v for v in address_groups.values() if len(v) >= threshold]]}
    repeated_domains = {str(threshold): {"domains": len(groups),
                         "with_multiple_party_combinations": sum(len({v[0] for v in group}) > 1 for group in groups)}
                        for threshold in (2, 3, 5)
                        for groups in [[v for v in domain_groups.values() if len(v) >= threshold]]}
    prices = {}
    for rate in rate_values:
        values = []
        for field in email_fields:
            if str(field.get("rateplan") or "").strip() != rate:
                continue
            try:
                values.append(Decimal(str(field.get("averagerate") or "").replace(",", "")))
            except InvalidOperation:
                continue
        prices[rate] = {"distinct_average_rates": len(set(values)), "minimum": str(min(values)) if values else None,
                        "maximum": str(max(values)) if values else None}
    sent = sorted(row["parentMessage"]["sentAt"] for row in source if row["parentMessage"].get("sentAt"))
    not_cancelled = [field for field in email_fields if field.get("status") not in ("Cancelled", "No Show")]
    noncancel_rates = Counter(field.get("rateplan") for field in not_cancelled)
    result = {
        "source": {"pdfs": len(source), "distinct_confirmations": len(all_rows), "successful": len(successes),
                   "failed": sum(row.get("ok") is False for row in all_rows),
                   "distinct_messages": len({row["parentMessage"]["messageDbId"] for row in source}),
                   "distinct_threads": len({row["parentMessage"]["threadId"] for row in source
                                            if row["parentMessage"].get("threadId")}),
                   "first_sent": sent[0] if sent else None, "last_sent": sent[-1] if sent else None},
        "all_sources": dict(source_values), "email_count": len(email_rows), "email_pdf_count": sum(docs_per_booking),
        "email_multiple_pdfs": sum(count > 1 for count in docs_per_booking),
        "email_rate_plans": dict(rate_values), "email_cms_ids": dict(cms_values),
        "email_party_combinations": dict(combination),
        "email_cms_by_party_combination": {key: dict(values) for key, values in cms_by_combination.items()},
        "email_party_distinct_values": {name: len({norm(field.get(name)) for field in email_fields if available(field.get(name))})
                                        for name in ("ta1", "company", "araccountname")},
        "email_organization_without_ar": sum(available(f.get("company")) and not available(f.get("araccountname")) for f in email_fields),
        "email_statuses": dict(status_values), "email_guarantees": dict(guarantee_values),
        "email_non_cancelled_or_no_show": len(not_cancelled),
        "email_non_cancelled_top_five_rates": sum(count for _, count in noncancel_rates.most_common(5)),
        "profiles": {"all_filled": sum(available(fields(row).get("guestid")) for row in successes),
                     "all_distinct": len(profiles_all), "all_repeated_profiles": sum(n > 1 for n in profiles_all.values()),
                     "all_confirmations_with_repeated_profile": sum(n for n in profiles_all.values() if n > 1),
                     "email_filled": sum(available(f.get("guestid")) for f in email_fields),
                     "email_distinct": len(profiles), "email_repeated_profiles": sum(n > 1 for n in profiles.values()),
                     "email_confirmations_with_repeated_profile": sum(n for n in profiles.values() if n > 1),
                     "guest_email_addresses_shared_across_profiles": len(shared_email_sets),
                     "profiles_with_shared_guest_email": len(set().union(*shared_email_sets)) if shared_email_sets else 0,
                     "full_names_with_multiple_profile_ids": sum(len(group) > 1 for group in names.values())},
        "guest_details": {
            "grid_rows_all": dict(Counter(guest_grid_count(row) for row in successes)),
            "grid_rows_email": dict(Counter(guest_grid_count(row) for row in email_rows)),
            "form_profile_ids_all": sum(available(guest_form_field(row, "guestid")) for row in successes),
            "form_first_names_all": sum(available(guest_form_field(row, "firstname")) for row in successes),
            "form_last_names_all": sum(available(guest_form_field(row, "lastname")) for row in successes),
            "form_emails_all": sum(available(guest_form_field(row, "emailaddress")) for row in successes),
        },
        "contacts": {"guest_email": sum(available(f.get("emailaddress")) for f in email_fields),
                     "phone_or_mobile": sum(available(f.get("phonenumber")) or available(f.get("mobilenumber")) for f in email_fields),
                     "both": sum(available(f.get("emailaddress")) and (available(f.get("phonenumber")) or available(f.get("mobilenumber"))) for f in email_fields),
                     "neither": sum(not available(f.get("emailaddress")) and not available(f.get("phonenumber")) and not available(f.get("mobilenumber")) for f in email_fields)},
        "notes": {"reservation_note_nonempty": sum(available(f.get("reservationnote")) for f in email_fields),
                  "popup_note": sum(any(row[stage].get("notes") for stage in ("stay360", "recordView", "guestDetails")) for row in email_rows)},
        "rooms": {"charge_type_filled": sum(available(f.get("roomtypecharge")) for f in email_fields),
                  "charge_type_differs": sum(available(f.get("roomtypecharge")) and norm(f.get("roomtypecharge")) != norm(f.get("roomtype")) for f in email_fields),
                  "assigned_room": sum(available(f.get("room")) for f in email_fields)},
        "adults": dict(Counter(str(f.get("adults") or "").strip() for f in email_fields)),
        "children": dict(Counter(str(f.get("children") or "").strip() for f in email_fields)),
        "nights": dict(Counter(str(f.get("nights") or "").strip() for f in email_fields)),
        "rate_prices": prices, "recipient_coverage": dict(coverage), "recipient_domains": domains,
        "recipient_address_reuse": repeated_addresses, "recipient_domain_reuse": repeated_domains,
        "distinct_recipient_addresses": len(address_groups), "distinct_recipient_domains": len(domain_groups),
        "linked_thread_coverage": dict(thread_coverage),
        "recipient_history_at_first_outbound": {"address": recipient_history(timeline, 1),
                                                 "domain": recipient_history(timeline, 2)},
    }
    if sum(rate_values.values()) != len(email_rows) or sum(combination.values()) != len(email_rows):
        raise ValueError("Email aggregates do not reconcile")
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.output.parent.stat().st_mode & 0o077:
        raise ValueError("Output directory is not private")
    with args.output.open("x") as output:
        json.dump(result, output, indent=2, sort_keys=True)
        output.write("\n")
    print(json.dumps({"pdfs": len(source), "successful": len(successes), "email": len(email_rows),
                      "output": str(args.output)}))


if __name__ == "__main__":
    main()
