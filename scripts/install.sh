#!/bin/sh
# Installs or updates Wheatley (@wheatley-ai/cli) for the current user.
#
#   curl -fsSL https://raw.githubusercontent.com/SphericalKat/wheatley/main/scripts/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/SphericalKat/wheatley/main/scripts/install.sh | sh -s -- --version 0.2.0
#
# A rerun upgrades an existing install in place, so every step must be safe to repeat.
set -eu

PACKAGE="@wheatley-ai/cli"
# The lowest host Node.js version that Wheatley supports (`engines.node` in packages/wheatley/package.json).
MIN_NODE_VERSION="26.13.1"
# The Node.js release that the installer downloads if the host Node.js is missing or too old.
MANAGED_NODE_VERSION="26.13.1"

DOCS_URL="https://sphericalkat.github.io/wheatley/"

MUTED=""
CYAN_BRIGHT=""
CYAN=""
BLUE=""
NC=""
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  ESC=$(printf '\033')
  MUTED="${ESC}[0;2m"
  CYAN_BRIGHT="${ESC}[0;96m"
  CYAN="${ESC}[0;36m"
  BLUE="${ESC}[0;34m"
  NC="${ESC}[0m"
fi

ERR_RED=""
ERR_NC=""
if [ -t 2 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  ESC=$(printf '\033')
  ERR_RED="${ESC}[0;31m"
  ERR_NC="${ESC}[0m"
fi

say() {
  printf '%s\n' "$*"
}

fail() {
  printf '%sError: %s%s\n' "$ERR_RED" "$*" "$ERR_NC" >&2
  exit 1
}

print_banner() {
  printf '\n'
  printf '%s█   █ █   █ █████  ███  █████ █     █████ █   █%s\n' "$CYAN_BRIGHT" "$NC"
  printf '%s█   █ █   █ █     █   █   █   █     █      █ █ %s\n' "$CYAN_BRIGHT" "$NC"
  printf '%s█ █ █ █████ ████  █████   █   █     ████    █  %s\n' "$CYAN" "$NC"
  printf '%s██ ██ █   █ █     █   █   █   █     █       █  %s\n' "$CYAN" "$NC"
  printf '%s█   █ █   █ █████ █   █   █   █████ █████   █  %s\n' "$BLUE" "$NC"
  printf '\n'
  printf '%sTo start:%s\n' "$MUTED" "$NC"
  printf '\n'
  printf 'wheatley init  %s# Configure your model and provider%s\n' "$MUTED" "$NC"
  printf 'wheatley       %s# Start chatting%s\n' "$MUTED" "$NC"
  printf '\n'
  printf '%sFor more information visit %s%s\n' "$MUTED" "$NC" "$DOCS_URL"
  printf '\n'
}

usage() {
  cat <<'EOF'
Install Wheatley (@wheatley-ai/cli) for the current user.

Usage: install.sh [--version <version>] [--no-modify-path]

Options:
  --version <version>  Install this release. The default is the latest release on npm.
  --no-modify-path     Do not add the wheatley command folder to PATH in a shell profile.
  -h, --help           Show this help.

Environment:
  XDG_DATA_HOME         App and Node.js runtime go in $XDG_DATA_HOME/wheatley (default ~/.local/share).
  XDG_BIN_HOME          The wheatley command goes in this folder (default ~/.local/bin).
  npm_config_registry   The npm registry (default https://registry.npmjs.org).
  WHEATLEY_NODE_MIRROR  The Node.js download site (default https://nodejs.org/dist).
  WHEATLEY_PACKAGE_SPEC Install this npm package spec (for example a .tgz from pnpm pack) instead of a release.
EOF
}

version=""
modify_path=1

while [ "$#" -gt 0 ]; do
  case $1 in
    --version)
      [ "$#" -ge 2 ] || fail "--version needs a value"
      version=$2
      shift 2
      ;;
    --version=*)
      version=${1#--version=}
      shift
      ;;
    --no-modify-path)
      modify_path=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1 (run with --help for usage)"
      ;;
  esac
done

version=${version#v}

[ -n "${HOME:-}" ] || fail "HOME is not set"

data_home=${XDG_DATA_HOME:-$HOME/.local/share}
bin_home=${XDG_BIN_HOME:-$HOME/.local/bin}
app_dir=$data_home/wheatley/app
runtime_dir=$data_home/wheatley/runtime
registry=${npm_config_registry:-https://registry.npmjs.org}
registry=${registry%/}
node_mirror=${WHEATLEY_NODE_MIRROR:-https://nodejs.org/dist}
node_mirror=${node_mirror%/}

scratch=""

cleanup() {
  if [ -n "$scratch" ]; then
    rm -rf "$scratch"
  fi
}

trap cleanup EXIT
trap 'exit 1' INT TERM

for tool in curl tar uname mktemp sed awk; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required but not installed"
done

fetch() {
  curl --fail --silent --show-error --location --output "$2" "$1" || fail "download failed: $1"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "sha256sum or shasum is required to verify the Node.js download"
  fi
}

# Succeeds if version $1 is at least version $2. Both have the form X.Y.Z. A suffix after Z is ignored.
version_at_least() {
  left=$1
  right=$2
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 # Field splitting on "." is intended.
  set -- $left
  l1=${1:-0} l2=${2:-0} l3=${3:-0}
  # shellcheck disable=SC2086
  set -- $right
  r1=${1:-0} r2=${2:-0} r3=${3:-0}
  IFS=$old_ifs
  l3=${l3%%[!0-9]*}
  r3=${r3%%[!0-9]*}

  for part in "$l1" "$l2" "${l3:-0}" "$r1" "$r2" "${r3:-0}"; do
    case $part in
      '' | *[!0-9]*) return 1 ;;
    esac
  done

  [ "$l1" -gt "$r1" ] && return 0
  [ "$l1" -lt "$r1" ] && return 1
  [ "$l2" -gt "$r2" ] && return 0
  [ "$l2" -lt "$r2" ] && return 1
  [ "${l3:-0}" -ge "${r3:-0}" ]
}

node_bin=""
npm_bin=""

# Selects the host Node.js and its npm if Node.js is new enough. Prints the reason and fails otherwise.
use_host_node() {
  if ! command -v node >/dev/null 2>&1; then
    say "${MUTED}Node.js is not installed. Downloading Node.js ${NC}${MANAGED_NODE_VERSION}${MUTED}...${NC}"
    return 1
  fi

  host_version=$(node --version 2>/dev/null) || host_version=""
  host_version=${host_version#v}

  if ! version_at_least "$host_version" "$MIN_NODE_VERSION"; then
    say "${MUTED}Host Node.js ${NC}${host_version:-unknown}${MUTED} is older than ${MIN_NODE_VERSION}. Downloading Node.js ${NC}${MANAGED_NODE_VERSION}${MUTED}...${NC}"
    return 1
  fi

  # Shims of version managers (for example fnm or nvm) can point at a temporary folder. The real binary path is stable.
  resolved_node=$(node -p 'process.execPath') || return 1
  node_dir=$(dirname "$resolved_node")

  if [ -x "$node_dir/npm" ]; then
    npm_bin=$node_dir/npm
  elif command -v npm >/dev/null 2>&1; then
    npm_bin=$(command -v npm)
  else
    say "${MUTED}Host Node.js ${NC}${host_version}${MUTED} has no npm. Downloading Node.js ${NC}${MANAGED_NODE_VERSION}${MUTED}...${NC}"
    return 1
  fi

  node_bin=$resolved_node
  say "${MUTED}Using host Node.js ${NC}${host_version} ${MUTED}(${node_bin})${NC}"
}

is_musl() {
  [ -f /etc/alpine-release ] && return 0

  for loader in /lib/ld-musl-*; do
    [ -e "$loader" ] && return 0
  done

  ldd --version 2>&1 | grep -qi musl
}

detect_platform() {
  case $(uname -s) in
    Linux) node_os=linux ;;
    Darwin) node_os=darwin ;;
    *) fail "unsupported operating system: $(uname -s). Install Node.js $MIN_NODE_VERSION or newer. Then run the installer again." ;;
  esac

  case $(uname -m) in
    x86_64 | amd64) node_arch=x64 ;;
    aarch64 | arm64) node_arch=arm64 ;;
    *) fail "unsupported CPU architecture: $(uname -m). Install Node.js $MIN_NODE_VERSION or newer. Then run the installer again." ;;
  esac

  if [ "$node_os" = linux ] && is_musl; then
    fail "this system uses musl libc (for example Alpine Linux). Node.js publishes no official musl builds. Install Node.js $MIN_NODE_VERSION or newer with the system package manager (for example apk add nodejs npm). Then run the installer again. As an alternative, use the Docker image ghcr.io/sphericalkat/wheatley."
  fi
}

