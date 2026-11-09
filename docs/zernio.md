# Connect Instagram with Zernio

Zernio is an **optional paid connection provider and sponsor of OpenReply**. It manages the Instagram connection, platform credentials, API calls, and incoming events so you do not need to create and review your own Meta app. OpenReply stays self-hosted and continues to run campaigns, keyword matching, follow gates, queues, retries, logs, link tracking, and the inbox.

[Explore Zernio](https://zernio.com/?utm_source=openreply&utm_medium=sponsorship&utm_campaign=openreply-integration&utm_content=provider-guide) · [Check pricing](https://zernio.com/pricing?utm_source=openreply&utm_medium=sponsorship&utm_campaign=openreply-integration&utm_content=provider-guide-pricing) · [Use your own Meta app instead](setup.md#the-meta-app)

## Before connecting

- Deploy your OpenReply web app and always-on worker. Configure PostgreSQL, Redis, email sign-in, and the shared environment variables in [setup.md](setup.md#environment-variables).
- Use the same `ENCRYPTION_KEY` on the web app and worker. Provider credentials are encrypted at rest.
- Set `NEXTAUTH_URL` to the public HTTPS URL of your deployment. Zernio must be able to reach its webhook endpoint.
- Have a Zernio account with the access needed for Instagram and Inbox, and an existing Zernio profile to use with the workspace.
- Use an Instagram Business or Creator account. Instagram’s permissions, messaging windows, rate limits, and platform policies still apply.

You do **not** need the direct Meta environment variables (`INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`) for Zernio accounts. Keep them if you also use direct Meta accounts.

## Connect from Settings

1. Sign in to OpenReply as the workspace **owner or admin** and open **Settings**.
2. Create an **unrestricted read/write Zernio API key with Inbox access** in Zernio, then save it in the Zernio connection section. A profile-restricted or read-only key will not work for this integration. OpenReply saves it encrypted and does not return the saved key to the browser.
3. Select an **existing Zernio profile** for the workspace. OpenReply registers its own signed webhook automatically. Do not manually replace webhooks used by other integrations.
4. Select an existing Instagram account from that profile and import it. Or use the Zernio connection flow to authorize a new Instagram account, return to Settings, and import it into OpenReply.
5. Create your campaign **in OpenReply**. Do not create a matching automation in Zernio, which could send duplicate replies.
6. Comment a test keyword from a different Instagram account. Confirm the private reply arrives and appears as sent in OpenReply’s DM Logs.

There is one saved Zernio connection and selected profile per workspace. Existing direct Meta accounts stay direct Meta; this integration does not migrate providers. An account already connected elsewhere or through the other provider cannot be silently imported over that connection.

## Feature availability

| Feature | Zernio behavior |
| --- | --- |
| Campaigns, keywords, public replies, private replies, DM buttons | Run through OpenReply, with API calls sent through Zernio. Platform constraints still apply. |
| Incoming comments, DMs, and follow-gate postbacks | Delivered through OpenReply’s signed Zernio webhook subscription and processed by its campaign queue. |
| Post picker | Shows the **latest 25 posts**. Older posts are not available through this picker. |
| Post reporting and analytics | Require Zernio’s **analytics add-on** and synced data. Missing data is not evidence of zero activity. |
| Follower count snapshots | Can be **up to 24 hours old**. They are reporting snapshots, not live follower checks. |
| Follow gate | Standalone DM and Story campaigns release a gated reply only after a verified follow. Existing comment campaigns keep their previous behavior. |
| Inbox | Opening conversations and sending replies are supported. A preview is omitted when the API does not provide message direction; this does not mean the thread is empty. |
| Token refresh | Zernio handles its platform credentials. OpenReply’s direct Meta token refresh does not run on Zernio accounts. |

## DM keyword and Story reply campaigns

On a Zernio account, choose **DM keyword** to reply to an incoming message containing a keyword, or **Story reply** to match text replies to all Stories or a selected Story. You can match any text or specific keywords for Story replies. A Story reply arrives through the inbox, so its text can also match a DM keyword campaign. Each campaign applies its own cooldown and schedule. Story mentions and attachment-only messages do not count as text Story replies.

The Story picker uses [Zernio’s active Story list](https://docs.zernio.com/instagram/list-instagram-stories). Instagram only lists live Stories within their 24-hour lifetime, excludes live video and reshares, and may withhold media previews. If the webhook omits Story context, OpenReply looks up the exact message in [Zernio’s inbox](https://docs.zernio.com/messages/get-inbox-conversation-messages). A selected Story requires a matching Story ID from one of those sources. Automated replies still use the standard [Instagram messaging window and permissions](https://docs.zernio.com/platforms/instagram). When **follow first** is on, an unavailable or negative follow check keeps the reply locked. The confirmation button rechecks the relationship and only unlocks that person’s reply after a positive result.

The per-person cooldown starts when the campaign starts sending its reply or follow prompt. Enter zero to allow each distinct matching message. The schedule accepts an optional start and end in Europe/Rome, or a duration that begins on enablement. At expiration the campaign pauses and sends that have not begun stop, including delayed follow-ups. Saving edits does not restart an expired campaign. Enable it again to start a fresh duration, or set a new end time before enabling a fixed schedule.

## Operations and troubleshooting

Check `/api/health` first. A working webhook does not deliver DMs on its own: the background worker must be healthy and connected to Redis and PostgreSQL. Check DM Logs for delivery failures, `WebhookEvent` for incoming delivery, and `OperationalEvent` for worker errors.

If connection setup fails, check that the API key is unrestricted, read/write, and has Inbox access; that the selected profile belongs to the key’s account; and that your instance is publicly reachable over HTTPS. Keep the web app and worker’s encryption keys identical.

If you change your public deployment URL, update `NEXTAUTH_URL` on both processes and reconfigure the Zernio connection so its webhook targets the new URL. Check delivery again before relying on campaigns.

Disconnecting an account from OpenReply does **not** delete it from Zernio. Manage the upstream account in Zernio separately. There is no automatic migration between Zernio and direct Meta.

Sponsorship appears only in OpenReply’s project and interface surfaces. OpenReply does not append Zernio branding or promotional text to customer messages.

### Delivery uncertainty and retries

If Zernio times out or returns an ambiguous send response, OpenReply marks the delivery unconfirmed and avoids automatically sending it again. Inspect the Instagram inbox before retrying manually. Public replies and private DMs track their outcomes independently. Durable postback receipts distinguish a replayed event from a new button tap, including after queue history expires; these receipts also survive a worker restart during delivery.

Deploy the database migrations (`npm run db:migrate`) before starting the updated web app and worker. The integration adds provider/connection storage, independent delivery-uncertainty flags, and durable postback receipts. Existing Instagram accounts default to the direct Meta provider.
