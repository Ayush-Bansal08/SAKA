> ## Documentation Index
> Fetch the complete documentation index at: https://docs.privy.io/llms.txt
> Use this file to discover all available pages before exploring further.

# Interfacing with common libraries

> [!NOTE]
>
> If you are looking to integrate Privy with a Solana library instead, please see our [Solana web3
> integrations guide](https://docs.privy.io/wallets/using-wallets/solana/kit-integrations.md).

**React**

> [!TIP]
>
> Privy is fully compatible with popular web3 libraries for interfacing wallets, including [`viem`](https://viem.sh/), [`wagmi`](https://wagmi.sh/), [`ethers`](https://docs.ethers.org/), and [`web3js`](https://web3js.readthedocs.io/en/v1.10.0/).

Read below to learn how to best integrate Privy alongside these libraries.

## Viem

Viem represents connected wallets as either an [**account**](https://viem.sh/docs/accounts/local.html) object, which can sign with the wallet, or a [**wallet client**](https://viem.sh/docs/clients/wallet.html) object, which can also send transactions from the wallet.

### Getting an account

To get an account for a user's connected wallet, import the `toViemAccount` method and the `useWallets` hook from the React SDK.

```tsx theme={"system"}
import {toViemAccount, useWallets} from '@privy-io/react-auth';
```

Then, pass the `ConnectedWallet` object for your user's wallet to the method, which will return a `LocalAccount` instance.

```tsx theme={"system"}
const {wallets} = useWallets();

const wallet = wallets.find((wallet) => (wallet.address === 'your-desired-address'));
const account = await toViemAccount({wallet});
```

You can then use the `account` to sign messages, typed data payloads, and transactions.

### Getting a wallet client

To get a viem wallet client for a user's connected wallet, first import your desired network from the **`viem/chains`** package and import the **`createWalletClient`** method and **`custom`** transport from **`viem`**:

```tsx theme={"system"}
import {createWalletClient, custom} from 'viem';
// Replace `sepolia` with your desired network
import {sepolia} from 'viem/chains';
```

Then, find your desired wallet from the **`wallets`** array and switch its network to the chain you imported, using the wallet's **`switchChain`** method:

```tsx theme={"system"}
const {wallets} = useWallets();
const wallet = wallets[0]; // Replace this with your desired wallet
await wallet.switchChain(sepolia.id);
```

Lastly, get the wallet's EIP1193 provider using the wallet's **`getEthereumProvider`** method and pass it to viem's **`createWalletClient`** method like so:

```tsx theme={"system"}
const provider = await wallet.getEthereumProvider();
const walletClient = createWalletClient({
    account: wallet.address as Hex,
    chain: sepolia,
    transport: custom(provider),
});
```

You can then use the [**wallet client**](https://viem.sh/docs/clients/wallet) to get information about the wallet or request signatures and transactions.

## Wagmi

Privy is fully compatible with **`wagmi`**. Please see our [**wagmi guide**](https://docs.privy.io/wallets/connectors/ethereum/integrations/wagmi.md) for setting up the integration.

## Ethers

### Ethers v5

```tsx theme={"system"}
const privyProvider = await wallet.getEthereumProvider();
const provider = new ethers.providers.Web3Provider(privyProvider);
```

### Ethers v6

```tsx theme={"system"}
const provider = await wallet.getEthereumProvider();
const ethersProvider = new ethers.BrowserProvider(provider);
const signer = ethersProvider.getSigner();
```

## Web3.js

Web3.js represents connected wallets as a [**Web3**](https://docs.web3js.org/guides/web3_providers_guide/#providers-types) object, which you can use to get information about the current wallet or the request signatures and transactions.

To get a Web3js provider for a user's connected wallet, first [find your desired wallet](https://docs.privy.io/wallets/wallets/get-a-wallet/get-connected-wallet.md) from the **`wallets`** array and switch it to your desired network, using the wallet's **`switchChain`** method:

```ts theme={"system"}
const {wallets} = useWallets();
const wallet = wallets[0]; // Replace this with your desired wallet
await wallet.switchChain(sepolia.id);
```

Then, get the wallet's EIP1193 provider using the wallet's **`getEthereumProvider`** method and pass it to Web3js's **`Web3`** constructor like so:

```ts theme={"system"}
const provider = await wallet.getEthereumProvider();
const web3 = new Web3(provider);
```

You can then use the [**Web3 provider**](https://docs.web3js.org/guides/web3_providers_guide/) to get information about the wallet or request signatures and transactions.

**React Native**

> [!TIP]
>
> Privy is fully compatible with popular web3 libraries for interfacing wallets, including [`viem`](https://viem.sh/), [`ethers`](https://docs.ethers.org/), and [`web3js`](https://web3js.readthedocs.io/en/v1.10.0/).

> [!WARNING]
>
> Third-party libraries may require additional shims to be used in a React Native environment.

### Integrating with `viem`

First, import the necessary methods, objects, and networks from `viem`:

```ts theme={"system"}
import {createWalletClient, custom} from 'viem';
// Replace 'mainnet' with your desired network
import {mainnet} from 'viem/chains';
```

Next, get an EIP-1193 provider for the user's embedded wallet, and switch its network to your desired network:

```ts theme={"system"}
const provider = await wallet.getProvider();
await provider.request({
    method: 'wallet_switchEthereumChain',
    // Replace '0x1' with the chain ID of your desired network
    params: [{chainId: '0x1'}],
});
```

Lastly, initialize a viem Wallet Client from the EIP-1193 provider:

```ts theme={"system"}
const walletClient = createWalletClient({
    // Replace this with your desired network that you imported from viem
    chain: mainnet,
    transport: custom(provider),
});
```

You can now use methods implemented by viem's [Wallet Client](https://viem.sh/docs/clients/wallet.html), including [`signMessage`](https://viem.sh/docs/actions/wallet/signMessage.html#signmessage), [`signTypedData`](https://viem.sh/docs/actions/wallet/signTypedData.html#signtypeddata), and [`sendTransaction`](https://viem.sh/docs/actions/wallet/sendTransaction.html#sendtransaction)!

### Integrating with `ethers`

First, import `ethers`:

```ts theme={"system"}
import {ethers} from 'ethers';
```

Next, get an EIP-1193 provider for the user's embedded wallet, and switch its network to your desired network:

```ts theme={"system"}
await provider.request({
    method: 'wallet_switchEthereumChain',
    // Replace '0x1' with the chain ID of your desired network
    params: [{chainId: '0x1'}],
});
```

Lastly, initialize an ethers provider and signer from this EIP-1193 provider:

```ts theme={"system"}
const ethersProvider = new ethers.providers.Web3Provider(provider);
const ethersSigner = ethersProvider.getSigner();
```

You can then use methods implemented by ethers' [providers](https://docs.ethers.org/v5/api/providers/) and [signers](https://docs.ethers.org/v5/api/signer/), including [`signMessage`](https://docs.ethers.org/v5/api/signer/#Signer-signMessage) and [`sendTransaction`](https://docs.ethers.org/v5/api/signer/#Signer-sendTransaction).

### Integrating with `web3.js`

First, import `web3`:

```ts theme={"system"}
import {Web3} from 'web3';
```

Next, get an EIP-1193 provider for the user's embedded wallet, and switch its network to your desired network:

```ts theme={"system"}
await wallet.provider.request({
    method: 'wallet_switchEthereumChain',
    // Replace '0x1' with the chain ID of your desired network
    params: [{chainId: '0x1'}],
});
```

Lastly, initialize an ethers provider and signer from this EIP-1193 provider:

```ts theme={"system"}
const web3 = new Web3(wallet.getEthereumProvider());
```

You can then use interfaces by web3.js for [signing messages](https://docs.web3js.org/guides/wallet/signing), [sending transactions](https://docs.web3js.org/guides/wallet/transactions), and [more](https://docs.web3js.org/guides/web3_eth/eth).

**NodeJS**

### Viem

[`viem`](https://viem.sh/docs/accounts/local.html) is a popular TypeScript library on EVM for executing onchain actions with wallets. Privy's wallets on EVM natively integrate with `viem`, allowing you to use the library's interfaces for signing messages, signing typed data, sending transactions, and more.

To integrate with `viem`, first install version `2^` of the library as a peer dependency:

```sh theme={"system"}
npm i viem@latest
```

Then, use Privy's `createViemAccount` method to initialize an instance of a viem [`Account`](https://viem.sh/docs/accounts/local) for an EVM wallet. As a parameter to this method, pass an object with the following:

| Field | Type | Description |
| - | - | - |
| `privy` | `PrivyClient` | Instance of the Privy client for your app. |
| `walletId` | `string` | ID of the wallet. |
| `address` | `0x${string}` | Ethereum address of the wallet. |

As an example, you can initialize an `Account` like so:

```tsx theme={"system"}
import {PrivyClient} from '@privy-io/node';
import {createViemAccount} from '@privy-io/node/viem';

// Initialize your Privy client
const privy = new PrivyClient(...);
// Create a viem account instance for a wallet
const account = await createViemAccount(privy, {
    walletId: 'insert-wallet-id',
    address: 'insert-address'
});
```

> [!TIP]
>
> If your wallet requires an [authorization context](https://docs.privy.io/controls/authorization-keys/using-owners/sign/signing-on-the-server.md),
> you should pass it to the `createViemAccount` method like so:
>
> ```tsx theme={"system"}
> const serverWalletAccount = await createViemAccount(privy, {
>   walletId: 'insert-wallet-id',
>   address: 'insert-address',
>   authorizationContext: {
>     authorization_private_keys: ['your authorization private key']
>   }
> });
> ```

From the returned `Account`, you can then initialize a viem [`WalletClient`](https://viem.sh/docs/clients/wallet) to sign messages and execute transactions with the wallet like so:

```tsx theme={"system"}
import {createWalletClient, http, parseEther} from 'viem';
import {base} from 'viem/chains';

const client = createWalletClient({
    account, // `Account` instance from above
    chain: base, // Replace with your desired network
    transport: http()
});

const hash = await client.sendTransaction({
    to: '0x59D3eB21Dd06A211C89d1caBE252676e2F3F2218',
    value: parseEther('0.001')
});
```

**Rust**

### Alloy

[`alloy`](https://alloy.rs/) is a comprehensive Rust library for Ethereum that provides type-safe, high-performance blockchain interactions. Privy's Rust SDK integrates seamlessly with alloy, allowing you to leverage alloy's powerful types and utilities while using Privy for wallet management and signing.

Coming soon.
