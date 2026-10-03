#!/usr/bin/env bash
# Laptop front door: Phase-A real-HMS proof video + Gate G1 accept.
# Never Vitest. Never accepts lookup/thread/message selectors or raw values.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO_ROOT:-$(cd "${SCRIPT_DIR}/../../.." && pwd)}"
ACTION="${1:-}"

usage() {
  printf '%s\n' \
    'usage: ops-hms-proof.sh doctor [--offline] [--tool <tool-id>|--wave <subwave-id>] [--action <action>] [--json]' \
    '       ops-hms-proof.sh status [--tool <tool-id>|--wave <subwave-id>|--operation <uuid>] [--json]' \
    '       ops-hms-proof.sh read-discovery <tool-id> [--resume <operation-id>] [--json]' \
    '       ops-hms-proof.sh read-proof <tool-id> [--resume <operation-id>] [--json]' \
    '       ops-hms-proof.sh read-wave <subwave-id> [--resume <operation-id>] [--json]' \
    '       ops-hms-proof.sh artifacts <tool-id> [--operation <uuid>|--release <uuid>|--latest-usable] [--json]' \
    '       ops-hms-proof.sh read-promote <tool-id> --release <release-id> [--resume <operation-id>] [--json]' \
    '       ops-hms-proof.sh read-rollback <tool-id> [--resume <operation-id>] [--json]' \
    '       ops-hms-proof.sh rearm <tool-id> --operation <superseded-operation-id> --after-source <revision> [--resume <successor-operation-id>] [--json]' \
    '       ops-hms-proof.sh reservation|accept-g1|artifact-video|live-wave' \
    '       ops-hms-proof.sh fetch-artifact <uuid> <receipt|video>' \
    '       ops-hms-proof.sh fetch-artifact <uuid> trace --confirm-sensitive' \
    '       ops-hms-proof.sh --help'
  exit "${1:-2}"
}

case "$ACTION" in
  -h|--help) usage 0 ;;
  reservation|accept-g1|artifact-video|live-wave) ;;
  doctor|status|read-discovery|read-proof|read-wave|artifacts|read-promote|read-rollback|rearm) ;;
  fetch-artifact) ;;
  *) usage 2 ;;
esac

SERVER_PILOT="${REPO_ROOT}/apps/server-pilot"
PHASE_B_OP_TS="${SERVER_PILOT}/src/ops/phase-b-operation.ts"

# Shared Phase B argv parser — one grammar locally before AWS. No second case tree.
phase_b_parse() {
  (
    cd "$SERVER_PILOT"
    unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
    node --import tsx "$PHASE_B_OP_TS" parse --json "$@"
  )
}

phase_b_local_operator() {
  (
    cd "$SERVER_PILOT"
    unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
    node --import tsx "$PHASE_B_OP_TS" local-operator --json "$@"
  )
}

case "$ACTION" in
  doctor|status|read-discovery|read-proof|read-wave|artifacts|read-promote|read-rollback|rearm)
  PARSE_JSON="$(phase_b_parse "$@" || true)"
    PARSE_OK="$(node -e 'try{const j=JSON.parse(process.argv[1]);process.stdout.write(j.ok===true?"1":"0")}catch{process.stdout.write("0")}' "$PARSE_JSON")" || {
      echo "HMS_FAIL code=USAGE_ERROR" >&2
      exit 2
    }
    if [ "$PARSE_OK" != "1" ]; then
      # parse CLI emits PhaseBOperatorResult on failure (no ok:true wrapper).
      if node -e 'const j=JSON.parse(process.argv[1]);process.exit(j.schemaVersion===1&&j.code?0:1)' "$PARSE_JSON" 2>/dev/null; then
        printf '%s\n' "$PARSE_JSON"
        EXIT_CODE="$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(String(j.exitCode||2))' "$PARSE_JSON")"
        exit "${EXIT_CODE:-2}"
      fi
      echo "HMS_FAIL code=USAGE_ERROR" >&2
      exit 2
    fi
    ;;
esac

case "$ACTION" in
  doctor)
    # Flags already validated by shared parser — extract from envelope (no second grammar).
    DOCTOR_TOOL="$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write((j.command&&j.command.toolId)||"")' "$PARSE_JSON")"
    DOCTOR_ACTION="$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write((j.command&&j.command.doctorAction)||"")' "$PARSE_JSON")"
    DOCTOR_JSON="$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(j.command&&j.command.json?"1":"0")' "$PARSE_JSON")"
    DOCTOR_OFFLINE="$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(j.command&&j.command.offline?"1":"0")' "$PARSE_JSON")"
    ;;
  status|read-discovery|read-proof|read-wave|artifacts|read-promote|read-rollback|rearm)
    # Grammar already validated by shared parser above.
    ;;
esac

# Phase B tool actions: shared local operator envelope (canonical JSON). No HMS in offline path.
case "$ACTION" in
  read-discovery|read-proof|read-promote|read-rollback|read-wave|artifacts|rearm)
    RESULT_JSON="$(phase_b_local_operator "$@")" || {
      RC=$?
      if [ -n "${RESULT_JSON:-}" ]; then
        printf '%s\n' "$RESULT_JSON"
      fi
      exit "$RC"
    }
    printf '%s\n' "$RESULT_JSON"
    EXIT_CODE="$(node -e 'const j=JSON.parse(process.argv[1]);process.stdout.write(String(j.exitCode??0))' "$RESULT_JSON")"
    exit "${EXIT_CODE:-0}"
    ;;
  status)
    STATUS_TS="${SERVER_PILOT}/src/ops/phase-b-status.ts"
    (
      cd "$SERVER_PILOT"
      unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
      shift
      exec node --import tsx "$STATUS_TS" "$@"
    )
    exit $?
    ;;
  doctor)
    DOCTOR_TS="${SERVER_PILOT}/src/ops/phase-b-doctor.ts"
    # Scoped bootstrap verify (EC2 metadata + asm-exec sentinel). No HMS browser.
    if [ -n "${DOCTOR_TOOL:-}" ] && [ -n "${DOCTOR_ACTION:-}" ] && [ "${DOCTOR_OFFLINE:-0}" -eq 0 ]; then
      : "${AWS_REGION:=af-south-1}"
      : "${INSTANCE_ID:=i-008f737974a9ba9b3}"
      # Vendor CRLF pin + installed LF pin (after tr -d '\r' strip).
      ASM_PIN='5f0c7f82827fe4eb89db0ba177aec694cd4cbf3acff003b09d1b545ea8595b7f'
      ASM_EXEC_INSTALLED_SHA256='81fd29e1f039209282bc8cbe482cda033d331f07284533a46f990368228a7e65'
      # shellcheck disable=SC2016
      REMOTE_DOCTOR=$(cat <<EOF
set -euo pipefail
PIN='${ASM_PIN}'
INSTALLED_PIN='${ASM_EXEC_INSTALLED_SHA256}'
SRC='/home/ubuntu/repos/zero/apps/server-pilot/deploy/vendor/asm-exec'
META='/etc/nava/hms-evidence-hmac.env'
printf '%s  %s\n' "\$PIN" "\$SRC" | sha256sum -c -
test -x /usr/local/bin/asm-exec
printf '%s  %s\n' "\$INSTALLED_PIN" /usr/local/bin/asm-exec | sha256sum -c -
grep -q 'os.execvpe' /usr/local/bin/asm-exec
test -f "\$META"
grep -q '^HMS_EVIDENCE_HMAC_SECRET_ARN=' "\$META"
grep -q '^HMS_EVIDENCE_HMAC_KEY_VERSION=' "\$META"
! awk -F= '\$1=="HMS_EVIDENCE_HMAC_KEY"{found=1} END{exit found+0}' "\$META"
OUT="\$(/usr/local/bin/asm-exec -- /bin/echo ASM_EXEC_SENTINEL_OK)"
test "\$OUT" = 'ASM_EXEC_SENTINEL_OK'
echo DOCTOR_EVIDENCE_BOOTSTRAP_OK
EOF
)
      SSM="${SCRIPT_DIR}/ssm-run-command.sh"
      DOCTOR_SSM_OUT="$(bash "$SSM" "$REMOTE_DOCTOR")"
      echo "$DOCTOR_SSM_OUT" | grep -q 'DOCTOR_EVIDENCE_BOOTSTRAP_OK' || {
        echo "HMS_FAIL code=EVIDENCE_BOOTSTRAP_UNREADY" >&2
        exit 1
      }
      echo "HMS_OK code=DOCTOR_OK" >&2
      if [ "${DOCTOR_JSON:-0}" -eq 1 ]; then
        node -e '
