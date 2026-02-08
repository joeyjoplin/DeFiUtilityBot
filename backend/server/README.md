# Backend Server

**Purpose**
Express server that issues invoices for utility services and verifies on-chain payments from the ExpenseVault before unlocking the service.

**How It Works**
- Client calls a purchase endpoint with a business case and parameters.
- Server returns HTTP 402 with `payment_required` instructions for `ExpenseVault.spend(...)`.
- Client (agent) submits the on-chain spend and then calls confirm.
- Server verifies the `Spent` event in the transaction receipt and returns a success response.

**Key Endpoints**
- `GET /health`: status and configured addresses.
- `POST /m2m/purchase`: unified invoice creation for `gas_station`, `vending_machine`, or `laundry`.
- `POST /m2m/confirm`: verifies on-chain spend by `txHash` and unlocks service.
- `POST /fuel/purchase`: legacy gas station flow.
- `POST /fuel/confirm`: legacy confirm flow.
- `POST /vending/purchase`: legacy vending flow.
- `POST /laundry/purchase`: legacy laundry flow.
- `GET /m2m/invoice/:id`: debug invoice info.

**Configuration**
Set these in `backend/server/.env`:
- `BASE_SEPOLIA_RPC_URL`
- `VAULT_ADDRESS`
- `MERCHANT_ADDRESS`
- `OWNER_ADDRESS`
- `SPENDER_ADDRESS` (optional)
- `PORT` (optional, default `3001`)

**Run**
```bash
cd backend/server
npm install
npm run dev
```

**Notes**
- The server expects USDC on Base Sepolia and validates `Spent` events from the vault.
- If `SPENDER_ADDRESS` is set, the server enforces the tx sender.
