# Security Policy

Keyforge is security-sensitive software: it mints the tokens your application
trusts. Please report vulnerabilities privately.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository
(Security → Report a vulnerability), or email
<keyforge.security@zdevzone.com>. Please do not open public issues for
security problems.

You can expect an acknowledgement within a week. Coordinated disclosure is
appreciated; credit is given unless you prefer otherwise.

## Scope notes

- The trust model assumes the **Ed25519 private key never leaves the server**.
  Anything that could exfiltrate it (path traversal, backup exposure, log
  leaks) is in scope and high severity.
- The admin surfaces (bearer token, session cookies) and the rate-limited
  public endpoints are in scope.
- "A user patched the public key out of their own copy of a client app" is
  out of scope: offline licensing keeps honest customers honest; it is not
  DRM, and Keyforge does not claim otherwise.

## Deployment hardening checklist

- Serve behind HTTPS (a reverse proxy or your platform's TLS).
- Keep `LICENSE_SIGNING_KEY` and `LICENSE_AUTH_SECRET` out of the repo and
  out of build logs; rotate the admin token if it ever leaks.
- Back up the license database; treat backups as secrets (they contain the
  ledger and, for the auth database, password hashes).
