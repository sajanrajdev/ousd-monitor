"""Why a publish stopped. A refusal's message is ours, so it can be shown and stored."""


class PublishRefused(RuntimeError):
    """The dataset can't be published. Its message is ours, so it can be shown and stored."""


class PublishUnavailable(PublishRefused):
    """A database is in use. It says nothing about the data, so nothing is marked stale."""
