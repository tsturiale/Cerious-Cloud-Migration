# Cerious Systems

Clean rebuild of the Acme/Arbitek trading terminal architecture.

This root preserves the existing terminal workflow and trading IP while starting a new service layout:

- `apps/terminal` - Vite + React + TypeScript terminal UI.
- `services/gateway` - FastAPI terminal gateway on port `8000`.
- `services/price` - CME-only market data ingress boundary.
- `services/order`, `services/fill`, `services/sim_exchange`, `services/alert`, `services/algo_engine` - service seams for the rebuild.
- `shared`, `algos`, `legacy-domain` - copied trading logic, model definitions, and domain code from the stable Arbitek/Acme build.
- `assets/workspaces` - copied Acme workspace definitions.

The current local build exposes the same browser-facing contracts as the legacy terminal:

- UI: `http://127.0.0.1:5173`
- Gateway: `http://127.0.0.1:8000`
- WebSocket: `/ws/{asset}?provider=polymarket`

The provider key remains `polymarket` internally only to preserve frontend compatibility. In Cerious, that surface is labeled and served as CME.

## Local Run

Backend:

```powershell
python -m uvicorn services.gateway.main:app --reload --host 127.0.0.1 --port 8000
```

Frontend:

```powershell
cd apps/terminal
npm install
npm run dev
```

## CME Ingress

Set `DATABENTO_API_KEY` to activate live Databento CME MBP-1 ingest. Without a key, the price service runs a deterministic CME simulator so the local terminal can be tested immediately.

Optional settings:

```powershell
$env:DATABENTO_API_KEY="..."
$env:CERIOUS_CME_DATASET="GLBX.MDP3"
$env:CERIOUS_CME_SCHEMA="mbp-1"
$env:CERIOUS_CME_SYMBOLS="ES.v.0,NQ.v.0,YM.v.0,RTY.v.0,CL.v.0,GC.v.0,ZM.v.0,ZS.v.0"
```

## T4 Ingress Probe

T4 WebSocket ingress is available behind the same price-service `Quote` contract. It is disabled by default so the current Databento path remains stable.

The official CTS/T4 protobuf sources are vendored at `vendor/t4/proto`. Regenerate the Python protobuf package after schema updates with:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe tools\compile_t4_protos.py
```

For CTS SIM username/password auth, add local credentials in `.env`:

```powershell
CERIOUS_PRICE_PROVIDER=t4
T4_AUTH_MODE=user_password
T4_FIRM=CTS
T4_USERNAME=your-username
T4_PASSWORD=your-password
T4_APP_NAME=your-app-name
T4_APP_LICENSE=your-app-license
T4_WS_URL=wss://wss-sim.t4login.com/v1
T4_API_URL=https://api-sim.t4login.com
T4_EXCHANGE_ID=CME_Eq
T4_CONTRACTS=ES,NQ,YM,RTY
```

For API-key auth, use `T4_AUTH_MODE=api_key` and `T4_API_KEY=your-key`.

For exact T4 market coordinates, use:

```powershell
T4_MARKETS=ES=CME_Eq:ES:XCME_C ES (M25);NQ=CME_Eq:NQ:...
```

Smoke test without the UI:

```powershell
.\.venv\Scripts\python.exe -m services.price.t4_probe --count 3 --timeout 45
```
