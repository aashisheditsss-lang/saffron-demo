# WhatsApp ordering backend (UAE restaurant MVP)

Node 22.13+ only. No packages to install. The database is SQLite, built into Node.

```bash
cp .env.example .env
npm test
npm start
```

Without WhatsApp keys it runs in **mock mode**. Outgoing messages are saved, and you can see them at `GET /api/dev/outbox`.

## Screens (served by the same server)

| Page | Who uses it | How they get in |
|---|---|---|
| `/menu` | Customer (phone) | The link the WhatsApp bot sends (`?t=`). Without one, Supabase phone login at checkout. |
| `/track?k=` | Customer | The link in the "confirmed" and "on the way" WhatsApp messages. |
| `/staff` | Kitchen, reception, manager | `STAFF_TOKEN` as the password. |
| `/rider` | Riders (phone) | The personal link made in Staff → Riders. Shares GPS while the rider has an order. |

**Notes:**

- Phone GPS and "Use my location" only work over **HTTPS** (or localhost).
- Maps use free OpenStreetMap tiles, which is fine for a pilot. Switch to a paid tile provider before real traffic.

**Try it locally:**

1. Run `npm start`.
2. Send a test WhatsApp message to the bot:
   ```bash
   curl -X POST localhost:8080/webhooks/whatsapp -d '{"entry":[{"changes":[{"value":{"messages":[{"id":"t1","from":"971501234567","type":"text","text":{"body":"2 shawarma"}}]}}]}]}'
   ```
3. Open the menu link shown by `GET /api/dev/outbox`.

## How an order flows

1. **Customer messages us** (or calls, see `/webhooks/missed-call`).
   - The bot replies with a menu link. The link carries a signed token holding their phone number.
   - If the customer typed dishes ("2 shawarma"), the cart comes pre-filled (`&c=`).
   - If the dish isn't on the menu ("orange juice"), the link opens at the closest dish (`&item=`).
2. **Menu page → `POST /api/orders`.** The server re-prices everything, checks the delivery zone and opening hours, and blocks double-taps.
   - Cash or card on delivery → CONFIRMED.
   - Card online → PAYMENT_PENDING, then the payment page (mock for now).
3. **Kitchen and reception** use the `/api/staff/*` routes: accept with a prep time → ready → assign a rider.
   - Live updates come from `/api/staff/stream`.
4. **Rider app** uses `/api/rider/*`: pick up, send GPS location, deliver.
   - The customer gets "arriving" automatically within 300 m.
5. **Customer gets a WhatsApp message at every step**, plus a live tracking link (`/api/track?k=`). After delivery the bot asks for a 1–5 rating.

**Background checks** (every 30 s):

- unpaid card orders expire after 15 min;
- alert if the kitchen hasn't accepted an order within 3 min;
- alert if a rider's GPS goes quiet for 60 s.

**Bot rules:** allergy questions, complaints and "talk to a person" go to staff, never the bot. While a staff member is in a chat, the bot stays quiet.

## Login: WhatsApp link or Supabase phone OTP

- **Customer came from WhatsApp:** their phone number is already proven. No login is needed.
- **Customer opened the menu from Google Maps or the website:** the frontend logs them in with Supabase phone OTP, then sends `Authorization: Bearer <supabase access_token>`. The backend asks Supabase who owns the token (`/auth/v1/user`) and only accepts **confirmed** phone numbers.

**To set up Supabase:**

1. Create a Supabase project. Put `SUPABASE_URL` and `SUPABASE_ANON_KEY` in `.env`.
2. In Supabase, go to Authentication → Providers → Phone and turn it on.
3. Choose an SMS provider (Twilio, MessageBird, Vonage or Textlocal) and paste its keys there. Supabase does not send SMS itself.
4. **UAE SMS rules:** messages to UAE numbers usually need a registered sender ID. Ask your SMS provider to register one; this can take days to weeks.
   - Cheaper option: Supabase's "Send SMS" auth hook can send the code over **WhatsApp** instead, using a Meta *authentication* template.
5. Set OTP expiry and rate limits under Authentication → Rate limits, to block SMS-cost abuse.

Staff and riders use simple tokens for now (`STAFF_TOKEN`, and a per-rider token from `POST /api/staff/riders`). They can move to Supabase login later.

## Going live checklist

Step-by-step pilot launch (hosting, domain, Meta setup): see [DEPLOY.md](DEPLOY.md).

- **Meta / WhatsApp:**
  - Verified Business Manager, a WhatsApp number, and a permanent token.
  - Webhook URL `https://<your-domain>/webhooks/whatsapp` with your `WA_VERIFY_TOKEN`.
  - Subscribe to `messages`.
- **An approved utility template** with one `{{1}}` parameter (`WA_UPDATE_TEMPLATE`). It is used for updates sent more than 24 h after the customer's last message.
- **A real card payment provider** in place of `payments.js` (mock). Card orders are switched off in production until then.
- **HTTPS hosting** with a persistent disk for `data.db`. Back the file up daily.
- **Secrets:** set `NODE_ENV=production` and strong `APP_SECRET` / `STAFF_TOKEN` values. The server refuses to start with the dev defaults.
