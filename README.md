# ProxyV

ProxyV is a persistent Rammerhead-based web proxy for Koyeb that starts an ngrok tunnel on boot. The Koyeb URL shows the generated ngrok URL, and the ngrok URL serves the proxy UI plus the Rammerhead session routes.

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

ProxyV uses Rammerhead sessions and the built-in proxy routes. It creates a session, opens the destination inside the embedded frame, and keeps the session ID in localStorage so login state can survive reloads.
