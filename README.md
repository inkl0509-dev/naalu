# 🚤 Naalu — cargo receipts for local boats

A phone app for local goods-carrying boats. Crew record each parcel, box, motorcycle, car or load of building materials, collect the money, and send the receipt to the customer on **WhatsApp or Viber**. All amounts are in **MVR**.

## Features
- **Receive cargo**: sender name and phone, receiver name and phone, and the island to send to. Phone numbers you have used before fill in the name automatically, and islands come from a saved list.
- **Rates you set once** (🏷️ Rates tab). Four ways to price:
  - **Per kg**, e.g. Box MVR 5/kg. Type the weight and the amount is calculated.
  - **Per piece**, e.g. Motorcycle MVR 300, Cement bag MVR 15.
  - **Per CBM (cubic metre)**, e.g. Furniture MVR 400/CBM. Type length × width × height in **cm, inch, feet or metre** plus the number of pieces. The app works out the CBM (120×80×100 cm × 2 = 1.92 CBM) and the price.
  - **By size**, e.g. Water tank: 500L = MVR 150, 1000L = MVR 250. Tap the size, then enter pieces.
  - **Minimum charge** (optional) for any rate, e.g. at least MVR 20.
  - **Other item**: any description and a fixed price, e.g. a car.
  - CBM is optional. Use it only for the rates or items where you want it.
- **Payment**: Cash, Transfer, **Card**, or **Not paid** (the receiver pays when collecting). Unpaid cargo can be marked paid later by cash, transfer or card.
- **Tax (GST) invoice**: tick **Tax invoice** on a receipt, or make every receipt a tax invoice in Settings. The invoice shows "TAX INVOICE", your registered name and TIN, the customer's TIN (optional), the taxable value, **GST 8%** and the total. In Settings you choose whether your prices **already include GST** or GST is **added on top**. The rate can be changed.
- **Voyages**: tap **+ New** on the Receive screen to start a voyage, e.g. "Voyage 12 · Malé → Thinadhoo · 21-11-2026". New cargo on **all crew phones** goes to that voyage. Accounts → **By voyage** shows that trip's billed amount, cash, transfer, card, unpaid, GST, kg, CBM, expenses (fuel, crew) and profit. You can **close** a voyage when the trip is finished. The Cargo tab can filter by voyage.
- **ދިވެހި / English**: tap the **ދިވެހި** button at the top to switch the **Receive, Rates and Settings** screens to Dhivehi. Each phone remembers its own choice.
- **Faruma font**: all Dhivehi text uses **Faruma**, including labels, names typed in Dhivehi, receipts and the tracking page. Add your font file as `fonts/faruma.ttf` (see `fonts/README.txt`). Without it, phones that have Faruma installed still use it, and others use the free Noto Sans Thaana font.
- **Receipt footer**: Settings has two ready-made thank-you messages to choose from, one in English and one in Dhivehi.
- **Receipt**: send it to the **sender or receiver** on WhatsApp or Viber, print it, or print **box labels** showing the receiver, island, phone, "1 / 5", PAID or COLLECT, and a barcode.
- **Cargo tab**: search by name, phone, island or receipt number, and filter by **Received / On boat / Delivered / Not paid**. Tap a receipt to change its status.
- **Accounts**: **by date** (Today, Yesterday, 7 days, This month, your own dates) or **by voyage**. Shows total billed, cash, transfer, card, not paid yet, GST, kg and CBM carried, totals by island, expenses and profit. Downloads a CSV file for Excel (opens correctly with Dhivehi names).
- **📍 Boat location**: on the Receive screen, one crew member taps **📍 Share location**. That phone sends the boat's GPS position about once a minute, or sooner if the boat moves more than 300 m, and keeps its screen on. Tap **🗺 Map** to see it.
- **🌐 Customer tracking portal** (`track.html`): every receipt sent on WhatsApp or Viber includes a **tracking link**, and the sender and receiver each get their own link. Customers can also open the page and type their **receipt number + last 4 digits of their phone**. They see:
  - status: Received → On the way → Delivered, with times
  - route and voyage, and the **boat on a live map** while the cargo is on the way
  - items, pieces, weight and CBM
  - **amount to pay** or "Paid"
  - Call / WhatsApp buttons for the boat
  - Customers see only short names (e.g. "Ahmed N.") and never full phone numbers, other receipts, or the boat's accounts.