process.stdout.write(JSON.stringify({
  schemaVersion:1,
  outcome:"ok",
  stage:"doctor",
  code:"DOCTOR_OK",
  exitCode:0,
  toolId:process.argv[1],
  action:process.argv[2],
  evidenceBootstrapReady:true,
  asmExecPinned:true,
})+"\n");
' "$DOCTOR_TOOL" "$DOCTOR_ACTION"
      fi
      exit 0
    fi
    (
      cd "$SERVER_PILOT"
      unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
      if [ "${DOCTOR_JSON:-0}" -eq 1 ]; then
        exec node --import tsx "$DOCTOR_TS" --json
      fi
      exec node --import tsx "$DOCTOR_TS"
    )
    exit $?
    ;;
esac

if [ "$ACTION" = "fetch-artifact" ]; then
  [ "$#" -ge 3 ] && [ "$#" -le 4 ] || usage 2
  ARTIFACT_ID="$2"
  KIND="$3"
  CONFIRM_SENSITIVE="${4:-}"
  if ! [[ "$ARTIFACT_ID" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]]; then
    usage 2
  fi
  case "$KIND" in
    receipt|video)
      [ "$#" -eq 3 ] || usage 2
      ;;
    trace)
      [ "$#" -eq 4 ] || usage 2
      if [ "$CONFIRM_SENSITIVE" != "--confirm-sensitive" ]; then
        echo "HMS_FAIL code=POLICY_BLOCK" >&2
        exit 10
      fi
      ;;
    *) usage 2 ;;
  esac
elif [ "$#" -ne 1 ]; then
  usage 2
fi

