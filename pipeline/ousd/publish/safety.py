"""What may leave in a dataset: the source legend and exchange listings read from
labels/README.md, and the checks that refuse a wallet, a URL, a key or a label that isn't a name.
"""

import os
import re
from collections.abc import Iterator, Mapping, Sequence
from datetime import UTC, date, datetime
from typing import Any
from urllib.parse import urlsplit

from ousd.chains import KEYED_RPC_ENV, load_chains
from ousd.publish.errors import PublishRefused
from ousd.solana import OUSD_MINT

LISTING_SOURCE_TYPE = "exchange_listing"
_LEGEND_HEADING = "## How we know: the source legend"
_RULE_HEADING = "## How unnamed clusters are found"
_HOSTS_HEADING = "## Where each source lives"
_LISTINGS_HEADING = "## Exchanges that say they support OUSD"
_LISTINGS_TABLE = "| Exchange | Source | Date checked |\n|---|---|---|\n"
_LEGEND_ROW = re.compile(r"^\| `([a-z_]+)` \| (.+?) \| (.+?) \|$")
_HOST_ROW = re.compile(r"^\| `([a-z_]+)` \| (.+?) \|$")
# One word, as exchange names are, so a person's name or a sentence can't pass as one.
_LISTING_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9.-]*")
_LISTING_HOST_ROW = re.compile(r"^\| ([A-Z][^|]*?) \| `([^`]+)` \|$")
_LISTING_ROW = re.compile(r"^\| ([^|]+?) \| (https://\S+) \| ([0-9]{4}-[0-9]{2}-[0-9]{2}) \|$")
_READING_NOTE = re.compile(r"^\*\*Reading a label:\*\* (.+)$", re.MULTILINE)
_EVM_SHAPE = re.compile(r"0[xX][0-9a-fA-F]{40}")
# The same address with no prefix. Bounded, so it can't match part of a 64-character hash.
_BARE_EVM_SHAPE = re.compile(r"(?<![0-9A-Za-z])[0-9a-fA-F]{40}(?![0-9A-Za-z])")
# Bounded by anything that isn't a letter or digit, so a longer hash can't match part of itself.
_BASE58_SHAPE = re.compile(r"(?<![0-9A-Za-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![0-9A-Za-z])")
# A run id is exactly this, and is also valid base58. Any other length of hex stays suspect.
_RUN_ID_SHAPE = re.compile(r"[0-9a-f]{32}")
_URL_SHAPE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
# What a word of a name can be. A dotted word reads as a host, so a real one is listed by name.
_NAME_WORD = re.compile(r"\(?[A-Za-z0-9&'-]+\)?")
_PAIR_WORD = re.compile(r"[A-Z0-9]{1,12}/[A-Z0-9]{1,12}")
_DOTTED_NAMES = frozenset({"LI.FI"})
# What a link's path segment can't be. `key` alone, so a slug like key-findings stays readable.
_PLAIN_SEGMENT = re.compile(r"[A-Za-z0-9._-]+")
_KEY_SEGMENT = re.compile(
    r"key|secret|password|passwd|bearer|jwt|credentials?"
    r"|.*(api[-_]?key|access[-_]?token|auth[-_]?token).*",
    re.IGNORECASE,
)
# A label's link, the one place a wallet-shaped value may be, and only after its own check.
_LABEL_LINK_PLACE = re.compile(r"labels\.json/(data|exchange_listings)/\d+/source_url")
# A full commit hash has an address's shape. Its schema allows 40 hex digits and nothing else.
_COMMIT_PLACE = "manifest.json/git_commit"
# Other variables that can hold a provider URL. KEYED_RPC_ENV has the rest.
_RPC_ENV = ("TEMPO_RPC_URL", "ETHEREUM_RPC_URL", "ETHEREUM_BLOCKSCOUT_URL")


