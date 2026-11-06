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
