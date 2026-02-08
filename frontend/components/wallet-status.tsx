'use client'

import { formatUnits } from "viem/utils"
import { useAccount, useBalance, useChainId, useChains } from "wagmi"

function short(address?: string) {
    if (!address) return ''
    return address.slice(0, 6) + '...' + address.slice(-4)
}

export default function WalletStatus() {
    const { address, isConnected } = useAccount()
    const chainId = useChainId()
    const chains = useChains()

    const currentChain = chains.find(chain => chain.id === chainId)

    const { data: balanceData, isLoading: isBalanceLoading } = useBalance({
        address,
        query: { enabled: Boolean(address) },
    })

    if (!isConnected) {
        return <div>Not connected</div>
    }

    return (
        <div>
            <div>
                Address: <code>{short(address)}</code>
            </div>
            <div>
                Network: {currentChain?.name ?? `Chain ID ${chainId}`}
            </div>
            <div>
                Balance: {isBalanceLoading
                    ? 'Loading…'
                    : balanceData
                        ? `${Number(formatUnits(balanceData.value, balanceData.decimals)).toFixed(4)} ${balanceData.symbol}`
                        : '—'}
            </div>
        </div>
    )
}