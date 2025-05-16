import "@rainbow-me/rainbowkit/styles.css";
import { walletConnectWallet } from '@rainbow-me/rainbowkit/wallets';
import { http, WagmiProvider } from "wagmi";
import { getDefaultConfig } from "@rainbow-me/rainbowkit";

import { celo, celoAlfajores} from "wagmi/chains";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const wallets = [
  {
    groupName: 'Recommended',
    wallets: [walletConnectWallet],
  },
];

const projectId = process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "";
if (!projectId) {
  console.warn("WalletConnect Project ID is needed");
}

export const config = getDefaultConfig({
  appName: "Buy Hypercert",
  projectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "",
  chains: [celo, celoAlfajores],
  transports: {
    [celo.id]: http("https://celo-mainnet.g.alchemy.com/v2/4FF6xgfo305aOiFhplzY7M6AaWWZMmg_"),
    [celoAlfajores.id]: http("https://celo-alfajores.g.alchemy.com/v2/4FF6xgfo305aOiFhplzY7M6AaWWZMmg_"),
  },
  wallets,
  ssr: true,
});

const queryClient = new QueryClient();

export default function Provider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
