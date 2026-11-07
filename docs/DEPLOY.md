# Deploying SAKA

The backend runs on one Azure VM with Docker Compose, and the web app runs on Vercel.

| Where    | What runs there                                               |
| -------- | ------------------------------------------------------------- |
| Azure VM | `api`, `worker`, `bot`, `mcp`, Postgres, Redis, Caddy (HTTPS) |
| Vercel   | Web app                                                       |

The hosted app runs as **staging**: `NODE_ENV=development` with dev sign-in and dev approvals.
Dev sign-in has no password, so anyone who enters a name gets that account. Use testnet funds only.
To go to production mode, set `NODE_ENV=production`, `AUTH_MODE=passkey`, `APPROVAL_MODE=passkey`
and `ALLOW_DEV_PROVIDERS=false`. Passkeys are locked to the `WEB_URL` domain, so settle the domain
first.

The compose file is [`deploy/azure/docker-compose.yml`](../deploy/azure/docker-compose.yml). Railway
configs are also kept in [`deploy/railway/`](../deploy/railway/README.md).

## 1. Create the VM

In the [Azure portal](https://portal.azure.com), choose **Create a resource → Virtual machine**.

| Field          | Value                                                                |
| -------------- | -------------------------------------------------------------------- |
| Subscription   | Azure for Students                                                   |
| Resource group | Create new: `saka-rg`                                                |
| VM name        | `saka-vm`                                                            |
| Region         | One your subscription allows (see below)                             |
| Image          | Ubuntu Server 24.04 LTS, x64                                         |
| Size           | `Standard_B2s` (2 vCPU, 4 GB). Any x64 size with at least 2 GB works |
| Authentication | Password, username `azureuser`, a long unique password               |
| Inbound ports  | Allow SSH (22), HTTP (80), HTTPS (443)                               |
| OS disk        | Standard SSD, 30 GB or more                                          |

To find your allowed regions, open **Policy → Assignments → Allowed resource deployment regions**
and read its parameters. If you see `RequestDisallowedByAzure` or a size is unavailable, try another
allowed region.

## 2. Give the VM a DNS name

1. Open the VM, then select its **Public IP address**.
2. Under **Configuration**, set **DNS name label** to something unique, such as `saka-api-demo`.
3. Save, then copy the full name, for example `saka-api-demo.centralindia.cloudapp.azure.com`.

This is your `API_DOMAIN`. The API URL is `https://` followed by that name.

## 3. Deploy the web app on Vercel

1. Import `Ayush-Bansal08/SAKA` at [vercel.com/new](https://vercel.com/new).
2. Set **Root Directory** to `apps/web`. Leave the build settings alone: `vercel.json` sets them.
3. Add the environment variable `VITE_API_URL` = `https://<API_DOMAIN>`, with no trailing slash.
4. Deploy, then copy the production URL, for example `https://saka-web.vercel.app`.

Vite bakes `VITE_API_URL` in at build time, so changing it later needs a redeploy.

## 4. Fill in the settings file

Edit `deploy/azure/.env` (git-ignored; copy `.env.example` if you are starting from a clean clone):

```env
API_DOMAIN=saka-api-demo.centralindia.cloudapp.azure.com
WEB_URL=https://saka-web.vercel.app
```

`API_DOMAIN` has no `https://`. `WEB_URL` has `https://` and no trailing slash, and must match the
Vercel production URL exactly or the browser blocks every request. The file also needs
`POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `ADMIN_TOKEN`, `MCP_AUTH_TOKEN` and `MCP_RESUME_SECRET`.

## 5. Prepare the VM

Connect from PowerShell, using your DNS name:

```powershell
ssh azureuser@<API_DOMAIN>
```

Then run on the VM:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker azureuser
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
git clone https://github.com/Ayush-Bansal08/SAKA.git
exit
```

## 6. Copy the settings file to the VM

Run this in PowerShell from the repo root:

```powershell
scp deploy\azure\.env azureuser@<API_DOMAIN>:SAKA/deploy/azure/.env
```

## 7. Start everything

Stop any local `pnpm dev` first: two bots polling one Telegram token conflict. Then:

```powershell
ssh azureuser@<API_DOMAIN>
```

```bash
cd ~/SAKA/deploy/azure
sed -i 's/\r$//' .env
docker compose up -d --build
docker compose ps -a
```

The first build takes several minutes. `migrate` should show `exited (0)`, and every other service
should show `running`. Then open `https://<API_DOMAIN>/health`, which should answer `"status":"ok"`
with the database and Redis up.

## 8. Test the live app

1. Open the Vercel URL and sign in as `demo`.
2. Create the agent wallet, then send it Sepolia ETH. It is detected in about 15 seconds.
3. **"Swap $5 ETH to USDC"** should execute and show the 0G request ID and receipt.
4. **"Swap $60 ETH to USDC"** should ask for approval.
5. **"Swap $500 ETH to USDC"** should be refused.
6. Run a scenario in **Autopilot → Simulator**.
7. Link Telegram in Settings and confirm an alert arrives.
8. Confirm the decision log gets a 0G Storage hash.

## Operating it

Run these from `~/SAKA/deploy/azure` on the VM:

| Task                | Command                                            |
| ------------------- | -------------------------------------------------- |
| See service state   | `docker compose ps -a`                             |
| Follow logs         | `docker compose logs -f --tail=100 api worker bot` |
| Deploy new code     | `git pull && docker compose up -d --build`         |
| Apply new settings  | `docker compose up -d`                             |
| Restart one service | `docker compose restart worker`                    |

Changing `WEB_URL` only needs `docker compose up -d`. Keep `POSTGRES_PASSWORD` and `ENCRYPTION_KEY`
unchanged after the first start: the database keeps its original password, and data encrypted with
the old key cannot be read with a new one.

**Rotating keys:** change the value in `deploy/azure/.env`, copy it to the VM, and run
`docker compose up -d`. For the 0G, Uniswap, Privy and Telegram keys, revoke the old one at the
provider afterwards.

**Costs:** the VM bills while it runs. Stopping it from the Azure portal (deallocated) stops compute
charges, and the Docker volumes survive a restart. Delete `saka-rg` when you are finished.

## Troubleshooting

| Symptom                                 | Check                                                                                                |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/health` does not load or has no HTTPS | `docker compose logs caddy`. Ports 80 and 443 must be open, and `API_DOMAIN` must match the DNS name |
| Browser shows CORS errors               | `WEB_URL` must exactly match the Vercel URL, then run `docker compose up -d`                         |
| Web app calls `localhost`               | Set `VITE_API_URL` on Vercel and redeploy                                                            |
| A service keeps restarting              | `docker compose logs <service>`. Missing settings are listed by name at startup                      |
| Telegram 409 conflict in `bot` logs     | The same bot token is running somewhere else; stop it                                                |
| Build is killed or very slow            | Confirm swap is on with `free -h`                                                                    |
| GeckoTerminal 429 retries in `mcp` logs | Harmless: it is a rate-limited fallback data source                                                  |
