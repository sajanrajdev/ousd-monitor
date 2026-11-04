# Labels

`labels.csv` says who a wallet or contract is, and how we know. It decides published numbers, so a label change is a reviewed change.

**The rule:** a public source must tie the name to the address. Behavior that merely looks like a partner is not enough, so such a wallet stays unnamed. We don't label private individuals, and we don't state guesses as fact. A wallet absent from this file counts as unlabeled, which is the safe default.

## Columns

| Column | Meaning |
|---|---|
| `chain` | `tempo`, `ethereum`, `base` or `solana` |
| `address` | Lowercase on EVM chains. Solana addresses keep their case. One row per chain and address |
| `entity` | The public name. Empty for an unnamed cluster |
| `category` | `issuer`, `issuer_route`, `system`, `dex`, `lending` or `exchange` |
| `source_type` | Where the knowledge comes from. See the legend below |
| `source_url` | Where to check it. A web address, except `derived_rule` rows, which point at the rule in this repository |
| `confidence` | `high` or `medium` |
| `date_checked` | The day we last confirmed the source still says this, in UTC |

**`system`** covers contracts that run a chain or pass money through without holding it as a venue, such as third-party routers, cross-chain relayers and their solvers. `dex` and `lending` are for contracts that hold liquidity. Bridge, the issuer of OUSD, is `issuer`, not `system`.

## How we know: the source legend

Every label has exactly one source type. It tells you what kind of evidence the label rests on, and so how to check it.

| Source type | What it means | How to check it |
|---|---|---|
| `explorer_tag` | A block explorer shows this name on the address | Open the link and read the name at the top of the address page |
| `project_docs` | The documentation or app of the project that runs the contract lists it under this name | Open the link and find the name, with its address beside it |
| `company_docs` | A company's own documentation names the address as its own | Open the link and find the name, with its address beside it |
| `official_statement` | The named organization said so in an announcement or other statement | Open the link and find the name and address in the statement |
| `published_research` | A named research publisher ties the name to the address | Open the link and find the name and address. Publishers may shorten an address, as in `0x4c2c…00b8` |
| `onchain_metadata` | The chain itself records it, such as a verified contract name and its creator | Open the link and read the contract details |
| `derived_rule` | No source names it. It is an unnamed cluster, found by a written rule applied to the chain's own data | Read the rule at the link. The dataset publishes no address for an unnamed cluster, so apply it to the addresses in `labels/labels.csv` in this repository |

**Reading a label:** a named label always has a web source you can open. A `derived_rule` label never has a name, because it describes what a wallet does, not who holds it. `confidence` is `medium` when the source leaves a gap, such as a vault page that shows no curator, or research that prints only a shortened address. Vault names come from the vault's creator, not from any company the name may suggest, so a name alone doesn't say who runs a vault. The 0x Settler labels rest on the verified contract name and on the creator the chain records for it, `deployer.zeroexprotocol.eth`. Tell us if a source no longer supports a label.

The site and methodology page carry this legend, so keep this section readable on its own.

## How unnamed clusters are found

An unnamed cluster is a set of wallets found from the chain's own transfers by a written rule. No public source names them, so they have no name here, and the rule says nothing about who holds them.

The redemption route (`issuer_route`) has three kinds of wallet. The hub is the wallet a chain's mints go to. Path wallets are on the fixed path from the hub into burns. Collection wallets take money from many senders, send every outgoing transfer to the hub, and hold almost no balance. A wallet that passes money through from a single sender stays unlabeled, as does any other wallet with flows into the route, however large the flows. A contract on the path may have a verified name on the chain, but that name doesn't say who runs it, so the label stays unnamed.

Published data gives a count of these wallets by chain and category, with this rule. Their addresses are only in `labels/labels.csv` in this repository.

## Where each source lives

Publish refuses a named label whose link is on any other host, holds a query string, or holds an address other than the row's own. Adding a host here is a reviewed change, like a label.

| Source type | Hosts |
|---|---|
| `explorer_tag` | `etherscan.io`, `basescan.org` |
| `project_docs` | `api.relay.link`, `developers.uniswap.org`, `api.orca.so`, `tempo.xyz`, `curator.morpho.org` |
| `company_docs` | none yet |
| `official_statement` | none yet |
| `published_research` | `crystalintelligence.com` |
| `onchain_metadata` | `etherscan.io`, `basescan.org` |
