"""Stable canonical IDs and aliases. Subject match alone never merges emails."""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Iterable


def stable_hash(*parts: object) -> str:
    raw = "\0".join("" if p is None else str(p) for p in parts)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def salted_sort_key(canonical_id: str, seed: str) -> str:
    return hashlib.sha256(f"{seed}\0{canonical_id}".encode("utf-8")).hexdigest()


@dataclass
class AliasIndex:
    """Duplicates stay as aliases of one canonical id."""

    canonical_of: dict[str, str] = field(default_factory=dict)
    aliases_of: dict[str, list[str]] = field(default_factory=dict)

    def add(self, canonical: str, *aliases: str) -> str:
        root = self.resolve(canonical)
        self.canonical_of.setdefault(root, root)
        self.aliases_of.setdefault(root, [])
        for a in aliases:
            if not a or a == root:
                continue
            prior = self.canonical_of.get(a)
            if prior and prior != root:
                # conflicting alias versions — quarantine by keeping first binding
                continue
            self.canonical_of[a] = root
            if a not in self.aliases_of[root]:
                self.aliases_of[root].append(a)
        return root

    def resolve(self, key: str) -> str:
        seen: set[str] = set()
        while key in self.canonical_of and self.canonical_of[key] != key:
            if key in seen:
                break
            seen.add(key)
            key = self.canonical_of[key]
        return key

    def record(self, key: str) -> dict[str, object]:
        root = self.resolve(key)
        aliases = sorted(self.aliases_of.get(root, []))
        return {"canonical_id": root, "aliases": aliases, "alias_count": len(aliases)}


def build_v6_alias_index(case_ids: Iterable[str], label_ids: Iterable[str]) -> AliasIndex:
    idx = AliasIndex()
    labels = set(label_ids)
    for cid in case_ids:
        aliases = [cid]
        if cid in labels:
            aliases.append(f"label:{cid}")
        idx.add(cid, *aliases)
    for lid in labels:
        if lid not in idx.canonical_of:
            idx.add(lid, f"label:{lid}")
    return idx


def halloween_not_independent(inputs_ids: list[str], backtest_ids: list[str]) -> dict[str, object]:
    """dataset/backtest/inputs.jsonl is another view, not another 1530 examples."""
    a, b = set(inputs_ids), set(backtest_ids)
    return {
        "inputs_n": len(inputs_ids),
        "inputs_unique": len(a),
        "backtest_n": len(backtest_ids),
        "backtest_unique": len(b),
        "intersection": len(a & b),
        "backtest_only": len(b - a),
        "inputs_only": len(a - b),
        "independent_examples_claim": False,
        "note": "backtest inputs are another view of the same halloween decisions",
    }
