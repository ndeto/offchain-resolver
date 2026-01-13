# Offchain Resolver (ERC-3668 Gateway)

This service is an [ERC-3668](https://eips.ethereum.org/EIPS/eip-3668) (CCIP-Read) gateway for ENS Universal Resolver calls. 

In this setup it:

- Accepts batch gateway payloads from the ENS Universal Resolver.
- Resolves each request against the onchain Agent Delegations resolver.
- Returns the ABI-encoded response bytes that the resolver callback expects.

## Hosted

- Gateway: https://ccip-read-offchain-resolver.vercel.app
- Source: https://github.com/ndeto/offchain-resolver

## Environment

Set the Base Sepolia RPC and resolver address:

- `BASE_SEPOLIA_RPC_URL`
- `BASE_SEPOLIA_AGENT_DELEGATIONS_RESOLVER_ADDRESS`

Optional local overrides:

- `PORT` (default: `8787`)

## Run locally

```bash
npm install
npm run dev
```