export AWS_REGION="af-south-1"
export INSTANCE_ID="i-008f737974a9ba9b3"
EXPECTED_ACCOUNT_ID="845242190536"
SSM="${SCRIPT_DIR}/ssm-run-command.sh"
SYNC="${SCRIPT_DIR}/sync-ec2-git-bundle.sh"
READ_GATE="${SCRIPT_DIR}/hms-read-gate.sh"
GATE_REPORT="${REPO_ROOT}/.superpowers/sdd/hms-read-foundation/gates/hms-read-gate-report.json"
TRANSFER_BUCKET="nava-zero-mail-845242190536-af-south-1"
TRANSFER_ROOT="hms-browser-proof-transfer/v1"
LOCAL_PROOF_ROOT="${REPO_ROOT}/.tmp/hms-browser-proof"
if ! [[ "$TRANSFER_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
  echo "HMS_FAIL code=POLICY_BLOCK" >&2
  exit 10
fi
if ! [[ "$AWS_REGION" =~ ^[a-z]{2}(-gov)?-[a-z]+-[0-9]$ ]] ||
  ! [[ "$INSTANCE_ID" =~ ^i-[a-f0-9]{8,17}$ ]]; then
  echo "HMS_FAIL code=POLICY_BLOCK" >&2
  exit 10
fi

verify_transfer_bucket_policy() {
  local public_block lifecycle versioning
  public_block="$(aws s3api get-public-access-block \
    --bucket "$TRANSFER_BUCKET" --region "$AWS_REGION" --output json)" ||
    return 1
  lifecycle="$(aws s3api get-bucket-lifecycle-configuration \
    --bucket "$TRANSFER_BUCKET" --region "$AWS_REGION" --output json)" ||
    return 1
  versioning="$(aws s3api get-bucket-versioning \
    --bucket "$TRANSFER_BUCKET" --region "$AWS_REGION" --output json)" ||
    return 1
  PUBLIC_BLOCK_JSON="$public_block" LIFECYCLE_JSON="$lifecycle" \
    VERSIONING_JSON="$versioning" TRANSFER_ROOT_VALUE="$TRANSFER_ROOT" node -e '
const pab=JSON.parse(process.env.PUBLIC_BLOCK_JSON||"{}").PublicAccessBlockConfiguration||{};
if(!["BlockPublicAcls","IgnorePublicAcls","BlockPublicPolicy","RestrictPublicBuckets"].every(k=>pab[k]===true))process.exit(1);
const versioning=JSON.parse(process.env.VERSIONING_JSON||"{}");
if(versioning.Status)process.exit(1);
const rules=JSON.parse(process.env.LIFECYCLE_JSON||"{}").Rules||[];
const target=(process.env.TRANSFER_ROOT_VALUE||"").replace(/\/?$/,"/");
const exactPrefix=(rule,prefix)=>rule.Status==="Enabled"&&
  rule.Filter&&Object.keys(rule.Filter).length===1&&
  rule.Filter.Prefix===prefix;
const one=(id)=>{const found=rules.filter(rule=>rule.ID===id);return found.length===1?found[0]:null};
const raw=one("archive-raw-mime-30d");
const attachments=one("archive-attachments-30d");
const multipart=one("abort-incomplete-multipart-1d");
const transfer=one("HmsBrowserProofTransferExpire1Day");
const retainedArchive=(rule,prefix)=>rule&&exactPrefix(rule,prefix)&&
  !rule.Expiration&&!rule.NoncurrentVersionExpiration&&
  rule.Transitions?.length===1&&rule.Transitions[0].Days===30&&
  rule.Transitions[0].StorageClass==="INTELLIGENT_TIERING";
const unsafeMailLifecycle=rules.some(rule=>{
  if(rule.Status!=="Enabled")return false;
  const prefix=rule.Filter?.Prefix??rule.Filter?.And?.Prefix??rule.Prefix??"";
  const overlaps=["raw-mime/","attachments/"].some(mail=>mail.startsWith(prefix)||prefix.startsWith(mail));
  const restoreRequired=[...(rule.Transitions||[]),...(rule.NoncurrentVersionTransitions||[])]
    .some(transition=>["GLACIER","DEEP_ARCHIVE"].includes(transition.StorageClass));
  return overlaps&&Boolean(rule.Expiration||rule.NoncurrentVersionExpiration||restoreRequired);
});
if(unsafeMailLifecycle||!retainedArchive(raw,"raw-mime/")||!retainedArchive(attachments,"attachments/"))process.exit(1);
if(!multipart||!exactPrefix(multipart,"")||Number(multipart.AbortIncompleteMultipartUpload?.DaysAfterInitiation)!==1)process.exit(1);
if(!transfer||!exactPrefix(transfer,target)||Number(transfer.Expiration?.Days)!==1)process.exit(1);
'
}

ensure_transfer_lifecycle_rule() {
  local lifecycle merge changed configuration minimum_object_size
  lifecycle="$(aws s3api get-bucket-lifecycle-configuration \
    --bucket "$TRANSFER_BUCKET" --region "$AWS_REGION" --output json)" ||
    return 1
  merge="$(
    LIFECYCLE_JSON="$lifecycle" TRANSFER_ROOT_VALUE="$TRANSFER_ROOT" node -e '
const current=JSON.parse(process.env.LIFECYCLE_JSON||"{}");
const rules=Array.isArray(current.Rules)?current.Rules:[];
const exactPrefix=(rule,prefix)=>rule.Status==="Enabled"&&
  rule.Filter&&Object.keys(rule.Filter).length===1&&
  rule.Filter.Prefix===prefix;
const one=(id)=>{const found=rules.filter(rule=>rule.ID===id);return found.length===1?found[0]:null};
const raw=one("archive-raw-mime-30d");
const attachments=one("archive-attachments-30d");
const multipart=one("abort-incomplete-multipart-1d");
const retainedArchive=(rule,prefix)=>rule&&exactPrefix(rule,prefix)&&
  !rule.Expiration&&!rule.NoncurrentVersionExpiration&&
  rule.Transitions?.length===1&&rule.Transitions[0].Days===30&&
  rule.Transitions[0].StorageClass==="INTELLIGENT_TIERING";
const unsafeMailLifecycle=rules.some(rule=>{
  if(rule.Status!=="Enabled")return false;
  const prefix=rule.Filter?.Prefix??rule.Filter?.And?.Prefix??rule.Prefix??"";
  const overlaps=["raw-mime/","attachments/"].some(mail=>mail.startsWith(prefix)||prefix.startsWith(mail));
  const restoreRequired=[...(rule.Transitions||[]),...(rule.NoncurrentVersionTransitions||[])]
    .some(transition=>["GLACIER","DEEP_ARCHIVE"].includes(transition.StorageClass));
  return overlaps&&Boolean(rule.Expiration||rule.NoncurrentVersionExpiration||restoreRequired);
});
if(unsafeMailLifecycle||!retainedArchive(raw,"raw-mime/")||!retainedArchive(attachments,"attachments/"))process.exit(1);
if(!multipart||!exactPrefix(multipart,"")||Number(multipart.AbortIncompleteMultipartUpload?.DaysAfterInitiation)!==1)process.exit(1);
const target=(process.env.TRANSFER_ROOT_VALUE||"").replace(/\/?$/,"/");
const desired={
  ID:"HmsBrowserProofTransferExpire1Day",
  Status:"Enabled",
  Filter:{Prefix:target},
  Expiration:{Days:1},
};
const prior=rules.find(rule=>rule.ID===desired.ID);
const valid=prior&&prior.Status==="Enabled"&&
  Object.keys(prior.Filter||{}).length===1&&prior.Filter.Prefix===target&&
  Number(prior.Expiration?.Days)===1;
const merged=valid?rules:[...rules.filter(rule=>rule.ID!==desired.ID),desired];
process.stdout.write(JSON.stringify({changed:!valid,configuration:{Rules:merged},
  minimumObjectSize:current.TransitionDefaultMinimumObjectSize||"all_storage_classes_128K"}));
'
  )" || return 1
  changed="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).changed))' "$merge")" ||
    return 1
  if [ "$changed" = "true" ]; then
    configuration="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).configuration))' "$merge")" ||
      return 1
    minimum_object_size="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).minimumObjectSize)' "$merge")" ||
      return 1
    aws s3api put-bucket-lifecycle-configuration \
      --bucket "$TRANSFER_BUCKET" \
      --region "$AWS_REGION" \
      --transition-default-minimum-object-size "$minimum_object_size" \
      --lifecycle-configuration "$configuration" >/dev/null ||
      return 1
  fi
}

run_remote() {
  local budget_exec="$1"
  local budget_poll="$2"
  shift 2
  export SSM_DELIVERY_TIMEOUT_SECONDS=60
  export SSM_EXECUTION_TIMEOUT_SECONDS="$budget_exec"
  export SSM_MAX_POLL_SECONDS="$budget_poll"
  bash "$SSM" "$*"
}

decode_ssm_stdout() {
  node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8").trim();
try {
  const value = JSON.parse(raw);
  if (value.Stderr) process.stderr.write(value.Stderr);
  process.stdout.write(value.Stdout || "");
} catch {
  process.stderr.write(raw + "\n");
  process.exit(70);
}
'
}

purge_expired_local_proofs() {
  LOCAL_PROOF_ROOT_VALUE="$LOCAL_PROOF_ROOT" node -e '
const fs=require("fs"),path=require("path");
const root=path.resolve(process.env.LOCAL_PROOF_ROOT_VALUE||"");
if(!fs.existsSync(root))process.exit(0);
const rootStat=fs.lstatSync(root);
if(rootStat.isSymbolicLink()||!rootStat.isDirectory())process.exit(1);
for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  const target=path.join(root,entry.name);
  const stat=fs.lstatSync(target);
  if(stat.isSymbolicLink()||!stat.isDirectory()){
    fs.rmSync(target,{recursive:true,force:true});
    continue;
  }
  let expiresAt=NaN;
  try{
    const receipt=JSON.parse(fs.readFileSync(path.join(target,"receipt.v1.json"),"utf8"));
    expiresAt=Date.parse(receipt.expiresAt);
  }catch{}
  if(!Number.isFinite(expiresAt)||expiresAt<=Date.now()){
    fs.rmSync(target,{recursive:true,force:true});
  }
}
'
}

apply_local_acl() {
  local dir="$1"
  local stage="${2:-complete}"
  local files=()
  case "$stage" in
    directory) ;;
    complete) files=(receipt.v1.json video.webm) ;;
    files)
      shift 2
      [ "$#" -gt 0 ] || return 1
      files=("$@")
      ;;
    *) return 1 ;;
  esac
  chmod 700 "$dir" || return 1
  local file
  for file in "${files[@]}"; do
    chmod 600 "$dir/$file" || return 1
  done

  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      command -v cygpath >/dev/null 2>&1 || return 1
      command -v powershell.exe >/dev/null 2>&1 || return 1
      command -v icacls.exe >/dev/null 2>&1 || return 1
      local win_dir acl_files
      win_dir="$(cygpath -w "$dir")" || return 1
      acl_files="$(IFS=,; printf '%s' "${files[*]}")"
      HMS_ACL_DIR="$win_dir" HMS_ACL_FILES="$acl_files" \
        powershell.exe -NoProfile -NonInteractive -Command - <<'POWERSHELL'
$ErrorActionPreference = 'Stop'
$dir = $env:HMS_ACL_DIR
$files = @()
if ($env:HMS_ACL_FILES) { $files = @($env:HMS_ACL_FILES -split ',') }
$userSid = ([System.Security.Principal.NTAccount]$env:USERNAME).Translate(
  [System.Security.Principal.SecurityIdentifier]
)
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')

