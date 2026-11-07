# How to set up invoice email (Resend)

For Todd, once. Crosscuts emails invoices through a service called Resend. You make a free account, prove you own `thcabinets.com.au`, make a key, and paste the key into Crosscuts. After that, **Send invoice** works for everyone who can edit invoices.

This is the only email Crosscuts sends, and only when a person presses **Send invoice** (brief decision D9, changed 2026-11-07).

## 1. Make a Resend account

1. Go to resend.com and sign up with your own email.
2. The free plan is plenty for invoices.

## 2. Prove you own thcabinets.com.au

Email from `accounts@thcabinets.com.au` will only be accepted by other people's mail servers if Resend is allowed to send for that domain.

1. In Resend open **Domains**, then **Add Domain**, and type `thcabinets.com.au`.
2. Resend shows a short list of DNS records (names, types and values). **Use exactly what Resend shows you.** They are different for every account, so they are not written here.
3. Open wherever the DNS for `thcabinets.com.au` is managed (the domain registrar or DNS host) and add each record Resend lists.
4. Back in Resend press **Verify**. It can take a few minutes, sometimes a few hours. When every record shows **Verified**, the domain is ready.
5. Resend's records are added alongside the ones for your normal company email. Don't delete or replace the existing ones.

## 3. Make an API key

1. In Resend open **API Keys**, then **Create API Key**.
2. Name it `Crosscuts`. Give it **Sending access** only, and restrict it to the `thcabinets.com.au` domain.
3. Copy the key now. Resend shows it once. It starts with `re_`.

## 4. Put the key in Crosscuts

1. In Crosscuts open **Users** (as an administrator) and find the **Invoice email** section.
2. Paste the key into **Resend API key** and press **Save**. The key is kept on the server and is never shown again (you will only see its last four characters).
3. Check **From**. It starts as `TH Cabinets Accounts <accounts@thcabinets.com.au>`. Replies from clients go to the same address. If you use another address, it must be on the verified domain.

To change the key later, paste a new one over it. **Remove key** turns invoice email off again.

## 5. Try it

1. Open an issued invoice for a job whose client email is your own and press **Send invoice**.
2. Press **Send invoice** in the window. Within a few minutes the email history on the invoice should say **Delivered**.
3. Check the email arrived and the PDF looks right.

## If something goes wrong

- **"Email isn't set up yet"**: no key is saved. Do step 4.
- **"Resend refused the email ... domain is not verified"**: step 2 isn't finished. Look at the domain in Resend.
- **"Resend didn't accept the API key"**: the key was wrong, deleted or limited to a different domain. Make a new one (step 3) and save it (step 4).
- **"The invoice PDF couldn't be made"**: nothing was sent and the invoice was not marked sent. Tell Todd.
- **An email shows Bounced**: the address is wrong or the mailbox is gone. Correct it and press **Re-send**.

## Where the key lives

In the `data/config` folder on the Umbrel (a file called `resend-api-key`), next to the other keys. It is never in the database, the database backups, the audit log or on screen.
