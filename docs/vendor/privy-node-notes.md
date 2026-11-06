> ## Documentation Index
> Fetch the complete documentation index at: https://docs.privy.io/llms.txt
> Use this file to discover all available pages before exploring further.

# Quickstart

> Learn how to create users, embedded wallets, and send transactions in your NodeJS app using PrivyClient

## 0. Prerequisites

This guide assumes that you have completed the [Setup](https://docs.privy.io/basics/nodeJS/setup.md) guide,
to get a Privy client instance, `privy`.

## 1. Creating a wallet

First, we will create a wallet.
You will use this wallet's `id` in future calls to sign messages and send transactions.

> [tab] Ethereum
>
> ```ts theme={"system"}
> import { APIError, PrivyAPIError } from '@privy-io/node';
>
> try {
>   const createdWallet = await privy.wallets().create({chain_type: 'ethereum'});
>   const walletId = createdWallet.id;
> } catch (error) {
>   if (error instanceof APIError) {
>     // When the library is unable to connect to the API,
>     // or if the API returns a non-success status code (i.e., 4xx or 5xx response),
>     // a subclass of `APIError` will be thrown:
>     console.log(error.status); // 400
>     console.log(error.name); // BadRequestError
>   } else if (error instanceof PrivyAPIError) {
>     // Other errors from the Privy SDK all subclass `PrivyAPIError`.
>     console.log(error.message);
>   } else {
>     // This error is not related to the Privy SDK.
>     throw error;
>   }
> }
> ```

> [tab] Solana
>
> ```ts theme={"system"}
> import { APIError, PrivyAPIError } from '@privy-io/node';
>
> try {
>   const createdWallet = privy.wallets().create({chain_type: 'solana'});
>   const walletId = createdWallet.id;
> } catch (error) {
>   if (error instanceof APIError) {
>     // When the library is unable to connect to the API,
>     // or if the API returns a non-success status code (i.e., 4xx or 5xx response),
>     // a subclass of `APIError` will be thrown:
>     console.log(error.status); // 400
>     console.log(error.name); // BadRequestError
>   } else if (error instanceof PrivyAPIError) {
>     // Other errors from the Privy SDK all subclass `PrivyAPIError`.
>     console.log(error.message);
>   } else {
>     // This error is not related to the Privy SDK.
>     throw error;
>   }
> }
> ```

> [!TIP]
>
> [Learn more](https://docs.privy.io/wallets/wallets/create/create-a-wallet.md) about creating wallets.

> [!NOTE]
>
> When using the `PrivyClient` to work with the API, all errors thrown will be instances of
> `APIError` or `PrivyAPIError`. You should catch these errors and handle them accordingly, using
> the error's `status`, `name` and `message`.

### User wallets

You can create a non-custodial user wallet using the SDK. First, create a user, then provision a wallet for that user.

> [tab] Ethereum
>
> ```ts theme={"system"}
> try {
>   const user = await privy.users().create({
>     linked_accounts: [{type: 'email', address: 'batman@privy.io'}],
>   });
>
>   const {id, address, chain_type} = await privy.wallets().create({
>     chain_type: 'ethereum',
>     owner: {user_id: user.id}
>   });
>
> } catch (error) {
>   console.error(error);
> }
> ```

> [tab] Solana
>
> ```ts theme={"system"}
> try {
>   const user = await privy.users().create({
>     linked_accounts: [{type: 'email', address: 'batman@privy.io'}],
>   });
>
>  const {id, address, chain_type} = await privy.wallets().create({
>     chain_type: 'solana',
>     owner: {user_id: user.id}
>   });
>
> } catch (error) {
>   console.error(error);
> }
> ```

> [!NOTE]
>
> If you are creating a user wallet, you must specify the user ID as the owner of the wallet. You can obtain a user ID by first [creating a user](https://docs.privy.io/user-management/migrating-users-to-privy/create-or-import-a-user.md) before creating the wallet.
>
> Or, you can [create a user and wallet at the same time](https://docs.privy.io/user-management/migrating-users-to-privy/create-or-import-a-user.md).

## 2. Signing a message

Next, we'll sign a plaintext message with the wallet using the `signMessage` method.
Make sure to specify your wallet ID (not address) from creation in the input.

> [tab] Ethereum
>
> ```ts theme={"system"}
> try {
>   const message = "Hello, Privy!";
>
>   const response = await privy.wallets().ethereum().signMessage(walletId, { message });
>   // Signature is hex-encoded for Ethereum
>   const signature = response.signature;
> } catch (error) {
>   if (error instanceof APIError) {
>     console.log(error.status, error.name);
>   } else if (error instanceof PrivyAPIError) {
>     console.log(error.message);
>   } else {
>     throw error;
>   }
> }
> ```

> [tab] Solana
>
> ```ts theme={"system"}
> try {
>   const message = "Hello, Privy!";
>   // Solana requires the message to be base64 encoded
>   const base64Message = Buffer.from(message, 'utf8').toString('base64')
>
>   const response = await privy.wallets().solana().signMessage(walletId, { message: base64Message });
>   // Signature is base64-encoded for Solana
>   const signature = response.signature;
> } catch (error) {
>   if (error instanceof APIError) {
>     console.log(error.status, error.name);
>   } else if (error instanceof PrivyAPIError) {
>     console.log(error.message);
>   } else {
>     throw error;
>   }
> }
> ```

> [!TIP]
>
> [Learn more](https://docs.privy.io/wallets/using-wallets/ethereum/sign-a-message.md) about signing messages.

## 3. Sending transactions

> [!NOTE]
>
> Your wallet must have some funds in order to send a transaction. You can use a testnet
> [faucet](https://console.optimism.io/faucet) to test transacting on a testnet (e.g. Base Sepolia)
> or send funds to the wallet on the network of your choice.

To send a transaction from your wallet, use the `sendTransaction` method.
It will populate missing network-related values (gas limit, gas fee values, nonce, type), sign your
transaction, broadcast it to the network, and return the transaction hash to you.

In the request, make sure to specify your wallet `id` from your wallet creation above, as well as
the `caip2` chain ID and `chain_id` values for the network you want to transact on.
Also, input your recipient or smart contract address in the `to` field.

> [tab] Ethereum
>
> ```ts theme={"system"}
> try {
>     const caip2 = "eip155:11155111"; // Sepolia testnet
>
>     const response = await privy.wallets().ethereum().sendTransaction(walletId, {
>       caip2,
>       params: {
>         transaction: {
>           to: recipientAddress,
>           value: "0x1", // 1 wei
>           chain_id: 11_155_111, // Sepolia testnet
>         },
>       },
>     });
>     const transactionHash = response.hash;
> } catch (error) {
>   if (error instanceof APIError) {
>     console.log(error.status, error.name);
>   } else if (error instanceof PrivyAPIError) {
>     console.log(error.message);
>   } else {
>     throw error;
>   }
> }
> ```

> [tab] Solana
>
> ```ts theme={"system"}
> try {
>     const caip2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // Solana Mainnet
>
>     // A base64 encoded serialized transaction to sign
>     const transaction = "insert-base-64-encoded-serialized-transaction";
>
>     const response = await privy.wallets().solana().signAndSendTransaction(walletId, {
>       caip2,
>       transaction,
>     });
>     const transactionHash = response.hash;
> } catch (error) {
>   if (error instanceof APIError) {
>     console.log(error.status, error.name);
>   } else if (error instanceof PrivyAPIError) {
>     console.log(error.message);
>   } else {
>     throw error;
>   }
> }
> ```

> [!TIP]
>
> [Learn more](https://docs.privy.io/wallets/using-wallets/ethereum/send-a-transaction.md) about sending transactions.

> [!TIP]
>
> If you’re interested in more control, you can prepare and broadcast the transaction yourself, and
> simply use `eth_signTransaction` ([EVM](https://docs.privy.io/wallets/using-wallets/ethereum/sign-a-transaction.md)) and
> `signTransaction` ([Solana](https://docs.privy.io/wallets/using-wallets/solana/sign-a-transaction.md)) RPCs to sign the
> transaction with a wallet.

## 4. Creating a user

To create a user for your application, you can use the `create` method, passing in
a `UserCreateRequestBody` object, which allows you to specify the linked accounts, custom metadata,
and wallets that should be associated with said user.

```ts theme={"system"}
import {APIError, PrivyAPIError, PrivyClient} from '@privy-io/node';

const privy = new PrivyClient({appId: 'insert-your-app-id', appSecret: 'insert-your-app-secret'});

try {
  const user = await privy.users().create({
    linked_accounts: [
      {type: 'custom_auth', custom_user_id: '$SUBJECT_ID'},
      {type: 'email', address: '$EMAIL'}
    ]
  });

  const userId = user.id;
} catch (error) {
  if (error instanceof APIError) {
    console.log(error.status, error.name);
  } else if (error instanceof PrivyAPIError) {
    console.log(error.message);
  } else {
    throw error;
  }
}
```

> [!TIP]
>
> [Learn more](https://docs.privy.io/user-management/migrating-users-to-privy/create-or-import-a-user.md) about creating
> users, and look at our [pregenerating wallets](https://docs.privy.io/recipes/pregenerate-wallets.md) guide for linking
> wallets to your users before they even sign in.

## Next steps & advanced topics

* For an additional layer of security, you can choose to sign your requests with [authorization keys](https://docs.privy.io/controls/authorization-keys/using-owners/overview.md).
* To restrict what wallets can do, you can set up [policies](https://docs.privy.io/controls/policies/overview.md).
* To prevent double sending the same transaction, take a look at our support for [idempotency](https://docs.privy.io/api-reference/idempotency-keys.md) keys.
* If you want to require multiple parties to sign off before sending a transaction for a wallet, you can accomplish this through the use of [quorum approvals](https://docs.privy.io/controls/quorum-approvals/overview.md).
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
> ## Documentation Index
> Fetch the complete documentation index at: https://docs.privy.io/llms.txt
> Use this file to discover all available pages before exploring further.

# Create a policy

You can create a policy using the Privy Dashboard, the NodeJS SDK, or the REST API.

Policies optionally have owners, which represent the signatures required to modify the policy after creation, see [setting authorization signatures](https://docs.privy.io/api-reference/authorization-signatures.md).

> [!TIP]
>
> We highly recommend specifying owners for your policies to further restrict the parties that can
> modify them. Without an owner, the policies can be updated by your app secret alone.

**NodeJS**

Use the **`PrivyClient`**'s **`create`** method from the `policies()` interface to create a new policy.

```tsx theme={"system"}
const policy = await privy.policies().create({
  name: 'Allow list certain smart contracts',
  version: '1.0',
  chain_type: 'ethereum',
  rules: [
    {
      name: 'Allowlist OUSD',
      method: 'eth_sendTransaction',
      action: 'ALLOW',
      conditions: [
        {
          field_source: 'ethereum_transaction',
          field: 'to',
          operator: 'eq',
          value: '0x20c0000000000000000000006a37da5c996874be'
        }
      ]
    }
  ],
  owner_id: 'fmfdj6yqly31huorjqzq38zc'
});
```

**Python**

Use the `create` method on the policies service.

```python theme={"system"}
policy = client.policies.create(
    chain_type="ethereum",
    name="Allow transfers to a known address",
    version="1.0",
    rules=[
        {
            "name": "Allow recipient",
            "method": "eth_sendTransaction",
            "action": "ALLOW",
            "conditions": [
                {
                    "field_source": "ethereum_transaction",
                    "field": "to",
                    "operator": "eq",
                    "value": "insert-allowed-address",
                }
            ],
        }
    ],
    owner_id="insert-key-quorum-id",
)
```

**Java**

You can create a policy using the Java SDK by using the `policies().create()` method.

```java theme={"system"}
try {
    // Create a policy rule to allow OUSD transfers
    Rule allowOusd = Rule.builder()
        .name("Allowlist OUSD")
        .method(PolicyRuleMethod.ETH_SEND_TRANSACTION)
        .action(Action.ALLOW)
        .conditions(List.of(
            EthereumTransactionCondition.builder()
                .fieldSource(EthereumTransactionConditionFieldSource.ETHEREUM_TRANSACTION)
                .field(EthereumTransactionConditionField.TO)
                .operator(ConditionOperator.EQ)
                .value(ConditionValue.of("0x20c0000000000000000000006a37da5c996874be"))
                .build()
        ))
        .build();

    // Create a policy that contains your rules
    PolicyCreateRequestBody policy = PolicyCreateRequestBody.builder()
      .version(Version.ONE_DOT0)
      .name("Allowlist certain smart contracts")
      .chainType(WalletChainType.ETHEREUM)
      .rules(List.of(
          allowOusd
      ))
      .build();

    PolicyCreateResponse response = privyClient
        .policies()
        .create(policy);

    if (response.policy().isPresent()) {
      Policy policy = response.policy().get();
      String policyId = policy.id();
    }
} catch (APIException e) {
    String errorBody = e.bodyAsString().orElse(e.getMessage());
    System.err.println(errorBody);
} catch (Exception e) {
    System.err.println(e.getMessage());
}
```

### Parameters

When defining a policy, you may specify the following values on the `PolicyCreateRequestBody` builder:

**parameters**

**version** `Version`

Version of the policy.

**name** `String`

Name to assign to policy.

**chainType** `WalletChainType`

Chain type for wallets that the policy will be applied to.

**rules** `List\<Rule\>`

A list of `Rule` objects describing what rules to apply to each RPC method (e.g.
`'eth_sendTransaction'`) that the wallet can take. [Learn more about
`Rules`](https://docs.privy.io/controls/policies/overview#rules).

**owner** `OwnerInput`

The owner of the policy. You should specify either an `owner` or an `ownerId`, but not both.

**ownerId** `String`

The key quorum ID of the owner of the policy. You should specify either an `owner` or an
`ownerId`, but not both.

### Returns

The `PolicyCreateResponse` object contains an optional `policy()` field that contains the created
policy if the policy was created successfully.

**policy()** `Optional\<Policy\>`

The created policy.

**Policy**

**version** `Version`

Version of the policy.

**name** `String`

Name of the policy.

**chainType** `WalletChainType`

Chain type of the wallets that the policy will be applied to.

**id** `String`

Unique ID of the policy.

**ownerId** `String`

The key quorum ID of the owner of the policy.

**createdAt** `Double`

The Unix time of when the policy was created.

**rules** `List\<Rule\>`

A list of `Rule` objects describing what rules to apply to each RPC method (e.g.
`'eth_sendTransaction'`) that the wallet can take. [Learn more about
`Rules`](https://docs.privy.io/controls/policies/overview#rules).

**Rust**

Use the **`PrivyClient`**'s **`create`** method from the `policies()` interface to create a new policy.

```rust theme={"system"}
use privy_rs::{PrivyClient, generated::types::*};

let client = PrivyClient::new(app_id, app_secret)?;

// Create policy rules
let ousd_condition = PolicyRuleCondition {
    field_source: "ethereum_transaction".to_string(),
    field: "to".to_string(),
    operator: "eq".to_string(),
    value: serde_json::Value::String("0x20c0000000000000000000006a37da5c996874be".to_string()),
};

let allow_ousd_rule = PolicyRule {
    name: "Allowlist OUSD".to_string(),
    method: "eth_sendTransaction".to_string(),
    action: PolicyRuleAction::Allow,
    conditions: vec![ousd_condition],
};

let request = CreatePolicyBody {
    name: "Allowlist certain smart contracts".to_string(),
    version: "1.0".to_string(),
    chain_type: "ethereum".to_string(),
    rules: vec![allow_ousd_rule],
    owner_id: Some("fmfdj6yqly31huorjqzq38zc".to_string()),
    owner: None,
};

let policy = client
    .policies()
    .create(request, &authorization_context)
    .await?;

println!("Created policy: {}", policy.id);
```

### Parameters and Returns

See the Rust SDK documentation for detailed parameter and return types, including embedded examples:

* [PoliciesClient::create](https://docs.rs/privy-rs/latest/privy_rs/subclients/struct.PoliciesClient.html#method.create)

For REST API details, see the [API reference](https://docs.privy.io/api-reference/policies/create.md).

**Go**

To create a policy with the Go SDK, use the `New` method on the `Policies` service.

### Usage

```go theme={"system"}
policy, err := client.Policies.New(context.Background(), privy.PolicyNewParams{
    Name:      "Allow list certain smart contracts",
    ChainType: privy.WalletChainTypeEthereum,
    Version:   privy.PolicyNewParamsVersion1_0,
    OwnerID:   privy.String("fmfdj6yqly31huorjqzq38zc"),
    Rules: []privy.PolicyNewParamsRule{
        {
            Name:   "Allowlist OUSD",
            Method: "eth_sendTransaction",
            Action: "ALLOW",
            Conditions: []privy.PolicyNewParamsRuleConditionUnion{
                {
                    OfEthereumTransaction: &privy.PolicyNewParamsRuleConditionEthereumTransaction{
                        Field:    "to",
                        Operator: "eq",
                        Value: privy.PolicyNewParamsRuleConditionEthereumTransactionValueUnion{
                            OfString: privy.String("0x20c0000000000000000000006a37da5c996874be"),
                        },
                    },
                },
            },
        },
    },
})
if err != nil {
    log.Fatalf("failed to create policy: %v", err)
}

fmt.Println("Created policy:", policy.ID)
```

### Parameters and Returns

See the [API reference](https://docs.privy.io/api-reference/policies/create.md) for more details.

**Ruby**

To create a policy with the Ruby SDK, use the `create` method on the `policies` service.

### Usage

```ruby theme={"system"}
policy = client.policies.create(
  policy_create_params: {
    version: "1.0",
    name: "Allow list certain smart contracts",
    chain_type: "ethereum",
    owner_id: "fmfdj6yqly31huorjqzq38zc",
    rules: [
      {
        name: "Allowlist OUSD",
        method: "eth_sendTransaction",
        action: "ALLOW",
        conditions: [
          {
            field_source: "ethereum_transaction",
            field: "to",
            operator: "eq",
            value: "0x20c0000000000000000000006a37da5c996874be"
          }
        ]
      }
    ]
  }
)

puts(policy.id)
```

### Parameters and Returns

See the [API reference](https://docs.privy.io/api-reference/policies/create.md) for more details.

**REST API**

To create a new policy, make a `POST` request to:

```sh theme={"system"}
https://api.privy.io/v1/policies
```

> [!TIP]
>
> In the request headers, make sure to include Privy's [required authentication
> headers](https://docs.privy.io/basics/rest-api/setup.md#authentication) and [headers that may be required for your app's
> wallet API setup](https://docs.privy.io/basics/rest-api/quickstart.md#2-sign-a-message). You can also include an
> [idempotency key](https://docs.privy.io/api-reference/idempotency-keys.md) header.

## **Body**

In the request body, include the following:

**body attributes**

**version** `'1.0'`

Version of the policy. Currently, 1.0 is the only version.

**name** `string`

Name to assign to policy.

**chain\_type** `'ethereum'`

Chain type for wallets that the policy will be applied to.

**rules** `Rule`

A list of `Rule` objects describing what rules to apply to each RPC method (e.g.
`'eth_sendTransaction'`) that the wallet can take. [Learn more about
`Rules`](https://docs.privy.io/controls/policies/overview#rules).

**owner** `\{public_key: string\} | null`

The P-256 public key of the owner of the policy. If you provide this, do not specify an owner\_id
as it will be generated automatically.

View [this guide](https://docs.privy.io/controls/authorization-keys/owners/overview.md) to learn more about owners.

**owner\_id** `string | null`

The key quorum ID of the owner of the policy. If you provide this, do not specify an owner.

View [this guide](https://docs.privy.io/controls/authorization-keys/owners/overview.md) to learn more about owners.

Once you have successfully created a policy, you can assign that policy to a wallet at [creation](https://docs.privy.io/wallets/wallets/create/create-a-wallet.md#param-policy-ids).

## **Response**

If the policy is created successfully, the response will include the request body as well as an additional unique `id` field for the policy.

**response**

**id** `string`

Unique ID for the policy.

**version** `'1.0'`

Version of the policy. Currently, 1.0 is the only version.

**name** `string`

Name to assign to policy.

**chain\_type** `'ethereum'`

Chain type for wallets that the policy will be applied to.

**rules** `Rule[]`

A list of `Rule` objects describing what rules to apply to each RPC method (e.g.
`'eth_sendTransaction'`) that the wallet can take. [Learn more about
`Rules`](https://docs.privy.io/controls/policies/overview#rules).

**owner\_id** `string | null`

The key quorum ID of the owner of the policy, whose signature is required to modify the policy.

## Example

As an example, a sample request to create a new `eth_sendTransaction` policy might look like the following:

```bash theme={"system"}
$ curl --request POST https://api.privy.io/v1/policies \
-u "<your-privy-app-id>:<your-privy-app-secret>" \
-H "privy-app-id: <your-privy-app-id>" \
-H "privy-authorization-signature: <authorization-signature-for-request>" \
-H 'Content-Type: application/json' \
-d '{
    "version": "1.0",
    "name": "Allowlist certain smart contracts",
    "chain_type": "ethereum",
    "rules": [{
      "name": "Allowlist OUSD",
      "method": "eth_sendTransaction",
      "conditions": [
          {
              "field_source": "ethereum_transaction",
              "field": "to",
              "operator": "eq",
              "value": "0x20c0000000000000000000006a37da5c996874be"
          }
      ],
      "action": "ALLOW"
    }],
    "owner": {
      "public_key": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEx4aoeD72yykviK+f/ckqE2CItVIG1rCnvC3/XZ1HgpOcMEMialRmTrqIK4oZlYd1RfxU3za/C9yjhboIuoPD3g=="
    }
}'
```

A successful response will look like the following:

```json theme={"system"}
{
  "id": "fmfdj6yqly31huorjqzq38zc",
  "name": "Allowlist certain smart contracts",
  "version": "1.0",
  "chain_type": "ethereum",
  "rules": [
    {
      "name": "Allowlist OUSD",
      "method": "eth_sendTransaction",
      "conditions": [
        {
          "field_source": "ethereum_transaction",
          "field": "to",
          "operator": "eq",
          "value": "0x20c0000000000000000000006a37da5c996874be"
        }
      ],
      "action": "ALLOW"
    }
  ],
  "owner_id": "fmfdj6yqly31huorjqzq38zc"
}
```
