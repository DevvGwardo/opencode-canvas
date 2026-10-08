# Security

OpenCode Canvas is a local proxy for your OpenCode server, which can read and write files and run shell commands. Treat it with the same care.

- It listens on `127.0.0.1` by default. Non-loopback bindings (`--lan` or `--hostname`) require `CANVAS_PASSWORD` with at least 12 characters. This password is separate from OpenCode's service password.
- Canvas uses rate-limited login, 12-hour server-side sessions, and HttpOnly, SameSite cookies. Logout revokes the session, including ongoing streams; restarting the server invalidates all logins.
- The OpenCode service password stays on the server. Model metadata responses strip settings, headers, and variant bodies before reaching the client.
- Requests with a foreign `Origin`, cross-site `Sec-Fetch-Site`, or unapproved `Host` are rejected. Local interface addresses are allowed for LAN use; additional names require `--allow-host`.
- Authentication does not encrypt HTTP traffic. Use only trusted private networks, or put Canvas behind HTTPS/private VPN access. Never port-forward it to the public internet or expose `--dev` to untrusted clients.
- HTTPS reverse proxies must use an explicit `--origin https://canvas.lan`; forwarded headers alone are not trusted. This requires a strong Canvas password and uses Secure login cookies. Keep the proxy-to-Canvas connection private.
- The integrated Chrome/Chromium browser uses a temporary profile, with sandboxing enabled and debugging bound to loopback. Downloads are blocked. Navigation/input actions and viewport streams require Canvas access.
- The browser is **shared by all authenticated viewers**. They can see and use any site logins made in that temporary profile. It is not a per-user security boundary. The profile is discarded after five minutes without viewers or on server shutdown.
- API writes are not retried on transport failure. A failed prompt/command request may already have been accepted; inspect the session before retrying.
- Auto-approve features let agents act without asking. They're off by default and need an explicit confirmation to enable.

## Reporting a vulnerability

Please report security issues privately via GitHub's "Report a vulnerability" (Security tab) rather than in a public issue.
