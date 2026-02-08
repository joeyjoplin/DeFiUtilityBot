FROM python:3.11-slim

# Install Node.js 20 on Debian (for the server)
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Node deps (server) ----
COPY backend/server/package*.json ./backend/server/
RUN cd backend/server && npm ci

# ---- Python deps (agents) ----
COPY backend/agents/requirements.txt ./backend/agents/requirements.txt
RUN python3.11 -m pip install --no-cache-dir -r backend/agents/requirements.txt

# Copy the rest of the repo
COPY . .

ENV NODE_ENV=production
ENV PYTHON_BIN=python3.11

WORKDIR /app/backend/server
CMD ["node", "server.js"]

