# How to invoice in Crosscuts

For Todd and the accounts team (Chloe, Tracy, Jill). Crosscuts issues the tax invoices. MYOB still keeps the books, so every issued invoice is also typed into MYOB.

## Before the first invoice (Todd, once)

1. Open **Users**. Under **Business details and invoicing**, fill in:
   - trading name, legal name, ABN and address (Crosscuts won't issue without these);
   - phone, email, bank account name, BSB and account number, and the payment terms wording;
   - the **invoice prefix** and **next number**. They are `CC-` and `1` unless you change them.
2. Check the numbering carefully. **The prefix and number lock as soon as the first invoice is issued.**
3. Have Tracy check a printed draft against what the ATO and MYOB need before the first real one is sent.

## When an invoice becomes due

Crosscuts makes an invoice **due** by itself, and everyone in accounts gets an alert in **Alerts** in the menu bar:

| Invoice | Becomes due when |
|---|---|
| Deposit (10%) | the job is first put on the board |
| Progress (50%) | Todd presses **Materials ordered** on the job page |
| Final (40%) and any extras | the project manager presses **Confirm complete** on a job marked **Installed** in Finish week (from 0.2.5; an admin setting the stage to Complete by hand also does it) |

Jobs that were already on the board before invoicing started don't get automatic invoices. Use **New invoice** for those.

**An invoice always has a value.** If the job has no value yet, the deposit, progress or final waits as **Needs value**, and whoever can set job values is told. It becomes due, with its amount, as soon as the value is set on the job. The Friday round-up lists how many are waiting.

## Issuing an invoice

1. Open **Accounts** and click the orange **Due** cell.
2. Check the line. It is pre-filled from the job value, for example "Deposit (10%): Smith kitchen, 12 Rose St". Change the wording or amount if needed, or add lines. Amounts include GST.
3. Check the **Bill to** name and address. Crosscuts won't issue without a name.
4. Leave the due date blank for the standard terms (10 days), or set one.
5. **Preview** shows the draft, marked "DRAFT – not a tax invoice".
6. Press **Issue**. The invoice gets its number and is locked: it can't be changed after this.
7. **View / Save as PDF**, then choose "Save as PDF" in the print window. Email the PDF to the client from your own email. Crosscuts never sends email.
8. Enter the invoice in MYOB, then tick **Entered in MYOB**. The table and the Friday round-up show anything not yet entered.

## When the money arrives

Click the issued cell and press **Mark paid**. The date defaults to today and can be changed. If you mark the wrong one, **Mark unpaid** undoes it.

## Mistakes

- **Wrong details on an issued invoice:**
  1. Press **Void** and give a reason. That invoice keeps its number, is marked VOID, and a new draft copy opens for you to correct and issue under a new number.
  2. Void the old one in MYOB too.
  3. If it was the final invoice, the job stays at "Invoiced" while the replacement is a draft. Issue the replacement promptly.
- **Paid invoices can't be voided.** Talk to Todd; credit notes aren't built yet.
- **An invoice that isn't needed** (a warranty visit, or a deposit taken some other way): press **Waive** and give a reason. **Un-waive** puts it back to due.

## Overdue invoices (Jill)

An issued invoice that is unpaid after its due date shows in **red**. The **Overdue list** shows each one with the client's phone, the days overdue, when they were last contacted, and your follow-up notes. Press **Contacted today** after each call.

## Extras

**Add extra** records a variation on a job (description and amount, including GST). It waits as "pending" and becomes due with the final invoice, or straight away if the job is already complete.

## The Friday round-up

Every Friday at 12:00 (Sydney time) everyone in accounts gets one alert listing:
- what is due but not issued;
- what is overdue;
- what isn't in MYOB yet.

It repeats every Friday until the list is clear. Todd can also send it at any time with **Run round-up now** on the Users page.

## Sent and follow-up (0.2.7)

Crosscuts doesn't send invoices; you send them as before, then record it.

- Open the invoice and click **Mark sent** (today, or change the date first). If the invoice has no follow-up interval yet, it takes the client's payment terms, or the default (7 days).
- **Follow up every (days)** changes the interval for this invoice. **Use for this client** saves it as that client's terms, so their next invoices start with it. Client names match loosely: "Smith Pty Ltd" and "smith pty. ltd" are the same client.
- When you chase a payment, type what was said in **Contact note** and click **Contacted today** (on the overdue list it is one click). Each contact goes in the **Contact log**.
- An overdue invoice with no contact within its interval is marked **Needs follow-up** on the overdue list. On weekdays at 7:00 Accounts gets one alert with the count, and the Dashboard's **Waiting on you** lists invoices to issue, issued but not sent, and needing follow-up.
- **Follow-up intervals** (above the overdue list) holds the default and the client terms.
