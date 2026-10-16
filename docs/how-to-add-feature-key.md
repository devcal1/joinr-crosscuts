# How to add a feature key

For engineers and agents. A feature key is a coarse permission name such as `jobs.edit`. Keep the list to a dozen or two. Keys are not one per button. Background is in [auth.md](auth.md) and `docs/plans/m1-contracts.md`.

Adding a key changes code, so it ships in a release. Follow [CLAUDE.md](../CLAUDE.md) for the rules and the release flow.

## Steps

1. **Add the key to the end of `KEYS`** in `crosscuts/app/lib/permissions.js` (append; don't reorder: the Users page lists keys in this order). Use an `area.action` name, such as `inspections.edit`. A key needs no migration (`permission_overrides.feature_key` has no CHECK).

2. **Add it to `PRESETS`** in the same file, for each role that should have it. `admin` is every key **except** `OWNER_ONLY_KEYS` (`KEYS.filter(...)`, M13), so admin gets an ordinary new key automatically, and with it every notification sent to holders of that key. The owner holds every key whatever their roles (`computeEffective(roles, overrides, isOwner)`), so the owner gets it too.

3. **Gate the route.** Routers use `defineRoutes`, and the access value is the key. Follow the pattern in the existing routers:

   ```js
   const r = defineRoutes("/api");
   r.get("/thing", "some.key", handler);
   ```

   The access value can be a single key, an array of keys (any one is enough), `'login'` (any logged-in user), or `'public'` (only for login and setup endpoints). A route with no access value stops the server from booting. Nothing checks that the key exists: a misspelt key locks everyone out, admin included. Finer rules (which key each change needs) belong in the `lib/` module, as `lib/orders.js` does.

4. **Gate the page**, if the key guards an HTML page. Add the path to `PAGE_ACCESS` in `crosscuts/app/lib/pages.js`. A `.html` page that is not listed needs only a login, so an unlisted page is open to every logged-in user.

5. **Link it in the menu bar**, if the page should appear there: add an item to its department in `DEPARTMENTS` in `public/shell/shell.js` (one key per item). A sub-page that should light up a menu link goes in `PAGE_ALIASES`. The shell shows only the items the user may use; its classes are prefixed `cc-`. If the key opens a dashboard line, see `public/index.js` (and `renderHint`'s list of working keys).

6. **Add smoke tests.** Each new key needs:
   - a logged-out call that returns 401;
   - one role that the key permits, returning 200;
   - one role without it, returning 403.

   Put these in the milestone's own suite, `ci/smoke-mN-*.sh`. **Also update the two key-count assertions in `ci/smoke.sh`** (the setup user's perms and `/api/users/meta`), and any exact preset assertion there, including the admin preset's count (every key except the owner-only ones).

7. **Update the docs:** the key-by-role table and the intro paragraph in [auth.md](auth.md), and the plain-English roles in [how-to-add-user.md](how-to-add-user.md).

8. **Check locally, then rely on CI.** Boot with the shim command in CLAUDE.md. A local run is not the real test.

9. **Bump `version`** in `crosscuts/app/package.json` (and the root version in `crosscuts/app/package-lock.json`). It is the image tag. CI fails a push that changes `crosscuts/app/` without a bump. After CI publishes, the release finishes in `tenon-umbrel-store` (see the release flow in [CLAUDE.md](../CLAUDE.md)).

## Adding an owner-only key

An owner-only key (M13: `bonuses.manage`, `alarms.manage`, `loans.manage`) is one the admin preset doesn't get: only the owner holds it, and only the owner can grant or revoke it. Use one only for something Todd wants kept from the other admins, and with his sign-off. Background is in [auth.md](auth.md) ("The owner and owner-only keys") and `docs/plans/m13-contracts.md` §3.

Follow the steps above, with these differences:

1. **Append it to `KEYS` and to `OWNER_ONLY_KEYS`** in `lib/permissions.js`. That is all it takes to keep it out of the admin preset, give it to the owner, and put the owner-only guards on the Users routes (`routes/users.js`: grant/revoke, and the password reset of anyone holding it by a grant). Don't put it in any other preset.
2. **Hide its audit rows:** add each entity type the area writes to `PRIVATE_ENTITY_TYPES` in `lib/audit.js`, mapped to the key. Then only its holders see those rows and their action names. Give the area its own entity types; never write its rows under an existing type.
3. **No notices, tasks, comments or Planner items** for the area: the admin role sees all of those, so they would show the figures to every admin. A dashboard line for the key's holders (as the alarm leavers line) is fine.
4. **The Users page needs no change:** it reads the list from `GET /api/users/meta` (`ownerOnlyKeys`).
5. **Smoke:** as above (the total in `ci/smoke.sh` goes up by one; the admin preset's count stays the same), plus a non-owner admin refused 403 on its routes and pages and on granting it, and the owner granting it to another login (`ci/smoke-m13-owner.sh` has the pattern).
6. **Docs:** the key table and "The owner and owner-only keys" in [auth.md](auth.md), the owner section of [how-to-add-user.md](how-to-add-user.md), and the brief's §3.

## Adding a role

A role also needs a **migration**: `user_roles` has a CHECK listing the roles, and SQLite can't alter a CHECK, so the table is rebuilt. Copy `021_new_roles.js` (itself 017's method): refuse orphans, copy, compare, drop, rename, `foreign_key_check`. It is not additive, so it needs Todd's sign-off. Change `ROLES` and the migration together: if they disagree, creating a user answers a misleading 409. Then:

- `PRESETS` and `ROLES` (append) in `lib/permissions.js`;
- `ROLE_LABELS` in `public/users.js`;
- `lib/planner/layers.js` (which layers the role sees and posts to; the default layer order);
- chat channels are by role too, but a role channel means rebuilding `channels` (it has child tables): avoid it;
- `ci/smoke.sh`: the role and preset assertions and a user and jar for the role;
- `tools/screenshots/menu-shots.js` (two role lists);
- [auth.md](auth.md), [how-to-add-user.md](how-to-add-user.md) and the brief's §3.

## Cautions

- **Do not rename or delete a key that is in use.** Overrides are stored by key name in `permission_overrides`. An override for an unknown key is ignored, so a renamed key silently loses its overrides.
- **Do not touch the board files** (`schedule.html`, `schedule.css`, `schedule.js`, `workers.html`) to add a key. Gate the route on the server, and leave the board's markup alone. The board hides nothing for view-only users in M1. That is a known limit.
- **Overrides need no code.** Once a key ships, an admin can grant or revoke it per user from the Users page.
