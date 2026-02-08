import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "viem";
import { baseSepolia } from "wagmi/chains";

const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || 'TEMP_PROJECT_ID';
const baseSepoliaRpc = process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org";

export const wagmiConfig = getDefaultConfig({
    appName: 'AIDeFiFuel',
    projectId,
    chains: [baseSepolia],
    transports: {
        [baseSepolia.id]: http(baseSepoliaRpc),
    },
    ssr: true,
})
