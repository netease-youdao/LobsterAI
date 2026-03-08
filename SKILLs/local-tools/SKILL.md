---
name: local-tools
description: Access local system resources including Calendar on macOS and Windows. Use this skill when you need to manage user's schedule directly on their device.
official: true
---

# Local Tools Skill

## When to Use This Skill

Use the local-tools skill when you need to:

- **Calendar Management** - View, create, update, or delete calendar events

**Examples of when to use:**
- User: "Show me my schedule for tomorrow"
- User: "Create a meeting at 3 PM"
- User: "Search for calendar events containing 'project'"
- User: "Delete tomorrow's meeting"

## How It Works

```
┌──────────┐    Bash/PowerShell    ┌─────────────────────────────────────────────────────────────┐
│  Claude  │──────────────────────▶│  calendar.sh / calendar.ps1                                 │
│          │                       │  ├─ macOS: osascript -l JavaScript (JXA) ──▶ Calendar.app   │
│          │                       │  └─ Windows: PowerShell ──▶ Outlook COM API                 │
└──────────┘                       └─────────────────────────────────────────────────────────────┘
```

**Architecture:**
1. **CLI Scripts** - Platform-specific scripts, no HTTP server needed
   - `calendar.sh` - Bash script for macOS
   - `calendar.ps1` - PowerShell script for Windows

2. **Local Calendar Access** - Direct access to system calendar
   - macOS: Uses JXA (JavaScript for Automation) to control Calendar.app
   - Windows: Uses PowerShell COM API to control Microsoft Outlook

3. **JSON Output** - Structured data format for easy parsing

## Platform Support

| Platform | Implementation | Calendar App | Status |
|----------|---------------|--------------|--------|
| **macOS 10.10+** | JXA + Calendar.app | Calendar.app | ✅ Fully Supported |
| **Windows 7+** | PowerShell + COM | Microsoft Outlook | ✅ Fully Supported |
| **Linux** | - | - | ❌ Not Supported |

## Permissions

### macOS
- Requires "Calendar" access permission
- User will be prompted on first use
- Can be managed in: System Settings > Privacy & Security > Calendar

### Windows
- Requires Microsoft Outlook to be installed
- May require administrative privileges for COM access

## Calendar Operations

**IMPORTANT: How to Locate the Script**

When you read this SKILL.md file using the Read tool, you receive its absolute path (e.g., `/Users/username/.../SKILLs/local-tools/SKILL.md`).

**To construct the script path:**
1. Take the directory of this SKILL.md file
2. Append `/scripts/calendar.sh` (macOS) or `/scripts/calendar.ps1` (Windows)

**Example:**
```bash
# If SKILL.md is at: /Users/username/path/to/SKILLs/local-tools/SKILL.md
# Then the script is: /Users/username/path/to/SKILLs/local-tools/scripts/calendar.sh

bash "/Users/username/path/to/SKILLs/local-tools/scripts/calendar.sh" <operation> [options]
```

In all examples below, `<skill-dir>/scripts/calendar.sh` is a placeholder. Replace it with the actual absolute path.

### Best Practices for AI Assistant

**DO:**
- ✅ Execute commands directly without showing trial-and-error process
- ✅ If command fails, inform user about permission issues without showing technical errors
- ✅ Use `search` command for searching birthdays/anniversaries
- ✅ If no calendar name specified, script will automatically use first available calendar

**DON'T:**
- ❌ Don't repeatedly try different command combinations
- ❌ Don't show error stacks or technical details to users
- ❌ Don't read script source code to analyze issues
- ❌ Don't ask users for calendar name, use default behavior

**Example - Searching for birthdays:**
```bash
# Correct approach: Search directly, don't trial-and-error
bash "<skill-dir>/scripts/calendar.sh" search --query "birthday"

# If permission error returned, directly tell user:
# "Calendar access permission is required. Please open System Settings > Privacy & Security > Calendar, and authorize Terminal or LobsterAI"
```

### List Events

```bash
# List events for next 7 days (default)
bash "<skill-dir>/scripts/calendar.sh" list

# List events for specific date range
bash "<skill-dir>/scripts/calendar.sh" list \
  --start "2026-02-12T00:00:00" \
  --end "2026-02-19T23:59:59"

# List events from specific calendar (macOS)
bash "<skill-dir>/scripts/calendar.sh" list \
  --calendar "Work"
```

### Create Event

```bash
# Create a simple event
bash "<skill-dir>/scripts/calendar.sh" create \
  --title "Team Meeting" \
  --start "2026-02-13T14:00:00" \
  --end "2026-02-13T15:00:00"

# Create event with location and notes
bash "<skill-dir>/scripts/calendar.sh" create \
  --title "Client Call" \
  --start "2026-02-14T10:00:00" \
  --end "2026-02-14T11:00:00" \
  --calendar "Work" \
  --location "Conference Room A" \
  --notes "Discuss Q1 roadmap"
```

