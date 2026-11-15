# Deploying Satchel

How to run Satchel on your own server and connect Claude Code, claude.ai, Claude Desktop and
mobile, and other MCP clients to it.

The recommended setup puts the server behind **Cloudflare Access with Managed OAuth**. Access
handles the login, every client signs in with your identity through OAuth, and the server
only checks the JWT Access forwards. No token has to be copied to any client. The server
contains no OAuth code of its own (see "Authentication" in `docs/design.md`).

Placeholders used below:

- `HOST`: the public hostname you give Satchel, e.g. `satchel.example.com`.
- `TEAM`: your Cloudflare One team domain, `<team>.cloudflareaccess.com`.

Dashboard labels in Cloudflare and Claude move around. The paths below follow their docs
("Validating JWTs" and "Managed OAuth" for Cloudflare; "Add a connector that isn't in the
directory" for Claude) at the time of writing.

## 1. Run the container

Satchel is one container with one data directory. From a clone of this repository:

```bash
cp .env.example .env
mkdir -p data && sudo chown 1000:1000 data     # the image runs as uid 1000
docker compose up -d --build
```

Leave the auth variables in `.env` empty for now except one: until Access is set up in
step 3, set `SATCHEL_TOKEN` to a throwaway value (`openssl rand -hex 16`) so the server
starts. Remove it again in step 3.

`compose.yaml` publishes the port on `127.0.0.1:8787` only. Reach the server from elsewhere
through a tunnel or reverse proxy (step 2), never by publishing the port publicly.

The embedding model (`SATCHEL_EMBED_MODEL`, a few hundred MB) downloads into `data/models`
on first use. The server answers with full-text search while it downloads. Set
`SATCHEL_EMBED_MODEL=off` to skip it entirely.

Test:

```bash
docker compose ps                         # satchel ... (healthy), within about 30 s
curl -s http://127.0.0.1:8787/healthz     # ok
```

If the container exits, `docker compose logs satchel` says why. A server with no auth mode
configured refuses to start.

## 2. Give it a public hostname

Clients reach Satchel at `https://HOST/mcp`. Any route from the internet to port 8787 works,
as long as Cloudflare proxies the hostname (Access only sees traffic that goes through
Cloudflare):

- **Cloudflare Tunnel, sidecar.** Uncomment the `cloudflared` service in `compose.yaml`,
  create a tunnel in Zero Trust > **Networks** > **Tunnels**, add a public hostname `HOST`
  pointing at `http://satchel:8787`, and put the tunnel token in `.env` as
  `CLOUDFLARE_TUNNEL_TOKEN`. The tunnel token is a secret.
- **An existing tunnel or reverse proxy.** Route `HOST` to the container's port 8787 as you
  would any other service.

Do not put another login in front of Satchel, such as a forward-auth middleware with its own
login page. OAuth clients cannot complete a login page that is not part of the OAuth flow;
Access is the only gate.

Test, from any machine:

```bash
curl -si https://HOST/healthz | head -5
```

Expected: `HTTP/2 200` and `ok` if nothing guards the hostname yet, or `HTTP/2 302` to a
`cloudflareaccess.com` login if an existing Access application (for example a wildcard one)
already covers it. `404` or `502` means the route does not reach the container.

## 3. Create the Access application

3.1 Zero Trust > **Access controls** > **Applications** > **Add an application** >
**Self-hosted**.

| Field                         | Value                    |
| ----------------------------- | ------------------------ |
| Application name              | `Satchel`                |
| Public hostname / destination | `HOST` (no path)         |
| Session duration              | `24h`, or your preference |

3.2 Add a policy: action **Allow**, rule **Include > Emails > your own email address**.
Nobody else: one server holds one person's memories. Do not add "Everyone".

3.3 Save. If a wildcard application already covers the hostname, this more specific one
takes precedence for `HOST`.

3.4 Copy the audience tag: the application's **Edit** > **Additional settings** >
**Application Audience (AUD) Tag**, a 64-character hex string. It is an identifier, not a
secret.

3.5 Find `TEAM`. It is the host in the login redirect Access now returns:

```bash
curl -sI https://HOST/healthz | sed -n 's/^[Ll]ocation: https:\/\/\([^/]*\).*/\1/p'
curl -s https://TEAM/cdn-cgi/access/certs | head -c 80     # {"keys": ...
```

3.6 Point the server at Access. In `.env`:

```
CF_ACCESS_TEAM_DOMAIN=<TEAM>
CF_ACCESS_AUD=<the AUD tag>
SATCHEL_TOKEN=
```

Then `docker compose up -d`. In production, leave `SATCHEL_TOKEN` empty: every client signs
in through OAuth.

## 4. Turn on Managed OAuth

The application's **Edit** > **Advanced settings** > **Managed OAuth**: on.

| Setting                 | Value                                     | Why                                                                 |
| ----------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| Allow localhost clients | on                                        | Claude Code and other CLI clients redirect to `http://localhost:<port>/callback` |
| Allow loopback clients  | on                                        | the same for `127.0.0.1`                                            |
| Allowed redirect URIs   | `https://claude.ai/api/mcp/auth_callback` | the callback claude.ai uses for web, Desktop and mobile             |
| Access token lifetime   | `15m`                                     | Cloudflare recommends 5 to 15 minutes                               |
| Grant session duration  | `336h` (two weeks)                        | how long a client stays signed in; Cloudflare recommends 1 to 2 weeks for CLI and agent use |

Dynamic client registration must end up enabled (the API field is
`dynamic_client_registration.enabled`); claude.ai and Claude Code register themselves.

Test, from a machine that is not logged in to Access:

```bash
curl -si https://HOST/mcp | head -12
```

Expected: `HTTP/2 401` with a `www-authenticate:` header carrying `resource_metadata="..."`.
Fetch that URL, then the authorization server metadata it names:

```bash
curl -s '<resource_metadata url>'; echo
curl -s '<authorization server metadata url>'; echo
```

Expected: JSON with `authorization_servers`, then JSON with `authorization_endpoint`,
`token_endpoint`, `registration_endpoint` and `"S256"` under
`code_challenge_methods_supported`. A `302` instead of the `401` means Managed OAuth is not
active on the application that covers `HOST`.

## 5. Connect clients

### Claude Code

Install the plugin from this repository (see `plugin/README.md`):

```
/plugin marketplace add <path-or-git-url-of-this-repo>
/plugin install satchel@satchel-plugins
```

Set `SATCHEL_URL=https://HOST` in the shell that starts Claude Code (it is not a secret),
restart Claude Code, run `/mcp`, select `satchel` and sign in with your email.

On a machine without a browser (a container, a remote shell), open the printed sign-in URL
on your own machine. The last redirect goes to `http://localhost:<port>/callback`, which
points at your machine, not the remote one, so that page may fail to load; paste the URL
from the address bar back into Claude Code when it asks for it.

Install `jq` on each machine. The plugin's hooks need only `sh` and `git`, but the hook that
fills project, branch and commit into the agent's calls needs `jq`. Why the hooks prompt the
agent instead of calling the server is in `docs/plugin-oauth.md`.

Test: start `claude` in a git repository and give it any task. It calls `brief` in its
first turn, and after a `git commit` it calls `checkpoint` with the new commit.

### claude.ai, Claude Desktop and mobile

Add a custom connector: **Customize > Connectors > Add > Add custom connector** (on Team or
Enterprise, an Owner adds it under **Organization settings > Connectors**).

| Field          | Value                                                    |
| -------------- | -------------------------------------------------------- |
| Name           | `Satchel`                                                |
| MCP server URL | `https://HOST/mcp`                                       |
| Authentication | **Sign in now**                                          |
| OAuth client   | **Register automatically** (Dynamic Client Registration) |

Leave request headers empty. Click Add, then Connect, and sign in with your email.
Authentication settings cannot be edited later: to change them, remove the connector and
add it again. Connectors belong to your account, so Desktop and mobile should list it under
**Connectors** too; if one shows it disconnected, connect it there and sign in again.

These clients do not show the server's MCP `instructions` to the model, so nothing tells
the model to load your memory except the `brief` tool description. Add a standing
instruction to your profile's personal preferences (claude.ai **Settings**):

```
At the start of every conversation, call the Satchel `brief` tool before answering, and
follow the "How to use this memory" rules it returns. Before writing code, load my coding
rules: call Satchel `recall` with tags ["code"] and the file types involved, all pages.
```

The brief ends with the rules for `recall`, `memorize` and `checkpoint`, so once it is
loaded the model has what Claude Code gets from the instructions. The second sentence
matters for coding: these clients have no hooks, so nothing else loads your coding rules
when the model starts writing code. In Claude Code the plugin does that (see
`plugin/README.md`).

Test, in a new chat with the connector switched on: "Call the Satchel brief tool."
Expected: the brief, ending with a "How to use this memory" section.

### Other MCP clients

Any client that speaks MCP over Streamable HTTP with OAuth (dynamic client registration and
PKCE) can connect to `https://HOST/mcp`. Clients that sign in from the command line use a
loopback redirect, which step 4 allows. A client that cannot open a browser at all needs one
of the options in `docs/plugin-oauth.md`, "Automatic options for later".

## 6. Back up the data directory

Everything lives in the data directory (`./data`, mounted at `/data`):

- `repo/` is a git repository and the source of truth. Every write through the server is a
  commit, so a copy of `repo/` alone is enough to rebuild everything else.
- `index.sqlite` is the search index plus the recall log. The index rebuilds from `repo/`;
  the recall log (which memories were used, by whom) does not. Do not copy it with a plain
  file copy while the server runs, since a live SQLite file can be captured half-written.
  Use a filesystem snapshot, or stop the container first.
- `models/` is the downloaded embedding model. Leave it out of backups.

Test a backup:

```bash
git -C data/repo log --oneline | head -3       # recent commits
git -C data/repo status --short                # empty unless you edited files by hand
```

To prove a restore, start a second container on a copy of `repo/` only: `brief` shows the
same topics and counts, and the recall log starts empty.

## Troubleshooting

- **The server answers `401` to a signed-in client.** The Access JWT failed validation:
  check `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` against step 3. Set
  `SATCHEL_LOG_LEVEL=debug` to log which credential headers a rejected request carried and
  why a JWT failed, never their values. The `401` itself never says why, on purpose.
- **claude.ai says "Couldn't reach the MCP server" or "Authorization with the MCP server
  failed".** Its requests come from Anthropic's IP range (`160.79.104.0/21`); a WAF or bot
  rule on the hostname can block the discovery or token endpoints. Check Cloudflare's
  security events for blocked requests from that range.
- **A client stops working after about two weeks.** The grant session from step 4 expired.
  Sign in again (`/mcp` in Claude Code; reconnect the connector in claude.ai).
- **Local development.** Run the server with `SATCHEL_TOKEN=dev` on loopback and add it to
  Claude Code with the token as a header; see the README and `plugin/README.md`.
