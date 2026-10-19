# Cloudflare manual (option 4)

What you do by hand on Cloudflare to run the Sevens Out room server, and what happens behind each step. Most commands can be run by the local agent (see Prompt 2). Only the account and the browser login need you.

You don't need your own domain, and you don't need a paid plan.

## 1. Create the account (once, about 5 minutes)

1. Go to <https://dash.cloudflare.com/sign-up>, sign up with email and password, and confirm the email.
2. When Cloudflare asks what you want to do, skip adding a website. The room server lives on a free `workers.dev` address.
3. Turn on two-factor authentication: **My Profile → Authentication → Two-Factor Authentication**. Anyone with access to the account can change the server.

New accounts are on the **Workers Free** plan by default.

## 2. Pick your workers.dev subdomain (once)

1. In the dashboard, open **Workers & Pages**.
2. Look at **Your subdomain**. If it's empty, or you don't like the name, click **Change** and pick one, for example `rot`.
3. The room server will be reachable at `https://sevens-out.<your-subdomain>.workers.dev`. The first part comes from `"name"` in `server/cloudflare/wrangler.jsonc`.

If you skip this, `wrangler deploy` asks you for a subdomain the first time.

## 3. Log in from your computer (once per machine)

In the repo folder, run:

```
npx wrangler login
```

A browser window opens. Sign in to Cloudflare and click **Allow**. Then check it worked:

```
npx wrangler whoami
```

It should show your email and account name.

On a machine without a browser, use an API token instead: create one as in step 7 and run with `CLOUDFLARE_API_TOKEN=… npx wrangler deploy …`.

## 4. Tell the server which page may connect

In `server/cloudflare/wrangler.jsonc`, set:

```jsonc
"vars": { "ALLOWED_ORIGINS": "https://<your-github-username>.github.io" }
```

- Use the exact origin: `https://`, no path, no trailing slash.
- To allow several pages, separate them with commas.
- Phones running the page from anywhere else get "Origin not allowed".

## 5. Deploy

```
npm run worker:deploy
```

This uploads the Worker and creates the Durable Object class `GameRoom`. It's the SQLite-backed kind, which the Free plan includes. Wrangler prints the URL at the end.

Check it:

```
curl https://sevens-out.<your-subdomain>.workers.dev/health    # prints: ok
```

Then point the page at it in `index.html`, commit and push:

```html
<meta name="sevens-out-server" content="wss://sevens-out.<your-subdomain>.workers.dev">
```

Run `npm run worker:deploy` again whenever `server/` or `engine.js` changes. Pushing to GitHub only updates the page.

## 6. Where to look in the dashboard

Open **Workers & Pages → sevens-out**:

| Tab | What it shows |
|---|---|
| **Metrics** | Requests and errors per day. Each phone connecting counts as one request. |
| **Logs** | Live log of requests and server errors (observability is switched on in `wrangler.jsonc`). |
| **Settings → Variables and Secrets** | `ALLOWED_ORIGINS` as deployed. |
| **Settings → Domains & Routes** | The workers.dev address, and custom domains if you add one. |

The Durable Objects themselves (one per room code) appear under **Storage & Databases → Durable Objects** (the menu name may differ slightly). Rooms delete themselves after 14 days without use.

## 7. Optional: deploy from GitHub instead of your laptop

1. Create a token in **My Profile → API Tokens → Create Token**, using the template **Edit Cloudflare Workers**. Limit it to your account.
2. Find your **Account ID**: on the account home page, or on the **Workers & Pages** overview, in the right-hand column.
3. In the GitHub repo, open **Settings → Secrets and variables → Actions** and add two secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
4. Add a workflow, for example `.github/workflows/deploy-worker.yml`:

```yaml
name: deploy worker
on:
  push:
    branches: [main]
    paths: ['server/**', 'engine.js']
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cloudflare/wrangler-action@v4
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy -c server/cloudflare/wrangler.jsonc
```

## 8. Optional: your own domain

If a domain of yours is already managed by Cloudflare:

1. Open **Workers & Pages → sevens-out → Settings → Domains & Routes → Add → Custom domain**, for example `game.example.com`.
2. Change the meta tag to `wss://game.example.com`.
3. Keep `ALLOWED_ORIGINS` pointing at the page's origin.

## Costs and limits

You aren't charged on the Free plan. The daily limits reset at 00:00 UTC:

| Free plan, per day | Limit | A game night uses |
|---|---|---|
| Requests (Workers + Durable Objects) | 100,000 | About 1 per phone connection, plus 1 per 20 moves |
| Durable Object duration | 13,000 GB-s | Very little: idle rooms hibernate and cost nothing |
| Storage rows written | 100,000 | 1 per move |
| Storage | 5 GB in total | A few KB per room |

If a limit were ever reached, the server refuses requests until the daily reset; nothing is billed. The paid plan starts at $5/month and isn't needed for this.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No "Play online" button | The `sevens-out-server` meta tag is still empty, or the page hasn't redeployed yet. |
| Phones show "Reconnecting…" forever | Wrong address in the meta tag (it must start with `wss://`), or the Worker isn't deployed. Check `/health`. |
| Phones can't connect, and Logs show 403 | `ALLOWED_ORIGINS` doesn't match the page exactly. Deploy again after fixing it. |
| `wrangler deploy` asks for a subdomain | Step 2 wasn't done. Pick one when asked. |
| `wrangler` says you're not authenticated | Run step 3 again (`npx wrangler login`). |

## Removing it

```
npx wrangler delete -c server/cloudflare/wrangler.jsonc
```

This deletes the Worker and its rooms. You can also do it in the dashboard: **Workers & Pages → sevens-out → Settings → Delete**. Then empty the meta tag so the page hides online play again.

For the owner's statistics page (a second Worker, D1 and Cloudflare Access), see [admin.md](admin.md).
