# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in openclaw-obs, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, email: **kkeeling@gmail.com**

Include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You should receive a response within 72 hours. We'll work with you to understand and address the issue before any public disclosure.

## Scope

openclaw-obs is a local-first tool — it runs on your machine and stores data locally. The primary security concerns are:

- **Dashboard exposure** — The dashboard binds to localhost by default. If exposed via tunnel or reverse proxy, it has no authentication. Users are responsible for securing access.
- **SQLite injection** — All queries use parameterized statements.
- **Payload storage** — LLM inputs/outputs are stored locally. Sensitive data in conversations will be in the database.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.1.x   | ✅ Current |
