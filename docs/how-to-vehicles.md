# How to keep the vehicles register

For Accounts and the workshop manager. Added in 0.2.7 (`docs/plans/m28-contracts.md` section 1).

The register holds each work vehicle's rego and insurance dates and its service, repair and inspection bookings. It holds no costs. It starts empty.

## Accounts: rego and insurance

1. Open **Accounts > Vehicles**.
2. **Add vehicle**: the name (for example "White ute"), the rego plate, make and model, the rego and insurance expiry dates, the insurer and policy number. Save.
3. When a rego or insurance is renewed, click **Edit** and change the expiry date.
4. A vehicle that is sold: **Edit**, untick **Active**. It drops off the list (tick **Show inactive** to see it).

Crosscuts sends Accounts an alert 30 days and again 7 days before a rego or insurance expires (on the 7:00 weekday check). Expiries also show on the Planner's Company-wide layer, and in **Waiting on you** on the Dashboard from 30 days out.

## Workshop manager: bookings

1. Open **Workshop > Vehicles**.
2. On the vehicle, click **Book**: the kind (service, repair, inspection or other), the date, a time if there is one, where, and notes.
3. Bookings show on the Planner's Workshop layer and, on the day and after, in your **Waiting on you**.
4. When it is done, click **Confirm done** under Open bookings. **Edit** changes a booking; **Cancel booking** removes one that won't happen.
