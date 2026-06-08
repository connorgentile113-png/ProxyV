# ProxyV

ProxyV is a persistent Scramjet-based web proxy for Koyeb that starts an ngrok tunnel on boot. The Koyeb URL shows the generated ngrok URL, and the ngrok URL serves the same proxy UI, Scramjet service worker assets, and Bare transport endpoint.

## Run Locally

```bash
npm install
npm start
```

Open:

```text
http://localhost:8080
```

## Deploy On Koyeb

Deploy the GitHub repository as a Koyeb Web Service.

Koyeb uses the `PORT` environment variable automatically and runs `npm start` for Node.js apps.

Set these environment variables in Koyeb:

```text
NGROK_AUTHTOKEN=your-ngrok-token
```

Optional:

```text
NGROK_DOMAIN=your-static-ngrok-domain.ngrok-free.app
```

When the service starts, the server opens an ngrok HTTPS tunnel to the Koyeb process and exposes it through `/api/status`.

## Notes

ProxyV uses Scramjet with BareMux and a local Bare server transport, so in-frame navigation, subresources, fetch/XHR, and many client-side routing flows are handled by Scramjet instead of the old custom `/api/proxy` rewriter. Sites that require DRM, strict origin isolation, or aggressive bot checks may still reject or break under any reverse proxy.
