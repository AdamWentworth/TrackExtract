class TrackExtractError(Exception):
    """User-facing engine error."""


class CancelledError(TrackExtractError):
    """Raised when a job is cancelled."""
