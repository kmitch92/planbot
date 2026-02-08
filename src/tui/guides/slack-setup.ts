export const guide = {
  title: 'Slack Notifications Setup',
  content: `
SLACK NOTIFICATIONS SETUP
==========================

Receive Planbot notifications in a Slack channel. This guide covers
creating a Slack app, configuring permissions, and integrating with Planbot.

STEP 1: CREATE A SLACK APP
---------------------------
1. Visit: https://api.slack.com/apps

2. Click "Create New App"

3. Choose "From scratch"

4. Configure:
   - App Name: "Planbot" (or your preferred name)
   - Workspace: Select your target workspace

5. Click "Create App"

STEP 2: CONFIGURE SOCKET MODE (RECOMMENDED)
--------------------------------------------
Socket Mode enables real-time bidirectional communication without
exposing a public webhook endpoint.

1. Navigate to: Settings → Socket Mode

2. Toggle "Enable Socket Mode" to ON

3. Click "Generate an app-level token"
   - Token Name: "Planbot Connection"
   - Scope: connections:write

4. Save the app token (starts with xapp-...)
   Example: xapp-1-A123456789-9876543210-abcdef...

STEP 3: ADD BOT TOKEN SCOPES
-----------------------------
1. Navigate to: OAuth & Permissions → Bot Token Scopes

2. Click "Add an OAuth Scope" and add:
   - chat:write       (Send messages as bot)
   - channels:read    (View public channels)

   Optional scopes for advanced features:
   - chat:write.public    (Post to channels bot isn't in)
   - channels:history     (Read channel messages)

STEP 4: INSTALL APP TO WORKSPACE
---------------------------------
1. Navigate to: Settings → Install App

2. Click "Install to Workspace"

3. Review permissions and click "Allow"

4. Save the Bot User OAuth Token (starts with xoxb-...)
   Example: xoxb-YOUR-BOT-TOKEN-GOES-HERE

STEP 5: INVITE BOT TO CHANNEL
------------------------------
1. Open Slack and navigate to your target channel

2. In the channel, type:
   /invite @Planbot

   (Replace "Planbot" with your app's bot name)

3. Confirm the bot appears in channel members

STEP 6: CONFIGURE PLANBOT
--------------------------
Edit your tickets.yaml file:

\`\`\`yaml
config:
  model: sonnet
  planMode: true
  messaging:
    provider: slack
    botToken: \${SLACK_BOT_TOKEN}
    appToken: \${SLACK_APP_TOKEN}      # Required for Socket Mode
    channel: "#planbot"                # Channel name or ID
\`\`\`

STEP 7: SET ENVIRONMENT VARIABLES
----------------------------------
Add to .env file:

\`\`\`
SLACK_BOT_TOKEN=xoxb-YOUR-BOT-TOKEN-GOES-HERE
SLACK_APP_TOKEN=xapp-YOUR-APP-TOKEN-GOES-HERE
\`\`\`

⚠️  CRITICAL: Add .env to .gitignore immediately!

STEP 8: TEST CONFIGURATION
---------------------------
Validate your setup:

  $ planbot validate

Start Planbot to receive notifications:

  $ planbot start

Expected notifications:
- Ticket processing started
- Plan approval requests
- Question prompts
- Completion/failure alerts

FINDING CHANNEL ID (ALTERNATIVE TO NAME)
-----------------------------------------
If using channel ID instead of name:

1. Open Slack in browser

2. Navigate to target channel

3. Check URL:
   https://app.slack.com/client/T12345678/C98765432
   Channel ID: C98765432

4. Use in tickets.yaml:
   channel: "C98765432"

TROUBLESHOOTING
---------------
Problem: "channel_not_found" error
- Verify bot is invited to channel (/invite @Planbot)
- Check channel name includes # prefix
- Try using channel ID instead of name

Problem: "not_authed" or "invalid_auth" error
- Bot token may be incorrect or expired
- Verify token starts with xoxb-
- Reinstall app to workspace to refresh token

Problem: Messages not appearing
- Ensure chat:write scope is added
- Check bot is installed to correct workspace
- Verify channel exists and bot has access

Problem: Socket Mode connection fails
- Confirm Socket Mode is enabled
- Verify app token has connections:write scope
- Check appToken environment variable is set

SECURITY NOTES
--------------
- Never commit tokens to version control
- Rotate tokens if accidentally exposed (reinstall app)
- Use workspace-specific apps for production
- Consider restricting app permissions to minimum required scopes
- Review Slack audit logs periodically
`,
};
