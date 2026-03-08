#!/bin/bash

# IMAP/SMTP Email Skill Setup Helper

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if npm dependencies are installed
check_dependencies() {
  if [ -d "node_modules" ]; then
    return 0
  fi
  return 1
}

# Function to install npm dependencies
install_dependencies() {
  echo -e "${YELLOW}📦 Installing npm dependencies...${NC}"
  if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗ npm is not installed or not in PATH${NC}"
    echo "Please install Node.js and npm first: https://nodejs.org/"
    return 1
  fi

  if npm install; then
    echo -e "${GREEN}✓ Dependencies installed successfully${NC}"
    return 0
  else
    echo -e "${RED}✗ Failed to install dependencies${NC}"
    return 1
  fi
}

# Check and install dependencies if needed
if ! check_dependencies; then
  if ! install_dependencies; then
    exit 1
  fi
fi

echo "================================"
echo "  IMAP/SMTP Email Skill Setup"
echo "================================"
echo ""
echo "This script will help you create a .env file with your email credentials."
echo ""

# Prompt for email provider
echo "Select your email provider:"
echo "  1) Gmail"
echo "  2) Outlook"
echo "  3) 163.com"
echo "  4) vip.163.com"
echo "  5) 126.com"
echo "  6) vip.126.com"
echo "  7) 188.com"
echo "  8) vip.188.com"
echo "  9) yeah.net"
echo " 10) QQ Mail"
echo " 11) Custom"
echo ""
read -p "Enter choice (1-11): " PROVIDER_CHOICE

case $PROVIDER_CHOICE in
  1)
    IMAP_HOST="imap.gmail.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.gmail.com"
    SMTP_PORT="587"
    SMTP_SECURE="false"
    IMAP_TLS="true"
    ;;
  2)
    IMAP_HOST="outlook.office365.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.office365.com"
    SMTP_PORT="587"
    SMTP_SECURE="false"
    IMAP_TLS="true"
    ;;
  3)
    IMAP_HOST="imap.163.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.163.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  4)
    IMAP_HOST="imap.vip.163.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.vip.163.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  5)
    IMAP_HOST="imap.126.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.126.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  6)
    IMAP_HOST="imap.vip.126.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.vip.126.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  7)
    IMAP_HOST="imap.188.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.188.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  8)
    IMAP_HOST="imap.vip.188.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.vip.188.com"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  9)
    IMAP_HOST="imap.yeah.net"
    IMAP_PORT="993"
    SMTP_HOST="smtp.yeah.net"
    SMTP_PORT="465"
    SMTP_SECURE="true"
    IMAP_TLS="true"
    ;;
  10)
    IMAP_HOST="imap.qq.com"
    IMAP_PORT="993"
    SMTP_HOST="smtp.qq.com"
    SMTP_PORT="587"
    SMTP_SECURE="false"
    IMAP_TLS="true"
    ;;
  11)
    read -p "IMAP Host: " IMAP_HOST
    read -p "IMAP Port: " IMAP_PORT
    read -p "SMTP Host: " SMTP_HOST
    read -p "SMTP Port: " SMTP_PORT
    read -p "Use TLS for IMAP? (true/false): " IMAP_TLS
    read -p "Use SSL for SMTP? (true/false): " SMTP_SECURE
    ;;
  *)
    echo "Invalid choice"
    exit 1
    ;;
esac

echo ""
read -p "Email address: " EMAIL
read -s -p "Password / App Password / Authorization Code: " PASSWORD
echo ""
if [ -z "$REJECT_UNAUTHORIZED" ]; then
  read -p "Accept self-signed certificates? (y/n): " ACCEPT_CERT
  if [ "$ACCEPT_CERT" = "y" ]; then
    REJECT_UNAUTHORIZED="false"
  else
    REJECT_UNAUTHORIZED="true"
  fi
fi

# Create .env file
cat > .env << EOF
# IMAP Configuration
IMAP_HOST=$IMAP_HOST
IMAP_PORT=$IMAP_PORT
IMAP_USER=$EMAIL
IMAP_PASS=$PASSWORD
IMAP_TLS=$IMAP_TLS
IMAP_REJECT_UNAUTHORIZED=$REJECT_UNAUTHORIZED
IMAP_MAILBOX=INBOX

# SMTP Configuration
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_SECURE=$SMTP_SECURE
SMTP_USER=$EMAIL
SMTP_PASS=$PASSWORD
SMTP_FROM=$EMAIL
SMTP_REJECT_UNAUTHORIZED=$REJECT_UNAUTHORIZED
EOF

echo ""
echo "✅ Created .env file"
echo ""
echo "Testing connections..."
echo ""

# Test IMAP connection
echo "Testing IMAP..."
if node scripts/imap.js list-mailboxes >/dev/null 2>&1; then
    echo "✅ IMAP connection successful!"
else
    echo "❌ IMAP connection test failed"
    echo "   Please check your credentials and settings"
fi

# Test SMTP connection
echo ""
echo "Testing SMTP..."
if node scripts/smtp.js test >/dev/null 2>&1; then
    echo "✅ SMTP connection successful!"
else
    echo "❌ SMTP connection test failed"
    echo "   Please check your credentials and settings"
fi

echo ""
echo "Setup complete! Try:"
echo "  node scripts/imap.js check"
echo "  node scripts/smtp.js send --to recipient@example.com --subject Test --body 'Hello World'"
