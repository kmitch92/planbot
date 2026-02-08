export const guide = {
  title: 'Webhook Server Setup',
  content: `
WEBHOOK SERVER SETUP
====================

Planbot can run an HTTP webhook server for external integrations,
custom UIs, and programmatic control. This guide covers configuration,
endpoints, security, and usage.

WHAT THE WEBHOOK SERVER DOES
-----------------------------
The webhook server enables:

- Programmatic approval/rejection of plans
- Answering Claude's questions remotely
- Querying current processing status
- Integration with CI/CD pipelines
- Building custom approval interfaces
- Remote monitoring and control

BASIC CONFIGURATION
-------------------
Edit tickets.yaml to enable the webhook server:

\`\`\`yaml
config:
  model: sonnet
  planMode: true
  webhook:
    enabled: true
    port: 3847                    # HTTP server port
    path: /planbot/webhook        # Base URL path
    secret: your-shared-secret    # HMAC signature secret
\`\`\`

For production, set secret via environment variable:

\`\`\`yaml
  webhook:
    enabled: true
    secret: \${WEBHOOK_SECRET}
\`\`\`

.env file:
\`\`\`
WEBHOOK_SECRET=generate-a-long-random-string-here
\`\`\`

STARTING THE WEBHOOK SERVER
----------------------------
Run Planbot with webhook server enabled:

  $ planbot serve

Or combine with ticket processing:

  $ planbot start

The server will start on the configured port:
  Webhook server listening on http://localhost:3847

AVAILABLE ENDPOINTS
-------------------

1. APPROVE A PLAN
   POST /planbot/webhook/approve
   Body: { "ticketId": "ticket-001" }

   Response:
   { "success": true, "message": "Plan approved" }

2. REJECT A PLAN
   POST /planbot/webhook/reject
   Body: { "ticketId": "ticket-001", "reason": "Incomplete" }

   Response:
   { "success": true, "message": "Plan rejected" }

3. ANSWER A QUESTION
   POST /planbot/webhook/answer
   Body: { "ticketId": "ticket-001", "answer": "Use TypeScript" }

   Response:
   { "success": true, "message": "Answer submitted" }

4. GET STATUS
   GET /planbot/webhook/status

   Response:
   {
     "currentTicket": "ticket-001",
     "status": "awaiting_approval",
     "queueLength": 3,
     "processedCount": 5
   }

AUTHENTICATION & SECURITY
--------------------------
All POST requests require HMAC-SHA256 signature verification:

1. Set shared secret in config (webhook.secret)

2. Client computes HMAC signature:
   - Hash algorithm: SHA256
   - Secret: webhook.secret value
   - Payload: JSON request body (stringified)

3. Include signature in request header:
   X-Planbot-Signature: <hex-encoded-hmac>

Example (JavaScript):
\`\`\`javascript
const crypto = require('crypto');

const payload = JSON.stringify({ ticketId: 'ticket-001' });
const signature = crypto
  .createHmac('sha256', process.env.WEBHOOK_SECRET)
  .update(payload)
  .digest('hex');

fetch('http://localhost:3847/planbot/webhook/approve', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Planbot-Signature': signature,
  },
  body: payload,
});
\`\`\`

CORS CONFIGURATION (BROWSER CLIENTS)
-------------------------------------
For browser-based UIs, enable CORS:

\`\`\`yaml
config:
  webhook:
    enabled: true
    cors:
      enabled: true
      origin: "https://my-planbot-ui.com"
      methods: ["GET", "POST"]
\`\`\`

For development (localhost):
\`\`\`yaml
    cors:
      enabled: true
      origin: "http://localhost:3000"
\`\`\`

⚠️  WARNING: Never use origin: "*" in production!

EXAMPLE USAGE: CUSTOM APPROVAL UI
----------------------------------
Build a web UI that queries status and approves plans:

1. Frontend polls status endpoint:
   GET /planbot/webhook/status

2. Display current plan to user

3. On approval button click:
   POST /planbot/webhook/approve
   Body: { "ticketId": "<current-ticket-id>" }

4. Planbot resumes execution

EXAMPLE USAGE: CI/CD INTEGRATION
---------------------------------
Auto-approve plans in CI pipeline after tests pass:

\`\`\`bash
#!/bin/bash
# run-tests.sh

npm test

if [ $? -eq 0 ]; then
  curl -X POST http://localhost:3847/planbot/webhook/approve \\
    -H "Content-Type: application/json" \\
    -H "X-Planbot-Signature: $SIGNATURE" \\
    -d '{"ticketId": "'"$TICKET_ID"'"}'
fi
\`\`\`

EXAMPLE USAGE: SLACK SLASH COMMAND
-----------------------------------
Create Slack slash command to approve plans:

1. User types: /approve-plan ticket-001

2. Slack webhook posts to your proxy server

3. Proxy server calls Planbot webhook:
   POST /planbot/webhook/approve

4. Planbot proceeds with execution

SECURITY BEST PRACTICES
------------------------
1. ALWAYS set a strong webhook secret (32+ random chars)

2. NEVER expose webhook server to public internet without:
   - Reverse proxy (nginx, Caddy)
   - HTTPS/TLS encryption
   - Rate limiting
   - IP whitelisting

3. Use environment variables for secrets (never hardcode)

4. Enable CORS only for trusted origins

5. Validate all input on server side

6. Log all webhook requests for audit trail

7. Consider additional authentication layer (API keys, OAuth)

PRODUCTION DEPLOYMENT CHECKLIST
--------------------------------
- [ ] Strong random secret configured
- [ ] Secret stored in environment variable
- [ ] HTTPS enabled (via reverse proxy)
- [ ] CORS restricted to known origins
- [ ] Rate limiting configured
- [ ] Request logging enabled
- [ ] Firewall rules configured
- [ ] Monitoring and alerts set up
- [ ] Webhook endpoints tested
- [ ] Documentation updated with API contract

TROUBLESHOOTING
---------------
Problem: "Invalid signature" error
- Verify secret matches between client and server
- Ensure payload is JSON-stringified before hashing
- Check signature is hex-encoded
- Confirm no extra whitespace in payload

Problem: CORS errors in browser
- Add frontend origin to cors.origin config
- Verify cors.enabled is true
- Check browser console for specific CORS error

Problem: Connection refused
- Verify webhook.enabled is true
- Confirm port is not already in use
- Check firewall rules allow traffic on port
- Ensure server is running (planbot serve)

Problem: "Ticket not found" error
- Verify ticketId exists in tickets.yaml
- Check ticket is in correct state for operation
- Confirm ticket hasn't already completed

MONITORING & LOGGING
--------------------
Webhook server logs all requests:

- Timestamp
- HTTP method and path
- Request headers
- Response status
- Processing time

Enable debug logging for detailed output:

  $ DEBUG=planbot:* planbot serve

Review logs to:
- Audit approval/rejection actions
- Detect authentication failures
- Monitor performance
- Troubleshoot integration issues
`,
};
