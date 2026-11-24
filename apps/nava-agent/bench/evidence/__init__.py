"""Offline U2/U3 evidence plumbing. Explicit source paths only; no DB discovery."""

from .schema import SCHEMA_VERSION, FIELD_POLICY_VERSION, SAMPLE_VERSION

__all__ = ["SCHEMA_VERSION", "FIELD_POLICY_VERSION", "SAMPLE_VERSION"]
