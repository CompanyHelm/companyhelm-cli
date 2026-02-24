function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const CODEX_APP_SERVER_STDIN_LISTEN_FLAG = "--listen stdio://";
const CODEX_YOLO_FLAG = "--dangerously-bypass-approvals-and-sandbox";

export function buildNvmCodexBootstrapScript(homeDirectory?: string): string {
  const lines = [
    "set -euo pipefail",
  ];

  if (homeDirectory) {
    lines.push(`export HOME=${shellQuote(homeDirectory)}`);
  }

  lines.push(
    'if [ -z "${NVM_DIR:-}" ] || [ ! -s "$NVM_DIR/nvm.sh" ]; then',
    '  for candidate in "/usr/local/nvm" "$HOME/.nvm" "/opt/nvm" "/root/.nvm"; do',
    '    if [ -s "$candidate/nvm.sh" ]; then',
    '      export NVM_DIR="$candidate"',
    "      break",
    "    fi",
    "  done",
    "fi",
    'if [ -z "${NVM_DIR:-}" ] || [ ! -s "$NVM_DIR/nvm.sh" ]; then',
    '  echo "nvm is not configured: unable to locate nvm.sh." >&2',
    "  exit 1",
    "fi",
    '. "$NVM_DIR/nvm.sh"',
    'nvm use --silent default >/dev/null 2>&1 || true',
    'if ! command -v codex >/dev/null 2>&1; then',
    '  echo "codex command is not available after sourcing nvm." >&2',
    "  exit 1",
    "fi",
  );

  return lines.join("\n");
}

export function buildCodexAppServerCommand(homeDirectory?: string): string {
  const bootstrap = buildNvmCodexBootstrapScript(homeDirectory);
  return `${bootstrap}\ncodex ${CODEX_YOLO_FLAG} app-server ${CODEX_APP_SERVER_STDIN_LISTEN_FLAG}`;
}