- **Works offline at sea**: receipts save on the phone and sync when the signal returns.
- **Many boats**: the admin (**iirufan@gmail.com**) creates a boat and gets a code. Crew join with the code. **Boats can never see each other's cargo or money**, and the admin cannot see it either. This is enforced by Firebase security rules on the server.

## Setup

### 1. Firebase (make a NEW project just for Naalu)
1. Go to https://console.firebase.google.com and click **Add project**, e.g. "naalu".
2. Open **Authentication → Get started** and turn on **Email/Password**.
3. Open **Firestore Database → Create database** and choose **Production mode**.
4. In **Firestore → Rules**, paste everything from `firestore.rules` and click **Publish**.
5. Open **Project settings → Your apps → Web (</>)** and register an app. Copy the config into `firebase-config.js`.

The free Spark plan is enough. Storage is not needed.

### 2. GitHub
```bash
git init
git add .
git commit -m "Naalu"
git branch -M main
git remote add origin https://github.com/YOUR_NAME/naalu.git
git push -u origin main
```

### 3. Vercel
1. Go to https://vercel.com, click **Add New → Project** and import `naalu`. Set Framework to **Other** with no build command, then click **Deploy**.
2. In Firebase, open **Authentication → Settings → Authorized domains** and add your Vercel domain, e.g. `naalu.vercel.app`.

### 4. Admin login (one time)
1. Open the app and press **Create new account** with `iirufan@gmail.com`.
2. Press **Send verification link**, tap the link in Gmail, then press **I clicked the link ✔**.
3. On the Admin screen, type a boat name and press **+ Create**, then **Share code** to send it on WhatsApp to the boat owner.

### 5. On each crew phone
1. Open the link in Chrome or Safari and choose **Add to Home screen**.
2. Create an account, enter the boat code, and you're in.
3. First go to **🏷️ Rates** and add your prices, then **⚙️ Settings** for the boat name and phone.

## Boat location: what to know
- It works from the **browser on a phone on board**. Keep Naalu **open on screen** and the phone **plugged into power**. Phones stop sending GPS from web apps when the screen is off or another app is in front. The app asks the phone to keep the screen on while sharing.
- At sea with no signal, positions can't be sent. Customers see "last updated X min ago", and the position updates when the signal comes back.
- Only **one phone per boat** needs to share. If two phones share, the latest one wins.
- For tracking **24/7 without a phone**, a small **GPS tracker device** (SIM-card type) or **AIS** is more reliable. Naalu could be connected to one later.

## Notes
- **Viber**: Viber doesn't let apps fill in a message for a specific number. The app **copies the receipt** and opens that person's Viber chat, where you **paste** it (long-press → Paste). If no phone number was entered, Viber opens a "share to" list instead.
- **WhatsApp**: the message opens ready to send. You only press send.
- Phone numbers: type the 7-digit number (e.g. 7771234). The app adds 960 automatically.
- **Tax invoices**: the layout follows the usual GST invoice details (TAX INVOICE, your name and TIN, invoice number, date, customer, taxable value, GST and total). Confirm with MIRA or your accountant that it meets your exact requirements before relying on it.
- **Upgrading from the first version**: paste the new `firestore.rules` into Firebase again. Old receipts keep working.
- Box labels print best on A4 or a label printer. Choose how many labels when asked.

## Data layout (Firestore)
```
admins/{userId}                 → extra admins (optional, added by hand)
codes/{CODE}                    → boatId (secret join codes)
users/{userId}                  → boatId this phone belongs to
boats/{boatId}                  → name, phone, footer, islands[], code, active, tin, gstRate, currentVoyageId
boats/{boatId}/rates/{id}       → name, mode (kg | piece | cbm | size), rate, min, sizes[]
boats/{boatId}/voyages/{id}     → name, from, to, date, status (open | closed)
tracking/{receiptNo-last4}      → PUBLIC limited copy for the customer portal (status, island, short names, total, paid)
boatpos/{boatId}                → PUBLIC boat position (lat, lng, time, speed)
boats/{boatId}/cargo/{id}       → receiptNo, sender, receiver, lines[], total, paid, status …
boats/{boatId}/contacts/{phone} → saved names for auto-fill
boats/{boatId}/expenses/{id}    → title, amount
```
