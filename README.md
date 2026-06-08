# ProxyV

ProxyV is a Vercel-compatible serverless web proxy. It uses a Vercel Function at `/api/proxy` to fetch upstream sites and rewrite page, stylesheet, script, form, redirect, and asset URLs back through the proxy.

## Run Locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:8080
```

## Deploy On Vercel

Import the GitHub repository into Vercel and deploy it. No external Wisp server, ngrok tunnel, or always-on Node server is required.

Vercel settings:

```text
Build Command: npm run build
Output Directory: public
```

The included `vercel.json` already sets those values.

## Notes

This proxy is designed for serverless hosting. It handles normal HTTP pages and assets well, including CSS URL rewriting and common HTML attributes. Sites that require raw WebSocket tunneling, strict origin isolation, DRM, or very complex client-side routing may still reject or break under any serverless reverse proxy.