### Update Event

```bash
# Update event title
bash "<skill-dir>/scripts/calendar.sh" update \
  --id "EVENT-ID" \
  --title "Updated Meeting Title"

# Update event time
bash "<skill-dir>/scripts/calendar.sh" update \
  --id "EVENT-ID" \
  --start "2026-02-13T15:00:00" \
  --end "2026-02-13T16:00:00"
```

### Delete Event

```bash
bash "<skill-dir>/scripts/calendar.sh" delete \
  --id "EVENT-ID"
```

### Search Events

```bash
# Search for events containing keyword (searches ALL calendars)
bash "<skill-dir>/scripts/calendar.sh" search \
  --query "meeting"

# Search in specific calendar only
bash "<skill-dir>/scripts/calendar.sh" search \
  --query "project" \
  --calendar "Work"
```

**Note:** When `--calendar` is not specified, the search operation will look through **all available calendars** on both macOS and Windows.

## Output Format

All commands return JSON with the following structure:

### Success Response

```json
{
  "success": true,
  "data": {
    "events": [
      {
        "eventId": "E621F8C4-...",
        "title": "Team Meeting",
        "startTime": "2026-02-13T14:00:00.000Z",
        "endTime": "2026-02-13T15:00:00.000Z",
        "location": "Conference Room",
        "notes": "Weekly sync",
        "calendar": "Work",
        "allDay": false
      }
    ],
    "count": 1
  }
}
```

### Error Response

```json
{
  "success": false,
  "error": {
    "code": "CALENDAR_ACCESS_ERROR",
    "message": "Calendar access permission is required...",
    "recoverable": true,
    "permissionRequired": true
  }
}
```

### Error Codes

| Code | Meaning | Recoverable |
|------|---------|-------------|
| `CALENDAR_ACCESS_ERROR` | Permission denied or calendar not accessible | Yes |
| `INVALID_INPUT` | Missing required parameters | No |
| `EVENT_NOT_FOUND` | Event ID not found | No |
| `OUTLOOK_NOT_AVAILABLE` | Microsoft Outlook not installed (Windows) | Yes |

## Date Format Guidelines

### Important: Date Format Guidelines

When using the `list` command with time ranges:

1. **Always use ISO 8601 format**: `YYYY-MM-DDTHH:mm:ss`
2. **Use local timezone**: Do NOT use UTC or timezone suffixes (like +08:00 or Z)
3. **Calculate dates yourself**: Do NOT use shell command substitution like `$(date ...)`
4. **Claude should compute dates**: Based on current date, calculate target dates directly
5. **Examples**:
   - Today at midnight: `2026-02-13T00:00:00`
   - Today at end of day: `2026-02-13T23:59:59`
   - Tomorrow morning: `2026-02-14T09:00:00`
   - Next week Monday: `2026-02-16T00:00:00`

**Why**: The script expects local time strings that match your system timezone. Shell substitutions may not execute correctly in all environments.

## Common Patterns

### Pattern 1: Schedule Management

```bash
# User asks: "What meetings do I have today?"
# Claude's approach: Calculate today's date and query full day from 00:00 to 23:59
# IMPORTANT: Claude should replace 2026-02-13 with the actual current date
bash "<skill-dir>/scripts/calendar.sh" list \
  --start "2026-02-13T00:00:00" \
  --end "2026-02-13T23:59:59"

# User asks: "What's on my schedule tomorrow?"
# Claude should calculate tomorrow's date (e.g., if today is 2026-02-13, tomorrow is 2026-02-14)
bash "<skill-dir>/scripts/calendar.sh" list \
  --start "2026-02-14T00:00:00" \
  --end "2026-02-14T23:59:59"
```

### Pattern 2: Meeting Scheduling

```bash
# User asks: "Schedule a meeting for tomorrow at 3 PM"
# Claude's approach:
bash "<skill-dir>/scripts/calendar.sh" create \
  --title "Meeting" \
  --start "2026-02-13T15:00:00" \
  --end "2026-02-13T16:00:00" \
  --calendar "Work"
```

### Pattern 3: Event Search

```bash
# User asks: "Find all meetings about the project"
# Claude's approach:
bash "<skill-dir>/scripts/calendar.sh" search \
  --query "project" \
  --calendar "Work"
```

### Pattern 4: Availability Check

```bash
# User asks: "Am I free tomorrow afternoon?"
# Claude's approach:
# 1. List tomorrow's events
# 2. Analyze time slots
# 3. Report availability
bash "<skill-dir>/scripts/calendar.sh" list \
  --start "2026-02-14T00:00:00" \
  --end "2026-02-14T23:59:59"
```

## Known Behaviors

### Time Range Matching

