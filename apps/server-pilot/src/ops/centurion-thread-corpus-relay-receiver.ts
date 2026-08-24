import {
  buildReceiveReceipt,
  buildReceiverAcknowledgement,
  receiverAcknowledgementKey,
  relayManifestKey,
  relayObjectKey,
  verifyCenturionRelaySnapshot,
  type CenturionRelayMember,
} from './centurion-thread-corpus-relay.js';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type {
  RelayBucketConfig,
  RelayObjectMetadata,
  RelayObjectStore,
} from './centurion-thread-corpus-relay-producer.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export type WindowsPrivateAcl = {
  assertTrustedPath(path: string): Promise<{ stableIdentity: string; volumeId: string } | null>;
  lockDownDirectory(path: string): Promise<boolean>;
  lockDownFiles(paths: readonly string[]): Promise<boolean>;
  promoteNoReplace(partialPath: string, finalPath: string): Promise<boolean>;
  fsyncReceipt(path: string): Promise<boolean>;
};

export type ReceiverFileSystem = {
  assertGitignoredPrivateRoot(): Promise<{
    root: string;
    stableIdentity: string;
    volumeId: string;
  } | null>;
  createPartialDirectory(transferId: string): Promise<string | null>;
  writeCreateNew(path: string, content: Uint8Array): Promise<boolean>;
  readFile(path: string, maxBytes: number): Promise<Uint8Array | null>;
  listRelativePaths(root: string): Promise<readonly string[] | null>;
  writeReceiveReceipt(receiptJson: string): Promise<{ path: string; sha256: string } | null>;
  removePartial(path: string): Promise<boolean>;
};

export type RelayReceiverRuntimeConfig = {
  version: 'centurion-thread-corpus-relay-receiver-config-v1';
  relay: RelayBucketConfig;
  privateDestination: { checkoutRoot: string; destinationRoot: string };
};

export type RelayReceiverRuntimePort = {
  platform(): string;
  readProtectedConfig(): Promise<string>;
  inspectCheckout(input: {
    checkoutRoot: string;
    destinationRoot: string;
  }): Promise<{ gitignored: boolean; stableIdentity: string; volumeId: string } | null>;
};

export type ReceiverResult =
  | {
      outcome: 'received';
      transferId: string;
      sourceManifestSha256: string;
      memberSetSha256: string;
    }
  | { outcome: 'blocked' };

export type WindowsCommandInvocation = {
  executable: 'powershell.exe';
  args: readonly ['-NoProfile', '-NonInteractive', '-EncodedCommand', string];
  options: {
    shell: false;
    windowsHide: true;
    stdio: readonly ['ignore', 'pipe', 'ignore'];
    env: Readonly<Record<string, string>>;
  };
};

export type WindowsCommandRunner = {
  run(invocation: WindowsCommandInvocation): Promise<{
    status: number | null;
    stdout: string | null;
  }>;
};

type RemoteMember = {
  path: string;
  bytes: number;
  sha256: string;
};

type ParsedRelayManifest = {
  transferId: string;
  snapshotId: string;
  sourceManifestSha256: string;
  memberSetSha256: string;
  members: RemoteMember[];
  bytes: Uint8Array;
  sha256: string;
};

type TrustedPath = {
  stableIdentity: string;
  volumeId: string;
};

type VerifiedFinal = {
  receiptSha256: string;
};

const RECEIVER_CONFIG_VERSION = 'centurion-thread-corpus-relay-receiver-config-v1';
const RELAY_VERSION = 'centurion-thread-corpus-relay-v1';
const RECEIPT_FILENAME = 'receive-receipt.v1.json';
const RELAY_MANIFEST_FILENAME = 'relay-manifest.v1.json';
const MAX_RELAY_MANIFEST_BYTES = 1_000_000;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_ACL_BATCH_PATHS = 4_096;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const OPAQUE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LITERAL_ROOT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RAW_MIME_MEMBER = /^raw-mime\/[a-f0-9]{64}\.eml$/;
const ATTACHMENT_TEXT_MEMBER = /^attachment-text\/[a-f0-9]{64}\.txt$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

const POWERSHELL_PRIVATE_ACL_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$VerbosePreference = 'SilentlyContinue'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public struct CenturionRelayFileInformation {
  public uint FileAttributes;
  public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
  public uint VolumeSerialNumber;
  public uint FileSizeHigh;
  public uint FileSizeLow;
  public uint NumberOfLinks;
  public uint FileIndexHigh;
  public uint FileIndexLow;
}

