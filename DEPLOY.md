# Pilot launch guide

**Goal:** one restaurant takes real WhatsApp orders, paid by cash or card machine on delivery, for 2–4 weeks.

**Already done in the code:** Dockerfile, Render config (`render.yaml`), clean shutdown on restarts, and production safety checks:
- the server won't start with default passwords;
- test-only routes are off;
- the fake card payment is off.

The steps below need **your accounts**, so you do them. Steps 1–2 take about an hour. Meta (step 4) can take a few days because of business verification, so **start step 4 first**.

---

## 1. Put your real menu in before the first deploy
- Edit `src/menu-seed.js`: names (EN/AR), prices in AED, descriptions, tags, add-ons, and the typo keywords (`kw`).
- Put the restaurant's own photos in `public/img/` and replace the stock photos.
- The menu is only loaded into an **empty** database. After launch, use the Staff → Menu tab for sold-out items. Changing prices later needs a small admin step; ask for it when you need it.

## 2. Hosting on Render (about USD 7–10 per month)
1. Create a **private** GitHub repository and push this `backend` folder to it.
2. Go to render.com → **New → Blueprint** → pick the repository. It reads `render.yaml`, which sets up:
   - a web service in Frankfurt;
   - a 1 GB disk for the database;
   - random `APP_SECRET`, `STAFF_TOKEN` and `WA_VERIFY_TOKEN` values.
3. Fill in the empty settings it asks for: `PUBLIC_URL`, `SHOP_NAME`, `SHOP_LAT`, `SHOP_LNG`, `TRN`. Add the WhatsApp ones after step 4.
4. **Domain:** in Render, open Settings → Custom domain, then add `order.<your-domain>`. At your domain registrar, add the CNAME record Render shows. Render sets up HTTPS automatically.
   - HTTPS is required: rider GPS and "Use my location" only work over HTTPS.
5. Set `PUBLIC_URL` to that `https://` address and redeploy.
6. **Check it:** `https://order.<your-domain>/health` should show `"ok":true`.

## 3. Staff and riders
- **Kitchen / reception tablet:** open `/staff` and log in with `STAFF_TOKEN` (copy it from Render → Environment). Turn the tablet's sound on, because new orders beep.
- **Riders:** go to Staff → Riders → Add rider, then send each rider their personal link on WhatsApp. Riders must allow location on their phone.

## 4. WhatsApp (Meta). Start this first.
1. **Meta Business portfolio:** create one at business.facebook.com and complete **business verification**. You need the trade licence, and it can take a few days.
2. **Developer app:** at developers.facebook.com, create an app (type **Business**) and add the **WhatsApp** product.
3. **Phone number:** add the restaurant's number.
   - A number that is already on the WhatsApp Business **app** must be moved over or deleted there first.
   - Or use a new number.
4. **Permanent token:** in Business settings → System users, create a system user. Give it the WhatsApp account and generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`. Paste these into Render:
   - the token → `WA_TOKEN`;
   - the phone number ID → `WA_PHONE_NUMBER_ID`;
   - App settings → Basic → App secret → `WA_APP_SECRET`.
5. **Webhook:** in WhatsApp → Configuration, set:
   - Callback URL: `https://order.<your-domain>/webhooks/whatsapp`
   - Verify token: the `WA_VERIFY_TOKEN` value from Render.

   Then subscribe to **messages**.
6. **Template**, for order updates sent more than 24 h after the customer's last message:
   - Create a **Utility** template, for example named `order_update`, in English, with the body `Update on your order: {{1}}`.
   - Once approved, set `WA_UPDATE_TEMPLATE=order_update`.
7. **Check it:** send "hi" to the number from your own phone. You should get the menu link back. `/health` should show `"whatsapp":"live"`.

## 5. Point customers to WhatsApp
- **Google Business Profile:** set the order / website link to `https://wa.me/971XXXXXXXXX?text=Hi` (your number without + or spaces).
- **Missed calls (optional):** if your phone provider can call a webhook, point it to `/webhooks/missed-call` and set `MISSED_CALL_SECRET`.

## 6. Before real customers: 5 test orders by the team
Run each of these once:
- Delivery, cash.
- Delivery, card machine.
- Pickup.
- An item marked sold out.
- An allergy question, to check it reaches the Chats tab.

Check every WhatsApp message arrives, the tracking map moves, and the Today tab totals match the cash the rider hands in.

## Optional: Supabase phone login
This is only for customers who open `/menu` without WhatsApp. See README → "Login". Leave `SUPABASE_*` empty to skip it for the pilot.

---

## Known pilot limits
- **No online card payment.** Customers pay cash or by card machine. Online payment needs a UAE payment provider (Network International, Checkout.com or Stripe) connected first.
- **One restaurant**, one shared staff password, and one server.
- **SQLite on one disk.** Fine for hundreds of orders a day. Turn on Render's disk snapshots, and download a copy of `/data/data.db` weekly.
- **No request rate limiting** yet. Add it before advertising the menu link widely.
- **Maps** use free OpenStreetMap tiles. Switch to a paid tile provider if traffic grows.