The `list` command uses **interval overlap detection**:
- Returns events that have **any overlap** with the query time range
- Does NOT require events to be fully contained within the range

**Examples:**
- Query: 2026-02-13 00:00:00 to 23:59:59
- Returns:
  - ✅ Events fully on Feb 13 (e.g., 10:00-11:00)
  - ✅ Multi-day events spanning Feb 13 (e.g., Feb 12 10:00 - Feb 14 10:00)
  - ✅ Events crossing midnight (e.g., Feb 13 23:30 - Feb 14 00:30)
  - ❌ Events entirely before Feb 13 (e.g., Feb 12 10:00-11:00)
  - ❌ Events entirely after Feb 13 (e.g., Feb 14 10:00-11:00)

### All-Day Events

- Treated as spanning from 00:00:00 to 23:59:59 on their date(s)
- Multi-day all-day events (e.g., Feb 12-14) will appear when querying any date within that range

### Time Precision

- Comparisons use second-level precision
- Milliseconds are ignored in date comparisons

### Recurring Events

- Each occurrence is treated as a separate event instance
- The script returns individual occurrences within the queried time range

## Best Practices

### 1. Always Check Before Creating

Before creating an event, list existing events to avoid conflicts:

```bash
# First check existing events
bash "<skill-dir>/scripts/calendar.sh" list

# Then create if no conflict
bash "<skill-dir>/scripts/calendar.sh" create ...
```

### 2. Use Specific Calendars (macOS)

Specify the calendar to keep events organized:

```bash
bash "<skill-dir>/scripts/calendar.sh" create \
  --title "Team Meeting" \
  --calendar "Work" \
  ...
```

### 3. Search Before Updating/Deleting

Always search first to get the correct event ID:

```bash
# Search to find event ID
bash "<skill-dir>/scripts/calendar.sh" search --query "meeting"

# Then update or delete
bash "<skill-dir>/scripts/calendar.sh" update --id "FOUND-ID" ...
```

### 4. Handle Errors Gracefully

Parse the response and handle errors:

```bash
result=$(bash "<skill-dir>/scripts/calendar.sh" list)
if echo "$result" | grep -q '"success":true'; then
  # Process events
  events=$(echo "$result" | jq '.data.events')
else
  # Handle error
  error=$(echo "$result" | jq '.error.message')
  echo "Failed: $error"
fi
```

## Limitations

### macOS
- Requires macOS 10.10 Yosemite or later (for JXA support)
- Requires Calendar access permission
- Does not support advanced recurring event queries
- Cannot modify recurring event rules

### Windows
- Requires Microsoft Outlook to be installed
- Does not support other calendar applications (Windows Calendar, Google Calendar, etc.)
- May require COM access permissions in corporate environments
- Folder enumeration may skip restricted calendars

### General
- All dates must be in ISO 8601 format (`YYYY-MM-DDTHH:mm:ss`)
- Uses local timezone for all operations
- Return values are converted to UTC (ISO 8601 with Z suffix)
- No support for attendees or meeting invitations

## Troubleshooting

### macOS

**Permission Denied:**
```
Error: Calendar access permission is required
```
**Solution:** Open System Settings > Privacy & Security > Calendar, authorize Terminal or LobsterAI

**Script Not Found:**
```
bash: calendar.sh: No such file or directory
```
**Solution:** Ensure you're using the absolute path from SKILL.md's directory + `/scripts/calendar.sh`

### Windows

**Outlook Not Found:**
```
Error: Microsoft Outlook is not installed or not accessible
```
**Solution:** Install Microsoft Outlook and ensure it's properly configured

**PowerShell Execution Policy:**
```
Error: Execution of scripts is disabled on this system
```
**Solution:** Run PowerShell as Administrator and execute:
```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

## Technical Details

### macOS Implementation

**JXA (JavaScript for Automation):**
- Uses `osascript -l JavaScript` to execute JXA code
- Controls Calendar.app via Apple Events
- Works on both Intel and Apple Silicon Macs
- Requires user permission for Calendar access

**Date Handling:**
- Uses BSD date command (macOS native)
- Format: `date +%Y-%m-%dT%H:%M:%S` (local timezone)
- Relative dates: `date -v+7d` (7 days from now)

### Windows Implementation

**PowerShell + COM:**
- Uses Outlook COM API via PowerShell
- Requires Outlook to be installed and configured
- Works with all Outlook-compatible calendars

**Date Handling:**
- Uses PowerShell `[DateTime]::Parse()` for date parsing
- Automatically handles local timezone

### Cross-Platform Consistency

Both implementations:
- Use identical JSON output format
- Support the same operations (list, create, update, delete, search)
- Handle dates in local timezone
- Return UTC timestamps in ISO 8601 format

## Related Skills

- **imap-smtp-email** - For email-based meeting invitations
- **scheduled-task** - For recurring calendar synchronization