# Downloads and verifies the managed Node.js runtime unless it is already present, then selects it.
use_managed_node() {
  detect_platform
  name=node-v$MANAGED_NODE_VERSION-$node_os-$node_arch
  archive=$name.tar.gz
  target=$runtime_dir/node-v$MANAGED_NODE_VERSION

  if [ -x "$target/bin/node" ]; then
    say "${MUTED}Using Node.js ${NC}${MANAGED_NODE_VERSION} ${MUTED}(${target})${NC}"
  else
    mkdir -p "$runtime_dir"
    # The download and extraction stay in a temporary folder next to the target, so the final rename is atomic.
    scratch=$(mktemp -d "$runtime_dir/.download.XXXXXX")
    say "${MUTED}Downloading Node.js ${NC}${MANAGED_NODE_VERSION} ${MUTED}(${node_os}-${node_arch})...${NC}"
    fetch "$node_mirror/v$MANAGED_NODE_VERSION/$archive" "$scratch/$archive"
    fetch "$node_mirror/v$MANAGED_NODE_VERSION/SHASUMS256.txt" "$scratch/SHASUMS256.txt"

    expected=$(awk -v file="$archive" '$2 == file { print $1 }' "$scratch/SHASUMS256.txt")
    [ -n "$expected" ] || fail "SHASUMS256.txt has no checksum for $archive"
    actual=$(sha256_of "$scratch/$archive")
    [ "$expected" = "$actual" ] || fail "checksum mismatch for $archive: expected $expected, got $actual"

    tar -xzf "$scratch/$archive" -C "$scratch"
    [ -x "$scratch/$name/bin/node" ] || fail "$archive has no bin/node"

    if ! "$scratch/$name/bin/node" --version >/dev/null 2>"$scratch/node-check.log"; then
      cat "$scratch/node-check.log" >&2
      if grep -q 'libatomic' "$scratch/node-check.log"; then
        fail "Node.js $MANAGED_NODE_VERSION needs libatomic. Install it, for example with apt-get install libatomic1 or dnf install libatomic. Then run the installer again."
      fi
      fail "the downloaded Node.js $MANAGED_NODE_VERSION does not run on this system"
    fi

    rm -rf "$target"
    mv "$scratch/$name" "$target"
    rm -rf "$scratch"
    scratch=""
    say "${MUTED}Installed Node.js ${NC}${MANAGED_NODE_VERSION} ${MUTED}in ${target}${NC}"
  fi

  node_bin=$target/bin/node
  npm_bin=$target/bin/npm
}

