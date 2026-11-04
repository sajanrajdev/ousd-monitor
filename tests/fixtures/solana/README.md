# Solana JSON-RPC fixtures

Captured verbatim from the Solana mainnet public RPC endpoint with no API key.

- **Endpoint:** `https://api.mainnet-beta.solana.com`
- **Capture date:** `2026-11-04` UTC (`2026-11-04T04:38:46Z` to `2026-11-04T04:39:50Z`, `2026-11-03` local)
- **Format:** Each file holds the JSON-RPC response `result` formatted with 2-space indentation, except `error_min_context_slot.json` and `error_unsupported_version.json`, which hold the full JSON-RPC error response body.

## Files

| File | Method | Parameters | Stored |
|---|---|---|---|
| `mint_inner_second_mint.json` | `getTransaction` | `["3bcNbfSDoDGX25DfYpwWrE2Z5WKZw2EKTdMCf8sLnjPMKuTeH3zDEH9NKe5TZFKZNCfguEGac4KeTvM5RG8gHgio", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `burn_inner_second_mint.json` | `getTransaction` | `["5N1276YqFMhu8oHxmUt8uK7HZ1cVmCdEjnnpfG7DgN6WUoiSWQxFRwnVozFPsuFxATBJG7oPp6D3ka6Z2evab9xk", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `plain_burn_close.json` | `getTransaction` | `["5uHfZGg2egTb8nYaMGG94327Ja399AqJNFTiAqhyJoiMT8Xi5yEJZwMeQjSa8VPVGWeMevuPA9HjQjd3Rr4PTjW6", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `failed_inner_move.json` | `getTransaction` | `["5uwsKpkxjtW4RV3UHNEREVip1YvUpkfmBxvNQpGXQTrbDQw7s72MZDkhBF4BhQ9NwEfxW124VJA2i9WvWTLRhZDv", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `version_1.json` | `getTransaction` | `["3mcZGRsHsd7QPyHoGUzv6hCfo3rAKxZ7Ym3T5W4xM9TtEqEWzaTmsE8UMGSQynw3wkCT1R9L7EZT8xjMfisitLUs", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `version_0_inner.json` | `getTransaction` | `["D4rsdZfkmdstKBgpeo5SdVKgAJ9Dtrebh29Yx323uu7dvjBwKF3fzJGjbGNJQLXt7ZLnDa35LWaQfvC1zkuZRw5", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `shared_position_a.json` | `getTransaction` | `["4RWC94UKCbJf2ev9b9A7cNABN2qxaeL3uGku3Nd1wp8T3vqGfFeKGZFUnwtJPYMP228PzgqfYt8MaqRNvAGDksZh", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `shared_position_b.json` | `getTransaction` | `["52Vo1pMd2uawLk7TbGNggDhG3k3D32xPM16THuNy6rKKUrXhF8cZXBqsEfQ2cN8M8dEHVEG4xqJJHH1pDGKUzJmJ", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `transient_account.json` | `getTransaction` | `["3mM4LwzwtTxcwh5eyqpJbGZxhfHBkdLRg53soRFXTpAa7xZa7RQAXQjop9PWMqXU3FTPpZKaSsAHhZ3eBm8yew4W", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `top_level_transfer.json` | `getTransaction` | `["3FXYo3fvVRepJazMGgwgEZ9zouurccDbUs39vvAwi8MMe9QnbxnUYwUtK6n8Dw9zS5gK1dvNU7VzRuyDDjpWUyFS", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `no_movement.json` | `getTransaction` | `["3Xqq4SHeTZNkrHxgVnTAsBhNiBKpndpqHxBzuR3hQJwSm7bogZPkorq8Nn6XHsADUNumB1Djnjq8QRycoj8StPM1", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `mint_creation.json` | `getTransaction` | `["5w8xF6Bzj9UNkMyBWUPDAeUwTZtqECMXg5do4S19gthAC6JR7JSyrmUhN3VyrfBB6rvsJT4kBzejsvtRUTz5AcbW", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `confidential_deposit_transfer.json` | `getTransaction` | `["63wKxJ254UT832pB3jSbgfzJwSY5CjNETi1LwXvSzLKTE9tDY3a3JN1gTgJJ2xyRpZ4GnpvzfPH5f9ZMsfJGEZ7F", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `confidential_withdraw.json` | `getTransaction` | `["3YM38ogmcFP2unpDiEdWhDKbK2KEsdweytRW1AmYS666JkSWzU4CrXgcPeDGKh9hkX38oNWi7dsgZQe7Cd7D5R5d", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 1}]` | `result` |
| `mint_account.json` | `getAccountInfo` | `["ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB", {"encoding": "jsonParsed", "commitment": "finalized"}]` | `result` |
| `token_account.json` | `getAccountInfo` | `["EjLgtKu5s4q9ifSEVUvypiSsa9ZifCtNefXNZyR2yitd", {"encoding": "jsonParsed", "commitment": "finalized"}]` | `result` |
| `token_accounts_one_owner.json` | `getProgramAccounts` | `["TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", {"encoding": "jsonParsed", "commitment": "finalized", "withContext": true, "filters": [{"memcmp": {"offset": 0, "bytes": "ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB"}}, {"memcmp": {"offset": 32, "bytes": "DpqFuc9Ce2Frn8dMvz8aVZoF1HusRr9gfALrtafG9x4X"}}, {"memcmp": {"offset": 165, "bytes": "3"}}]}]` | `result` |
| `token_supply.json` | `getTokenSupply` | `["ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB", {"commitment": "finalized"}]` | `result` |
| `block_time.json` | `getBlockTime` | `[463296214]` | `result` |
| `signature_page.json` | `getSignaturesForAddress` | `["ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB", {"commitment": "finalized", "limit": 3, "before": "2E8WdNXrJNXejKbahJk4mrTb8yfxmWyM5ZKbNY4NMyStB36UdPG8vnzzqFAhCJ7399HhX63uCnFR2qmcZHL1GDmm"}]` | `result` |
| `signature_page_before_creation.json` | `getSignaturesForAddress` | `["ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB", {"commitment": "finalized", "limit": 5, "before": "5w8xF6Bzj9UNkMyBWUPDAeUwTZtqECMXg5do4S19gthAC6JR7JSyrmUhN3VyrfBB6rvsJT4kBzejsvtRUTz5AcbW"}]` | `result` |
| `error_min_context_slot.json` | `getSignaturesForAddress` | `["ousd2mJsPEckLHcSCDxyKD7NDGARZcfLbDZkKiatYHB", {"commitment": "finalized", "limit": 1000, "minContextSlot": 999999999}]` | full JSON-RPC body |
| `error_unsupported_version.json` | `getTransaction` | `["3mcZGRsHsd7QPyHoGUzv6hCfo3rAKxZ7Ym3T5W4xM9TtEqEWzaTmsE8UMGSQynw3wkCT1R9L7EZT8xjMfisitLUs", {"encoding": "jsonParsed", "commitment": "finalized", "maxSupportedTransactionVersion": 0}]` | full JSON-RPC body |
