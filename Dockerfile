# The daily run's image: the pipeline, the site build and the Vercel CLI, built once by the host.
# The volume mounts at /app/data at start, so nothing under data/ is in the image. See docs/deploy.md.
FROM node:24.10.0-bookworm-slim

# uv, pinned, from its own image. It installs Python 3.12 from .python-version into the image.
COPY --from=ghcr.io/astral-sh/uv:0.8.8 /uv /uvx /usr/local/bin/

# make runs every step. ca-certificates for HTTPS. No git: the commit comes from OUSD_GIT_COMMIT.
# No headless browser: screenshots and acceptance runs are local only.
RUN apt-get update \
    && apt-get install -y --no-install-recommends make ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Volumes mount as root, so the run stays root (no RAILWAY_RUN_UID needed).
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_NO_CACHE=1 \
    NEXT_TELEMETRY_DISABLED=1 \
    VERCEL_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NO_UPDATE_NOTIFIER=1

WORKDIR /app

# The Vercel CLI, pinned. The version is set here and nowhere else.
RUN npm install --global --no-fund --no-audit vercel@65.0.0 \
    && npm cache clean --force

# Python dependencies from uv.lock, before the source, so a code change keeps this layer. The dev
# group too, as every runtime command is `uv run --locked`, which would otherwise install it.
COPY pyproject.toml uv.lock .python-version README.md ./
RUN uv sync --locked --no-install-project

# Site dependencies from the lockfile, through npx at packageManager's pnpm version, as the
# Makefile runs it. make web-release installs again at run time, which is then a no-op.
COPY web/package.json web/pnpm-lock.yaml web/pnpm-workspace.yaml web/
RUN PNPM_SPEC="$(sed -n 's/.*"packageManager": *"\([^"]*\)".*/\1/p' web/package.json)" \
    && test -n "$PNPM_SPEC" \
    && npx --yes "$PNPM_SPEC" --dir web install --frozen-lockfile

COPY . .
RUN uv sync --locked \
    && chmod +x scripts/daily.sh \
    && mkdir -p data

# No VOLUME line: Railway refuses the keyword. The service's volume is mounted at /app/data.

CMD ["scripts/daily.sh"]
