#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only|-o)
      if [[ $# -lt 2 ]]; then
        echo "Укажите значение для $1" >&2
        exit 1
      fi
      ONLY="$2"
      shift 2
      ;;
    *)
      echo "Неизвестный аргумент: $1" >&2
      echo "Использование: ./run.sh [--only раздел]" >&2
      exit 1
      ;;
  esac
done

load_dotenv() {
  local file="$1" line key value existing
  [[ -f "$file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" != *=* ]] && continue

    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"

    if [[ ${#value} -ge 2 ]]; then
      if [[ "$value" == \"*\" ]]; then
        value="${value:1:${#value}-2}"
      elif [[ "$value" == \'*\' ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi

    existing=""
    if declare -p "$key" >/dev/null 2>&1; then
      existing="${!key}"
    fi
    if [[ -z "${existing// }" ]]; then
      printf -v "$key" '%s' "$value"
      export "$key"
    fi
  done < "$file"
}

if [[ ! -d "$ROOT/node_modules" ]]; then
  echo "Installing Playwright..."
  npm install --prefix "$ROOT"
fi

load_dotenv "$ROOT/.env"

if [[ -z "${EMIAS_URL:-}" || -z "${EMIAS_CODE:-}" ]]; then
  echo "В .env не заданы EMIAS_URL и/или EMIAS_CODE. Сценарий запросит их при запуске." >&2
fi

if [[ -n "$ONLY" ]]; then
  export EMIAS_ONLY="$ONLY"
fi

npm start --prefix "$ROOT"
