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

## How we know: the source legend

Every label has exactly one source type. It tells you what kind of evidence the label rests on, and so how to check it.

| Source type | What it means | How to check it |
|---|---|---|
| `explorer_tag` | A block explorer shows this name on the address | Open the link and read the name at the top of the address page |
| `project_docs` | The documentation or app of the project that runs the contract lists it under this name | Open the link and find the address on the page |
| `company_docs` | A company's own documentation names the address as its own | Open the link and find the address on the page |
| `official_statement` | The named organization said so in an announcement or other statement | Open the link and find the address in the statement |
| `published_research` | A named research publisher ties the name to the address | Open the link and find the address. Publishers may shorten it, as in `0x4c2c…00b8` |
| `onchain_metadata` | The chain itself records it, such as a verified contract name and its creator | Open the link and read the contract details |
| `derived_rule` | No source names it. It is an unnamed cluster, found by a written rule applied to the chain's own data | Read the rule at the link, then apply it to the address's transfers |

**Reading a label:** a named label always has a web source you can open. A `derived_rule` label never has a name, because it describes what a wallet does, not who holds it. `confidence` is `medium` when the source leaves a gap, such as a vault page that shows no curator. Tell us if a source no longer supports a label.

The site and methodology page carry this legend, so keep this section readable on its own.
