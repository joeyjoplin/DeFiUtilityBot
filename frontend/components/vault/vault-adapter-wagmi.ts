import { writeContract, waitForTransactionReceipt, readContract } from "@wagmi/core";
import { parseUnits } from "viem";
import { wagmiConfig } from "../../wallet/wagmi";
import { EXPENSE_VAULT_ABI } from "../lib/contracts/expense-vault";
import type { VaultAdapter } from "./vault-adapter";

const USDC_DECIMALS = 6;
const ERC20_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function toUsdcUnits(amountUsdc: string) {
  return parseUnits(amountUsdc, USDC_DECIMALS);
}

function calculateSharesForWithdrawal(usdcAmount: bigint, totalShares: bigint, totalAssets: bigint
) {
  return (usdcAmount * totalShares + totalAssets - 1n) / totalAssets;
}

export function createWagmiVaultAdapter(opts: {
  ownerAddress?: `0x${string}`;
  vaultAddress: `0x${string}`;
  tokenAddress: `0x${string}`;
}): VaultAdapter {
  const { ownerAddress, vaultAddress, tokenAddress } = opts;
  return {
    async fund(amountUsdc: string) {
      const amount = toUsdcUnits(amountUsdc);

      const approveHash = await writeContract(wagmiConfig, {
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [vaultAddress, amount],
      });
      await waitForTransactionReceipt(wagmiConfig, { hash: approveHash });

      const hash = await writeContract(wagmiConfig, {
        address: vaultAddress,
        abi: EXPENSE_VAULT_ABI,
        functionName: "deposit",
        args: [amount],
      });

      await waitForTransactionReceipt(wagmiConfig, { hash });
    },

    async withdraw(amountUsdc: string) {
      if (!ownerAddress) {
        throw new Error("Wallet not connected");
      }

      const amount = toUsdcUnits(amountUsdc);

      if (amount <= 0n) throw new Error("Invalid amount");

      const [totalSupply, totalAssets, userShares] = await Promise.all([
        readContract(wagmiConfig, {
          address: vaultAddress,
          abi: EXPENSE_VAULT_ABI,
          functionName: "totalSupply",
        }) as Promise<bigint>,
        readContract(wagmiConfig, {
          address: vaultAddress,
          abi: EXPENSE_VAULT_ABI,
          functionName: "totalAssets",
        }) as Promise<bigint>,
        readContract(wagmiConfig, {
          address: vaultAddress,
          abi: EXPENSE_VAULT_ABI,
          functionName: "balanceOf",
          args: [ownerAddress],
        }) as Promise<bigint>,
      ]);

      if (totalSupply === 0n || totalAssets === 0n) {
        throw new Error("Vault is empty");
      }
      
      let sharesToWithdraw = calculateSharesForWithdrawal(amount, totalSupply, totalAssets);

      if (sharesToWithdraw > userShares) sharesToWithdraw = userShares;
      if (sharesToWithdraw <= 0n) throw new Error("Insufficient shares");

      const hash = await writeContract(wagmiConfig, {
        address: vaultAddress,
        abi: EXPENSE_VAULT_ABI,
        functionName: "withdraw",
        args: [sharesToWithdraw],
      });

      await waitForTransactionReceipt(wagmiConfig, { hash });
    },
  };
}
