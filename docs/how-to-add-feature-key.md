# How to add a feature key

For engineers and agents. A feature key is a coarse permission name such as `jobs.edit`. Keep the list to a dozen or two. Keys are not one per button. Background is in [auth.md](auth.md) and `docs/plans/m1-contracts.md`.

Adding a key changes code, so it ships in a release. Follow [CLAUDE.md](../CLAUDE.md) for the rules and the release flow.

## Steps

1. **Add the key to `KEYS`** in `crosscuts/app/lib/permissions.js`. Use a `area.action` name, such as `inspections.edit`.

2. **Add it to `PRESETS`** in the same file, for each role that should have it. `admin` is `[...KEYS]`, so admin gets the new key automatically.

3. **Gate the route.** Routers use `defineRoutes`, and the access value is the key. Follow the pattern in the existing routers:

   ```js
   const r = defineRoutes("/api");
   r.get("/thing", "some.key", handler);
   ```

   The access value can be a single key, an array of keys (any one is enough), `'login'` (any logged-in user), or `'public'` (only for login and setup endpoints). A route with no access value stops the server from booting.

4. **Gate the page**, if the key guards an HTML page. Add the path to `PAGE_ACCESS` in `crosscuts/app/lib/pages.js`. A `.html` page that is not listed needs only a login, so an unlisted page is open to every logged-in user.

5. **Link it in the shell**, if the page should appear in the department switcher. The shell in `public/shell/` shows only entries the user is allowed to use. Its classes must be prefixed `cc-`.

6. **Add smoke tests.** Each new key needs:
   - a logged-out call that returns 401;
   - one role that the key permits, returning 200;
   - one role without it, returning 403.

   Put these in the smoke suite, `ci/smoke.sh`.

7. **Check locally, then rely on CI.** Boot with the shim command in CLAUDE.md. A local run is not the real test.

8. **Bump `version:`** in `crosscuts/umbrel-app.yml`. CI fails a push that changes `crosscuts/app/` without it.

## Cautions

- **Do not rename or delete a key that is in use.** Overrides are stored by key name in `permission_overrides`. An override for an unknown key is ignored, so a renamed key silently loses its overrides.
- **Do not touch the board files** (`schedule.html`, `schedule.css`, `schedule.js`, `workers.html`) to add a key. Gate the route on the server, and leave the board's markup alone. The board hides nothing for view-only users in M1. That is a known limit.
- **Overrides need no code.** Once a key ships, an admin can grant or revoke it per user from the Users page.
