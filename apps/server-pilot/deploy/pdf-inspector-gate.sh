#!/usr/bin/env -S -i PATH=/usr/bin:/bin LC_ALL=C LANG=C /usr/bin/bash
# EC2-only PDF Inspector native gate.
# @firecrawl/pdf-inspector@1.12.0 published native build uses lopdf 0.41.0.
# Backtest-only: never promote, never retry outside this sandbox.
set -euo pipefail

EXPECTED_PACKAGE_VERSION='1.12.0'
EXPECTED_LOPDF_VERSION='0.41.0'
EXPECTED_PUBLISHED_GIT_HEAD='98990cc55028a83aa8c712df938dd5dc19523350'
MAX_PROTOCOL_OUTPUT_BYTES=$((2 * 1024 * 1024))
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
BWRAP_BIN="${BWRAP_BIN:-/usr/bin/bwrap}"
PRLIMIT_BIN="${PRLIMIT_BIN:-/usr/bin/prlimit}"
NODE_BIN="${NODE_BIN:-}"

fail() {
  printf 'pdf-inspector-gate: FAIL\n' >&2
  exit 1
}

candidate_gate() {
  local stage_root=''
  local source_root=''
  local cargo_lock=''
  local package_tarball=''
  local node_modules=''
  local node_modules_pnpm=''
  local package_root=''
  local native_addon=''
  local child_script=''
  local pnpm_store=''
  local network_probe_script=''
  local cargo_lock_sha256=''
  local source_tree_sha256=''
  local tarball_sha256=''
  local native_addon_sha256=''
  local child_script_sha256=''
  local package_tree_sha256=''
  local package_version=''
  local target=''
  local libc=''
  local node_abi=''
  local lopdf_version=''

  [[ "$NODE_BIN" == '/usr/bin/node' ]] || fail
  [[ "$BWRAP_BIN" == '/usr/bin/bwrap' ]] || fail
  [[ "$PRLIMIT_BIN" == '/usr/bin/prlimit' ]] || fail

  while (($# > 0)); do
    local option="$1"
    shift
    case "$option" in
      --stage-root) stage_root="${1:-}"; shift ;;
      --source-root) source_root="${1:-}"; shift ;;
      --cargo-lock) cargo_lock="${1:-}"; shift ;;
      --package-tarball) package_tarball="${1:-}"; shift ;;
      --node-modules) node_modules="${1:-}"; shift ;;
      --node-modules-pnpm) node_modules_pnpm="${1:-}"; shift ;;
      --package-root) package_root="${1:-}"; shift ;;
      --native-addon) native_addon="${1:-}"; shift ;;
      --child-script) child_script="${1:-}"; shift ;;
      --pnpm-store) pnpm_store="${1:-}"; shift ;;
      --network-probe-script) network_probe_script="${1:-}"; shift ;;
      --cargo-lock-sha256) cargo_lock_sha256="${1:-}"; shift ;;
      --source-tree-sha256) source_tree_sha256="${1:-}"; shift ;;
      --tarball-sha256) tarball_sha256="${1:-}"; shift ;;
      --native-addon-sha256) native_addon_sha256="${1:-}"; shift ;;
      --child-script-sha256) child_script_sha256="${1:-}"; shift ;;
      --package-tree-sha256) package_tree_sha256="${1:-}"; shift ;;
      --package-version) package_version="${1:-}"; shift ;;
      --target) target="${1:-}"; shift ;;
      --libc) libc="${1:-}"; shift ;;
      --node-abi) node_abi="${1:-}"; shift ;;
      --lopdf-version) lopdf_version="${1:-}"; shift ;;
      *) fail ;;
    esac
  done

  [[ -n "$stage_root" && -n "$source_root" && -n "$cargo_lock" && -n "$package_tarball" ]] || fail
  [[ -n "$node_modules" && -n "$node_modules_pnpm" && -n "$package_root" && -n "$native_addon" ]] || fail
  [[ -n "$child_script" && -n "$pnpm_store" && -n "$network_probe_script" ]] || fail
  [[ -n "$cargo_lock_sha256" && -n "$source_tree_sha256" && -n "$tarball_sha256" ]] || fail
  [[ -n "$native_addon_sha256" && -n "$package_tree_sha256" ]] || fail
  [[ -n "$package_version" && -n "$target" && -n "$libc" && -n "$node_abi" ]] || fail
  [[ -n "$lopdf_version" ]] || fail
  [[ "$cargo_lock_sha256" =~ ^[a-f0-9]{64}$ ]] || fail
  [[ "$source_tree_sha256" =~ ^[a-f0-9]{64}$ ]] || fail
  [[ "$tarball_sha256" =~ ^[a-f0-9]{64}$ ]] || fail
  [[ "$native_addon_sha256" =~ ^[a-f0-9]{64}$ ]] || fail
  [[ "$package_tree_sha256" =~ ^[a-f0-9]{64}$ ]] || fail
  [[ "$stage_root" == /* && "$stage_root" != '/' ]] || fail
  [[ ! -L "$stage_root" ]] || fail

  local canonical_stage
  canonical_stage="$(readlink -e -- "$stage_root")" || fail
  [[ "$canonical_stage" == "$stage_root" && -d "$canonical_stage" ]] || fail
  assert_owner_readonly() {
    local path="$1"
    local expected_type="$2"
    [[ ! -L "$path" ]] || fail
    if [[ "$expected_type" == 'directory' ]]; then
      [[ -d "$path" ]] || fail
    else
      [[ -f "$path" ]] || fail
    fi
    local uid mode
    read -r uid mode < <(stat -c '%u %a' -- "$path") || fail
    [[ "$uid" == "$(id -u)" ]] || fail
    local mode_value=$((8#$mode))
    (( (mode_value & 0077) == 0 && (mode_value & 0222) == 0 )) || fail
  }

  assert_stage_path() {
    local raw_path="$1"
    local expected_type="$2"
    [[ "$raw_path" == "$canonical_stage/"* ]] || fail
    local remaining="${raw_path#"$canonical_stage"/}"
    local current="$canonical_stage"
    local component index
    IFS='/' read -r -a components <<<"$remaining"
    assert_owner_readonly "$current" directory
    for ((index = 0; index < ${#components[@]}; index += 1)); do
      component="${components[index]}"
      [[ -n "$component" ]] || fail
      current="$current/$component"
      [[ ! -L "$current" ]] || fail
      if ((index == ${#components[@]} - 1)); then
        assert_owner_readonly "$current" "$expected_type"
      else
        assert_owner_readonly "$current" directory
      fi
    done
    local canonical_path
    canonical_path="$(readlink -e -- "$raw_path")" || fail
    [[ "$canonical_path" == "$canonical_stage/"* ]] || fail
    printf '%s\n' "$canonical_path"
  }

  source_root="$(assert_stage_path "$source_root" directory)"
  cargo_lock="$(assert_stage_path "$cargo_lock" file)"
  package_tarball="$(assert_stage_path "$package_tarball" file)"
  node_modules="$(assert_stage_path "$node_modules" directory)"
  node_modules_pnpm="$(assert_stage_path "$node_modules_pnpm" directory)"
  package_root="$(assert_stage_path "$package_root" directory)"
  native_addon="$(assert_stage_path "$native_addon" file)"
  pnpm_store="$(assert_stage_path "$pnpm_store" directory)"
  local trusted_app_root trusted_child_script trusted_network_probe_script
  trusted_app_root="$(readlink -e -- "$(dirname "${BASH_SOURCE[0]}")/..")" || fail
  [[ -d "$trusted_app_root" && ! -L "$trusted_app_root" ]] || fail
  trusted_child_script="$trusted_app_root/scripts/pdf-inspector-child.mjs"
  trusted_network_probe_script="$trusted_app_root/scripts/pdf-inspector-network-probe.mjs"
  [[ "$child_script" == "$trusted_child_script" ]] || fail
  [[ "$network_probe_script" == "$trusted_network_probe_script" ]] || fail
  [[ -f "$child_script" && ! -L "$child_script" ]] || fail
  [[ -f "$network_probe_script" && ! -L "$network_probe_script" ]] || fail
  child_script="$(readlink -e -- "$child_script")" || fail
  network_probe_script="$(readlink -e -- "$network_probe_script")" || fail
  [[ "$cargo_lock" == "$source_root/napi/Cargo.lock" ]] || fail
  [[ "$package_root" == "$node_modules/@firecrawl/pdf-inspector" ]] || fail
  [[ "$native_addon" == "$node_modules/"*.node ]] || fail

  assert_stage_tree() {
    local root="$1"
    local root_device
    root_device="$(stat -c %d -- "$root")" || fail
    while IFS= read -r -d '' child; do
      local child_device
      child_device="$(stat -c %d -- "$child")" || fail
      [[ "$child_device" == "$root_device" ]] || fail
      [[ ! -L "$child" ]] || fail
      if [[ -d "$child" ]]; then
        assert_owner_readonly "$child" directory
      else
        assert_owner_readonly "$child" file
      fi
    done < <(find "$root" -xdev -print0)
  }
  for mounted_tree in "$source_root" "$node_modules" "$node_modules_pnpm" "$pnpm_store" "$package_root"; do
    assert_stage_tree "$mounted_tree"
  done

  sha256_file() {
    sha256sum -- "$1" | awk '{print $1}'
  }
  [[ "$(sha256_file "$cargo_lock")" == "$cargo_lock_sha256" ]] || fail
  [[ "$(sha256_file "$package_tarball")" == "$tarball_sha256" ]] || fail
  [[ "$(sha256_file "$native_addon")" == "$native_addon_sha256" ]] || fail
  "$NODE_BIN" -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const entries = [];
    const visit = (current, relative) => {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) process.exit(1);
      if (stat.isDirectory()) {
        entries.push(`d:${relative}`);
        for (const entry of fs.readdirSync(current).sort()) {
          if (relative === "." && entry === ".git") continue;
          visit(path.join(current, entry), path.join(relative, entry));
        }
      } else if (stat.isFile()) {
        entries.push(`f:${relative}:${crypto.createHash("sha256").update(fs.readFileSync(current)).digest("hex")}`);
      } else process.exit(1);
    };
    visit(process.argv[1], ".");
    if (crypto.createHash("sha256").update(entries.join("\n")).digest("hex") !== process.argv[2]) process.exit(1);
  ' "$source_root" "$source_tree_sha256" || fail
  local tar_extract
  tar_extract="$(mktemp -d)" || fail
  if ! tar -tzf "$package_tarball" | while IFS= read -r entry; do
    entry="${entry%/}"
    [[ -n "$entry" && "$entry" != /* ]] || exit 1
    [[ "/$entry/" != *'/../'* ]] || exit 1
  done; then
    rm -rf "$tar_extract"
    fail
  fi
  if ! tar -tvzf "$package_tarball" | awk 'substr($1,1,1) !~ /^[-d]$/ { exit 1 }'; then
    rm -rf "$tar_extract"
    fail
  fi
  tar -xzf "$package_tarball" -C "$tar_extract" --no-same-owner --no-same-permissions || {
    rm -rf "$tar_extract"
    fail
  }
  [[ -d "$tar_extract/package" && ! -L "$tar_extract/package" ]] || {
    rm -rf "$tar_extract"
    fail
  }

  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const packageJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (
      packageJson.name !== "@firecrawl/pdf-inspector" ||
      packageJson.version !== process.argv[2]
    ) process.exit(1);
  ' "$package_root/package.json" "$package_version" || fail
  "$NODE_BIN" -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const entries = [];
    const visit = (current, relative) => {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) process.exit(1);
      if (stat.isDirectory()) {
        entries.push(`d:${relative}`);
        for (const entry of fs.readdirSync(current).sort()) {
          visit(path.join(current, entry), path.join(relative, entry));
        }
        return;
      }
      if (!stat.isFile()) process.exit(1);
      entries.push(`f:${relative}:${crypto.createHash("sha256").update(fs.readFileSync(current)).digest("hex")}`);
    };
    visit(root, ".");
    const digest = crypto.createHash("sha256").update(entries.join("\n")).digest("hex");
    if (digest !== process.argv[2]) process.exit(1);
  ' "$package_root" "$package_tree_sha256" || fail
  "$NODE_BIN" -e '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const path = require("node:path");
    const entries = [];
    const visit = (current, relative) => {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) process.exit(1);
      if (stat.isDirectory()) {
        entries.push(`d:${relative}`);
        for (const entry of fs.readdirSync(current).sort()) visit(path.join(current, entry), path.join(relative, entry));
      } else if (stat.isFile()) {
        entries.push(`f:${relative}:${crypto.createHash("sha256").update(fs.readFileSync(current)).digest("hex")}`);
      } else process.exit(1);
    };
    visit(process.argv[1], ".");
    if (crypto.createHash("sha256").update(entries.join("\n")).digest("hex") !== process.argv[2]) process.exit(1);
  ' "$tar_extract/package" "$package_tree_sha256" || {
    rm -rf "$tar_extract"
    fail
  }
  rm -rf "$tar_extract"
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const lock = fs.readFileSync(process.argv[1], "utf8");
    const versions = lock
      .split(/^\[\[package\]\]\s*$/m)
      .slice(1)
      .flatMap((block) => {
        if (!/^\s*name\s*=\s*"lopdf"\s*$/m.test(block)) return [];
        const match = block.match(/^\s*version\s*=\s*"([^"]+)"\s*$/m);
        return match ? [match[1]] : [];
      });
    const parse = (value) => {
      const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
      if (!match) return null;
      return {
        core: match.slice(1, 4).map(Number),
        prerelease: match[4] ? match[4].split(".") : null,
      };
    };
    const compare = (left, right) => {
      const a = parse(left);
      const b = parse(right);
      if (!a || !b) return NaN;
      for (let index = 0; index < a.core.length; index += 1) {
        if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
      }
      if (!a.prerelease && !b.prerelease) return 0;
      if (!a.prerelease) return 1;
      if (!b.prerelease) return -1;
      const length = Math.max(a.prerelease.length, b.prerelease.length);
      for (let index = 0; index < length; index += 1) {
        const leftPart = a.prerelease[index];
        const rightPart = b.prerelease[index];
        if (leftPart === undefined) return -1;
        if (rightPart === undefined) return 1;
        if (leftPart === rightPart) continue;
        const leftNumeric = /^\d+$/.test(leftPart);
        const rightNumeric = /^\d+$/.test(rightPart);
        if (leftNumeric && rightNumeric) return Number(leftPart) > Number(rightPart) ? 1 : -1;
        if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
        return leftPart > rightPart ? 1 : -1;
      }
      return 0;
    };
    const lopdfOrder = compare(process.argv[2], "0.42.0");
    if (
      versions.length !== 1 ||
      versions[0] !== process.argv[2] ||
      !Number.isFinite(lopdfOrder) ||
      lopdfOrder < 0
    ) process.exit(1);
  ' "$cargo_lock" "$lopdf_version" || fail

  [[ "$("$NODE_BIN" -p 'process.platform')" == 'linux' ]] || fail
  local native_arch
  native_arch="$("$NODE_BIN" -p 'process.arch')"
  case "$native_arch" in
    x64)
      native_arch='x64'
      [[ "$target" == "x86_64-unknown-linux-$libc" ]] || fail
      ;;
    arm64)
      native_arch='arm64'
      [[ "$target" == "aarch64-unknown-linux-$libc" ]] || fail
      ;;
    *) fail ;;
  esac
  local detected_libc='gnu'
  if ! "$NODE_BIN" -e '
    const report = process.report?.getReport?.();
    if (!report?.header?.glibcVersionRuntime) process.exit(1);
  ' >/dev/null 2>&1; then
    detected_libc='musl'
  fi
  [[ "$libc" == "$detected_libc" ]] || fail
  [[ "$("$NODE_BIN" -p 'process.versions.modules')" == "$node_abi" ]] || fail
  [[ "$native_addon" == "$node_modules/@firecrawl/pdf-inspector-linux-${native_arch}-${libc}/"*.node ]] || fail
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const root = process.argv[1];
    const addon = process.argv[2];
    const version = process.argv[3];
    const platform = process.argv[4];
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const resolved = path.resolve(root, String(pkg.main || ""));
    if (
      pkg.name !== platform ||
      pkg.version !== version ||
      !resolved.endsWith(".node") ||
      resolved !== addon
    ) process.exit(1);
  ' "$node_modules/@firecrawl/pdf-inspector-linux-${native_arch}-${libc}" \
    "$native_addon" "$package_version" \
    "@firecrawl/pdf-inspector-linux-${native_arch}-${libc}" || fail

  local node_bin node_dir node_name
  node_bin="$(readlink -f "$NODE_BIN")"
  node_dir="$(dirname "$node_bin")"
  node_name="$(basename "$node_bin")"
  local tmp listener_pid=''
  tmp="$(mktemp -d)"
  candidate_cleanup() {
    local exit_status=$?
    trap - EXIT
    if [[ -n "$listener_pid" ]]; then
      kill "$listener_pid" >/dev/null 2>&1 || true
    fi
    rm -rf "$tmp" || true
    return "$exit_status"
  }
  trap candidate_cleanup EXIT

  local listener_port_file listener_port=''
  listener_port_file="$tmp/network-listener.port"
  : >"$listener_port_file"
  "$node_bin" "$network_probe_script" --listen >"$listener_port_file" 2>/dev/null &
  listener_pid=$!
  local attempt
  for ((attempt = 0; attempt < 20; attempt += 1)); do
    if IFS= read -r listener_port <"$listener_port_file"; then
      if [[ "$listener_port" =~ ^[1-9][0-9]{0,4}$ ]] && ((listener_port <= 65535)); then
        break
      fi
    fi
    kill -0 "$listener_pid" >/dev/null 2>&1 || fail
    sleep 0.05
  done
  [[ "$listener_port" =~ ^[1-9][0-9]{0,4}$ ]] || fail
  ((listener_port <= 65535)) || fail
  "$node_bin" "$network_probe_script" --probe "$listener_port" --expect-connected \
    >/dev/null 2>&1 || fail

  set +e
  "$BWRAP_BIN" \
    --die-with-parent \
    --new-session \
    --unshare-user \
    --unshare-pid \
    --unshare-net \
    --unshare-ipc \
    --unshare-uts \
    --unshare-cgroup-try \
    --cap-drop ALL \
    --clearenv \
    --ro-bind /usr /usr \
    --ro-bind /lib /lib \
    --ro-bind-try /lib64 /lib64 \
    --dir /runtime \
    --ro-bind "$node_dir" /runtime/node \
    --dir /node_modules \
    --ro-bind "$network_probe_script" /app/network-probe.mjs \
    --proc /proc \
    --dev /dev \
    --tmpfs /tmp \
    --dir /app \
    --chdir /tmp \
    -- \
    "$PRLIMIT_BIN" \
    --cpu=5:5 \
    --as=1073741824:1073741824 \
    "--fsize=${MAX_PROTOCOL_OUTPUT_BYTES}:${MAX_PROTOCOL_OUTPUT_BYTES}" \
    --nofile=32:32 \
    --nproc=16:16 \
    --core=0:0 \
    -- \
    "/runtime/node/$node_name" /app/network-probe.mjs --probe "$listener_port" --expect-blocked \
    >"$tmp/network-probe.stdout" 2>"$tmp/network-probe.stderr"
  local network_probe_status=$?
  set -e
  [[ "$network_probe_status" -eq 0 ]] || fail
  [[ ! -s "$tmp/network-probe.stdout" && ! -s "$tmp/network-probe.stderr" ]] || fail

  "$node_bin" -e '
    const fs = require("node:fs");
    const out = process.argv[1];
    const stream = "BT /F1 12 Tf 72 720 Td (Synthetic gate fixture) Tj ET\n";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream`,
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (let index = 0; index < objects.length; index += 1) {
      offsets.push(Buffer.byteLength(pdf, "utf8"));
      pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf, "utf8");
    pdf += `xref\n0 ${objects.length + 1}\n`;
    pdf += "0000000000 65535 f \n";
    for (const offset of offsets.slice(1)) {
      pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    fs.writeFileSync(out, pdf, { mode: 0o600 });
  ' "$tmp/input.pdf"

  local -a candidate_bwrap_args=(
    --die-with-parent
    --new-session
    --unshare-user
    --unshare-pid
    --unshare-net
    --unshare-ipc
    --unshare-uts
    --unshare-cgroup-try
    --cap-drop ALL
    --clearenv
    --setenv NAPI_RS_ENFORCE_VERSION_CHECK 1
    --ro-bind /usr /usr
    --ro-bind /lib /lib
    --ro-bind-try /lib64 /lib64
    --dir /runtime
    --ro-bind "$node_dir" /runtime/node
    --ro-bind "$node_modules" /app/node_modules
    --dir /node_modules
  )
  candidate_bwrap_args+=(--ro-bind "$pnpm_store" /node_modules/.pnpm)
  candidate_bwrap_args+=(
    --ro-bind "$node_modules_pnpm" /app/.pnpm
    --ro-bind "$child_script" /app/pdf-inspector-child.mjs
    --proc /proc
    --dev /dev
    --tmpfs /tmp
    --dir /app
    --dir /input
    --ro-bind "$tmp/input.pdf" /input/document.pdf
    --chdir /tmp
    --
    "$PRLIMIT_BIN"
    --cpu=5:5
    --as=1073741824:1073741824
    "--fsize=${MAX_PROTOCOL_OUTPUT_BYTES}:${MAX_PROTOCOL_OUTPUT_BYTES}"
    --nofile=32:32
    --nproc=16:16
    --core=0:0
    --
    "/runtime/node/$node_name"
    /app/pdf-inspector-child.mjs
    /input/document.pdf
  )
  set +e
  local output
  output="$("$BWRAP_BIN" "${candidate_bwrap_args[@]}" 2>"$tmp/stderr")"
  local status=$?
  set -e
  [[ "$status" -eq 0 ]] || fail
  "$node_bin" -e '
    const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (
      value.status !== "ok" ||
      value.reason !== "text" ||
      value.pdfType !== "TextBased" ||
      value.pageCount !== 1
    ) process.exit(1);
  ' <<<"$output" || fail
  printf 'pdf-inspector-gate: PASS (candidate backtest-only, lopdf %s)\n' "$lopdf_version"
  candidate_cleanup
}

if [[ -z "$NODE_BIN" ]]; then
  if [[ -n "${NVM_BIN:-}" && -x "${NVM_BIN}/node" ]]; then
    NODE_BIN="${NVM_BIN}/node"
  else
    NODE_BIN="$(command -v node || true)"
  fi
fi

[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || fail
[[ -x "$BWRAP_BIN" ]] || fail
[[ -x "$PRLIMIT_BIN" ]] || fail
"$NODE_BIN" --version >/dev/null 2>&1 || fail

if [[ "${1:-}" == '--candidate' ]]; then
  shift
  candidate_gate "$@"
  exit 0
fi

PACKAGE_JSON="$APP_DIR/node_modules/@firecrawl/pdf-inspector/package.json"
CHILD_SCRIPT="$APP_DIR/scripts/pdf-inspector-child.mjs"
NETWORK_PROBE_SCRIPT="$APP_DIR/scripts/pdf-inspector-network-probe.mjs"
NODE_MODULES="$APP_DIR/node_modules"
PROVENANCE_MANIFEST="$APP_DIR/deploy/pdf-inspector-provenance.json"
LOCKFILE="$APP_DIR/../../pnpm-lock.yaml"
[[ -f "$PACKAGE_JSON" ]] || fail
[[ -f "$CHILD_SCRIPT" ]] || fail
[[ -f "$NETWORK_PROBE_SCRIPT" ]] || fail
[[ -d "$NODE_MODULES" ]] || fail
[[ -f "$PROVENANCE_MANIFEST" ]] || fail
[[ -f "$LOCKFILE" ]] || fail

PACKAGE_VERSION="$("$NODE_BIN" -e '
  const fs = require("node:fs");
  const packageJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(packageJson.version));
' "$PACKAGE_JSON")"
[[ "$PACKAGE_VERSION" == "$EXPECTED_PACKAGE_VERSION" ]] || fail

[[ "$("$NODE_BIN" -p 'process.platform')" == 'linux' ]] || fail
NATIVE_ARCH="$("$NODE_BIN" -p 'process.arch')"
case "$NATIVE_ARCH" in
  x64) NATIVE_ARCH='x64' ;;
  arm64) NATIVE_ARCH='arm64' ;;
  *) fail ;;
esac
LIBC_SUFFIX='gnu'
if ! "$NODE_BIN" -e '
  const report = process.report?.getReport?.();
  if (!report?.header?.glibcVersionRuntime) process.exit(1);
' >/dev/null 2>&1; then
  LIBC_SUFFIX='musl'
fi
NATIVE_PACKAGE="$NODE_MODULES/@firecrawl/pdf-inspector-linux-${NATIVE_ARCH}-${LIBC_SUFFIX}"
NATIVE_PACKAGE_JSON="$NATIVE_PACKAGE/package.json"
if [[ ! -f "$NATIVE_PACKAGE_JSON" ]]; then
  PACKAGE_DIR="$(dirname "$(readlink -f "$PACKAGE_JSON")")"
  PACKAGE_SCOPE_DIR="$(dirname "$PACKAGE_DIR")"
  NATIVE_PACKAGE="$PACKAGE_SCOPE_DIR/pdf-inspector-linux-${NATIVE_ARCH}-${LIBC_SUFFIX}"
  NATIVE_PACKAGE_JSON="$NATIVE_PACKAGE/package.json"
fi
[[ -f "$NATIVE_PACKAGE_JSON" ]] || fail
NATIVE_PACKAGE_VERSION="$("$NODE_BIN" -e '
  const fs = require("node:fs");
  const packageJson = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(packageJson.version));
' "$NATIVE_PACKAGE_JSON")"
[[ "$NATIVE_PACKAGE_VERSION" == "$EXPECTED_PACKAGE_VERSION" ]] || fail

PLATFORM_PACKAGE="@firecrawl/pdf-inspector-linux-${NATIVE_ARCH}-${LIBC_SUFFIX}"
IFS=$'\t' read -r MANIFEST_PACKAGE MANIFEST_VERSION MANIFEST_GIT_HEAD MANIFEST_LOPDF \
  MANIFEST_BACKTEST MAIN_MANIFEST_INTEGRITY PLATFORM_MANIFEST_VERSION PLATFORM_MANIFEST_INTEGRITY < <(
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const platform = manifest.linuxPlatformPackages?.[process.argv[2]];
    if (
      manifest.package !== "@firecrawl/pdf-inspector" ||
      !manifest.version ||
      !manifest.publishedGitHead ||
      !manifest.lopdf ||
      manifest.backtestOnly !== true ||
      !manifest.main?.integrity ||
      !platform?.version ||
      !platform?.integrity
    ) process.exit(1);
    process.stdout.write([
      manifest.package,
      manifest.version,
      manifest.publishedGitHead,
      manifest.lopdf,
      String(manifest.backtestOnly),
      manifest.main.integrity,
      platform.version,
      platform.integrity,
    ].join("\t") + "\n");
  ' "$PROVENANCE_MANIFEST" "$PLATFORM_PACKAGE"
) || fail
[[ "$MANIFEST_PACKAGE" == '@firecrawl/pdf-inspector' ]] || fail
[[ "$MANIFEST_VERSION" == "$EXPECTED_PACKAGE_VERSION" ]] || fail
[[ "$MANIFEST_GIT_HEAD" == "$EXPECTED_PUBLISHED_GIT_HEAD" ]] || fail
[[ "$MANIFEST_LOPDF" == "$EXPECTED_LOPDF_VERSION" ]] || fail
[[ "$MANIFEST_BACKTEST" == 'true' ]] || fail
[[ "$PLATFORM_MANIFEST_VERSION" == "$EXPECTED_PACKAGE_VERSION" ]] || fail

"$NODE_BIN" -e '
  const fs = require("node:fs");
  const lock = fs.readFileSync(process.argv[1], "utf8");
  const expected = new Map([
    [process.argv[2], process.argv[4]],
    [process.argv[3], process.argv[5]],
  ]);
  for (const [name, integrity] of expected) {
    const marker = `  '\''${name}@1.12.0'\'':`;
    const start = lock.indexOf(marker);
    if (start < 0) process.exit(1);
    const remainder = lock.slice(start + marker.length);
    const boundary = remainder.search(/\r?\n  \S/);
    const end = boundary < 0 ? lock.length : start + marker.length + boundary;
    const block = lock.slice(start, end);
    const match = block.match(/resolution: \{integrity: ([^}]+)\}/);
    if (!match || match[1] !== integrity) process.exit(1);
  }
' "$LOCKFILE" '@firecrawl/pdf-inspector' "$PLATFORM_PACKAGE" \
  "$MAIN_MANIFEST_INTEGRITY" "$PLATFORM_MANIFEST_INTEGRITY" || fail

NODE_BIN="$(readlink -f "$NODE_BIN")"
NODE_DIR="$(dirname "$NODE_BIN")"
NODE_NAME="$(basename "$NODE_BIN")"
PNPM_STORE="$(cd "$APP_DIR/../.." && pwd)/node_modules/.pnpm"
tmp="$(mktemp -d)"
listener_pid=''
cleanup() {
  if [[ -n "$listener_pid" ]]; then
    kill "$listener_pid" >/dev/null 2>&1 || true
    wait "$listener_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

listener_port_file="$tmp/network-listener.port"
: >"$listener_port_file"
"$NODE_BIN" "$NETWORK_PROBE_SCRIPT" --listen >"$listener_port_file" 2>/dev/null &
listener_pid=$!
listener_port=''
for ((attempt = 0; attempt < 20; attempt += 1)); do
  if IFS= read -r listener_port <"$listener_port_file"; then
    if [[ "$listener_port" =~ ^[1-9][0-9]{0,4}$ ]] && ((listener_port <= 65535)); then
      break
    fi
  fi
  if ! kill -0 "$listener_pid" >/dev/null 2>&1; then
    fail
  fi
  sleep 0.05
done
[[ "$listener_port" =~ ^[1-9][0-9]{0,4}$ ]] || fail
((listener_port <= 65535)) || fail
"$NODE_BIN" "$NETWORK_PROBE_SCRIPT" --probe "$listener_port" --expect-connected \
  >/dev/null 2>&1 || fail

set +e
"$BWRAP_BIN" \
  --die-with-parent \
  --new-session \
  --unshare-user \
  --unshare-pid \
  --unshare-net \
  --unshare-ipc \
  --unshare-uts \
  --unshare-cgroup-try \
  --cap-drop ALL \
  --clearenv \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind-try /lib64 /lib64 \
  --dir /runtime \
  --ro-bind "$NODE_DIR" /runtime/node \
  --dir /node_modules \
  --ro-bind-try "$PNPM_STORE" /node_modules/.pnpm \
  --ro-bind "$NETWORK_PROBE_SCRIPT" /app/network-probe.mjs \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --dir /app \
  --chdir /tmp \
  -- \
  "$PRLIMIT_BIN" \
  --cpu=5:5 \
  --as=1073741824:1073741824 \
  "--fsize=${MAX_PROTOCOL_OUTPUT_BYTES}:${MAX_PROTOCOL_OUTPUT_BYTES}" \
  --nofile=32:32 \
  --nproc=16:16 \
  --core=0:0 \
  -- \
  "/runtime/node/$NODE_NAME" /app/network-probe.mjs --probe "$listener_port" --expect-blocked \
  >"$tmp/network-probe.stdout" 2>"$tmp/network-probe.stderr"
network_probe_status=$?
set -e
[[ "$network_probe_status" -eq 0 ]] || fail
[[ ! -s "$tmp/network-probe.stdout" ]] || fail
[[ ! -s "$tmp/network-probe.stderr" ]] || fail

"$NODE_BIN" -e '
  const fs = require("node:fs");
  const out = process.argv[1];
  const stream = "BT /F1 12 Tf 72 720 Td (Synthetic gate fixture) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  fs.writeFileSync(out, pdf, { mode: 0o600 });
' "$tmp/input.pdf"

set +e
output="$("$BWRAP_BIN" \
  --die-with-parent \
  --new-session \
  --unshare-user \
  --unshare-pid \
  --unshare-net \
  --unshare-ipc \
  --unshare-uts \
  --unshare-cgroup-try \
  --cap-drop ALL \
  --clearenv \
  --setenv NAPI_RS_ENFORCE_VERSION_CHECK 1 \
  --ro-bind /usr /usr \
  --ro-bind /lib /lib \
  --ro-bind-try /lib64 /lib64 \
  --dir /runtime \
  --ro-bind "$NODE_DIR" /runtime/node \
  --ro-bind "$NODE_MODULES" /app/node_modules \
  --dir /node_modules \
  --ro-bind-try "$PNPM_STORE" /node_modules/.pnpm \
  --ro-bind-try "$NODE_MODULES/.pnpm" /app/.pnpm \
  --ro-bind "$CHILD_SCRIPT" /app/pdf-inspector-child.mjs \
  --proc /proc \
  --dev /dev \
  --tmpfs /tmp \
  --dir /app \
  --dir /input \
  --ro-bind "$tmp/input.pdf" /input/document.pdf \
  --chdir /tmp \
  -- \
  "$PRLIMIT_BIN" \
  --cpu=5:5 \
  --as=1073741824:1073741824 \
  "--fsize=${MAX_PROTOCOL_OUTPUT_BYTES}:${MAX_PROTOCOL_OUTPUT_BYTES}" \
  --nofile=32:32 \
  --nproc=16:16 \
  --core=0:0 \
  -- \
  "/runtime/node/$NODE_NAME" /app/pdf-inspector-child.mjs /input/document.pdf \
  2>"$tmp/stderr")"
status=$?
set -e
[[ "$status" -eq 0 ]] || fail

"$NODE_BIN" -e '
  const value = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (
    value.status !== "ok" ||
    value.reason !== "text" ||
    value.pdfType !== "TextBased" ||
    value.pageCount !== 1
  ) process.exit(1);
' <<<"$output" || fail

printf 'pdf-inspector-gate: PASS (backtest-only, lopdf %s)\n' "$EXPECTED_LOPDF_VERSION"
