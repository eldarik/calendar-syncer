# calendar-syncer

Copies events from the current week into the next week in Google Calendar.

## Setup

1. Create a Google Cloud project and enable the **Google Calendar API**.
2. Configure the **OAuth consent screen**:
   - choose **External** for a personal account
   - set the app name, support email, and developer contact email
   - add your Google account as a **Test user** while the app is in testing
3. Create an **OAuth client ID** for a **Desktop app**.
4. Download the credentials JSON file into this directory as `credentials.json`.
5. Install dependencies:

   ```bash
   npm install
   ```

6. Run the script once:

   ```bash
   npm run copy-week
   ```

The first run opens a browser window for Google sign-in and consent. The script then stores your OAuth token locally in `token.json`.

If Google shows a 403 `access_denied` error for an unverified app, open the OAuth consent screen in Google Cloud Console and add the account you are signing in with as a **Test user**.

## OpenCode command

After setup, run this from OpenCode:

```text
/copy-calendar
```

## Options

- `--calendar=<id>`: calendar ID to use, defaults to `primary`
- `--weeks=<n>` or `weeks=<n>`: number of weeks to copy forward, defaults to `1`
- `--dry-run`: prints what would be copied without creating events
- `--help`: prints usage

Examples:

```bash
npm run copy-week -- --dry-run
npm run copy-week -- --calendar=primary
npm run copy-week weeks=2
npm run copy-week -- --weeks=3 --dry-run
```

## Behavior

- Uses the current local week from Monday 00:00:00 to next Monday 00:00:00
- Copies timed and all-day events
- Can copy to multiple future weeks with the `weeks` option
- Skips cancelled events
- Skips all repeating/recurring events (parent events, instances, and modified instances)
- Avoids duplicates in target weeks by matching title and start/end time
