# Smart Contracts

**Purpose**
On-chain ExpenseVault that holds user funds, enforces spend policies for utility agents, and optionally invests idle balances into a liquidity pool strategy.

**Core Contracts**
- `ExpenseVault.sol`: USDC vault with delegated spend policies, merchant whitelists, and EIP-712 signatures.
- `LiquidityPoolStrategy.sol`: strategy adapter that deposits vault idle funds into a pool.
- `SimulatedLiquidityPool.sol`: simple yield simulator for tests and demos.
- `IERC20.sol`: minimal ERC-20 interface.

**Architecture Notes**
- Users deposit USDC and receive vault shares.
- Policies allow a `spender` to pay `merchant` addresses under limits.
- `rebalance()` moves idle funds to the strategy while keeping a reserve in the vault.

**Commands**
```bash
cd backend/smartcontract
forge build
forge test
forge fmt
```

**Deploy (example)**
```bash
cd backend/smartcontract
forge script script/DeployAndSetup.s.sol --rpc-url "$RPC_URL" --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
```

**Configuration**
Set these in `backend/smartcontract/.env`:
- `RPC_URL`
- `DEPLOYER_PRIVATE_KEY`
- `OWNER_PRIVATE_KEY`
