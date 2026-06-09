#!/usr/bin/env bash
# =============================================================================
# Configure MySQL on the DB host (default 10.127.1.23) for access from the
# app host ONLY (default 10.127.1.70). Run with: sudo bash setup-mysql-lan.sh
#
# Hardened vs the original:
#   - Binds MySQL to the DB host's LAN IP, NOT 0.0.0.0.
#   - Grants only to the app host's IP (+ localhost for admin), NOT a wildcard '%'.
#   - Opens the firewall only FROM the app host, not to the world.
#   - Reads the DB password from the environment (MEET_DB_PASSWORD) or prompts;
#     never hardcodes it and never echoes it.
# =============================================================================
set -euo pipefail

DB_HOST_IP="${DB_HOST_IP:-10.127.1.23}"     # interface MySQL should bind to
APP_HOST_IP="${APP_HOST_IP:-10.127.1.70}"   # the only remote host allowed to connect
DB_NAME="${DB_NAME:-meetclone}"
DB_USER="${DB_USER:-meetuser}"
DB_PASSWORD="${MEET_DB_PASSWORD:-}"

if [[ -z "${DB_PASSWORD}" ]]; then
  read -r -s -p "MySQL password for ${DB_USER}: " DB_PASSWORD; echo
fi
if [[ -z "${DB_PASSWORD}" ]]; then
  echo "No password provided; aborting." >&2; exit 1
fi

echo "[1/4] Binding MySQL to ${DB_HOST_IP} (not 0.0.0.0)..."
sed -i \
  -e "s/^bind-address\s*=.*/bind-address\t\t= ${DB_HOST_IP}/" \
  -e "s/^mysqlx-bind-address\s*=.*/mysqlx-bind-address\t= ${DB_HOST_IP}/" \
  /etc/mysql/mysql.conf.d/mysqld.cnf
echo "      Done."

echo "[2/4] Restarting MySQL..."
systemctl restart mysql
echo "      Done."

echo "[3/4] Granting ${DB_USER} from ${APP_HOST_IP} only (+ localhost for admin)..."
mysql <<SQL
CREATE USER IF NOT EXISTS '${DB_USER}'@'${APP_HOST_IP}' IDENTIFIED BY '${DB_PASSWORD}';
ALTER USER '${DB_USER}'@'${APP_HOST_IP}' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'${APP_HOST_IP}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASSWORD}';
GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO '${DB_USER}'@'localhost';
-- Remove the insecure wildcard grant if it exists:
DROP USER IF EXISTS '${DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL
echo "      Done."

echo "[4/4] Restricting firewall: allow 3306 only from ${APP_HOST_IP}..."
if command -v ufw &>/dev/null && ufw status | grep -q "Status: active"; then
  ufw delete allow 3306/tcp 2>/dev/null || true
  ufw allow from "${APP_HOST_IP}" to any port 3306 proto tcp comment "MySQL: app host only"
  ufw reload
  echo "      ufw rule scoped to ${APP_HOST_IP}."
else
  echo "      ufw not active; add an iptables rule allowing 3306 only from ${APP_HOST_IP}."
fi

echo ""
echo "Done. MySQL bound to ${DB_HOST_IP}:3306, reachable only by ${APP_HOST_IP} (+ localhost)."
