#!/bin/bash
# Generate self-signed TLS certificate for HTTPS access from other devices on the network.
# Certs are stored in certs/ (gitignored).

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CERT_DIR="$PROJECT_DIR/certs"

mkdir -p "$CERT_DIR"

HOSTNAME=$(hostname)

openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/key.pem" \
  -out "$CERT_DIR/cert.pem" \
  -days 365 \
  -subj "/CN=${HOSTNAME}" \
  -addext "subjectAltName=DNS:${HOSTNAME},DNS:${HOSTNAME}.local,DNS:localhost,IP:127.0.0.1"

echo "Certificate generated in $CERT_DIR"
echo "  CN: ${HOSTNAME}"
echo "  SANs: ${HOSTNAME}, ${HOSTNAME}.local, localhost, 127.0.0.1"
echo "  Valid for 365 days"