def _section(text: str, heading: str) -> str:
    _, found, after = text.partition(heading)
    if not found:
        raise PublishRefused(f"labels/README.md has no section {heading.removeprefix('## ')!r}")
    return after.partition("\n## ")[0]


def _read_legend(text: str) -> dict[str, Any]:
    """The source legend, parsed from labels/README.md so there is one copy of the words."""
    section = _section(text, _LEGEND_HEADING)
    note = _READING_NOTE.search(section)
    if note is None:
        raise PublishRefused("labels/README.md has no source legend to publish")
    rows = [
        {"source_type": match[1], "meaning": match[2], "how_to_check": match[3]}
        for line in section.splitlines()
        if (match := _LEGEND_ROW.match(line))
    ]
    return {"source_types": rows, "reading_a_label": note[1]}


def _read_unnamed_rule(text: str) -> str:
    return " ".join(_section(text, _RULE_HEADING).split())


def _read_source_hosts(text: str) -> dict[str, set[str]]:
    return {
        match[1]: set(re.findall(r"`([^`]+)`", match[2]))
        for line in _section(text, _HOSTS_HEADING).splitlines()
        if (match := _HOST_ROW.match(line))
    }


def _read_listing_hosts(text: str) -> dict[str, str]:
    return {
        match[1]: match[2]
        for line in _section(text, _HOSTS_HEADING).splitlines()
        if (match := _LISTING_HOST_ROW.match(line))
    }


def _is_a_past_date(text: str) -> bool:
    try:
        return date.fromisoformat(text) <= datetime.now(UTC).date()
    except ValueError:
        return False


def _read_exchange_listings(text: str) -> list[dict[str, str]]:
    """Exchanges whose own page says they support OUSD. The page names no wallet, so its link holds
    no address, and it must be on the host recorded for that exchange. Anything in the table that
    doesn't read as a row refuses, so an exchange can't drop out unnoticed."""
    before, found, table = _section(text, _LISTINGS_HEADING).partition(_LISTINGS_TABLE)
    if not found:
        raise PublishRefused("labels/README.md has no exchange listings table")
    if "|" in before:
        raise PublishRefused("labels/README.md has an exchange listing it can't read")
    hosts = _read_listing_hosts(text)
    rows = []
    for line in filter(None, (line.rstrip() for line in table.splitlines())):
        match = _LISTING_ROW.match(line)
        if match is None or not _is_a_past_date(match[3]):
            raise PublishRefused("labels/README.md has an exchange listing it can't read")
        if not _LISTING_NAME.fullmatch(match[1]):
            raise PublishRefused("an exchange listing has an entity that doesn't look like a name")
        if match[1] not in hosts:
            raise PublishRefused("an exchange listing isn't on the list of exchanges and hosts")
        _refuse_bad_source(
            {
                "chain": "the exchange list",
                "address": "",
                "source_type": LISTING_SOURCE_TYPE,
                "source_url": match[2],
            },
            {LISTING_SOURCE_TYPE: {hosts[match[1]]}},
        )
        rows.append(
            {
                "entity": match[1],
                "source_type": LISTING_SOURCE_TYPE,
                "source_url": match[2],
                "date_checked": match[3],
            }
        )
    if not rows:
        raise PublishRefused("labels/README.md has no exchange listings")
    if len({row["entity"] for row in rows}) != len(rows):
        raise PublishRefused("labels/README.md lists an exchange twice")
    return rows


def _comparable(address: str) -> str:
    """EVM addresses are case-insensitive. Base58 addresses are not."""
    return address.lower() if address.lower().startswith("0x") else address


def _wallet_shapes(text: str) -> list[str]:
    evm = _EVM_SHAPE.findall(text)
    bare = _BARE_EVM_SHAPE.findall(text)
    base58 = [shape for shape in _BASE58_SHAPE.findall(text) if not _RUN_ID_SHAPE.fullmatch(shape)]
    return [*evm, *bare, *base58]