public static class CenturionRelayNative {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern SafeFileHandle CreateFile(
    string path,
    uint desiredAccess,
    uint shareMode,
    IntPtr securityAttributes,
    uint creationDisposition,
    uint flagsAndAttributes,
    IntPtr templateFile
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetFileInformationByHandle(
    SafeFileHandle handle,
    out CenturionRelayFileInformation information
  );
}
'@ | Out-Null

function Require-EnvironmentValue([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) { throw 'missing input' }
  return $value
}

function Canonical-Path([string]$Value) {
  $full = [IO.Path]::GetFullPath($Value)
  $comparison = [StringComparison]::OrdinalIgnoreCase
  if (-not [String]::Equals($full.TrimEnd('\'), $Value.TrimEnd('\'), $comparison)) {
    throw 'noncanonical path'
  }
  return $full
}

function Read-HandleIdentity([string]$PathValue) {
  $item = Get-Item -LiteralPath $PathValue -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'reparse point'
  }

  $share = [uint32]([IO.FileShare]::Read -bor [IO.FileShare]::Write -bor [IO.FileShare]::Delete)
  $flags = [uint32]0x02200000
  $handle = [CenturionRelayNative]::CreateFile(
    $PathValue,
    [uint32]0,
    $share,
    [IntPtr]::Zero,
    [uint32]3,
    $flags,
    [IntPtr]::Zero
  )
  if ($handle.IsInvalid) { throw 'handle open failed' }
  try {
    $info = New-Object CenturionRelayFileInformation
    if (-not [CenturionRelayNative]::GetFileInformationByHandle($handle, [ref]$info)) {
      throw 'handle stat failed'
    }
    if (($info.FileAttributes -band [uint32]0x400) -ne 0) {
      throw 'reparse handle'
    }
    return [PSCustomObject]@{
      stableIdentity = ('{0:x8}:{1:x8}:{2:x8}' -f $info.VolumeSerialNumber, $info.FileIndexHigh, $info.FileIndexLow)
      volumeId = ('{0:x8}' -f $info.VolumeSerialNumber)
    }
  } finally {
    $handle.Dispose()
  }
}

function Assert-TrustedPath([string]$PathValue) {
  $full = Canonical-Path $PathValue
  $first = Read-HandleIdentity $full
  $cursor = $full
  while ($true) {
    $current = Read-HandleIdentity $cursor
    if ($cursor -eq $full -and $current.stableIdentity -ne $first.stableIdentity) {
      throw 'identity changed'
    }
    $parent = [IO.Path]::GetDirectoryName($cursor)
    if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
  $second = Read-HandleIdentity $full
  if ($second.stableIdentity -ne $first.stableIdentity -or $second.volumeId -ne $first.volumeId) {
    throw 'identity changed'
  }
  return $second
}

function Set-PrivateAcl([string]$PathValue, [bool]$Directory) {
  $identity = Assert-TrustedPath $PathValue
  $callerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ([string]::IsNullOrWhiteSpace($callerSid)) { throw 'caller SID unavailable' }
  $systemSid = 'S-1-5-18'
  $item = Get-Item -LiteralPath $PathValue -Force -ErrorAction Stop
  $acl = $item.GetAccessControl()
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
    [void]$acl.RemoveAccessRuleAll($rule)
  }
  $inheritance = if ($Directory) {
    [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  } else {
    [Security.AccessControl.InheritanceFlags]::None
  }
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($callerSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow)))
  [void]$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($systemSid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow)))
  $item.SetAccessControl($acl)

  $verified = (Get-Item -LiteralPath $PathValue -Force -ErrorAction Stop).GetAccessControl()
  if (-not $verified.AreAccessRulesProtected) { throw 'inheritance enabled' }
  $rules = @($verified.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | Where-Object { -not $_.IsInherited })
  if ($rules.Count -ne 2) { throw 'unexpected acl entries' }
  foreach ($rule in $rules) {
    if (
      $rule.AccessControlType -ne $allow -or
      $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
      ($rule.IdentityReference.Value -ne $callerSid -and $rule.IdentityReference.Value -ne $systemSid)
    ) {
      throw 'unexpected acl rule'
    }
  }
  return (Assert-TrustedPath $PathValue)
}

function Promote-NoReplace([string]$PartialValue, [string]$FinalValue) {
  $partial = Assert-TrustedPath $PartialValue
  $final = Canonical-Path $FinalValue
  $parentPath = [IO.Path]::GetDirectoryName($final)
  if ([string]::IsNullOrEmpty($parentPath)) { throw 'missing final parent' }
  $parent = Assert-TrustedPath $parentPath
  if ($partial.volumeId -ne $parent.volumeId -or (Test-Path -LiteralPath $final)) {
    throw 'unsafe promotion'
  }
  [IO.Directory]::Move($PartialValue, $FinalValue)
  $promoted = Assert-TrustedPath $FinalValue
  if ($promoted.volumeId -ne $partial.volumeId) { throw 'cross volume promotion' }
  return $promoted
}

