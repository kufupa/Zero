"""Move private mailbox payloads through the approved, expiring S3 transfer path.

SSM stdout and command history may contain metadata only. Payloads are uploaded
with AES256 server-side encryption to the private one-day transfer prefix, then
downloaded to an owner-private temporary directory and deleted.
"""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Any


BUCKET = 'nava-zero-mail-845242190536-af-south-1'
EXPECTED_BUCKET_OWNER = '845242190536'
REGION = 'af-south-1'
TRANSFER_PREFIX = 'hms-browser-proof-transfer/v1/mailbox-research'
MAX_TRANSFER_BYTES = 50_000_000
_TRANSFER_KEY_RE = re.compile(
    re.escape(TRANSFER_PREFIX) + r'/[0-9a-f]{32}/payload\.bin'
)


def transfer_key(token: str) -> str:
    if not re.fullmatch(r'[0-9a-f]{32}', token):
        raise ValueError('invalid_transfer_token')
    return f'{TRANSFER_PREFIX}/{token}/payload.bin'


def _aws_json(operation: str) -> dict[str, Any]:
    result = subprocess.run(
        [
            'aws', 's3api', operation, '--bucket', BUCKET, '--region', REGION,
            '--expected-bucket-owner', EXPECTED_BUCKET_OWNER, '--output', 'json',
        ],
        text=True,
        capture_output=True,
        timeout=30,
    )
    if result.returncode:
        raise RuntimeError('private_transfer_preflight_failed')
    if operation == 'get-bucket-versioning' and not result.stdout.strip():
        return {}
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError('private_transfer_preflight_failed') from exc
    if not isinstance(value, dict):
        raise RuntimeError('private_transfer_preflight_failed')
    return value


def ensure_private_transfer_bucket() -> None:
    public_block = _aws_json('get-public-access-block').get('PublicAccessBlockConfiguration', {})
    if not all(
        public_block.get(flag) is True
        for flag in ('BlockPublicAcls', 'IgnorePublicAcls', 'BlockPublicPolicy', 'RestrictPublicBuckets')
    ):
        raise RuntimeError('private_transfer_bucket_not_private')

    if _aws_json('get-bucket-versioning').get('Status'):
        raise RuntimeError('private_transfer_bucket_versioned')

    lifecycle = _aws_json('get-bucket-lifecycle-configuration')
    rules = [
        rule for rule in lifecycle.get('Rules', [])
        if rule.get('ID') == 'HmsBrowserProofTransferExpire1Day'
    ]
    if len(rules) != 1:
        raise RuntimeError('private_transfer_expiry_unavailable')
    rule = rules[0]
    if (
        rule.get('Status') != 'Enabled'
        or rule.get('Filter') != {'Prefix': 'hms-browser-proof-transfer/v1/'}
        or rule.get('Expiration', {}).get('Days') != 1
        or rule.get('NoncurrentVersionExpiration') is not None
    ):
        raise RuntimeError('private_transfer_expiry_unavailable')


def _validate_key(key: str) -> None:
    if not _TRANSFER_KEY_RE.fullmatch(key):
        raise ValueError('invalid_transfer_key')


def fetch_payload(metadata: object, expected_key: str) -> bytes:
    _validate_key(expected_key)
    if not isinstance(metadata, dict):
        raise ValueError('invalid_transfer_metadata')
    size = metadata.get('bytes')
    digest = metadata.get('sha256')
    if (
        metadata.get('key') != expected_key
        or metadata.get('server_side_encryption') != 'AES256'
        or not isinstance(size, int)
        or isinstance(size, bool)
        or not 0 < size < MAX_TRANSFER_BYTES
        or not isinstance(digest, str)
        or not re.fullmatch(r'[0-9a-f]{64}', digest)
    ):
        raise ValueError('invalid_transfer_metadata')

    with tempfile.TemporaryDirectory(prefix='nava-mailbox-transfer-') as directory:
        path = Path(directory) / 'payload.bin'
        result = subprocess.run(
            [
                'aws', 's3api', 'get-object', '--bucket', BUCKET, '--key', expected_key,
                '--region', REGION, '--expected-bucket-owner', EXPECTED_BUCKET_OWNER,
                '--output', 'json',
                str(path),
            ],
            text=True,
            capture_output=True,
            timeout=150,
        )
        if result.returncode:
            raise RuntimeError('private_transfer_download_failed')
        try:
            response = json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise RuntimeError('private_transfer_download_failed') from exc
        if (
            not isinstance(response, dict)
            or response.get('ServerSideEncryption') != 'AES256'
            or response.get('ContentLength') != size
        ):
            raise RuntimeError('private_transfer_integrity_failed')
        payload = path.read_bytes()
    if len(payload) != size or hashlib.sha256(payload).hexdigest() != digest:
        raise RuntimeError('private_transfer_integrity_failed')
    return payload


def delete_transfer(key: str) -> None:
    _validate_key(key)
    result = subprocess.run(
        [
            'aws', 's3api', 'delete-object', '--bucket', BUCKET, '--key', key,
            '--region', REGION, '--expected-bucket-owner', EXPECTED_BUCKET_OWNER,
            '--output', 'json',
        ],
        text=True,
        capture_output=True,
        timeout=30,
    )
    if result.returncode:
        raise RuntimeError('private_transfer_cleanup_failed')