function Set-ExactAcl([string]$Path, [bool]$Directory) {
  if ($Directory) {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  } else {
    $acl = [System.Security.AccessControl.FileSecurity]::new()
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner($userSid)
  foreach ($sid in @($userSid, $systemSid)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $Path -AclObject $acl

  $actual = Get-Acl -LiteralPath $Path
  if (-not $actual.AreAccessRulesProtected) { throw "ACL inheritance remains enabled" }
  $ownerSid = ([System.Security.Principal.NTAccount]$actual.Owner).Translate(
    [System.Security.Principal.SecurityIdentifier]
  )
  if ($ownerSid.Value -ne $userSid.Value) { throw "ACL owner mismatch" }
  $rules = @($actual.Access)
  if ($rules.Count -ne 2) { throw "ACL rule count mismatch" }
  $expected = @($userSid.Value, $systemSid.Value) | Sort-Object
  $observed = @(
    $rules | ForEach-Object {
      if ($_.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) {
        throw "ACL deny rule present"
      }
      if ($_.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) {
        throw "ACL rights mismatch"
      }
      $_.IdentityReference.Translate(
        [System.Security.Principal.SecurityIdentifier]
      ).Value
    } | Sort-Object
  )
  if (($observed -join ',') -ne ($expected -join ',')) { throw "ACL principal mismatch" }
}

Set-ExactAcl -Path $dir -Directory $true
foreach ($file in $files) {
  Set-ExactAcl -Path (Join-Path $dir $file) -Directory $false
}
POWERSHELL
      MSYS2_ARG_CONV_EXCL='*' icacls.exe "$win_dir" /verify >/dev/null || return 1
      ;;
    *)
      [ "$(stat -c '%a' "$dir")" = "700" ] || return 1
      for file in "${files[@]}"; do
        [ "$(stat -c '%a' "$dir/$file")" = "600" ] || return 1
      done
      ;;
  esac
}

if ! purge_expired_local_proofs; then
  echo "HMS_FAIL code=POLICY_BLOCK" >&2
  exit 10
fi
CALLER_ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" ||
  {
    echo "HMS_FAIL code=POLICY_BLOCK" >&2
    exit 10
  }
if [ "$CALLER_ACCOUNT" != "$EXPECTED_ACCOUNT_ID" ]; then
  echo "HMS_FAIL code=POLICY_BLOCK" >&2
  exit 10
fi

case "$ACTION" in
  reservation)
    if ! ensure_transfer_lifecycle_rule ||
      ! verify_transfer_bucket_policy; then
      echo "HMS_FAIL code=POLICY_BLOCK" >&2
      exit 10
    fi
    unset DATABASE_URL VITEST_ALLOW_PILOT_RDS
    bash "$READ_GATE" --fixture-only
    [ -f "$GATE_REPORT" ] ||
      { echo "HMS_FAIL code=EVIDENCE_INVALID" >&2; exit 10; }
    # Immutable scoped source stage; helper owns private transfer cleanup.
    bash "$SYNC" --plan-snapshot mail-artifact-reservation-chain

    INSTALL_CMD='set -euo pipefail
REV_FILE=/opt/nava/shared/nava-proof-source-revision
[ -f "$REV_FILE" ] || { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
REV=$(node -e "const fs=require(\"fs\");const v=fs.readFileSync(process.argv[1],\"utf8\").trim();if(!/^phase-a-[A-Za-z0-9._-]+$/.test(v))process.exit(10);process.stdout.write(v)" "$REV_FILE")
ROOT="/opt/nava/releases/$REV/worktree"
[ -f "$ROOT/apps/server-pilot/deploy/install-hms-browser.sh" ] || { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
export REPO_ROOT="$ROOT"
bash "$ROOT/apps/server-pilot/deploy/install-hms-browser.sh"
'
    INSTALL_RESPONSE="$(run_remote 800 900 "$INSTALL_CMD")" || INSTALL_RC=$?
    INSTALL_RC="${INSTALL_RC:-0}"
    if [ "$INSTALL_RC" -ne 0 ]; then
      printf '%s' "$INSTALL_RESPONSE" | decode_ssm_stdout || true
      case "$INSTALL_RC" in
        3|10|20|70) exit "$INSTALL_RC" ;;
        *) exit 70 ;;
      esac
    fi

    PROOF_CMD='set -euo pipefail
