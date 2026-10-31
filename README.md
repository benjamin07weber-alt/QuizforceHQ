# ⚡ QUIZFORCE HQ — Private Mission Control

**A separate, password-protected dashboard for the QUIZFORCE game.**

This project reads the **existing** `quizforce-leaderboard` Cloudflare D1 database. It does not replace or modify your QUIZFORCE game, its `/api/hq-track` endpoint, or its public leaderboard (`scores` table).

## What's included

- 🛰️ Overview: worldwide player totals, games, XP, perfect scores and a 14-day activity chart.
- 🏆 Hall of Fame: most XP, most games, most perfect scores, with real QUIZFORCE ranks.
- 👨‍🚀 Players: searchable/sortable list, XP, rank, total and tracked games, perfect scores.
- 🎮 Games: completed test history, subject, difficulty, score and earned XP, including tests not submitted to the public leaderboard.
- 🛡️ Admin: feature a champion, make HQ-only nickname/XP overrides, hide players, correct HQ-only game scores, restore original values, export CSV.
- 🔐 Security: login password is stored only as an **encrypted Cloudflare secret**, signed HttpOnly session cookie, 12-hour session, login rate limiting, same-origin checks and private API endpoints.
- 📱 Responsive layout for iPad, phone and desktop.

**Not yet included:** editing live game questions. Questions currently live inside QUIZFORCE's original `index.html`, not D1. A future game update is needed for HQ to edit them. HQ corrections/overrides do not change the public leaderboard. HQ player/game stats are client-reported and are not anti-cheat verified.

## Files you need in a NEW GitHub repository

```
QuizforceHQ/
├── README.md
├── public/
│   ├── index.html
│   └── _headers
└── functions/
    └── api/
        └── hq.js
```

> **Important:** Keep `public` and `functions` as separate folders at the *top level* of your new repository. Do not upload the ZIP file itself as the website. Extract the ZIP and upload its contents.

## Launch in 4 stages

### 1. Create the new GitHub repository

1. Go to https://github.com/new and sign in to your existing GitHub account.
2. Repository name: **QuizforceHQ** (or `quizforce-hq`).
3. Select **Private** if you prefer; Cloudflare can deploy from a private repo if you authorize access.
4. Create the repository.
5. Upload the **contents** of the extracted `QUIZFORCE_HQ` folder, preserving `public/index.html` and `functions/api/hq.js`. Commit the files.

On a computer, you can drag the `public` and `functions` folders into GitHub's **Add file → Upload files** area. On an iPad, GitHub's folder uploads can be awkward; you can instead use **Add file → Create new file** and type the full path (e.g. `functions/api/hq.js`) before pasting that file's contents.

### 2. Create a NEW Cloudflare Pages project

1. Open https://dash.cloudflare.com → **Workers & Pages** → **Create application** → **Pages**.
2. Choose **Import an existing Git repository** and select your **new QuizforceHQ repository** (NOT your existing QUIZFORCE game repo).
3. Choose these build settings:
   - **Project name:** `quizforcehq` (Cloudflare may offer a different name if taken)
   - **Production branch:** `main`
   - **Framework preset:** None
   - **Build command:** `exit 0`
   - **Build output directory:** `public`
   - **Root directory:** leave default/blank
4. Deploy. The page may show a login screen before the next steps; that is expected.

### 3. Connect the EXISTING D1 database

1. In **Workers & Pages**, select your **new HQ Pages project**.
2. Open **Settings → Bindings → Add → D1 database binding**.
3. **Variable name:** `DB` (must be exactly uppercase `DB`).
4. **Database:** `quizforce-leaderboard` (the existing database where your HQ tracking test succeeded).
5. Save. **Do not create a new database.**

The HQ function automatically creates its own small admin-only tables the first time you sign in. It does **not** change your existing game tables.

### 4. Add TWO secret settings, then redeploy

In your **new HQ Pages project**:

