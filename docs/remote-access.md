# Remote access

Agent Controller has two network paths that can need remote access:

1. **Agent Controller gateway** — the console and device API in this repository, normally on port `3996`.
2. **T3 Code environment** — the workstation agent server, normally on port `3773`.

Tunneling one does not automatically tunnel the other. Configure the gateway when you want to open Agent Controller from a phone or another computer. Configure the T3 environment when the gateway must reach a T3 Code host on another network.

The Settings workspace and initial onboarding inspect the machine running the gateway and identify the next missing step: install Tailscale, sign in, enable Serve or Funnel, restart after `.env` changes, or open the ready HTTPS URL. Use **Refresh** after changing Tailscale outside the browser. A separate T3 host still needs Tailscale configured on that host because the gateway cannot inspect another machine's local installation.

## Recommended: private Tailscale Serve

[T3 Code recommends a trusted private network](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md) for remote access. Tailscale Serve gives the gateway a stable MagicDNS HTTPS URL and limits access to devices and users allowed by the Tailnet policy.

Prerequisites:

- Install [Tailscale](https://tailscale.com/download) on the gateway host.
- Sign in and confirm `tailscale status` reports the device as connected.
- Install Tailscale on each remote phone or computer that should open the private URL.
- Keep Agent Controller authentication enabled. Tailnet access is an additional boundary, not a replacement for Clerk.

From this repository, run:

```bash
npm run setup:tunnel -- --mode serve --write-env
```

The command:

- checks that Tailscale is installed and connected;
- runs a persistent HTTPS reverse proxy to `http://127.0.0.1:3996`;
- prints the `https://machine.tailnet.ts.net` URL;
- updates `PUBLIC_BASE_URL` in `.env`;
- appends the HTTPS origin to `CLERK_AUTHORIZED_PARTIES` without replacing existing origins.

Restart Agent Controller after the environment file changes:

```bash
npm start
```

Open the printed HTTPS URL from a device signed in to the permitted Tailnet.

Disable the mapping later with:

```bash
npm run setup:tunnel -- --mode serve-off
```

Tailscale Serve uses background mode, so its mapping resumes after a reboot or Tailscale restart until it is disabled.

## Public internet: Tailscale Funnel

Funnel publishes the gateway to the broader internet. Use it only when the client cannot join your Tailnet and public reachability is truly required.

```bash
npm run setup:tunnel -- --mode funnel --write-env
```

The setup command refuses Funnel when Agent Controller is using development authentication. Configure Clerk first. The `--allow-public` override exists for operators who have independently installed another production authentication layer; it should not be used to bypass the warning on an unprotected gateway.

Disable Funnel with:

```bash
npm run setup:tunnel -- --mode funnel-off
```

Before using Funnel:

- Confirm Clerk sign-in works at the Funnel URL.
- Add the HTTPS origin to the Clerk application’s allowed origins if Clerk rejects the new domain.
- Keep rate limits enabled.
- Never put device credentials, API tokens, T3 pairing tokens, or session tokens in shared URLs or screenshots.
- Revoke sessions you no longer recognize.

Tailscale Funnel is HTTPS-only and supports public ports `443`, `8443`, and `10000`. Agent Controller uses public HTTPS port `443` by default while the local gateway stays on `3996`.

## T3 Code environment access

For a T3 server that is already running, T3 Code can configure Serve and mint a new one-time pairing credential without restarting:

```bash
npx t3 pair --tailscale
```

For a new T3 environment managed by this repository, use Initial setup in the console and choose **Tailscale Serve**, or run:

```bash
npm run setup:t3 -- --project '/path/to/project' --tunnel tailscale
```

The setup wrapper launches `t3 serve --tailscale-serve`, captures the stable HTTPS endpoint and pairing token, and can register the environment with Agent Controller when gateway credentials are supplied.

The Agent Controller gateway must be able to reach the T3 Serve URL. If the gateway and T3 host are different machines, both need to participate in a Tailnet path permitted by its access-control rules.

## LAN hardware and listener settings

ESP32 controllers do not normally run Tailscale. If they reach the gateway over Wi-Fi, keep:

```env
HOST=0.0.0.0
```

and keep their stored gateway URL pointed at the gateway host’s LAN address, for example `http://192.168.1.162:3996`. Tailscale proxies to the loopback address on the same host even while the server listens on all interfaces.

If there are no LAN devices and every client uses Tailscale, binding Agent Controller to `127.0.0.1` reduces direct LAN exposure.

## Troubleshooting

### The setup command cannot find Tailscale

Install Tailscale, launch the app, sign in, and verify:

```bash
tailscale status
```

On macOS, the setup command checks both `PATH` and the standard Tailscale application CLI location.

### The HTTPS URL exists but sign-in fails

- Restart Agent Controller after `--write-env` updates `.env`.
- Confirm `PUBLIC_BASE_URL` is the printed HTTPS origin.
- Confirm `CLERK_AUTHORIZED_PARTIES` includes that origin.
- Add the origin in the Clerk dashboard if the frontend reports an origin or redirect restriction.

### Serve works locally but not from the phone

- Confirm the phone is signed in to Tailscale.
- Confirm both devices appear in `tailscale status`.
- Check Tailnet access-control rules.
- Use `tailscale serve status` to confirm the proxy is active.

### Funnel is not reachable immediately

The first Funnel setup can require an admin consent page, MagicDNS, HTTPS certificates, and the Funnel node attribute. Public DNS propagation can also take several minutes. Follow the URL printed by the Tailscale CLI and retry after approval.

## References

- [T3 Code remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)
- [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve)
- [Tailscale Serve CLI](https://tailscale.com/docs/reference/tailscale-cli/serve)
- [Tailscale Funnel](https://tailscale.com/docs/features/tailscale-funnel)
- [Tailscale Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)