REPO_ROOT=/home/ubuntu/repos/zero
REV_FILE=/opt/nava/shared/nava-proof-source-revision
[ -f "$REV_FILE" ] || { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
REV=$(node -e "const fs=require(\"fs\");const v=fs.readFileSync(process.argv[1],\"utf8\").trim();if(!/^phase-a-[A-Za-z0-9._-]+$/.test(v))process.exit(10);process.stdout.write(v)" "$REV_FILE")
ROOT="/opt/nava/releases/$REV/worktree"
PROOF_JS="$ROOT/apps/server-pilot/dist/ops/hms-live-proof.js"
[ -f "$PROOF_JS" ] || { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
cd "$ROOT"
sha256sum -c MANIFEST.sha256 >/dev/null || { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
sha256sum -c BUILD_MANIFEST.sha256 >/dev/null || { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
node -e "const fs=require(\"fs\");const p=\"gate/hms-read-gate-report.json\";const v=JSON.parse(fs.readFileSync(p,\"utf8\"));const t=Date.parse(v.timestamp);if(v.passed!==true||v.mode!==\"--fixture-only\"||!Number.isFinite(t)||Date.now()-t>2*60*60*1000||t>Date.now()+60000)process.exit(10)"
SOURCE_SHA=$(sha256sum MANIFEST.sha256 | awk "{print \$1}")
case "$REV" in
  phase-a-*-"${SOURCE_SHA:0:16}") ;;
  *) echo HMS_FAIL code=BUILD_MISMATCH; exit 10 ;;
esac
[ "$(stat -c "%U:%G" "/opt/nava/releases/$REV")" = "root:root" ] || { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
[ -z "$(find "/opt/nava/releases/$REV" \( -type f -o -type d \) -perm /022 -print -quit)" ] || { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
[ ! -w "$PROOF_JS" ] || { echo HMS_FAIL code=BUILD_MISMATCH; exit 10; }
export NAVA_PROOF_SOURCE_REVISION="$REV"
ENV_FILE="$REPO_ROOT/apps/server-pilot/.env.production"
[ -f "$ENV_FILE" ] || ENV_FILE=/home/ubuntu/.env.production
set -a; source "$ENV_FILE"; set +a
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/nava/ms-playwright}"
export HMS_CHROMIUM_EXECUTABLE_PATH=/opt/nava/chromium/chrome
export HMS_READ_ROLE_PROOF_PATH=/etc/nava/hms-read-role-proof.v1.json
export HMS_SHADOW_SERVICE_USER_ID="${HMS_SHADOW_SERVICE_USER_ID:-user-centurion}"
export HMS_BROWSER_ARTIFACT_ROOT="${HMS_BROWSER_ARTIFACT_ROOT:-/opt/nava/shared/hms-browser-artifacts}"
mkdir -p "$HMS_BROWSER_ARTIFACT_ROOT"
chmod 700 "$HMS_BROWSER_ARTIFACT_ROOT"
cd "$ROOT/apps/server-pilot"
TMP=$(mktemp /tmp/nava-hms-proof.XXXXXX)
ARMED=1
cleanup() {
  ORIGINAL_RC=$?
  trap - EXIT INT TERM
  if [ "$ARMED" -eq 1 ]; then node "$PROOF_JS" stop >/dev/null 2>&1 || ORIGINAL_RC=20; fi
  rm -f "$TMP"
  exit "$ORIGINAL_RC"
}
trap cleanup EXIT
trap "exit 70" INT TERM
node "$PROOF_JS" status
node "$PROOF_JS" rearm
set +e
node "$PROOF_JS" proof-video >"$TMP" 2>&1
PROOF_RC=$?
set -e
set +e
STOP_OUTPUT=$(node "$PROOF_JS" stop 2>&1)
STOP_RC=$?
set -e
if [ "$STOP_RC" -ne 0 ]; then
  printf "%s\n" "$STOP_OUTPUT"
  rm -f "$TMP"
  echo HMS_FAIL code=ROLLBACK_INCOMPLETE
  exit 20
fi
printf "%s\n" "$STOP_OUTPUT"
node -e "process.stdout.write(require(\"fs\").readFileSync(process.argv[1],\"utf8\"))" "$TMP"
rm -f "$TMP"
ARMED=0
exit "$PROOF_RC"
'
    set +e
    PROOF_RESPONSE="$(run_remote 600 720 "$PROOF_CMD")"
    PROOF_RC=$?
    set -e
    PROOF_OUTPUT="$(printf '%s' "$PROOF_RESPONSE" | decode_ssm_stdout)" ||
      PROOF_DECODE_RC=$?
    if [ "${PROOF_DECODE_RC:-0}" -ne 0 ]; then
      exit 70
    fi
    if [ "$PROOF_RC" -ne 0 ]; then
      printf '%s' "$PROOF_OUTPUT"
      case "$PROOF_RC" in
        3|10|20|70) exit "$PROOF_RC" ;;
        *) exit 70 ;;
      esac
    fi
    case "$PROOF_OUTPUT" in
      *HMS_ROLLBACK_OK*PHASE_A_PROOF_EVIDENCE_V1*PHASE_A_PROOF_READY*) ;;
      *) echo "HMS_FAIL code=EVIDENCE_INVALID" >&2; exit 10 ;;
    esac

    TRANSFER_UUID="$(node -e 'console.log(require("crypto").randomUUID())')"
    TRANSFER_PREFIX="${TRANSFER_ROOT}/${TRANSFER_UUID}"
    LOCAL_DEST=""
    cleanup_transfer() {
      local object=""
      local delete_failed=0
      local remote_response=""
      local remote_output=""
      local remote_rc=0
      for object in preflight receipt.v1.json video.webm; do
        aws s3api delete-object \
          --bucket "$TRANSFER_BUCKET" \
          --key "${TRANSFER_PREFIX}/${object}" \
          --region "$AWS_REGION" >/dev/null 2>&1 || delete_failed=1
      done
      if [ "$delete_failed" -eq 0 ]; then
        return 0
      fi

      # Unversioned bucket + successful scoped DeleteObject is definitive.
      local remote_cleanup="set -euo pipefail
for OBJECT in preflight receipt.v1.json video.webm; do
  aws s3api delete-object --bucket '$TRANSFER_BUCKET' --key '${TRANSFER_PREFIX}/'\$OBJECT --region '$AWS_REGION' >/dev/null
done
echo HMS_PROOF_TRANSFER_CLEAN
"
      set +e
      remote_response="$(run_remote 180 300 "$remote_cleanup")"
      remote_rc=$?
      set -e
      if [ "$remote_rc" -eq 0 ]; then
        remote_output="$(printf '%s' "$remote_response" | decode_ssm_stdout)" || return 1
        case "$remote_output" in
          *HMS_PROOF_TRANSFER_CLEAN*) return 0 ;;
        esac
      fi
      return 1
    }
    rollback_transfer_on_exit() {
      local original_rc=$?
      local rollback_failed=0
      trap - EXIT
      if [ -n "$LOCAL_DEST" ]; then
        rm -rf "$LOCAL_DEST" || rollback_failed=1
        [ ! -e "$LOCAL_DEST" ] || rollback_failed=1
      fi
      if ! cleanup_transfer; then
        rollback_failed=1
      fi
      if [ "$rollback_failed" -ne 0 ]; then
        echo "HMS_FAIL code=ROLLBACK_INCOMPLETE" >&2
        exit 20
      fi
      exit "$original_rc"
    }
    trap rollback_transfer_on_exit EXIT

    PREFLIGHT_KEY="${TRANSFER_PREFIX}/preflight"
    PREFLIGHT_CMD="set -euo pipefail
PREFLIGHT_FILE=\$(mktemp /tmp/nava-hms-proof-preflight.XXXXXX)
trap 'rm -f \"\$PREFLIGHT_FILE\"' EXIT
: > \"\$PREFLIGHT_FILE\"
SSE=\$(aws s3api put-object --bucket '$TRANSFER_BUCKET' --key '$PREFLIGHT_KEY' --body \"\$PREFLIGHT_FILE\" --region '$AWS_REGION' --server-side-encryption AES256 --query ServerSideEncryption --output text)
[ \"\$SSE\" = AES256 ] || exit 10
echo HMS_PROOF_TRANSFER_PREFLIGHT_OK
"
    PREFLIGHT_RESPONSE="$(run_remote 180 300 "$PREFLIGHT_CMD")" ||
      PREFLIGHT_RC=$?
    PREFLIGHT_RC="${PREFLIGHT_RC:-0}"
    if [ "$PREFLIGHT_RC" -ne 0 ]; then
      printf '%s' "$PREFLIGHT_RESPONSE" | decode_ssm_stdout || true
      exit 10
    fi
    PREFLIGHT_OUTPUT="$(printf '%s' "$PREFLIGHT_RESPONSE" | decode_ssm_stdout)"
    case "$PREFLIGHT_OUTPUT" in
      *HMS_PROOF_TRANSFER_PREFLIGHT_OK*) ;;
      *) echo "HMS_FAIL code=EVIDENCE_INVALID" >&2; exit 10 ;;
    esac
    PREFLIGHT_LOCAL="$(mktemp "${TMPDIR:-/tmp}/hms-proof-preflight.XXXXXX")"
    aws s3 cp "s3://${TRANSFER_BUCKET}/${PREFLIGHT_KEY}" "$PREFLIGHT_LOCAL" \
      --region "$AWS_REGION" >/dev/null
    rm -f "$PREFLIGHT_LOCAL"
    aws s3 rm "s3://${TRANSFER_BUCKET}/${PREFLIGHT_KEY}" \
      --region "$AWS_REGION" >/dev/null

    TRANSFER_CMD="set -euo pipefail