1. Open **Settings → Variables and Secrets → Add**.
2. Add the first variable:
   - **Name:** `HQ_ADMIN_PASSWORD`
   - **Value:** choose a strong private password **at least 12 characters** long.
   - **Encrypt:** ON (make it a secret).
3. Add the second variable:
   - **Name:** `HQ_SESSION_SECRET`
   - **Value:** a **different, random 32+ character** secret (ideally 48+ characters from a password manager).
   - **Encrypt:** ON.
4. Save both for **Production**. **Do not put the values in GitHub, HTML or a chat message.**
5. Go to **Deployments** and **Retry deployment** (or commit a tiny README change to trigger a new deployment). Bindings and secrets must be present in the new deployment.
6. Open your new HQ address (for example `https://quizforcehq.pages.dev` if available), enter your chosen admin password and enjoy your private HQ.

### First live test

1. Sign in to HQ. The Overview should show the same players and test records you verified in D1.
2. Open **Players** and check a nickname/XP.
3. Open **Games & scores** and check the completed 5-question test.
4. Open **Admin controls** and optionally feature a champion.
5. Open your original QUIZFORCE game, complete another test, then press **Refresh** in HQ. The tracked games total should increase after the game reports the completion.

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| “HQ setup needed” on login screen | Both Cloudflare secrets are missing or too short; add them and redeploy. |
| “D1 database binding DB is missing” | Add a D1 binding named `DB` to **the new HQ Pages project**, choose the existing database, redeploy. |
| “HQ could not load this request” | Check Cloudflare Pages deployment/Function logs; make sure the original `qfhq_players` and `qfhq_runs` tables are in the bound database. |
| 404 at `/api/hq` | Check the GitHub file path is exactly `functions/api/hq.js` at repo root; use Git-connected Cloudflare Pages (not dashboard direct upload). |
| Incorrect password | Use the exact `HQ_ADMIN_PASSWORD` set in Cloudflare. After 5 wrong attempts, wait 15 minutes. |
| Stats seem lower than expected | Detailed runs only exist from the date tracking was installed. Players on other devices count as separate anonymous player IDs. |
| Changing XP doesn't change the public leaderboard | Correct: HQ overrides are intentionally **HQ-only**. |

## Important privacy and security notes

- The HTML login screen can be visited publicly, but **the stats API requires a valid admin session**. Passwords are never included in website code or API responses.
- For additional protection, you may also place the HQ site behind Cloudflare Access with an allowlist for your own email.
- Only nicknames, anonymous player IDs and game results are stored by the existing tracking system; it does **not** record players' countries or locations.
- Don't use the real names of children as player nicknames.
- Keep the GitHub repo private if desired, but **a private GitHub repo alone does not password-protect a deployed website**; the HQ password does that.

## Technical notes

- **Frontend:** `public/index.html` (self-contained HTML/CSS/JS, no external libraries).
- **Backend:** `functions/api/hq.js` (Cloudflare Pages Function, WebCrypto, D1).
- **DB binding:** `DB` → existing `quizforce-leaderboard`.
- **Secret bindings:** `HQ_ADMIN_PASSWORD`, `HQ_SESSION_SECRET`.
- **Build:** `exit 0`, output `public`.
- **Authentication:** HMAC-SHA256 signed, Secure, HttpOnly, SameSite=Strict session cookie; 12-hour lifetime. Login attempts limited to 5 per 15 minutes per hashed IP.
- **Admin changes:** stored separately in `qfhq_hq_overrides`, `qfhq_hq_settings`, and `qfhq_hq_run_corrections`. Original `qfhq_players`, `qfhq_runs`, and public `scores` records are never overwritten by HQ admin actions.
- **No extra SQL setup** is needed for HQ; the API creates HQ-only tables automatically after successful sign-in.

Official Cloudflare references: https://developers.cloudflare.com/pages/framework-guides/deploy-anything/ and https://developers.cloudflare.com/pages/functions/bindings/.
QUIZFORCE HQ — Production deployment activated!! !!!!!⚡
