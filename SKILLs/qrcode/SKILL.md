---
name: qrcode
description: Generate QR codes for URLs, text, WiFi credentials, vCards, and more. Use when user wants to create a QR code for sharing links, connecting to WiFi, or encoding contact information.
official: true
version: 1.0.0
---

# QR Code Generator Skill

## When to Use This Skill

Use this skill when the user asks:

- "Generate a QR code for..."
- "Create a QR code for this URL"
- "Make a QR code for WiFi"
- "Generate QR code for contact info/vCard"
- "Encode this text into a QR code"

## How It Works

This skill uses free QR code APIs to generate QR code images. The generated QR code is saved to a file and can be displayed or shared.

### API Endpoints

We use the `qrcode` npm package or public APIs:

```bash
# Option 1: Using npx (no install needed)
npx qrcode "https://example.com" -o qr.png

# Option 2: Using public API
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https://example.com" -o qr.png
```

## Generate Basic QR Code

### From URL

```bash
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https://example.com" -o /tmp/qr-example.png
```

### From Text

```bash
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=Hello%20World" -o /tmp/qr-text.png
```

## Generate WiFi QR Code

Format: `WIFI:T:WPA;S:networkName;P:password;;`

```bash
# Example: WiFi network "MyNetwork" with password "secret123"
WIFI_STRING="WIFI:T:WPA;S:MyNetwork;P:secret123;;"
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$WIFI_STRING'))")
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$ENCODED" -o /tmp/qr-wifi.png
```

### WiFi QR Code Parameters

| Parameter | Value | Description |
|-----------|-------|-------------|
| T | WPA/WEP/nopass | WiFi security type |
| S | network_name | SSID (network name) |
| P | password | WiFi password |
| H | true/false | Hidden network |

## Generate vCard QR Code

Format for contact info:

```bash
VCARD="BEGIN:VCARD
VERSION:3.0
FN:John Doe
TEL:+1234567890
EMAIL:john@example.com
URL:https://example.com
END:VCARD"

ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$VCARD'''))")
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$ENCODED" -o /tmp/qr-contact.png
```

## Customization Options

### Size

```bash
# Small (150x150)
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=https://example.com" -o qr.png

# Medium (300x300)
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https://example.com" -o qr.png

# Large (500x500)
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=500x500&data=https://example.com" -o qr.png
```

### Color

```bash
# Black on white (default)
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https://example.com&color=black" -o qr.png

# Red on white
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https://example.com&color=red" -o qr.png

# With background color
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https://example.com&bgcolor=yellow" -o qr.png
```

### Format (for API that supports it)

```bash
# PNG (default)
# JPG
# SVG (vector)
```

## Error Handling

### Network Error

If curl fails:
```
Error: Failed to download QR code. Check your internet connection.
```

### Invalid Data

If data is too long for QR code:
```
Error: Data too long to encode as QR code. Try a shorter URL or text.
```

### Rate Limiting

If API returns error:
```
Error: API rate limited. Wait a moment and try again.
```

## Usage Examples

### Example 1: Generate URL QR Code

**User:** "Generate a QR code for my website https://example.com"

```bash
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=https://example.com" -o /tmp/my-website-qr.png
echo "QR code saved to /tmp/my-website-qr.png"
```

**Output:** QR code image file

### Example 2: WiFi Network

**User:** "Create a QR code for my WiFi network 'HomeWiFi' with password 'secretpass'"

```bash
WIFI_STRING="WIFI:T:WPA;S:HomeWiFi;P:secretpass;;"
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$WIFI_STRING'))")
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$ENCODED" -o /tmp/wifi-qr.png
```

### Example 3: Phone Number

**User:** "Make a QR code that when scanned adds a contact with phone +1234567890"

```bash
DATA="TEL:+1234567890"
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$DATA'))")
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$ENCODED" -o /tmp/phone-qr.png
```

### Example 4: SMS

**User:** "QR code for SMS to 1234567890 with message 'Hello'"

```bash
DATA="SMSTO:1234567890:Hello"
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$DATA'))")
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$ENCODED" -o /tmp/sms-qr.png
```

### Example 5: Email

**User:** "QR code for emailing to test@example.com"

```bash
DATA="mailto:test@example.com"
ENCODED=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$DATA'))")
curl -s "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=$ENCODED" -o /tmp/email-qr.png
```

## Best Practices

1. **Use appropriate size** - 300x300 is usually good for scanning
2. **Test before sharing** - Verify QR code works with user's phone
3. **Consider color contrast** - Ensure good contrast for reliable scanning
4. **Keep data short** - Shorter URLs/text work better
5. **Use URL shorteners** - For long URLs, suggest using a URL shortener first

## Limitations

1. **Data length** - QR codes have limited capacity
2. **Internet required** - API call needed to generate
3. **No editing** - Generated QR cannot be edited, must regenerate
4. **No tracking** - Cannot track who scanned

## Quick Reference

| Type | Format | Example |
|------|--------|---------|
| URL | raw URL | `https://example.com` |
| WiFi | `WIFI:T:WPA;S:SSID;P:password;;` | `WIFI:T:WPA;S:MyWiFi;P:pass;;` |
| Phone | `TEL:+number` | `TEL:+1234567890` |
| SMS | `SMSTO:number:message` | `SMSTO:123456:Hello` |
| Email | `mailto:email` | `mailto:test@example.com` |
| vCard | VCARD format | See example above |

## Security Considerations

1. **Be careful with WiFi passwords** - QR codes can be easily scanned by anyone
2. **Don't encode sensitive data** - QR codes are not encrypted
3. **Use temporary files** - Clean up generated QR images after use