if ! use_host_node; then
  use_managed_node
fi

node_path_dir=$(dirname "$node_bin")

spec=${WHEATLEY_PACKAGE_SPEC:-}

if [ -n "$spec" ]; then
  [ -z "$version" ] || fail "--version and WHEATLEY_PACKAGE_SPEC cannot be used together"
  # npm runs in the app folder, so a relative tarball path must become absolute first.
  if [ -f "$spec" ]; then
    case $spec in
      /*) ;;
      *) spec=$(pwd)/$spec ;;
    esac
  fi
else
  if [ -z "$version" ]; then
    latest_json=$(curl --fail --silent --show-error --location "$registry/@wheatley-ai%2Fcli/latest") ||
      fail "cannot read the latest release from $registry"
    version=$(printf '%s' "$latest_json" | "$node_bin" -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version') ||
      fail "cannot read the version from the registry response"
  fi

  case $version in
    '' | *[!0-9A-Za-z.+-]*) fail "invalid version: $version" ;;
  esac

  spec=$PACKAGE@$version
fi

if [ -n "$version" ]; then
  say "${MUTED}Installing ${NC}wheatley ${MUTED}version: ${NC}${version}"
else
  say "${MUTED}Installing ${NC}wheatley ${MUTED}from: ${NC}${spec}"
fi
mkdir -p "$app_dir"

# The app folder is its own npm project, so npm ignores package.json files (and their devEngines) of the caller.
if [ ! -f "$app_dir/package.json" ]; then
  printf '{\n  "private": true\n}\n' >"$app_dir/package.json"
fi

scratch=$(mktemp "$app_dir/.npm-install.XXXXXX")
if ! (
  cd "$app_dir"
  PATH="$node_path_dir:$PATH" "$npm_bin" install --prefix "$app_dir" --save-exact --omit=dev \
    --no-audit --no-fund --no-update-notifier --loglevel=error "$spec"
) >"$scratch" 2>&1; then
  cat "$scratch" >&2
  fail "npm install $spec failed"
fi
rm -f "$scratch"
scratch=""

entry=$app_dir/node_modules/@wheatley-ai/cli/bin/wheatley.js
[ -f "$entry" ] || fail "npm did not install $entry"

# Prints $1 as a single-quoted shell word.
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

mkdir -p "$bin_home"
shim=$bin_home/wheatley
scratch=$(mktemp "$bin_home/.wheatley.XXXXXX")
{
  printf '#!/bin/sh\n'
  printf '# Written by the Wheatley installer. Rerun the installer to change it.\n'
  printf 'exec %s %s "$@"\n' "$(shell_quote "$node_bin")" "$(shell_quote "$entry")"
} >"$scratch"
chmod 755 "$scratch"
mv -f "$scratch" "$shim"
scratch=""

# Releases up to 0.2.0 have no --version flag, so the smoke check uses --help.
"$shim" --help >/dev/null || fail "the installed wheatley command does not run: $shim --help"
installed=$("$node_bin" -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' \
  "$app_dir/node_modules/@wheatley-ai/cli/package.json") || fail "cannot read the installed version"
say "${MUTED}Installed ${NC}wheatley ${installed} ${MUTED}at ${NC}${shim}"

case ":$PATH:" in
  *":$bin_home:"*)
    print_banner
    exit 0
    ;;
esac

if [ "$modify_path" -eq 0 ]; then
  say "${MUTED}${bin_home} is not on \$PATH. Add it to run wheatley by name.${NC}"
  print_banner
  exit 0
fi

path_line="export PATH=\"$bin_home:\$PATH\""

case $(basename "${SHELL:-sh}") in
  zsh)
    profile=${ZDOTDIR:-$HOME}/.zshrc
    ;;
  bash)
    if [ "$(uname -s)" = Darwin ]; then
      profile=$HOME/.bash_profile
    else
      profile=$HOME/.bashrc
    fi
    ;;
  fish)
    profile=${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/wheatley.fish
    path_line="fish_add_path -g \"$bin_home\""
    ;;
  *)
    profile=$HOME/.profile
    ;;
esac

if [ -f "$profile" ] && grep -qxF "$path_line" "$profile"; then
  say "${MUTED}${profile} already adds ${bin_home} to \$PATH${NC}"
else
  mkdir -p "$(dirname "$profile")"
  printf '\n# Added by the Wheatley installer\n%s\n' "$path_line" >>"$profile"
  say "${MUTED}Successfully added ${NC}wheatley ${MUTED}to \$PATH in ${NC}${profile}"
fi

say "${MUTED}Reload your shell, or run:${NC}"
printf '  %s\n' "$path_line"
print_banner