GATE=/opt/nava/shared/hms-runtime/hms-phase-a-gate.v1.json
ROOT=/opt/nava/shared/hms-browser-artifacts
TRANSFER_UUID='$TRANSFER_UUID'
TRANSFER_BUCKET='$TRANSFER_BUCKET'
TRANSFER_ROOT='$TRANSFER_ROOT'
META=\$(node -e '
const fs=require(\"fs\"),path=require(\"path\"),crypto=require(\"crypto\");
const gate=JSON.parse(fs.readFileSync(process.argv[1],\"utf8\"));
if(gate.state!==\"provisional\"||!/^[-0-9a-f]{36}\$/i.test(gate.artifactId||\"\"))process.exit(10);
const dir=path.join(process.argv[2],gate.artifactId);
const receiptPath=path.join(dir,\"receipt.v1.json\"),videoPath=path.join(dir,\"video.webm\");
const receiptBody=fs.readFileSync(receiptPath);
const receiptSha=crypto.createHash(\"sha256\").update(receiptBody).digest(\"hex\");
if(receiptSha!==gate.receiptSha256)process.exit(10);
const receipt=JSON.parse(receiptBody);
const zero=[\"blockedRequests\",\"mutationRequests\",\"popupCount\",\"downloadCount\",\"webSocketCount\"].every(k=>receipt[k]===0);
if(receipt.artifactId!==gate.artifactId||receipt.sourceRevision!==gate.sourceRevision||receipt.artifactState!==\"complete\"||receipt.operationOutcome!==\"succeeded\"||receipt.executionClass!==\"live_proof\"||receipt.credentialMode!==\"view_only\"||!zero||!receipt.trace||!receipt.video||Date.parse(receipt.expiresAt)<=Date.now())process.exit(10);
const video=fs.readFileSync(videoPath);
const videoSha=crypto.createHash(\"sha256\").update(video).digest(\"hex\");
if(videoSha!==receipt.video.sha256||video.byteLength!==receipt.video.bytes)process.exit(10);
const trace=fs.readFileSync(path.join(dir,\"trace.zip\"));
const traceSha=crypto.createHash(\"sha256\").update(trace).digest(\"hex\");
if(traceSha!==receipt.trace.sha256||trace.byteLength!==receipt.trace.bytes)process.exit(10);
process.stdout.write(JSON.stringify({schemaVersion:1,artifactId:receipt.artifactId,sourceRevision:receipt.sourceRevision,toolId:receipt.toolId,toolVersion:receipt.toolVersion,dependencyRevision:receipt.dependencyRevision,playwrightRevision:receipt.playwrightRevision,chromiumRevision:receipt.chromiumRevision,productionOriginAttested:true,credentialMode:receipt.credentialMode,trace:receipt.trace,video:receipt.video,receiptSha256:receiptSha,blockedRequests:receipt.blockedRequests,mutationRequests:receipt.mutationRequests,popupCount:receipt.popupCount,downloadCount:receipt.downloadCount,webSocketCount:receipt.webSocketCount,expiresAt:receipt.expiresAt}));
' \"\$GATE\" \"\$ROOT\")
ARTIFACT_ID=\$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).artifactId)' \"\$META\")
DIR=\"\$ROOT/\$ARTIFACT_ID\"
KEY_BASE=\"\$TRANSFER_ROOT/\$TRANSFER_UUID\"
RECEIPT_SSE=\$(aws s3api put-object --bucket \"\$TRANSFER_BUCKET\" --key \"\$KEY_BASE/receipt.v1.json\" --body \"\$DIR/receipt.v1.json\" --region '$AWS_REGION' --server-side-encryption AES256 --query ServerSideEncryption --output text)
VIDEO_SSE=\$(aws s3api put-object --bucket \"\$TRANSFER_BUCKET\" --key \"\$KEY_BASE/video.webm\" --body \"\$DIR/video.webm\" --region '$AWS_REGION' --server-side-encryption AES256 --query ServerSideEncryption --output text)
[ \"\$RECEIPT_SSE\" = AES256 ] || exit 10
[ \"\$VIDEO_SSE\" = AES256 ] || exit 10
printf 'HMS_PROOF_TRANSFER_V1\n%s\n' \"\$META\"
"
    set +e
    TRANSFER_RESPONSE="$(run_remote 600 720 "$TRANSFER_CMD")"
    TRANSFER_RC=$?
    set -e
    if [ "$TRANSFER_RC" -ne 0 ]; then
      printf '%s' "$TRANSFER_RESPONSE" | decode_ssm_stdout || true
      case "$TRANSFER_RC" in
        3|10|20|70) exit "$TRANSFER_RC" ;;
        *) exit 70 ;;
      esac
    fi
    TRANSFER_OUTPUT="$(printf '%s' "$TRANSFER_RESPONSE" | decode_ssm_stdout)"
    TRANSFER_META="$(printf '%s' "$TRANSFER_OUTPUT" | node -e '
const fs=require("fs");
const lines=fs.readFileSync(0,"utf8").trim().split(/\r?\n/);
const marker=lines.indexOf("HMS_PROOF_TRANSFER_V1");
if(marker<0||!lines[marker+1])process.exit(10);
const value=JSON.parse(lines[marker+1]);
process.stdout.write(JSON.stringify(value));
')"
    ARTIFACT_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).artifactId)' "$TRANSFER_META")"
    RECEIPT_SHA="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).receiptSha256)' "$TRANSFER_META")"
    DEST="${LOCAL_PROOF_ROOT}/${ARTIFACT_ID}"
    LOCAL_DEST="$DEST"
    mkdir -p "$DEST"
    if ! apply_local_acl "$DEST" directory; then
      echo "HMS_FAIL code=EVIDENCE_INVALID" >&2
      exit 10
    fi
    aws s3 cp "s3://${TRANSFER_BUCKET}/${TRANSFER_PREFIX}/receipt.v1.json" \
      "$DEST/receipt.v1.json.part" --region "$AWS_REGION" >/dev/null
    aws s3 cp "s3://${TRANSFER_BUCKET}/${TRANSFER_PREFIX}/video.webm" \
      "$DEST/video.webm.part" --region "$AWS_REGION" >/dev/null
    mv "$DEST/receipt.v1.json.part" "$DEST/receipt.v1.json"
    mv "$DEST/video.webm.part" "$DEST/video.webm"
    if ! apply_local_acl "$DEST"; then
      echo "HMS_FAIL code=EVIDENCE_INVALID" >&2
      exit 10
    fi
    LOCAL_EVIDENCE_BASE="$(node -e '
const fs=require("fs"),path=require("path"),crypto=require("crypto");
const meta=JSON.parse(process.argv[1]);
const receiptPath=process.argv[2],videoPath=process.argv[3];
const receiptBody=fs.readFileSync(receiptPath),video=fs.readFileSync(videoPath);
const receiptSha=crypto.createHash("sha256").update(receiptBody).digest("hex");
const videoSha=crypto.createHash("sha256").update(video).digest("hex");
if(receiptSha!==meta.receiptSha256||videoSha!==meta.video.sha256||video.byteLength!==meta.video.bytes)process.exit(10);
const receipt=JSON.parse(receiptBody);
if(receipt.artifactId!==meta.artifactId||receipt.artifactState!=="complete")process.exit(10);
process.stdout.write(JSON.stringify({...meta,localReceiptPath:path.resolve(receiptPath),localVideoPath:path.resolve(videoPath)}));
' "$TRANSFER_META" "$DEST/receipt.v1.json" "$DEST/video.webm")"
    if ! cleanup_transfer; then
      trap - EXIT
      echo "HMS_FAIL code=ROLLBACK_INCOMPLETE" >&2
      exit 20
    fi
    SEAL_CMD="set -euo pipefail
GATE=/opt/nava/shared/hms-runtime/hms-phase-a-gate.v1.json
node - \"\$GATE\" '$ARTIFACT_ID' '$RECEIPT_SHA' <<'NODE'
const fs=require('fs'),path=require('path');
const gatePath=process.argv[2],artifactId=process.argv[3],receiptSha256=process.argv[4];
const value=JSON.parse(fs.readFileSync(gatePath,'utf8'));
if(value.schemaVersion!==1||value.state!=='provisional'||
  value.artifactId!==artifactId||value.receiptSha256!==receiptSha256)process.exit(10);
value.state='awaiting_continue';
value.deliveryAttestedAt=new Date().toISOString();
delete value.acceptedAt;
const tmp=path.join(path.dirname(gatePath),'.hms-phase-a-gate-'+process.pid+'.tmp');
const fd=fs.openSync(tmp,'wx',0o600);
try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
fs.renameSync(tmp,gatePath);
const parent=fs.openSync(path.dirname(gatePath),'r');
try{fs.fsyncSync(parent)}finally{fs.closeSync(parent)}
NODE
echo HMS_G1_DELIVERY_SEALED
"
    SEAL_RESPONSE="$(run_remote 180 300 "$SEAL_CMD")" || SEAL_RC=$?
    SEAL_RC="${SEAL_RC:-0}"
    if [ "$SEAL_RC" -ne 0 ]; then
      printf '%s' "$SEAL_RESPONSE" | decode_ssm_stdout || true
      case "$SEAL_RC" in
        3|10|20|70) exit "$SEAL_RC" ;;
        *) exit 70 ;;
      esac
    fi
    SEAL_OUTPUT="$(printf '%s' "$SEAL_RESPONSE" | decode_ssm_stdout)"
    case "$SEAL_OUTPUT" in
      *HMS_G1_DELIVERY_SEALED*) ;;
      *) echo "HMS_FAIL code=EVIDENCE_INVALID" >&2; exit 10 ;;
    esac
    LOCAL_DEST=""
    trap - EXIT
    LOCAL_EVIDENCE="$(node -e '
const evidence=JSON.parse(process.argv[1]);
evidence.deliveryAttestation={
  transport:"private_s3",
  serverSideEncryption:"AES256",
  transferCleanupVerified:true,
  localAclVerified:true
};
process.stdout.write(JSON.stringify(evidence));
' "$LOCAL_EVIDENCE_BASE")"
    printf '%s\n' \
      'HMS_ROLLBACK_OK' \
      'PHASE_A_PROOF_EVIDENCE_V1' \
      "$LOCAL_EVIDENCE" \
      'PHASE_A_PROOF_READY'
    ;;

  accept-g1)
    ACCEPT_CMD='set -euo pipefail
GATE=/opt/nava/shared/hms-runtime/hms-phase-a-gate.v1.json
ROOT=/opt/nava/shared/hms-browser-artifacts
REV_FILE=/opt/nava/shared/nava-proof-source-revision
CURRENT=$(node -e "const fs=require(\"fs\");const v=fs.readFileSync(process.argv[1],\"utf8\").trim();if(!/^phase-a-[A-Za-z0-9._-]+\$/.test(v))process.exit(10);process.stdout.write(v)" "$REV_FILE")
RELEASE="/opt/nava/releases/$CURRENT/worktree"
PROOF_JS="$RELEASE/apps/server-pilot/dist/ops/hms-live-proof.js"
cd "$RELEASE"
sha256sum -c MANIFEST.sha256 >/dev/null || { echo G1_FAIL code=EVIDENCE_INVALID; exit 10; }
sha256sum -c BUILD_MANIFEST.sha256 >/dev/null || { echo G1_FAIL code=EVIDENCE_INVALID; exit 10; }
SOURCE_SHA=$(sha256sum MANIFEST.sha256 | awk "{print \$1}")
case "$CURRENT" in
  phase-a-*-"${SOURCE_SHA:0:16}") ;;
  *) echo G1_FAIL code=EVIDENCE_INVALID; exit 10 ;;
esac
[ -f "$PROOF_JS" ] || { echo G1_FAIL code=EVIDENCE_INVALID; exit 10; }
[ ! -w "$PROOF_JS" ] || { echo G1_FAIL code=EVIDENCE_INVALID; exit 10; }
export HMS_PHASE_A_GATE_PATH="$GATE"
export HMS_BROWSER_ARTIFACT_ROOT="$ROOT"
export NAVA_PROOF_SOURCE_REVISION_PATH="$REV_FILE"
cd "$RELEASE/apps/server-pilot"
node "$PROOF_JS" accept-g1
'
    set +e
    ACCEPT_RESPONSE="$(run_remote 180 300 "$ACCEPT_CMD")"
    ACCEPT_RC=$?
    set -e
    printf '%s' "$ACCEPT_RESPONSE" | decode_ssm_stdout
    case "$ACCEPT_RC" in
      0|3|10|20|70) exit "$ACCEPT_RC" ;;
      *) exit 70 ;;
    esac
    ;;

  artifact-video|live-wave)
    echo "HMS_WAIT code=AGENT_REPAIR_REQUIRED" >&2
    exit 3
    ;;

  fetch-artifact)
    if ! ensure_transfer_lifecycle_rule ||
      ! verify_transfer_bucket_policy; then
      echo "HMS_FAIL code=POLICY_BLOCK" >&2
      exit 10
    fi
    case "$KIND" in
      receipt) FILE_NAME="receipt.v1.json" ;;
      video) FILE_NAME="video.webm" ;;
      trace) FILE_NAME="trace.zip" ;;
    esac
    TRANSFER_UUID="$(node -e 'console.log(require("crypto").randomUUID())')"
    TRANSFER_PREFIX="${TRANSFER_ROOT}/${TRANSFER_UUID}"
    REMOTE_CLEAN=0
    DEST="${LOCAL_PROOF_ROOT}/${ARTIFACT_ID}"
    PART_FILES=()
    cleanup_fetch_objects() {
      local object
      local failed=0
      for object in receipt.v1.json "$FILE_NAME"; do
        aws s3api delete-object \
          --bucket "$TRANSFER_BUCKET" \
          --key "${TRANSFER_PREFIX}/${object}" \
          --region "$AWS_REGION" >/dev/null 2>&1 || failed=1
      done
      return "$failed"
    }
    cleanup_fetch_on_exit() {
      local original_rc=$?
      local part
      local cleanup_failed=0
      trap - EXIT
      for part in "${PART_FILES[@]}"; do
        rm -f "$part" || cleanup_failed=1
      done
      if [ "$REMOTE_CLEAN" -ne 1 ] && ! cleanup_fetch_objects; then
        cleanup_failed=1
      fi
      if [ "$cleanup_failed" -ne 0 ]; then
        echo "HMS_FAIL code=ROLLBACK_INCOMPLETE" >&2
        exit 20
      fi
      exit "$original_rc"
    }
    trap cleanup_fetch_on_exit EXIT

    FETCH_CMD="set -euo pipefail