def _looks_opaque(text: str) -> bool:
    """A run of letters and digits too long or too mixed to be a word."""
    runs = re.split(r"[-_.]", text)
    return any(len(run) >= 20 or (len(run) >= 12 and any(c.isdigit() for c in run)) for run in runs)


def _looks_like_a_name(entity: str) -> bool:
    """Words only, so a URL, a host or a key with no scheme can't pass as a name."""
    return all(
        word in _DOTTED_NAMES
        or ((_NAME_WORD.fullmatch(word) or _PAIR_WORD.fullmatch(word)) and not _looks_opaque(word))
        for word in entity.split(" ")
    )


def _is_key_like(segment: str) -> bool:
    return (
        not _PLAIN_SEGMENT.fullmatch(segment)
        or bool(_KEY_SEGMENT.fullmatch(segment))
        or _looks_opaque(segment)
    )


def _refuse_bad_source(row: Mapping[str, str], hosts: Mapping[str, set[str]]) -> None:
    """A named label's link must open on the source its type documents, and show only that row.
    Messages name the chain alone, since a bad value may be the very thing that must not spread."""
    link = row["source_url"]
    where = f"a label on {row['chain']}"
    parts = urlsplit(link)
    if parts.scheme != "https" or "?" in link or "#" in link or "@" in parts.netloc:
        raise PublishRefused(f"{where} has a source link that isn't a plain https link")
    if parts.hostname not in hosts.get(row["source_type"], ()):
        raise PublishRefused(f"{where} has a source link on a host its source type doesn't list")
    own = _comparable(row["address"])
    if any(_comparable(shape) != own for shape in _wallet_shapes(link)):
        raise PublishRefused(f"{where} has a source link holding another address")
    for segment in filter(None, parts.path.split("/")):
        if _comparable(segment) != own and _is_key_like(segment):
            raise PublishRefused(f"{where} has a source link with a key-like path segment")


def _token_contracts() -> set[str]:
    """OUSD's own contracts, which are public and identify the token rather than any holder."""
    evm = {chain.token.lower() for chain in load_chains({}).values()}
    return {*evm, OUSD_MINT}


def _provider_values() -> list[str]:
    names = (*KEYED_RPC_ENV.values(), *_RPC_ENV)
    return [value for name in names if (value := os.environ.get(name, "").strip())]


def _strings(value: Any, place: str) -> Iterator[tuple[str, str]]:
    if isinstance(value, str):
        yield place, value
    elif isinstance(value, Mapping):
        for key, inner in value.items():
            yield f"{place}/{key}", str(key)
            yield from _strings(inner, f"{place}/{key}")
    elif isinstance(value, list):
        for index, inner in enumerate(value):
            yield from _strings(inner, f"{place}/{index}")


def _refuse_unsafe_text(place: str, text: str, tokens: set[str], providers: Sequence[str]) -> None:
    """Names the place, never the value, as the value is what must not spread."""
    if any(_comparable(shape) not in tokens for shape in _wallet_shapes(text)):
        raise PublishRefused(f"{place} holds a wallet-shaped value")
    if _URL_SHAPE.search(text):
        raise PublishRefused(f"{place} holds a URL")
    if any(value in text for value in providers):
        raise PublishRefused(f"{place} holds a provider URL")


def _refuse_unsafe_dataset(
    payloads: Mapping[str, Mapping[str, Any]], tabular: Mapping[str, bytes]
) -> None:
    """The last gate on what leaves: the whole dataset is refused for one bad value, wherever a
    new column, a check's detail or a label put it. A named label's link has its own check."""
    tokens = _token_contracts()
    providers = _provider_values()
    for filename, payload in payloads.items():
        for place, text in _strings(payload, filename):
            if not _LABEL_LINK_PLACE.fullmatch(place) and place != _COMMIT_PLACE:
                _refuse_unsafe_text(place, text, tokens, providers)
    for filename, data in tabular.items():
        _refuse_unsafe_text(filename, data.decode(), tokens, providers)
