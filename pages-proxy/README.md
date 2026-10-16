# levelstudio.pages.dev

A Cloudflare Pages project (`levelstudio`) whose only job is the short address: `dist/_worker.js`
forwards every request to the `studio` Worker through the service binding `STUDIO`
(set on the project, production and preview). It leaves the account's workers.dev name alone,
which Max Fashion Studio's link depends on.

Do not deploy it with `wrangler pages …`: recent Wrangler versions redirect Pages commands to
Workers and pick up the root `wrangler.jsonc`, which redeploys the studio instead. Upload with the
API:

```sh
curl -X POST "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT>/pages/projects/levelstudio/deployments" \
  -H "Authorization: Bearer <TOKEN>" \
  -F "manifest={}" -F "branch=main" \
  -F "_worker.js=@pages-proxy/dist/_worker.js;type=application/javascript+module"
```
