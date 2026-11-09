# Market Pulse https://annaw1010.github.io/Market.Log1010/#day

A personal market news desk that runs free on GitHub. It ranks the top stories for the day, week, month and year, shows the key indicators for each period, writes a "walk me through the markets" brief, and keeps your saved articles and watchlist in sync across devices.

Built for private banking and wealth management recruiting: the Recruiting tab has interview briefs, client conversation starters, firm news for the banks you are targeting, and practice questions.

## What updates, and how often

| Part of the site | Source | How fresh |
| --- | --- | --- |
| Ticker tape, watchlist quotes, live headline stream, economic calendar | TradingView widgets | Live (some symbols delayed up to 15 minutes) |
| Running feed and top stories | 15 publisher RSS feeds plus Google News searches | Every 20 minutes |
| Key indicators and the brief | Yahoo Finance, with FRED as backup | Every 20 minutes (FRED series lag a day) |
| Economic data (CPI, jobs, GDP) | FRED | As released |
| Firm watch | Google News | Hourly |
| Saved article titles and follow-up coverage | The article page and Google News | Within a few minutes of saving, then every 6 hours |

The site itself is static. A GitHub Action runs `scripts/update.py` every 20 minutes, commits the history it needs, and redeploys the site. Your browser checks for new data every 2 minutes while the page is open.

## Setup (about 10 minutes)

1. **Create a repository.** On GitHub, click New repository. Name it `market-pulse`, make it **Public** (free GitHub Pages and free Actions minutes need a public repo), and create it without a README.
2. **Upload the files.** Unzip `market-pulse.zip`. On the new repo page, click "uploading an existing file" and drag in everything inside the folder.
   The `.github` folder is hidden on Mac. In Finder, press `Cmd + Shift + .` to show hidden files before you select everything. If it still does not upload, create it by hand: Add file, Create new file, type `.github/workflows/update.yml` as the name, and paste in the contents of that file from the zip.
3. **Turn on Pages.** Settings, Pages, under "Build and deployment" set Source to **GitHub Actions**.
4. **Allow the updater to save history.** Settings, Actions, General, Workflow permissions, choose **Read and write permissions**, Save.
5. **Run the first update.** Actions tab, "Update Market Pulse", Run workflow. (If a run already failed right after your upload, that is expected: Pages was not on yet.) The first run takes 2 to 3 minutes because it backfills this year's headlines so the Month and Year tabs are not empty.
6. **Open your site** at `https://YOUR-USERNAME.github.io/market-pulse/`. Bookmark it, and on your phone use Share, Add to Home Screen.

## Sync your saved items (recommended)

Without sync, saved articles and tickers stay in one browser, and the updater cannot fetch titles, follow-up coverage or ticker headlines for them.

1. GitHub, Settings (your profile), Developer settings, Personal access tokens, **Fine-grained tokens**, Generate new token.
2. Repository access: **Only select repositories**, pick `market-pulse`.
3. Permissions: **Contents: Read and write** and **Actions: Read and write**.
4. Copy the token, open your site, Settings, paste it, Save and test.

Do this once per device. The token is stored only in that browser. Note that because the repo is public, `data/saved.json` (your saved links, watchlist and notes) is visible to anyone who finds the repo, so keep notes professional.

## Using it

- **Today, Week, Month, Year**: the brief at the top, ranked stories on the left (filter by theme), indicators for that period on the right.
- **Live**: every headline as it arrives, newest first, next to TradingView's live stream.
- **My desk**: paste any article link to save it, add a note on why it matters to a client, and track follow-up coverage. Add tickers (`JPM` or `NYSE:JPM`); click one for headlines and pitch notes.
- **Recruiting**: copy the daily or weekly brief to practice "walk me through the markets", skim firm news before a networking call, and work through the practice questions.
- **Update now** starts a fresh run on GitHub (with sync connected) instead of waiting for the next scheduled one.

## Customize

Everything lives in `config.json`:

- `feeds`: add or remove RSS feeds. `weight` raises a source's influence on rankings.
- `google_news`: search phrases pulled every run.
- `themes`: keywords for each theme filter. Keywords with a capital letter match case exactly (so `Fed` ignores "fed up").
- `indicators` and `macro`: Yahoo symbols and FRED series IDs.
- `firm_watch`: the firms on the Recruiting tab. Add any bank you are networking with.
- `tape`: symbols on the live ticker tape, in TradingView format.

Edit the file on GitHub and commit. The site redeploys automatically.

## Troubleshooting

- **"Updated 3 h ago" in red**: open the Actions tab and look at the latest run. GitHub sometimes delays scheduled runs during busy periods; a failed run shows the error.
- **A feed shows as not responding**: publishers occasionally change feed URLs. Remove or replace it in `config.json`.
- **Indicators missing**: Yahoo sometimes rate-limits GitHub's servers. FRED fills in most rows; the rest return on the next run.
- **Scheduled runs stopped**: GitHub pauses schedules on repos with no activity for 60 days. The updater commits history daily, so this should not happen, but Run workflow restarts it if it does.

This is a news and study tool, not investment advice.
