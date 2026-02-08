export const guide = {
  title: 'Telegram Notifications Setup',
  content: `
TELEGRAM NOTIFICATIONS SETUP
=============================

Receive Planbot notifications directly in Telegram. This guide walks you
through creating a bot and configuring Planbot to send updates.

STEP 1: CREATE A BOT VIA @BotFather
------------------------------------
1. Open Telegram and search for @BotFather (official Telegram bot)

2. Start a chat and send:
   /newbot

3. Follow the prompts:
   - Bot display name: "My Planbot" (or any name you prefer)
   - Bot username: must end in "bot" (e.g., my_planbot_bot)

4. BotFather will respond with your bot token:
   Example: 123456789:ABCdefGHIjklMNOpqrsTUVwxyz

   ⚠️  SAVE THIS TOKEN SECURELY - treat it like a password!

STEP 2: GET YOUR CHAT ID
-------------------------
1. Send any message to your new bot in Telegram
   (search for your bot username and start a chat)

2. Visit this URL in your browser (replace <TOKEN> with your bot token):
   https://api.telegram.org/bot<TOKEN>/getUpdates

3. Look for the "chat" object in the JSON response:
   {
     "chat": {
       "id": 123456789,
       ...
     }
   }

4. Save this chat ID number (e.g., 123456789)

STEP 3: CONFIGURE PLANBOT
--------------------------
Edit your tickets.yaml file and add messaging configuration:

\`\`\`yaml
config:
  model: sonnet
  planMode: true
  messaging:
    provider: telegram
    botToken: \${TELEGRAM_BOT_TOKEN}
    chatId: "123456789"           # Use your chat ID (as string)
\`\`\`

STEP 4: SET ENVIRONMENT VARIABLE
---------------------------------
Add your bot token to .env file:

\`\`\`
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
\`\`\`

⚠️  IMPORTANT: Add .env to .gitignore to avoid committing secrets!

STEP 5: TEST YOUR CONFIGURATION
--------------------------------
Run validation to ensure everything is configured correctly:

  $ planbot validate

If validation passes, start Planbot and watch for notifications:

  $ planbot start

You should receive Telegram messages when:
- Tickets start processing
- Plans are ready for approval
- Claude asks questions
- Tickets complete or fail

TROUBLESHOOTING
---------------
Problem: No messages received
- Verify bot token is correct in .env
- Confirm you sent a message to the bot first
- Check that chatId matches your Telegram chat ID
- Ensure chatId is quoted as a string in YAML

Problem: "Unauthorized" error
- Bot token may be invalid or revoked
- Create a new bot via @BotFather if needed

Problem: Messages sent to wrong chat
- Double-check the chat ID from getUpdates API
- Make sure you're using YOUR chat ID, not someone else's

SECURITY NOTES
--------------
- Never share your bot token publicly
- Never commit .env file to version control
- Regenerate bot token if accidentally exposed (via @BotFather)
- Consider using a dedicated bot per project/environment
`,
};
