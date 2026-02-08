# Frontend

**Purpose**
Next.js UI for the AIDeFiFuel demo. Connects a wallet, displays vault status, and drives the utility payment flow.

**Run**
```bash
cd frontend
npm install
npm run dev
```
UI runs on `http://localhost:3000` by default.

**Configuration**
Set these in your environment as needed:
- `NEXT_PUBLIC_WC_PROJECT_ID` for WalletConnect (see `frontend/wallet/wagmi.ts`).

**Tech Stack**
- Next.js + React
- RainbowKit + wagmi + viem for wallet and chain interactions
