export type VaultAdapter = {
  fund(amountUsdc: string): Promise<void>;
  withdraw(amountUsdc: string): Promise<void>;
  getVaultBalanceUsdc?: () => Promise<number>;
};