ROOT=/opt/nava/shared/hms-browser-artifacts
ARTIFACT_ID='$ARTIFACT_ID'
FILE_NAME='$FILE_NAME'
KIND='$KIND'
TRANSFER_BUCKET='$TRANSFER_BUCKET'
KEY_BASE='$TRANSFER_PREFIX'
META=\$(node -e '
const fs=require(\"fs\"),path=require(\"path\"),crypto=require(\"crypto\");
const [root,artifactId,fileName,kind]=process.argv.slice(1);
if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\$/i.test(artifactId))process.exit(10);
const dir=path.join(root,artifactId);
const dirStat=fs.lstatSync(dir);
if(dirStat.isSymbolicLink()||!dirStat.isDirectory())process.exit(10);
const receiptPath=path.join(dir,\"receipt.v1.json\");
const receiptBody=fs.readFileSync(receiptPath);
const receiptSha256=crypto.createHash(\"sha256\").update(receiptBody).digest(\"hex\");
const receipt=JSON.parse(receiptBody);
const expiresAt=Date.parse(receipt.expiresAt);
if(receipt.schemaVersion!==1||receipt.artifactId!==artifactId||receipt.artifactState!==\"complete\"||!Number.isFinite(expiresAt)||expiresAt<=Date.now())process.exit(3);
const targetPath=path.join(dir,fileName);
const targetBody=fs.readFileSync(targetPath);
const targetSha=crypto.createHash(\"sha256\").update(targetBody).digest(\"hex\");
const expected=kind===\"receipt\"?{sha256:receiptSha256,bytes:receiptBody.byteLength}:kind===\"video\"?receipt.video:receipt.trace;
if(!expected||expected.sha256!==targetSha||expected.bytes!==targetBody.byteLength)process.exit(10);
process.stdout.write(JSON.stringify({schemaVersion:1,artifactId,kind,fileName,sha256:targetSha,bytes:targetBody.byteLength,receiptSha256,expiresAt:receipt.expiresAt}));
' \"\$ROOT\" \"\$ARTIFACT_ID\" \"\$FILE_NAME\" \"\$KIND\")
RECEIPT_SSE=\$(aws s3api put-object --bucket \"\$TRANSFER_BUCKET\" --key \"\$KEY_BASE/receipt.v1.json\" --body \"\$ROOT/\$ARTIFACT_ID/receipt.v1.json\" --region '$AWS_REGION' --server-side-encryption AES256 --query ServerSideEncryption --output text)
[ \"\$RECEIPT_SSE\" = AES256 ] || exit 10
if [ \"\$FILE_NAME\" != receipt.v1.json ]; then
  TARGET_SSE=\$(aws s3api put-object --bucket \"\$TRANSFER_BUCKET\" --key \"\$KEY_BASE/\$FILE_NAME\" --body \"\$ROOT/\$ARTIFACT_ID/\$FILE_NAME\" --region '$AWS_REGION' --server-side-encryption AES256 --query ServerSideEncryption --output text)
  [ \"\$TARGET_SSE\" = AES256 ] || exit 10
fi
printf 'HMS_ARTIFACT_TRANSFER_V1\n%s\n' \"\$META\"
"
    set +e
    FETCH_RESPONSE="$(run_remote 180 300 "$FETCH_CMD")"
    FETCH_RC=$?
    set -e
    if [ "$FETCH_RC" -ne 0 ]; then
      printf '%s' "$FETCH_RESPONSE" | decode_ssm_stdout || true
      case "$FETCH_RC" in
        3|10|20|70) exit "$FETCH_RC" ;;
        *) exit 70 ;;
      esac
    fi
    FETCH_OUTPUT="$(printf '%s' "$FETCH_RESPONSE" | decode_ssm_stdout)"
    FETCH_META="$(printf '%s' "$FETCH_OUTPUT" | node -e '
const fs=require("fs");
const lines=fs.readFileSync(0,"utf8").trim().split(/\r?\n/);
const marker=lines.indexOf("HMS_ARTIFACT_TRANSFER_V1");
if(marker<0||!lines[marker+1])process.exit(10);
const meta=JSON.parse(lines[marker+1]);
if(meta.schemaVersion!==1)process.exit(10);
process.stdout.write(JSON.stringify(meta));
')"

    mkdir -p "$DEST"
    if [ -L "$DEST" ] || [ ! -d "$DEST" ] ||
      ! apply_local_acl "$DEST" directory; then
      echo "HMS_FAIL code=EVIDENCE_INVALID" >&2
      exit 10
    fi
    RECEIPT_PART="$DEST/receipt.v1.json.part-${TRANSFER_UUID}"
    PART_FILES+=("$RECEIPT_PART")
    aws s3 cp "s3://${TRANSFER_BUCKET}/${TRANSFER_PREFIX}/receipt.v1.json" \
      "$RECEIPT_PART" --region "$AWS_REGION" >/dev/null
    if [ "$FILE_NAME" = "receipt.v1.json" ]; then
      TARGET_PART="$RECEIPT_PART"
    else
      TARGET_PART="$DEST/${FILE_NAME}.part-${TRANSFER_UUID}"
      PART_FILES+=("$TARGET_PART")
      aws s3 cp "s3://${TRANSFER_BUCKET}/${TRANSFER_PREFIX}/${FILE_NAME}" \
        "$TARGET_PART" --region "$AWS_REGION" >/dev/null
    fi
    LOCAL_FETCH_META="$(node -e '
const fs=require("fs"),crypto=require("crypto");
const meta=JSON.parse(process.argv[1]);
const receiptBody=fs.readFileSync(process.argv[2]);
if(crypto.createHash("sha256").update(receiptBody).digest("hex")!==meta.receiptSha256)process.exit(10);
const receipt=JSON.parse(receiptBody);
const expiresAt=Date.parse(receipt.expiresAt);
if(receipt.artifactId!==meta.artifactId||!Number.isFinite(expiresAt)||expiresAt<=Date.now())process.exit(3);
const target=fs.readFileSync(process.argv[3]);
if(target.byteLength!==meta.bytes||crypto.createHash("sha256").update(target).digest("hex")!==meta.sha256)process.exit(10);
process.stdout.write(JSON.stringify(meta));
' "$FETCH_META" "$RECEIPT_PART" "$TARGET_PART")"
    ACL_PARTS=("$(basename "$RECEIPT_PART")")
    if [ "$TARGET_PART" != "$RECEIPT_PART" ]; then
      ACL_PARTS+=("$(basename "$TARGET_PART")")
    fi
    if ! apply_local_acl "$DEST" files "${ACL_PARTS[@]}"; then
      echo "HMS_FAIL code=EVIDENCE_INVALID" >&2
      exit 10
    fi
    if ! cleanup_fetch_objects; then
      echo "HMS_FAIL code=ROLLBACK_INCOMPLETE" >&2
      exit 20
    fi
    REMOTE_CLEAN=1
    mv -f "$RECEIPT_PART" "$DEST/receipt.v1.json"
    if [ "$TARGET_PART" != "$RECEIPT_PART" ]; then
      mv -f "$TARGET_PART" "$DEST/$FILE_NAME"
    fi
    PART_FILES=()
    if [ "$FILE_NAME" = "receipt.v1.json" ]; then
      FINAL_FILES=(receipt.v1.json)
    else
      FINAL_FILES=(receipt.v1.json "$FILE_NAME")
    fi
    if ! apply_local_acl "$DEST" files "${FINAL_FILES[@]}"; then
      echo "HMS_FAIL code=EVIDENCE_INVALID" >&2
      exit 10
    fi
    trap - EXIT
    LOCAL_PATH="$(node -e 'process.stdout.write(require("path").resolve(process.argv[1]))' "$DEST/$FILE_NAME")"
    printf '%s\n' \
      'HMS_ARTIFACT_FETCHED_V1' \
      "$(node -e 'const meta=JSON.parse(process.argv[1]);meta.localPath=process.argv[2];meta.deliveryAttestation={transport:\"private_s3\",serverSideEncryption:\"AES256\",transferCleanupVerified:true,localAclVerified:true};process.stdout.write(JSON.stringify(meta))' "$LOCAL_FETCH_META" "$LOCAL_PATH")"
    ;;
esac