function Fsync-Receipt([string]$PathValue) {
  $before = Assert-TrustedPath $PathValue
  $stream = New-Object IO.FileStream($PathValue, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  $after = Assert-TrustedPath $PathValue
  if ($after.stableIdentity -ne $before.stableIdentity -or $after.volumeId -ne $before.volumeId) {
    throw 'receipt identity changed'
  }
}

try {
  $operation = Require-EnvironmentValue 'CENTURION_RELAY_OPERATION'
  switch ($operation) {
    'assert' {
      $identity = Assert-TrustedPath (Require-EnvironmentValue 'CENTURION_RELAY_PATH')
      [Console]::Out.Write(('{"ok":true,"stableIdentity":"' + $identity.stableIdentity + '","volumeId":"' + $identity.volumeId + '"}'))
      exit 0
    }
    'lock-directory' {
      [void](Set-PrivateAcl (Require-EnvironmentValue 'CENTURION_RELAY_PATH') $true)
      [Console]::Out.Write('{"ok":true}')
      exit 0
    }
    'lock-files' {
      $encodedPaths = Require-EnvironmentValue 'CENTURION_RELAY_PATHS'
      $paths = ConvertFrom-Json -InputObject $encodedPaths -NoEnumerate
      if (-not ($paths -is [Array]) -or $paths.Count -eq 0 -or $paths.Count -gt 4096) {
        throw 'invalid file set'
      }
      $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
      foreach ($filePath in $paths) {
        if (-not ($filePath -is [string]) -or -not $seen.Add($filePath)) { throw 'invalid file path' }
        [void](Set-PrivateAcl $filePath $false)
      }
      [Console]::Out.Write('{"ok":true}')
      exit 0
    }
    'promote' {
      [void](Promote-NoReplace (Require-EnvironmentValue 'CENTURION_RELAY_PATH') (Require-EnvironmentValue 'CENTURION_RELAY_FINAL_PATH'))
      [Console]::Out.Write('{"ok":true}')
      exit 0
    }
    'fsync-receipt' {
      Fsync-Receipt (Require-EnvironmentValue 'CENTURION_RELAY_PATH')
      [Console]::Out.Write('{"ok":true}')
      exit 0
    }
    default { throw 'unknown operation' }
  }
} catch {
  exit 1
}`;

export const WINDOWS_PRIVATE_ACL_ENCODED_COMMAND = Buffer.from(
  POWERSHELL_PRIVATE_ACL_SCRIPT,
  'utf16le',
).toString('base64');

function blocked(): ReceiverResult {
  return { outcome: 'blocked' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCanonicalKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function isOpaqueIdentifier(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_IDENTIFIER.test(value);
}

function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function sha256(content: Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function decodeUtf8(content: Uint8Array): string | null {
  try {
    if (
      content.byteLength >= 3 &&
      content[0] === 0xef &&
      content[1] === 0xbb &&
      content[2] === 0xbf
    ) {
      return null;
    }
    return textDecoder.decode(content);
  } catch {
    return null;
  }
}

function isLiteralRelayRoot(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.includes('\\') &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    value.split('/').every((segment) => LITERAL_ROOT_SEGMENT.test(segment))
  );
}

function isRelayBucketConfig(value: unknown): value is RelayBucketConfig {
  return (
    isRecord(value) &&
    hasCanonicalKeys(value, [
      'region',
      'bucket',
      'expectedBucketOwner',
      'literalRelayRoot',
      'kmsKeyArn',
      'lifecycleRuleId',
      'lifecycleExpirationDays',
      'maxSnapshotBytes',
    ]) &&
    typeof value.region === 'string' &&
    /^[a-z0-9-]{3,32}$/.test(value.region) &&
    typeof value.bucket === 'string' &&
    /^[a-z0-9](?:[a-z0-9.-]{1,61})?[a-z0-9]$/.test(value.bucket) &&
    !value.bucket.includes('..') &&
    typeof value.expectedBucketOwner === 'string' &&
    /^\d{12}$/.test(value.expectedBucketOwner) &&
    isLiteralRelayRoot(value.literalRelayRoot) &&
    typeof value.kmsKeyArn === 'string' &&
    /^arn:(aws|aws-us-gov|aws-cn):kms:[a-z0-9-]+:\d{12}:key\/[A-Za-z0-9-]+$/.test(
      value.kmsKeyArn,
    ) &&
    typeof value.lifecycleRuleId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(value.lifecycleRuleId) &&
    value.lifecycleExpirationDays === 1 &&
    isSafeInteger(value.maxSnapshotBytes, 1)
  );
}

function isCanonicalWindowsPath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > 4_096 ||
    value.includes('/') ||
    value.includes('\0') ||
    !/^[A-Za-z]:\\/.test(value) ||
    value.endsWith('\\')
  ) {
    return false;
  }
  return path.win32.normalize(value) === value && !value.split('\\').includes('..');
}

function sameWindowsPath(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

function expectedDestinationRoot(checkoutRoot: string): string {
  return path.win32.join(checkoutRoot, '.private', 'centurion-thread-corpus');
}

export function parseRelayReceiverRuntimeConfig(value: string): RelayReceiverRuntimeConfig | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      !hasCanonicalKeys(parsed, ['version', 'relay', 'privateDestination']) ||
      parsed.version !== RECEIVER_CONFIG_VERSION ||
      !isRelayBucketConfig(parsed.relay) ||
      !isRecord(parsed.privateDestination) ||
      !hasCanonicalKeys(parsed.privateDestination, ['checkoutRoot', 'destinationRoot']) ||
      !isCanonicalWindowsPath(parsed.privateDestination.checkoutRoot) ||
      !isCanonicalWindowsPath(parsed.privateDestination.destinationRoot) ||
      !sameWindowsPath(
        parsed.privateDestination.destinationRoot,
        expectedDestinationRoot(parsed.privateDestination.checkoutRoot),
      )
    ) {
      return null;
    }
    return {
      version: RECEIVER_CONFIG_VERSION,
      relay: { ...parsed.relay },
      privateDestination: {
        checkoutRoot: parsed.privateDestination.checkoutRoot,
        destinationRoot: parsed.privateDestination.destinationRoot,
      },
    };
  } catch {
    return null;
  }
}

function parseRemoteManifest(
  content: Uint8Array,
  config: RelayReceiverRuntimeConfig,
  transferId: string,
): ParsedRelayManifest | null {
  try {
    const json = decodeUtf8(content);
    if (!json) return null;
    const parsed: unknown = JSON.parse(json);
    if (
      !isRecord(parsed) ||
      !hasCanonicalKeys(parsed, [
        'schemaVersion',
        'transferId',
        'snapshotId',
        'sourceManifestSha256',
        'memberSetSha256',
        'members',
      ]) ||
      parsed.schemaVersion !== RELAY_VERSION ||
      parsed.transferId !== transferId ||
      !isUuidV4(parsed.transferId) ||
      !isOpaqueIdentifier(parsed.snapshotId) ||
      !isSha256(parsed.sourceManifestSha256) ||
      !isSha256(parsed.memberSetSha256) ||
      !Array.isArray(parsed.members) ||
      json !== `${JSON.stringify(parsed, null, 2)}\n`
    ) {
      return null;
    }

    const members: RemoteMember[] = [];
    let previousPath: string | undefined;
    let totalBytes = 0;
    for (const candidate of parsed.members) {
      if (
        !isRecord(candidate) ||
        !hasCanonicalKeys(candidate, ['path', 'bytes', 'sha256']) ||
        typeof candidate.path !== 'string' ||
        !isSafeInteger(candidate.bytes, 1) ||
        !isSha256(candidate.sha256) ||
        (previousPath !== undefined && compareText(previousPath, candidate.path) >= 0) ||
        candidate.bytes > config.relay.maxSnapshotBytes - totalBytes
      ) {
        return null;
      }
      relayObjectKey(config.relay.literalRelayRoot, transferId, candidate.path);
      previousPath = candidate.path;
      totalBytes += candidate.bytes;
      members.push({
        path: candidate.path,
        bytes: candidate.bytes,
        sha256: candidate.sha256,
      });
    }
    const sourceManifest = members.find((candidate) => candidate.path === 'manifest.json');
    if (
      !sourceManifest ||
      !members.some((candidate) => candidate.path === 'corpus.jsonl') ||
      sourceManifest.sha256 !== parsed.sourceManifestSha256
    ) {
      return null;
    }
    return {
      transferId,
      snapshotId: parsed.snapshotId,
      sourceManifestSha256: parsed.sourceManifestSha256,
      memberSetSha256: parsed.memberSetSha256,
      members,
      bytes: new Uint8Array(content),
      sha256: sha256(content),
    };
  } catch {
    return null;
  }
}

function sameMetadata(
  metadata: RelayObjectMetadata | null,
  expected: { key: string; bytes: number; sha256: string; kmsKeyArn: string },
): boolean {
  return (
    metadata !== null &&
    metadata.key === expected.key &&
    metadata.bytes === expected.bytes &&
    metadata.sha256 === expected.sha256 &&
    metadata.serverSideEncryption === 'aws:kms' &&
    metadata.sseKmsKeyId === expected.kmsKeyArn
  );
}

function validAcknowledgementMetadata(
  metadata: RelayObjectMetadata | null,
  acknowledgementKey: string,
  kmsKeyArn: string,
): boolean {
  return (
    metadata !== null &&
    metadata.key === acknowledgementKey &&
    isSafeInteger(metadata.bytes, 1) &&
    isSha256(metadata.sha256) &&
    metadata.serverSideEncryption === 'aws:kms' &&
    metadata.sseKmsKeyId === kmsKeyArn
  );
}

function relayPrefix(literalRelayRoot: string, transferId: string): string {
  const manifestKey = relayManifestKey(literalRelayRoot, transferId);
  return manifestKey.slice(0, -RELAY_MANIFEST_FILENAME.length);
}

function exactRemoteInventory(
  actual: readonly RelayObjectMetadata[] | null,
  manifest: ParsedRelayManifest,
  config: RelayReceiverRuntimeConfig,
  transferId: string,
  allowAcknowledgement: boolean,
): boolean {
  if (!actual) return false;
  try {
    const manifestKey = relayManifestKey(config.relay.literalRelayRoot, transferId);
    const acknowledgementKey = receiverAcknowledgementKey(
      config.relay.literalRelayRoot,
      transferId,
    );
    const expected = [
      ...manifest.members.map((candidate) => ({
        key: relayObjectKey(config.relay.literalRelayRoot, transferId, candidate.path),
        bytes: candidate.bytes,
        sha256: candidate.sha256,
        kmsKeyArn: config.relay.kmsKeyArn,
      })),
      {
        key: manifestKey,
        bytes: manifest.bytes.byteLength,
        sha256: manifest.sha256,
        kmsKeyArn: config.relay.kmsKeyArn,
      },
    ];
    const byKey = new Map(actual.map((metadata) => [metadata.key, metadata]));
    const acknowledgementPresent = byKey.has(acknowledgementKey);
    const expectedSize = expected.length + (acknowledgementPresent ? 1 : 0);
    if (
      actual.length !== expectedSize ||
      byKey.size !== actual.length ||
      !expected.every((candidate) => sameMetadata(byKey.get(candidate.key) ?? null, candidate))
    ) {
      return false;
    }
    if (!allowAcknowledgement) return !acknowledgementPresent;
    return (
      !acknowledgementPresent ||
      validAcknowledgementMetadata(
        byKey.get(acknowledgementKey) ?? null,
        acknowledgementKey,
        config.relay.kmsKeyArn,
      )
    );
  } catch {
    return false;
  }
}

function exactLocalInventory(
  actual: readonly string[] | null,
  expected: readonly string[],
): boolean {
  if (!actual || actual.length !== expected.length || new Set(actual).size !== actual.length) {
    return false;
  }
  const actualSet = new Set(actual);
  return expected.every((entry) => actualSet.has(entry));
}

function localMemberPath(root: string, memberPath: string): string | null {
  try {
    const candidate = path.win32.join(root, ...memberPath.split('/'));
    const relative = path.win32.relative(root, candidate).replaceAll('\\', '/');
    return relative === memberPath ? candidate : null;
  } catch {
    return null;
  }
}

async function materializeLocalMembers(input: {
  fileSystem: ReceiverFileSystem;
  root: string;
  members: readonly RemoteMember[];
  maxTotalBytes: number;
}): Promise<CenturionRelayMember[] | null> {
  try {
    const materialized: CenturionRelayMember[] = [];
    let totalBytes = 0;
    for (const expected of input.members) {
      if (expected.bytes > input.maxTotalBytes - totalBytes) return null;
      const filePath = localMemberPath(input.root, expected.path);
      if (!filePath) return null;
      const content = await input.fileSystem.readFile(filePath, expected.bytes);
      if (
        !content ||
        content.byteLength !== expected.bytes ||
        sha256(content) !== expected.sha256
      ) {
        return null;
      }
      totalBytes += content.byteLength;
      materialized.push({
        path: expected.path,
        bytes: expected.bytes,
        sha256: expected.sha256,
        content,
      });
    }
    return materialized;
  } catch {
    return null;
  }
}

function sameTrustedPath(left: TrustedPath, right: TrustedPath): boolean {
  return left.stableIdentity === right.stableIdentity && left.volumeId === right.volumeId;
}

async function assertTrustedPath(
  acl: WindowsPrivateAcl,
  pathValue: string,
  expectedVolume: string,
): Promise<TrustedPath | null> {
  const trusted = await acl.assertTrustedPath(pathValue);
  return trusted && trusted.volumeId === expectedVolume ? trusted : null;
}

export type TrustedAclFile = {
  path: string;
  identity: TrustedPath;
};

export async function lockAndReassertFileAclBatches(
  acl: WindowsPrivateAcl,
  expectedVolume: string,
  files: readonly TrustedAclFile[],
): Promise<boolean> {
  if (files.length === 0) return false;
  for (let offset = 0; offset < files.length; offset += MAX_ACL_BATCH_PATHS) {
    const batch = files.slice(offset, offset + MAX_ACL_BATCH_PATHS);
    if (!(await acl.lockDownFiles(batch.map((file) => file.path)))) return false;
    const verified = await Promise.all(
      batch.map((file) => assertTrustedPath(acl, file.path, expectedVolume)),
    );
    if (
      verified.some(
        (identity, index) => !identity || !sameTrustedPath(batch[index]!.identity, identity),
      )
    ) {
      return false;
    }
  }
  return true;
}

async function verifyFinalSnapshot(input: {
  config: RelayReceiverRuntimeConfig;
  transferId: string;
  fileSystem: ReceiverFileSystem;
  acl: WindowsPrivateAcl;
  finalPath: string;
  rootAcl: TrustedPath;
  manifest: ParsedRelayManifest;
}): Promise<VerifiedFinal | null> {
  try {
    const before = await assertTrustedPath(input.acl, input.finalPath, input.rootAcl.volumeId);
    const expectedInventory = [
      ...input.manifest.members.map((member) => member.path),
      RECEIPT_FILENAME,
    ];
    if (
      !before ||
      !exactLocalInventory(
        await input.fileSystem.listRelativePaths(input.finalPath),
        expectedInventory,
      )
    ) {
      return null;
    }
    const expectedFiles = expectedInventory.map((entry) =>
      path.win32.join(input.finalPath, ...entry.split('/')),
    );
    const beforeFiles = await Promise.all(
      expectedFiles.map((filePath) =>
        assertTrustedPath(input.acl, filePath, input.rootAcl.volumeId),
      ),
    );
    const trustedFiles = beforeFiles.flatMap((identity, index) =>
      identity ? [{ path: expectedFiles[index]!, identity }] : [],
    );
    if (
      trustedFiles.length !== expectedFiles.length ||
      !(await input.acl.lockDownDirectory(input.finalPath)) ||
      !(await lockAndReassertFileAclBatches(input.acl, input.rootAcl.volumeId, trustedFiles))
    ) {
      return null;
    }
    const after = await assertTrustedPath(input.acl, input.finalPath, input.rootAcl.volumeId);
    if (!after || !sameTrustedPath(before, after)) {
      return null;
    }
    const members = await materializeLocalMembers({
      fileSystem: input.fileSystem,
      root: input.finalPath,
      members: input.manifest.members,
      maxTotalBytes: input.config.relay.maxSnapshotBytes,
    });
    if (!members) return null;
    const verification = verifyCenturionRelaySnapshot(
      input.manifest.bytes,
      members,
      input.config.relay.maxSnapshotBytes,
    );
    if (
      verification.outcome !== 'verified' ||
      verification.snapshotId !== input.manifest.snapshotId ||
      verification.sourceManifestSha256 !== input.manifest.sourceManifestSha256 ||
      verification.memberSetSha256 !== input.manifest.memberSetSha256 ||
      verification.relayManifestSha256 !== input.manifest.sha256
    ) {
      return null;
    }

    const expectedReceipt = buildReceiveReceipt({
      transferId: input.transferId,
      snapshotId: verification.snapshotId,
      sourceManifestSha256: verification.sourceManifestSha256,
      relayManifestSha256: verification.relayManifestSha256,
      memberSetSha256: verification.memberSetSha256,
    });
    const receiptPath = path.win32.join(input.finalPath, RECEIPT_FILENAME);
    const receipt = await input.fileSystem.readFile(receiptPath, MAX_RECEIPT_BYTES);
    if (
      !receipt ||
      receipt.byteLength !== textEncoder.encode(expectedReceipt).byteLength ||
      textDecoder.decode(receipt) !== expectedReceipt
    ) {
      return null;
    }
    return { receiptSha256: sha256(receipt) };
  } catch {
    return null;
  }
}

async function acknowledge(input: {
  config: RelayReceiverRuntimeConfig;
  transferId: string;
  manifest: ParsedRelayManifest;
  receiptSha256: string;
  store: RelayObjectStore;
}): Promise<boolean> {
  try {
    const acknowledgementKey = receiverAcknowledgementKey(
      input.config.relay.literalRelayRoot,
      input.transferId,
    );
    const acknowledgement = textEncoder.encode(
      buildReceiverAcknowledgement({
        transferId: input.transferId,
        snapshotId: input.manifest.snapshotId,
        sourceManifestSha256: input.manifest.sourceManifestSha256,
        relayManifestSha256: input.manifest.sha256,
        memberSetSha256: input.manifest.memberSetSha256,
        receiveReceiptSha256: input.receiptSha256,
      }),
    );
    await input.store.putIfAbsent({
      key: acknowledgementKey,
      content: acknowledgement,
      bytes: acknowledgement.byteLength,
      sha256: sha256(acknowledgement),
      expectedBucketOwner: input.config.relay.expectedBucketOwner,
      kmsKeyArn: input.config.relay.kmsKeyArn,
    });
    return sameMetadata(await input.store.head(acknowledgementKey), {
      key: acknowledgementKey,
      bytes: acknowledgement.byteLength,
      sha256: sha256(acknowledgement),
      kmsKeyArn: input.config.relay.kmsKeyArn,
    });
  } catch {
    return false;
  }
}

export async function receiveCenturionThreadCorpusRelay(input: {
  config: RelayReceiverRuntimeConfig;
  transferId: string;
  store: RelayObjectStore;
  fileSystem: ReceiverFileSystem;
  acl: WindowsPrivateAcl;
  runtime: RelayReceiverRuntimePort;
}): Promise<ReceiverResult> {
  try {
    const config = parseRelayReceiverRuntimeConfig(JSON.stringify(input.config));
    if (!config || !isUuidV4(input.transferId) || input.runtime.platform() !== 'win32') {
      return blocked();
    }
    const inspected = await input.runtime.inspectCheckout(config.privateDestination);
    const privateRoot = await input.fileSystem.assertGitignoredPrivateRoot();
    if (
      !inspected ||
      !inspected.gitignored ||
      !isOpaqueIdentifier(inspected.stableIdentity) ||
      !isOpaqueIdentifier(inspected.volumeId) ||
      !privateRoot ||
      privateRoot.root !== config.privateDestination.destinationRoot ||
      privateRoot.stableIdentity !== inspected.stableIdentity ||
      privateRoot.volumeId !== inspected.volumeId
    ) {
      return blocked();
    }

    const initialRootAcl = await input.acl.assertTrustedPath(privateRoot.root);
    const partialRoot = path.win32.join(privateRoot.root, '.partial');
    if (
      !initialRootAcl ||
      !(await input.acl.lockDownDirectory(privateRoot.root)) ||
      !(await input.acl.lockDownDirectory(partialRoot))
    ) {
      return blocked();
    }
    const rootAcl = await assertTrustedPath(input.acl, privateRoot.root, initialRootAcl.volumeId);
    const partialRootAcl = await assertTrustedPath(input.acl, partialRoot, initialRootAcl.volumeId);
    if (!rootAcl || !sameTrustedPath(initialRootAcl, rootAcl) || !partialRootAcl) {
      return blocked();
    }
    const partialPath = path.win32.join(partialRoot, input.transferId);
    const finalPath = path.win32.join(privateRoot.root, input.transferId);
    const initialFinal = await input.acl.assertTrustedPath(finalPath);
    const initialFinalInventory = await input.fileSystem.listRelativePaths(finalPath);
    if (
      (initialFinal !== null && initialFinal.volumeId !== rootAcl.volumeId) ||
      (initialFinal !== null && initialFinalInventory === null) ||
      (initialFinal === null && initialFinalInventory !== null)
    ) {
      return blocked();
    }
    const finalAlreadyExists = initialFinal !== null;

    if (!(await input.store.assertRelayBucket(config.relay))) return blocked();
    const manifestKey = relayManifestKey(config.relay.literalRelayRoot, input.transferId);
    const manifestHead = await input.store.head(manifestKey);
    const manifestBytes = await input.store.getBounded(
      manifestKey,
      Math.min(config.relay.maxSnapshotBytes, MAX_RELAY_MANIFEST_BYTES),
    );
    if (
      !manifestBytes ||
      !sameMetadata(manifestHead, {
        key: manifestKey,
        bytes: manifestBytes.byteLength,
        sha256: sha256(manifestBytes),
        kmsKeyArn: config.relay.kmsKeyArn,
      })
    ) {
      return blocked();
    }
    const manifest = parseRemoteManifest(manifestBytes, config, input.transferId);
    if (
      !manifest ||
      !exactRemoteInventory(
        await input.store.listAll(relayPrefix(config.relay.literalRelayRoot, input.transferId)),
        manifest,
        config,
        input.transferId,
        finalAlreadyExists,
      )
    ) {
      return blocked();
    }
    for (const expected of manifest.members) {
      const key = relayObjectKey(config.relay.literalRelayRoot, input.transferId, expected.path);
      if (
        !sameMetadata(await input.store.head(key), {
          key,
          bytes: expected.bytes,
          sha256: expected.sha256,
          kmsKeyArn: config.relay.kmsKeyArn,
        })
      ) {
        return blocked();
      }
    }

    if (finalAlreadyExists) {
      const final = await verifyFinalSnapshot({
        config,
        transferId: input.transferId,
        fileSystem: input.fileSystem,
        acl: input.acl,
        finalPath,
        rootAcl,
        manifest,
      });
      if (
        !final ||
        !(await acknowledge({
          config,
          transferId: input.transferId,
          manifest,
          receiptSha256: final.receiptSha256,
          store: input.store,
        }))
      ) {
        return blocked();
      }
      return {
        outcome: 'received',
        transferId: input.transferId,
        sourceManifestSha256: manifest.sourceManifestSha256,
        memberSetSha256: manifest.memberSetSha256,
      };
    }

    const createdPartial = await input.fileSystem.createPartialDirectory(input.transferId);
    if (createdPartial !== partialPath) return blocked();
    const partialAcl = await assertTrustedPath(input.acl, createdPartial, rootAcl.volumeId);
    if (!partialAcl || !(await input.acl.lockDownDirectory(createdPartial))) return blocked();
    const relockedPartial = await assertTrustedPath(input.acl, createdPartial, rootAcl.volumeId);
    if (!relockedPartial || !sameTrustedPath(partialAcl, relockedPartial)) return blocked();

    const localMembers: CenturionRelayMember[] = [];
    for (const expected of manifest.members) {
      const key = relayObjectKey(config.relay.literalRelayRoot, input.transferId, expected.path);
      const content = await input.store.getBounded(key, expected.bytes);
      const localPath = localMemberPath(createdPartial, expected.path);
      if (
        !content ||
        !localPath ||
        content.byteLength !== expected.bytes ||
        sha256(content) !== expected.sha256 ||
        !sameMetadata(await input.store.head(key), {
          key,
          bytes: expected.bytes,
          sha256: expected.sha256,
          kmsKeyArn: config.relay.kmsKeyArn,
        }) ||
        !(await input.fileSystem.writeCreateNew(localPath, content))
      ) {
        return blocked();
      }
      const written = await input.fileSystem.readFile(localPath, expected.bytes);
      if (
        !written ||
        written.byteLength !== expected.bytes ||
        sha256(written) !== expected.sha256 ||
        !(await input.acl.lockDownFiles([localPath]))
      ) {
        return blocked();
      }
      localMembers.push({
        path: expected.path,
        bytes: expected.bytes,
        sha256: expected.sha256,
        content: written,
      });
    }

    if (
      !exactLocalInventory(
        await input.fileSystem.listRelativePaths(createdPartial),
        manifest.members.map((member) => member.path),
      )
    ) {
      return blocked();
    }
    const verification = verifyCenturionRelaySnapshot(
      manifest.bytes,
      localMembers,
      config.relay.maxSnapshotBytes,
    );
    if (
      verification.outcome !== 'verified' ||
      verification.snapshotId !== manifest.snapshotId ||
      verification.sourceManifestSha256 !== manifest.sourceManifestSha256 ||
      verification.memberSetSha256 !== manifest.memberSetSha256 ||
      verification.relayManifestSha256 !== manifest.sha256
    ) {
      return blocked();
    }
    const receiptJson = buildReceiveReceipt({
      transferId: input.transferId,
      snapshotId: verification.snapshotId,
      sourceManifestSha256: verification.sourceManifestSha256,
      relayManifestSha256: verification.relayManifestSha256,
      memberSetSha256: verification.memberSetSha256,
    });
    const receipt = await input.fileSystem.writeReceiveReceipt(receiptJson);
    const receiptPath = path.win32.join(createdPartial, RECEIPT_FILENAME);
    const receiptBytes = textEncoder.encode(receiptJson);
    const writtenReceipt = receipt
      ? await input.fileSystem.readFile(receipt.path, MAX_RECEIPT_BYTES)
      : null;
    if (
      !receipt ||
      receipt.path !== receiptPath ||
      receipt.sha256 !== sha256(receiptBytes) ||
      !writtenReceipt ||
      writtenReceipt.byteLength !== receiptBytes.byteLength ||
      textDecoder.decode(writtenReceipt) !== receiptJson ||
      !(await input.acl.lockDownFiles([receipt.path])) ||
      !(await input.acl.fsyncReceipt(receipt.path)) ||
      !exactLocalInventory(await input.fileSystem.listRelativePaths(createdPartial), [
        ...manifest.members.map((member) => member.path),
        RECEIPT_FILENAME,
      ])
    ) {
      return blocked();
    }
    if (!(await input.acl.promoteNoReplace(createdPartial, finalPath))) return blocked();

    const final = await verifyFinalSnapshot({
      config,
      transferId: input.transferId,
      fileSystem: input.fileSystem,
      acl: input.acl,
      finalPath,
      rootAcl,
      manifest,
    });
    if (
      !final ||
      !(await acknowledge({
        config,
        transferId: input.transferId,
        manifest,
        receiptSha256: final.receiptSha256,
        store: input.store,
      }))
    ) {
      return blocked();
    }
    return {
      outcome: 'received',
      transferId: input.transferId,
      sourceManifestSha256: manifest.sourceManifestSha256,
      memberSetSha256: manifest.memberSetSha256,
    };
  } catch {
    return blocked();
  }
}

class WindowsPrivateAclProcessAdapter implements WindowsCommandRunner {
  async run(
    invocation: WindowsCommandInvocation,
  ): Promise<{ status: number | null; stdout: string | null }> {
    try {
      const result = spawnSync(invocation.executable, invocation.args, {
        shell: invocation.options.shell,
        windowsHide: invocation.options.windowsHide,
        stdio: [...invocation.options.stdio],
        env: invocation.options.env,
        encoding: 'utf8',
      });
      return {
        status: result.status,
        stdout: typeof result.stdout === 'string' ? result.stdout : null,
      };
    } catch {
      return { status: null, stdout: null };
    }
  }
}

function parseAclResponse(
  response: { status: number | null; stdout: string | null },
  kind: 'assert' | 'ok',
): TrustedPath | true | null {
  try {
    if (
      response.status !== 0 ||
      typeof response.stdout !== 'string' ||
      response.stdout.length > 512
    ) {
      return null;
    }
    const parsed: unknown = JSON.parse(response.stdout);
    if (!isRecord(parsed) || response.stdout !== JSON.stringify(parsed)) return null;
    if (kind === 'ok') {
      return hasCanonicalKeys(parsed, ['ok']) && parsed.ok === true ? true : null;
    }
    return hasCanonicalKeys(parsed, ['ok', 'stableIdentity', 'volumeId']) &&
      parsed.ok === true &&
      isOpaqueIdentifier(parsed.stableIdentity) &&
      isOpaqueIdentifier(parsed.volumeId)
      ? { stableIdentity: parsed.stableIdentity, volumeId: parsed.volumeId }
      : null;
  } catch {
    return null;
  }
}

function invokeAcl(
  runner: WindowsCommandRunner,
  operation: 'assert' | 'lock-directory' | 'lock-files' | 'promote' | 'fsync-receipt',
  env: Record<string, string>,
  responseKind: 'assert' | 'ok',
): Promise<TrustedPath | true | null> {
  return runner
    .run({
      executable: 'powershell.exe',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        WINDOWS_PRIVATE_ACL_ENCODED_COMMAND,
      ],
      options: {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: {
          CENTURION_RELAY_OPERATION: operation,
          ...env,
        },
      },
    })
    .then((response) => parseAclResponse(response, responseKind))
    .catch(() => null);
}

export function createWindowsPrivateAcl(
  runner: WindowsCommandRunner = new WindowsPrivateAclProcessAdapter(),
): WindowsPrivateAcl {
  return {
    async assertTrustedPath(pathValue: string): Promise<TrustedPath | null> {
      const result = await invokeAcl(
        runner,
        'assert',
        { CENTURION_RELAY_PATH: pathValue },
        'assert',
      );
      return result === true ? null : result;
    },
    async lockDownDirectory(pathValue: string): Promise<boolean> {
      return (
        (await invokeAcl(runner, 'lock-directory', { CENTURION_RELAY_PATH: pathValue }, 'ok')) ===
        true
      );
    },
    async lockDownFiles(paths: readonly string[]): Promise<boolean> {
      if (
        paths.length === 0 ||
        paths.length > 4_096 ||
        paths.some((pathValue) => typeof pathValue !== 'string') ||
        new Set(paths).size !== paths.length
      ) {
        return false;
      }
      return (
        (await invokeAcl(
          runner,
          'lock-files',
          { CENTURION_RELAY_PATHS: JSON.stringify(paths) },
          'ok',
        )) === true
      );
    },
    async promoteNoReplace(partialPath: string, finalPath: string): Promise<boolean> {
      return (
        (await invokeAcl(
          runner,
          'promote',
          {
            CENTURION_RELAY_PATH: partialPath,
            CENTURION_RELAY_FINAL_PATH: finalPath,
          },
          'ok',
        )) === true
      );
    },
    async fsyncReceipt(pathValue: string): Promise<boolean> {
      return (
        (await invokeAcl(runner, 'fsync-receipt', { CENTURION_RELAY_PATH: pathValue }, 'ok')) ===
        true
      );
    },
  };
}

type LocalIdentity = {
  stableIdentity: string;
  volumeId: string;
};

function sameLocalIdentity(left: LocalIdentity, right: LocalIdentity): boolean {
  return left.stableIdentity === right.stableIdentity && left.volumeId === right.volumeId;
}

function localIdentity(value: { dev: number; ino: number }): LocalIdentity {
  return {
    stableIdentity: `${String(value.dev)}:${String(value.ino)}`,
    volumeId: String(value.dev),
  };
}

function assertLocalDirectory(directory: string): LocalIdentity {
  const stats = lstatSync(directory);
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    !sameWindowsPath(realpathSync.native(directory), directory)
  ) {
    throw new Error('unsafe directory');
  }
  return localIdentity(stats);
}

function assertLocalFile(filePath: string): LocalIdentity & { bytes: number } {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || !isSafeInteger(stats.size, 1)) {
    throw new Error('unsafe file');
  }
  return { ...localIdentity(stats), bytes: stats.size };
}

type DescriptorReader = (
  descriptor: number,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
) => number;

export function readExactBoundedDescriptor(
  descriptor: number,
  expectedBytes: number,
  reader: DescriptorReader = readSync,
): Uint8Array | null {
  if (!isSafeInteger(expectedBytes, 1)) return null;
  const content = new Uint8Array(expectedBytes);
  let offset = 0;
  while (offset < content.byteLength) {
    const remaining = content.byteLength - offset;
    const bytesRead = reader(descriptor, content, offset, remaining, offset);
    if (!isSafeInteger(bytesRead, 1) || bytesRead > remaining) return null;
    offset += bytesRead;
  }
  const trailingByte = new Uint8Array(1);
  return reader(descriptor, trailingByte, 0, 1, content.byteLength) === 0 ? content : null;
}

function sourceMemberPath(value: string): boolean {
  return (
    value === 'corpus.jsonl' ||
    value === 'manifest.json' ||
    RAW_MIME_MEMBER.test(value) ||
    ATTACHMENT_TEXT_MEMBER.test(value)
  );
}

class WindowsReceiverFileSystem implements ReceiverFileSystem {
  private partialPath: string | null = null;

  constructor(private readonly privateRoot: string) {}

  async assertGitignoredPrivateRoot(): Promise<{
    root: string;
    stableIdentity: string;
    volumeId: string;
  } | null> {
    try {
      const identity = assertLocalDirectory(this.privateRoot);
      return { root: this.privateRoot, ...identity };
    } catch {
      return null;
    }
  }

  async createPartialDirectory(transferId: string): Promise<string | null> {
    try {
      if (!isUuidV4(transferId)) return null;
      const partialRoot = path.win32.join(this.privateRoot, '.partial');
      assertLocalDirectory(partialRoot);
      const candidate = path.win32.join(partialRoot, transferId);
      if (path.win32.dirname(candidate) !== partialRoot) return null;
      mkdirSync(candidate, { recursive: false, mode: 0o700 });
      assertLocalDirectory(candidate);
      this.partialPath = candidate;
      return candidate;
    } catch {
      return null;
    }
  }

  async writeCreateNew(filePath: string, content: Uint8Array): Promise<boolean> {
    let descriptor: number | undefined;
    try {
      if (!this.partialPath || !content.byteLength) return false;
      const relative = path.win32.relative(this.partialPath, filePath).replaceAll('\\', '/');
      if (!sourceMemberPath(relative)) return false;
      const parent = path.win32.dirname(filePath);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      assertLocalDirectory(parent);
      descriptor = openSync(
        filePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size !== content.byteLength) return false;
      closeSync(descriptor);
      descriptor = undefined;
      return assertLocalFile(filePath).bytes === content.byteLength;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {}
      }
    }
  }

  async readFile(filePath: string, maxBytes: number): Promise<Uint8Array | null> {
    let descriptor: number | undefined;
    try {
      if (!isSafeInteger(maxBytes, 0)) return null;
      const before = assertLocalFile(filePath);
      if (before.bytes > maxBytes) return null;
      descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        !sameLocalIdentity(before, localIdentity(opened)) ||
        opened.size !== before.bytes
      ) {
        return null;
      }
      const content = readExactBoundedDescriptor(descriptor, before.bytes);
      const after = assertLocalFile(filePath);
      const afterOpen = fstatSync(descriptor);
      if (
        !content ||
        content.byteLength !== before.bytes ||
        !sameLocalIdentity(before, after) ||
        !sameLocalIdentity(before, localIdentity(afterOpen)) ||
        afterOpen.size !== before.bytes
      ) {
        return null;
      }
      return content;
    } catch {
      return null;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {}
      }
    }
  }

  async listRelativePaths(root: string): Promise<readonly string[] | null> {
    try {
      const paths: string[] = [];
      const visit = (directory: string, prefix: string): void => {
        assertLocalDirectory(directory);
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error('unsafe entry');
          const absolute = path.win32.join(directory, entry.name);
          const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
          if (entry.isDirectory()) {
            visit(absolute, relative);
          } else if (entry.isFile()) {
            assertLocalFile(absolute);
            paths.push(relative);
          } else {
            throw new Error('unsupported entry');
          }
        }
      };
      visit(root, '');
      return paths.sort(compareText);
    } catch {
      return null;
    }
  }

  async writeReceiveReceipt(receiptJson: string): Promise<{ path: string; sha256: string } | null> {
    try {
      if (!this.partialPath) return null;
      const receiptPath = path.win32.join(this.partialPath, RECEIPT_FILENAME);
      if (path.win32.dirname(receiptPath) !== this.partialPath) return null;
      const content = textEncoder.encode(receiptJson);
      if (!(await this.writeCreateNewReceipt(receiptPath, content))) return null;
      return { path: receiptPath, sha256: sha256(content) };
    } catch {
      return null;
    }
  }

  async removePartial(partialPath: string): Promise<boolean> {
    try {
      if (!this.partialPath || this.partialPath !== partialPath) return false;
      assertLocalDirectory(partialPath);
      rmSync(partialPath, { recursive: true, force: false, maxRetries: 0 });
      this.partialPath = null;
      return true;
    } catch {
      return false;
    }
  }

  private async writeCreateNewReceipt(filePath: string, content: Uint8Array): Promise<boolean> {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        filePath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(descriptor, content);
      fsyncSync(descriptor);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.size !== content.byteLength) return false;
      closeSync(descriptor);
      descriptor = undefined;
      return assertLocalFile(filePath).bytes === content.byteLength;
    } catch {
      return false;
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {}
      }
    }
  }
}

class WindowsCheckoutRuntimeAdapter implements RelayReceiverRuntimePort {
  constructor(private readonly checkoutRoot: string) {}

  platform(): string {
    return process.platform;
  }

  async readProtectedConfig(): Promise<string> {
    try {
      if (process.platform !== 'win32') throw new Error('unsupported platform');
      const privateRoot = expectedDestinationRoot(this.checkoutRoot);
      const configPath = path.win32.join(privateRoot, 'relay-receiver-config.json');
      const checkoutIdentity = assertLocalDirectory(this.checkoutRoot);
      const privateIdentity = assertLocalDirectory(path.win32.join(this.checkoutRoot, '.private'));
      const corpusIdentity = assertLocalDirectory(privateRoot);
      const before = assertLocalFile(configPath);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const opened = fstatSync(descriptor);
        if (
          !opened.isFile() ||
          !sameLocalIdentity(before, localIdentity(opened)) ||
          opened.size > MAX_RECEIPT_BYTES
        ) {
          throw new Error('unsafe config');
        }
        const content = readFileSync(descriptor, 'utf8');
        const after = assertLocalFile(configPath);
        if (
          !sameLocalIdentity(before, after) ||
          !sameLocalIdentity(checkoutIdentity, assertLocalDirectory(this.checkoutRoot)) ||
          !sameLocalIdentity(
            privateIdentity,
            assertLocalDirectory(path.win32.join(this.checkoutRoot, '.private')),
          ) ||
          !sameLocalIdentity(corpusIdentity, assertLocalDirectory(privateRoot))
        ) {
          throw new Error('config identity changed');
        }
        return content;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    } catch {
      throw new Error('protected config unavailable');
    }
  }

  async inspectCheckout(input: {
    checkoutRoot: string;
    destinationRoot: string;
  }): Promise<{ gitignored: boolean; stableIdentity: string; volumeId: string } | null> {
    try {
      if (
        process.platform !== 'win32' ||
        !sameWindowsPath(input.checkoutRoot, this.checkoutRoot) ||
        !sameWindowsPath(input.destinationRoot, expectedDestinationRoot(this.checkoutRoot))
      ) {
        return null;
      }
      const identity = assertLocalDirectory(input.destinationRoot);
      const gitIgnoredPath = path.win32
        .relative(input.checkoutRoot, input.destinationRoot)
        .replaceAll('\\', '/');
      if (gitIgnoredPath !== '.private/centurion-thread-corpus') return null;
      const result = spawnSync('git', ['check-ignore', '-q', '--', gitIgnoredPath], {
        cwd: input.checkoutRoot,
        shell: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      return result.status === 0 ? { gitignored: true, ...identity } : null;
    } catch {
      return null;
    }
  }
}

function defaultCheckoutRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
}

export function createDefaultRelayReceiverRuntime(
  checkoutRoot = defaultCheckoutRoot(),
): RelayReceiverRuntimePort {
  return new WindowsCheckoutRuntimeAdapter(checkoutRoot);
}

export function createDefaultReceiverFileSystem(destinationRoot: string): ReceiverFileSystem {
  return new WindowsReceiverFileSystem(destinationRoot);
}
