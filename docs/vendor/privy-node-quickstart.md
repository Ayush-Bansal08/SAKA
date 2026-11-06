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
