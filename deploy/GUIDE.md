# Putting the app online with a Google Cloud free VM

You end up with a private web address such as **https://crm.chabadcuritiba.com** that works on any phone or computer. Everything happens in your browser. Plan on about 30 minutes.

You need:
- Your Firebase / Google Cloud project with **Blaze** billing (you already have this).
- Access to the DNS settings of your domain (where `chabadcuritiba.com` is registered).

---

## 1. Create the free VM

1. Open https://console.cloud.google.com and pick your Firebase project at the top.
2. Menu ☰ → **Compute Engine** → **VM instances** → **Create instance**. If asked, click **Enable** for the Compute Engine API.
3. Fill in exactly these values. Other values may cost money.
   - **Name:** `crm`
   - **Region:** `us-central1 (Iowa)`, `us-east1 (South Carolina)` or `us-west1 (Oregon)`. Only these are free.
   - **Machine type:** series **E2**, type **e2-micro**
   - **Boot disk** → **Change**: operating system **Debian**, version **Debian 12**, disk type **Standard persistent disk** (*not* "Balanced"), size **30 GB** → **Select**
   - **Firewall:** tick **Allow HTTP traffic** and **Allow HTTPS traffic**
4. Click **Create**. After a minute it shows an **External IP**, e.g. `34.123.45.67`.

**Keep the address fixed:** Menu ☰ → **VPC network** → **IP addresses**, find the VM's address and click **Promote to static IP address**.

**Protect yourself from surprises:** Menu ☰ → **Billing** → **Budgets & alerts** → **Create budget** of US$1–5 with email alerts. The VM and disk are free within the limits above. Google may charge a small amount for the public IP address, typically a few dollars a month. The budget alert will tell you.

## 2. Point your web address at the VM

At your domain provider (where you manage `chabadcuritiba.com`), add a DNS record:

| Type | Name | Value |
|---|---|---|
| A | `crm` | the External IP from step 1 |

That makes `crm.chabadcuritiba.com` point to your VM. It usually takes effect in a few minutes, sometimes up to an hour.

## 3. Install the app

1. In **VM instances**, click **SSH** next to `crm`. A black terminal window opens in your browser.
2. Paste this line and press Enter:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/ChabadCuritiba/Database-/claude/jewish-community-platform-7zr3fp/deploy/setup.sh | sudo bash
   ```

3. When asked, type the web address (e.g. `crm.chabadcuritiba.com`) and your Google email.
4. Wait about 5 minutes until you see **== Done ==**.

The app now starts by itself whenever the VM reboots, and HTTPS (the padlock) is set up automatically.

## 4. Turn on "Continue with Google" sign-in

The online version only allows sign-in with Google, so this step is required.

1. Google Cloud Console → Menu ☰ → **APIs & Services** → **OAuth consent screen**. Google now calls this **Google Auth Platform**.
   - **Branding:** app name (e.g. "Beit Chabad CRM"), user support email and developer contact email → **Save**.
   - **Audience:** **Internal** if offered (only your Google Workspace accounts can sign in). Otherwise **External** → **Publish app**. The CRM still admits only invited users.
2. **Clients** → **+ Create client**.
   - Application type: **Web application**
   - **Authorized redirect URIs** → **+ Add URI**: `https://crm.chabadcuritiba.com/auth/google/callback`, using your address
   - **Create**, then copy the **Client ID** and **Client secret**.
3. Back in the SSH window, run:

   ```bash
   sudo nano /opt/crm/.env
   ```

   Paste the values after `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=`. Save with **Ctrl+O**, Enter, then exit with **Ctrl+X**.
4. Restart the app:

   ```bash
   sudo systemctl restart crm
   ```

## 5. Use it

Open **https://crm.chabadcuritiba.com** on your phone or computer → **Continue with Google**. You are the admin. Invite your team under **Admin › Users & roles** and fill in your organization details under **Admin › Settings**.

On a phone, you can add it to your home screen: in the browser's share menu, choose **Add to Home Screen**.

---

## Optional: email, SMS and online payments

Edit `/opt/crm/.env` as in step 4.3 and restart. Until you do, messages are only logged, never sent.

- **Email through Google Workspace / Gmail:** `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=` your address, `SMTP_PASS=` an **App Password** (Google Account → Security → 2-Step Verification → App passwords), `MAIL_FROM="Beit Chabad <you@chabadcuritiba.com>"`.
- **SMS & robo-calls:** Twilio account SID, auth token and phone number.
- **Online payments:** Stripe secret key and webhook secret (see README).

## Optional: Buggy, the voice assistant

1. Go to **aistudio.google.com** → **Get API key** → **Create API key** and pick your Google Cloud / Firebase project. Use a project with billing enabled (e.g. Blaze), so Google does not use your data to improve its products.
2. Add the key to `/opt/crm/.env`:
   ```
   GEMINI_API_KEY=your-key
   ```
3. Restart: `sudo systemctl restart crm`. Open **🎙 Buggy** in the menu.

Buggy picks the best available Gemini "Flash" model automatically and switches by itself when Google retires one, so don't set `GEMINI_MODEL` unless you have a specific reason. Buggy never saves anything without asking you to confirm. To open it by voice, see "Abrir o Buggy pela voz no celular" on the Buggy page (Siri Shortcut on iPhone, "Ok Google, abrir Buggy" on Android).

## Everyday tasks

| Task | Command (in the SSH window) |
|---|---|
| Install the latest version from GitHub | `sudo bash /opt/crm/deploy/update.sh` |
| See what the app is doing / errors | `sudo journalctl -u crm -n 100` |
| Restart | `sudo systemctl restart crm` |
| Back up now | Admin › Backups → **Back up now** (also runs nightly) |

Download a backup from **Admin › Backups** now and then and keep it somewhere safe, e.g. Google Drive. If the VM were ever deleted, that file restores everything.

## Troubleshooting

- **The page doesn't open / no padlock:** the DNS record from step 2 may not be active yet. Wait and retry. Check that HTTP/HTTPS traffic is allowed on the VM (VM → Edit → Firewall).
- **"has not been invited"** when signing in: only `ADMIN_EMAILS` and users invited under Admin › Users can sign in.
- **"redirect_uri_mismatch"** from Google: the redirect URI in step 4.2 must exactly match `https://YOUR-ADDRESS/auth/google/callback`.
