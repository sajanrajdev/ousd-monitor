# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Do not open a public issue or pull request for a security problem.

Include what you found, how to reproduce it, and which part of the project it affects. Reports are read as time allows, and a fix is published before details are.

## In scope

- **The pipeline:** ingestion, reconciliation, the dbt models and the publish step, including anything that could leak a key or let untrusted input change what is written.
- **Published dataset integrity:** a way to make the published JSON or CSV carry a number that did not pass the reconciliation checks, or to alter it after publication.
- **The site:** the static site built from the published dataset, including script injection and unsafe handling of dataset content.

## Out of scope

- A number you think is wrong but that comes from a correct reading of public chain data. Open a "Data question" issue instead.
- Findings in third-party services (RPC providers, Bridge's API, explorers) or in the contracts being measured.

## Keys

Provider keys live only in `.env`, which is never committed. If you find a key in the repository or its history, report it privately as above.
