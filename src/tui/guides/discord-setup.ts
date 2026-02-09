export const guide = {
  title: 'Discord Notifications Setup',
  content: `
DISCORD NOTIFICATIONS SETUP
============================

Receive Planbot notifications in a Discord channel. This guide covers
creating a bot, configuring permissions, and integration.

STEP 1: CREATE A DISCORD APPLICATION
-------------------------------------
1. Visit: https://discord.com/developers/applications

2. Click "New Application"

3. Enter application name: "Planbot" (or your preference)

4. Accept Terms of Service

5. Click "Create"

STEP 2: CREATE A BOT USER
--------------------------
1. In your application, navigate to: Bot (left sidebar)

2. Click "Add Bot"

3. Confirm by clicking "Yes, do it!"

4. Configure bot settings:
   - Public Bot: Toggle OFF (recommended for private use)
   - Require OAuth2 Code Grant: Leave OFF

5. Under "Privileged Gateway Intents" (if needed):
   - Message Content Intent: Enable if bot needs to read messages

6. Click "Reset Token" to reveal bot token

7. Save the token (appears once):
   Example: MTAwNTg4MjU2ODc4OTQ1MjgxMA.GxYZ12.AbC3DeF4...

   ⚠️  SAVE SECURELY - treat as a password!

STEP 3: INVITE BOT TO YOUR SERVER
----------------------------------
1. Navigate to: OAuth2 → URL Generator (left sidebar)

2. Under "Scopes", select:
   - bot

3. Under "Bot Permissions", select:
   - Send Messages
   - Read Messages/View Channels
   - Read Message History (optional)

4. Copy the generated URL at bottom of page

5. Paste URL in browser and:
   - Select your target server from dropdown
   - Click "Authorize"
   - Complete captcha if prompted

6. Verify bot appears in server member list

STEP 4: GET CHANNEL ID
-----------------------
1. Enable Developer Mode in Discord:
   - User Settings → Advanced → Developer Mode (toggle ON)

2. Right-click on your target channel

3. Click "Copy ID"

4. Save the channel ID:
   Example: 123456789012345678

STEP 5: CONFIGURE PLANBOT
--------------------------
Edit your tickets.yaml file:

\`\`\`yaml
config:
  model: sonnet
  planMode: true
  messaging:
    provider: discord
    botToken: \${DISCORD_BOT_TOKEN}
    channelId: "123456789012345678"    # Your channel ID (as string)
\`\`\`

STEP 6: SET ENVIRONMENT VARIABLE
---------------------------------
Add to .env file:

\`\`\`
DISCORD_BOT_TOKEN=MTAwNTg4MjU2ODc4OTQ1MjgxMA.GxYZ12.AbC3DeF4...
\`\`\`

⚠️  IMPORTANT: Add .env to .gitignore!

STEP 7: TEST CONFIGURATION
---------------------------
Validate setup:

  $ planbot validate

Start Planbot:

  $ planbot start

Expected Discord notifications:
- Ticket processing started
- Plan ready for approval
- Questions from Claude
- Completion or failure status

CHANNEL PERMISSIONS CHECK
--------------------------
Ensure bot has permissions in target channel:

1. Right-click channel → Edit Channel

2. Navigate to: Permissions

3. Add bot role or @Planbot user

4. Enable:
   - View Channel
   - Send Messages
   - Read Message History

5. Save Changes

TROUBLESHOOTING
---------------
Problem: No messages appear
- Verify bot is in the server (check member list)
- Confirm channelId is correct (right-click → Copy ID)
- Check bot has Send Messages permission in channel
- Ensure channelId is quoted as string in YAML

Problem: "Invalid token" error
- Bot token may be incorrect or regenerated
- Copy token again from Discord Developer Portal
- Ensure no extra spaces in .env file

Problem: "Missing Access" error
- Bot lacks permission to view or send in channel
- Add bot to channel permissions explicitly
- Check server-level role permissions

Problem: Bot offline in server
- Token may be invalid
- Bot may have been removed from server
- Re-invite bot using OAuth2 URL

SECURITY NOTES
--------------
- Never share bot token publicly
- Never commit .env to version control
- Regenerate token if exposed (Bot tab → Reset Token)
- Use separate bots for dev/staging/production
- Disable "Public Bot" toggle for private projects
- Review bot permissions regularly (minimum required only)

ADVANCED: WEBHOOK ALTERNATIVE
------------------------------
If you prefer webhook-based notifications (no bot):

1. Right-click channel → Edit Channel → Integrations

2. Create Webhook → Name it "Planbot"

3. Copy webhook URL

4. Configure in tickets.yaml:
   \`\`\`yaml
   messaging:
     provider: discord-webhook
     webhookUrl: \${DISCORD_WEBHOOK_URL}
   \`\`\`

Note: Webhooks are one-way (send only), cannot receive approvals.
`,
};
